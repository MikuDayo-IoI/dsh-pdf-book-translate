import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  acquireBookLock,
  availableChapters,
  bookIdentity,
  fileExists,
  intervalStrings,
  loadBookState,
  resolvePaths,
  resolveScope,
  targetLanguage as targetLang,
  type BookPaths,
} from './book.js'
import { runOutlinePipeline, runTranslationPipeline } from './pipeline.js'
import { PdfWorker, workerSpawn } from './worker.js'
import { TranslationCache } from './translate/cache.js'
import { createEngine } from './translate/engine.js'
import type {
  OutlineReport,
  StatusReport,
  TermEntry,
  TranslationReport,
} from './types.js'

export interface ToolConfig {
  apiKey?: string
  baseUrl: string
  model: string
  hostProvider?: string
  hostModel?: string
  langPair: string
  concurrency: number
  maxRetries: number
  timeoutMs: number
  termbasePath?: string
  pythonBin: string
}

export interface TranslateToolDeps {
  ctx: Context
  config: () => ToolConfig
}

interface TextLayerInfo {
  pageCount: number
  hasTextLayer: boolean
}

interface CommonArgs {
  input: string
  outputDir?: string
  langPair?: string
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    status: { type: 'string' as const, required: true as const },
    message: { type: 'string' as const, required: true as const },
    data: { type: 'json' as const, required: true as const },
  },
  additionalProperties: false,
}

function jsonData(value: unknown): JsonValue {
  return value as JsonValue
}

function renderReport(value: unknown): { type: 'text'; text: string }[] {
  const envelope = value as { status?: string; message?: string; data?: Record<string, unknown> }
  const status = envelope.status ?? 'unknown'
  const data = envelope.data ?? {}
  const lines: string[] = [`[${status}] ${envelope.message ?? ''}`]
  if (status === 'outlined') {
    const chapters = Array.isArray(data.chapters) ? data.chapters as Record<string, unknown>[] : []
    lines.push(`章节数：${chapters.length}`)
    for (const chapter of chapters.slice(0, 60)) {
      lines.push(`- ${String(chapter.id)} ${String(chapter.title)}（第 ${String(chapter.pages)} 页）`)
    }
    lines.push('', '下一步：询问用户要翻译的章节/页码，再调用 pdf_book_translate（不要默认整本翻译）。')
  } else if (status === 'translated') {
    lines.push(
      `页：请求 ${String(data.pagesRequested ?? 0)}，本次完成 ${String(data.pagesCompleted ?? 0)}，输出含 ${String(data.pagesInOutput ?? 0)} 页`,
      `段落：总 ${String(data.paragraphsTotal ?? 0)}，新译 ${String(data.paragraphsTranslated ?? 0)}，缓存命中 ${String(data.paragraphsCached ?? 0)}，失败 ${String(data.paragraphsFailed ?? 0)}，跳过 ${String(data.paragraphsSkipped ?? 0)}`,
      `缓存命中率：${((Number(data.cacheHitRate ?? 0)) * 100).toFixed(1)}%`,
      `API 调用 ${String(data.apiCalls ?? 0)} 次，token ${String(data.tokensIn ?? 0)}→${String(data.tokensOut ?? 0)}，耗时 ${((Number(data.durationMs ?? 0)) / 1000).toFixed(1)}s`,
      `译文 PDF：${String(data.translatedPath ?? '')}`,
    )
    if (typeof data.comparisonPath === 'string' && data.comparisonPath !== '') {
      lines.push(`对照 PDF：${data.comparisonPath}`)
    }
    const failures = Array.isArray(data.failures) ? data.failures as Record<string, unknown>[] : []
    if (failures.length > 0) {
      lines.push(`未翻译段落 ${failures.length} 个（PDF 中保留原文，重跑会重试）。失败原因：`)
      for (const failure of failures.slice(0, 5)) {
        lines.push(`- 第 ${String(failure.page ?? '?')} 页 / 段落 ${String(failure.id ?? '?')}：${String(failure.reason ?? '未知错误')}`)
      }
      if (failures.length > 5) lines.push(`- …另有 ${failures.length - 5} 条失败，见 data.failures。`)
    }
    const warnings = Array.isArray(data.warnings) ? data.warnings as Record<string, unknown>[] : []
    if (warnings.length > 0) {
      lines.push(`排版警告 ${warnings.length} 条（字号缩放/溢出等）。`)
      for (const warning of warnings.slice(0, 3)) {
        lines.push(`- 第 ${String(warning.page ?? '?')} 页 ${String(warning.kind ?? 'warning')}：${String(warning.detail ?? warning.message ?? '')}`)
      }
    }
  } else if (status === 'scope_required') {
    const chapters = Array.isArray(data.availableChapters) ? data.availableChapters as Record<string, unknown>[] : []
    if (chapters.length > 0) {
      lines.push('可用范围：')
      for (const chapter of chapters) {
        lines.push(`- ${String(chapter.id)} ${String(chapter.title)}（第 ${String(chapter.pages)} 页）`)
      }
    }
    lines.push('', '请先向用户确认要翻译的页码范围或章节，再调用本工具并显式传入 pages/chapters/sections（或 all=true）。')
  } else if (status === 'ready' || status === 'not_initialized') {
    const chapters = Array.isArray(data.chapters) ? data.chapters as Record<string, unknown>[] : []
    if (chapters.length > 0) {
      lines.push(`已翻译 ${String(data.translatedPages ?? 0)} 页；章节 ${chapters.length} 个。`)
      for (const chapter of chapters) {
        lines.push(`- ${String(chapter.id)} ${String(chapter.title)}（第 ${String(chapter.pages)} 页）`)
      }
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function requestedLang(args: CommonArgs, cfg: ToolConfig, previousLang?: string): string {
  const explicit = args.langPair?.trim()
  if (explicit !== undefined && explicit !== '') {
    if (previousLang !== undefined && previousLang !== explicit) {
      throw new Error(`该项目已建立 ${previousLang} 的翻译状态；本次请求 ${explicit}。请换一个输出目录，或使用原语言对。`)
    }
    return explicit
  }
  return previousLang ?? cfg.langPair
}

function resolveProjectPaths(args: CommonArgs, langPair: string): BookPaths {
  const inputPath = resolve(args.input)
  const outputDir = args.outputDir !== undefined && args.outputDir.trim() !== ''
    ? resolve(args.outputDir)
    : undefined
  return resolvePaths(inputPath, outputDir, langPair)
}

async function openProject(args: CommonArgs, cfg: ToolConfig, worker: PdfWorker): Promise<{
  paths: BookPaths
  identity: Awaited<ReturnType<typeof bookIdentity>>
  langPair: string
  previous: Awaited<ReturnType<typeof loadBookState>>
}> {
  const inputPath = resolve(args.input)
  if (!existsSync(inputPath)) throw new Error(`找不到 PDF：${inputPath}`)
  if (extname(inputPath).toLowerCase() !== '.pdf') throw new Error(`不是 PDF 文件：${inputPath}`)
  const probeLang = requestedLang(args, cfg)
  const probePaths = resolveProjectPaths(args, probeLang)
  const layer = await worker.command<TextLayerInfo>('textlayer', { path: inputPath })
  if (!layer.hasTextLayer) {
    throw new Error('该 PDF 没有文本层（可能是扫描版）。本插件不包含 OCR，无法翻译。')
  }
  const identity = await bookIdentity(inputPath, layer.pageCount)
  const previous = await loadBookState(probePaths, identity)
  const langPair = requestedLang(args, cfg, previous?.langPair)
  const paths = resolveProjectPaths(args, langPair)
  return { paths, identity, langPair, previous }
}

function splitIds(value: string | undefined): string[] {
  if (value === undefined) return []
  return value.split(/[,，、;；]/).map(v => v.trim()).filter(v => v !== '')
}

function failureReport(
  status: 'scope_required',
  paths: BookPaths,
  chapters: { id: string; title: string; pages: string }[],
  message: string,
): TranslationReport {
  return {
    status,
    inputPath: paths.inputPath,
    outputDir: paths.outputDir,
    zhanJiePath: paths.zhanJiePath,
    statePath: paths.statePath,
    pagesRequested: 0,
    pagesCompleted: 0,
    pagesInOutput: 0,
    paragraphsTotal: 0,
    paragraphsTranslated: 0,
    paragraphsCached: 0,
    paragraphsFailed: 0,
    paragraphsSkipped: 0,
    cacheHitRate: 0,
    apiCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    engine: '',
    mergedRanges: 0,
    previousTranslatedPages: 0,
    totalTranslatedPages: 0,
    failures: [],
    warnings: [],
    outline: { pageCount: 0, source: 'fallback', toc: [], chapters: [], warnings: [] },
    summaries: {},
    availableChapters: chapters,
    message,
  }
}

export function defineBookTools(deps: TranslateToolDeps): ToolDefinition[] {
  const { ctx, config } = deps
  return [
    defineOutlineTool(ctx, config),
    defineTranslateTool(ctx, config),
    defineStatusTool(ctx, config),
  ]
}

function defineOutlineTool(ctx: Context, config: () => ToolConfig): ToolDefinition {
  return defineTool({
    name: 'pdf_book_outline',
    description: [
      '识别 PDF 书籍的章（chapter）与节（section），为每章生成目标语言内容摘要，并写入输出目录下的 zhan_jie.md。',
      '该文件同时是断点状态：若任务中断，重新运行本工具会复用已有章节和摘要，只补缺失摘要。',
      '不执行翻译。完成后再询问用户要翻译的范围，并调用 pdf_book_translate。',
      '仅支持有文本层的 PDF（无 OCR）。',
    ].join(' '),
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 的绝对或工作区相对路径' },
      outputDir: { type: 'string', description: '输出目录；默认在 PDF 同目录下创建 <文件名>-translation' },
      langPair: { type: 'string', description: '语言对，如 en→zh；默认使用插件设置' },
      rescan: { type: 'boolean', description: 'true 时重新识别章节结构（保留可匹配的旧摘要）；默认 false，复用已有 zhan_jie.md' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderReport(value) },
    async execute(args, exec) {
      const started = Date.now()
      const cfg = config()
      const worker = await PdfWorker.start(cfg.pythonBin, workerSpawn(cfg.pythonBin).args, workerSpawn(cfg.pythonBin).cwd)
      try {
        const project = await openProject(args, cfg, worker)
        const lock = await acquireBookLock(project.paths.lockPath, 'outline')
        try {
          const result = await runOutlinePipeline({
            worker,
            paths: project.paths,
            identity: project.identity,
            langPair: project.langPair,
            previous: project.previous,
            rescan: args.rescan === true,
            getEngine: () => createEngine(ctx, cfg),
            signal: exec.signal,
          })
          const report: OutlineReport = {
            status: 'outlined',
            inputPath: project.paths.inputPath,
            outputDir: project.paths.outputDir,
            zhanJiePath: project.paths.zhanJiePath,
            statePath: project.paths.statePath,
            pageCount: project.identity.pageCount,
            source: result.state.outline.source,
            chapters: result.state.outline.chapters.map(chapter => ({
              id: chapter.id,
              title: chapter.title,
              pages: intervalStrings(rangeOf(chapter.pageStart, chapter.pageEnd)).join(','),
              sections: chapter.sections.map(section => ({
                id: section.id,
                title: section.title,
                pages: intervalStrings(rangeOf(section.pageStart, section.pageEnd)).join(','),
              })),
              summary: result.state.summaries[chapter.id] ?? '',
            })),
            reused: result.reused,
            summaryFallbacks: result.state.summaryFallbacks,
            warnings: result.warnings,
            message: `已识别 ${result.state.outline.chapters.length} 章 / ${result.state.outline.chapters.reduce((n, c) => n + c.sections.length, 0)} 节，纪要写入 ${project.paths.zhanJiePath}（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）。请询问用户翻译范围。`,
          }
          return { status: report.status, message: report.message, data: jsonData(report) }
        } finally {
          await lock.release()
        }
      } finally {
        await worker.dispose()
      }
    },
  })
}

function rangeOf(start: number, end: number): number[] {
  const pages: number[] = []
  for (let p = start; p <= end; p += 1) pages.push(p)
  return pages
}

function defineTranslateTool(ctx: Context, config: () => ToolConfig): ToolDefinition {
  return defineTool({
    name: 'pdf_book_translate',
    description: [
      '翻译 PDF 中指定范围的内容，保持原排版：使用 PyMuPDF 捕获段落 bbox、字号、颜色、粗体与对齐，删除原文后写回译文，保留图片、背景、矢量图形与链接。',
      '必须先运行 pdf_book_outline；必须显式给出 pages/chapters/sections 之一，或 all=true。不会默认整本翻译。',
      '按段落并发批翻译（默认并发 6）；每段完成后按“原文+语言对”的哈希写入 .translate-cache.json 与 journal。中断后重跑会跳过已有缓存，只补缺失段落。',
      '多次运行不同范围会合并到同一本译文 PDF；最终输出译文 PDF 和原版/译文左右对照 PDF。',
      '支持 JSON/TXT 术语表；仅支持有文本层的 PDF（无 OCR）。',
    ].join(' '),
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 的绝对或工作区相对路径' },
      outputDir: { type: 'string', description: '输出目录；默认 PDF 同目录的 <文件名>-translation' },
      langPair: { type: 'string', description: '语言对，如 en→zh；默认沿用已建立的 zhan_jie.md' },
      pages: { type: 'string', description: '1-based 页码范围表达式，如 “1-20,35,40-45”' },
      chapters: { type: 'string', description: '章节 id 或标题，逗号分隔，如 “ch-1,ch-3”' },
      sections: { type: 'string', description: '节 id 或标题，逗号分隔，如 “sec-1-1,sec-2-1”' },
      all: { type: 'boolean', description: '翻译全书；只有用户明确要求整本时才传 true' },
      termbase: { type: 'string', description: '术语表路径（JSON/TXT）；缺省自动读取输出目录的 termbase.json/glossary.json/术语表.json' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderReport(value) },
    async execute(args, exec) {
      const started = Date.now()
      const cfg = config()
      const worker = await PdfWorker.start(cfg.pythonBin, workerSpawn(cfg.pythonBin).args, workerSpawn(cfg.pythonBin).cwd)
      try {
        const project = await openProject(args, cfg, worker)
        const chapterIds = splitIds(args.chapters)
        const sectionIds = splitIds(args.sections)
        const hasScope = (args.pages !== undefined && args.pages.trim() !== '')
          || chapterIds.length > 0
          || sectionIds.length > 0
          || args.all === true
        if (!hasScope) {
          const chapters = project.previous !== undefined
            ? availableChapters(project.previous.outline)
            : []
          const report = failureReport(
            'scope_required',
            project.paths,
            chapters,
            '翻译范围未指定：请先询问用户要翻译哪些章/节/页，然后显式传参。',
          )
          return { status: report.status, message: report.message, data: jsonData(report) }
        }
        if (project.previous === undefined) {
          throw new Error(`尚未生成章节纪要。请先调用 pdf_book_outline 并等待完成：${project.paths.zhanJiePath}`)
        }
        const scope = resolveScope(project.previous.outline, {
          pages: args.pages,
          chapters: chapterIds,
          sections: sectionIds,
          all: args.all,
        })
        if (scope === undefined) {
          const report = failureReport('scope_required', project.paths, availableChapters(project.previous.outline), '未能解析出有效范围，请检查 pages/chapters/sections。')
          return { status: report.status, message: report.message, data: jsonData(report) }
        }

        const lock = await acquireBookLock(project.paths.lockPath, 'translate')
        try {
          const termResult = await loadTermbaseForProject(args.termbase, cfg.termbasePath, project.paths.outputDir)
          const engine = createEngine(ctx, {
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            hostProvider: cfg.hostProvider,
            hostModel: cfg.hostModel,
            maxRetries: cfg.maxRetries,
            timeoutMs: cfg.timeoutMs,
          })
          const cache = new TranslationCache(project.paths.cachePath)
          const result = await runTranslationPipeline({
            worker,
            paths: project.paths,
            state: project.previous,
            scope,
            langPair: project.langPair,
            termbase: termResult.entries,
            engine,
            cache,
            config: { concurrency: cfg.concurrency, maxParagraphs: 8, maxChars: 3000 },
            signal: exec.signal,
          })

          let comparisonPath: string | undefined
          const notes: string[] = [...termResult.warnings]
          try {
            await worker.command('compare', {
              inputPath: project.paths.inputPath,
              translatedPath: project.paths.translatedPath,
              outputPath: project.paths.comparisonPath,
              originalLabel: '原文',
              translatedLabel: `译文 ${targetLang(project.langPair)}`,
            })
            comparisonPath = project.paths.comparisonPath
          } catch (e) {
            notes.push(`对照 PDF 生成失败：${e instanceof Error ? e.message : String(e)}（译文 PDF 已生成）`)
          }

          const state = project.previous
          const report: TranslationReport = {
            status: 'translated',
            inputPath: project.paths.inputPath,
            outputDir: project.paths.outputDir,
            zhanJiePath: project.paths.zhanJiePath,
            statePath: project.paths.statePath,
            translatedPath: project.paths.translatedPath,
            comparisonPath,
            pagesRequested: result.pagesRequested,
            pagesCompleted: result.pagesCompleted,
            pagesInOutput: result.pagesInOutput,
            paragraphsTotal: result.paragraphsTotal,
            paragraphsTranslated: result.paragraphsTranslated,
            paragraphsCached: result.paragraphsCached,
            paragraphsFailed: result.paragraphsFailed,
            paragraphsSkipped: result.paragraphsSkipped,
            cacheHitRate: result.cacheHitRate,
            apiCalls: result.stats.apiCalls,
            tokensIn: result.stats.tokensIn,
            tokensOut: result.stats.tokensOut,
            durationMs: Date.now() - started,
            engine: result.stats.engine,
            mergedRanges: state.ranges.length,
            previousTranslatedPages: result.previousPages,
            totalTranslatedPages: result.translatedPages.length,
            failures: result.failures,
            warnings: result.warnings,
            outline: state.outline,
            summaries: state.summaries,
            scope,
            availableChapters: availableChapters(state.outline),
            message: [
              `翻译完成：本次 ${scope.label}，新译 ${result.paragraphsTranslated} 段，缓存命中 ${result.paragraphsCached} 段，失败 ${result.paragraphsFailed} 段。`,
              `输出 ${result.pagesInOutput} 页（累计范围 ${intervalStrings(result.translatedPages).join(',')}）。`,
              comparisonPath !== undefined ? `对照 PDF：${comparisonPath}` : '对照 PDF 未生成。',
              notes.length > 0 ? notes.join(' ') : '',
            ].filter(Boolean).join(' '),
          }
          return { status: report.status, message: report.message, data: jsonData(report) }
        } finally {
          await lock.release()
        }
      } finally {
        await worker.dispose()
      }
    },
  })
}

function defineStatusTool(ctx: Context, config: () => ToolConfig): ToolDefinition {
  return defineTool({
    name: 'pdf_book_status',
    description: '查看 PDF 书籍翻译项目的断点状态：章节纪要、已翻译页范围、缓存条目数、输出文件是否存在、上次统计。用于中断后决定从哪里继续。',
    parameters: {
      input: { type: 'string', required: true, description: '输入 PDF 的绝对或工作区相对路径' },
      outputDir: { type: 'string', description: '输出目录；默认 PDF 同目录的 <文件名>-translation' },
      langPair: { type: 'string', description: '语言对；默认沿用已有项目' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => renderReport(value) },
    async execute(args) {
      const cfg = config()
      const worker = await PdfWorker.start(cfg.pythonBin, workerSpawn(cfg.pythonBin).args, workerSpawn(cfg.pythonBin).cwd)
      try {
        const project = await openProject(args, cfg, worker)
        const cache = new TranslationCache(project.paths.cachePath)
        await cache.load()
        if (project.previous === undefined) {
          const report: StatusReport = {
            status: 'not_initialized',
            inputPath: project.paths.inputPath,
            outputDir: project.paths.outputDir,
            zhanJiePath: project.paths.zhanJiePath,
            statePath: project.paths.statePath,
            cachePath: project.paths.cachePath,
            pageCount: project.identity.pageCount,
            langPair: project.langPair,
            cacheEntries: cache.size,
            outputsExist: {
              translated: fileExists(project.paths.translatedPath),
              comparison: fileExists(project.paths.comparisonPath),
            },
            message: '尚未识别章节。请先调用 pdf_book_outline。',
          }
          return { status: report.status, message: report.message, data: jsonData(report) }
        }
        const state = project.previous
        const report: StatusReport = {
          status: 'ready',
          inputPath: project.paths.inputPath,
          outputDir: project.paths.outputDir,
          zhanJiePath: project.paths.zhanJiePath,
          statePath: project.paths.statePath,
          cachePath: project.paths.cachePath,
          translatedPath: project.paths.translatedPath,
          comparisonPath: fileExists(project.paths.comparisonPath) ? project.paths.comparisonPath : undefined,
          pageCount: project.identity.pageCount,
          langPair: state.langPair,
          chapters: state.outline.chapters.map(chapter => ({
            id: chapter.id,
            title: chapter.title,
            pages: intervalStrings(rangeOf(chapter.pageStart, chapter.pageEnd)).join(','),
            summary: state.summaries[chapter.id] ?? '',
          })),
          translatedPages: state.translatedPages.length,
          inProgressPages: state.activePages.length,
          inProgressIntervals: intervalStrings(state.activePages),
          translatedRanges: state.ranges.map(r => r.label),
          mergedIntervals: intervalStrings(state.translatedPages),
          cacheEntries: cache.size,
          lastStats: state.lastStats,
          outputsExist: {
            translated: fileExists(project.paths.translatedPath),
            comparison: fileExists(project.paths.comparisonPath),
          },
          message: `项目就绪：${state.outline.chapters.length} 章，已翻译 ${state.translatedPages.length} 页，缓存 ${cache.size} 段。${state.ranges.length} 个已完成范围。${state.activePages.length > 0 ? `另有 ${state.activePages.length} 页上次未完成，重跑会自动补全。` : ''}`,
        }
        return { status: report.status, message: report.message, data: jsonData(report) }
      } finally {
        await worker.dispose()
      }
    },
  })
}

async function loadTermbaseForProject(
  argPath: string | undefined,
  configPath: string | undefined,
  outputDir: string,
): Promise<{ entries: TermEntry[]; warnings: string[] }> {
  const warnings: string[] = []
  const explicit = argPath?.trim() !== '' && argPath !== undefined ? resolve(argPath) : undefined
  const configured = configPath?.trim() !== '' && configPath !== undefined ? resolve(configPath) : undefined
  let path = explicit ?? configured
  if (path === undefined) {
    for (const name of ['termbase.json', 'glossary.json', '术语表.json', 'termbase.txt', 'glossary.txt', '术语表.txt']) {
      const candidate = join(outputDir, name)
      if (existsSync(candidate)) {
        path = candidate
        break
      }
    }
  }
  if (path === undefined) return { entries: [], warnings }
  if (!existsSync(path)) {
    warnings.push(`术语表不存在，已忽略：${path}`)
    return { entries: [], warnings }
  }
  try {
    const raw = await readFile(path, 'utf8')
    const entries: TermEntry[] = []
    if (path.toLowerCase().endsWith('.json')) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item === null || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          const src = String(record.src ?? record.source ?? '').trim()
          const dst = String(record.dst ?? record.target ?? '').trim()
          if (src === '' || dst === '') continue
          entries.push({ src, dst, locked: record.locked === true })
        }
      } else if (parsed !== null && typeof parsed === 'object') {
        for (const [src, dst] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof dst !== 'string' || src.trim() === '' || dst.trim() === '') continue
          entries.push({ src: src.trim(), dst: dst.trim(), locked: false })
        }
      } else {
        warnings.push('术语表 JSON 必须是数组或 {原文:译文} 对象；已忽略。')
      }
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const parts = trimmed.split(/\t|,/).map(part => part.trim())
        if (parts.length < 2 || parts[0] === '' || parts[1] === '') {
          warnings.push(`术语表行格式无效，已跳过：${trimmed.slice(0, 80)}`)
          continue
        }
        entries.push({ src: parts[0]!, dst: parts[1]!, locked: parts[2] === 'locked' })
      }
    }
    const deduped = new Map<string, TermEntry>()
    for (const entry of entries) deduped.set(entry.src.toLowerCase(), entry)
    const result = [...deduped.values()]
    if (result.length === 0) warnings.push(`术语表没有有效条目：${path}`)
    else warnings.push(`已加载术语表 ${result.length} 条：${basename(path)}`)
    return { entries: result, warnings }
  } catch (e) {
    warnings.push(`术语表读取失败（已忽略）：${e instanceof Error ? e.message : String(e)}`)
    return { entries: [], warnings }
  }
}
