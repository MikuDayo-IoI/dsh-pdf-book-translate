import type {
  BookOutline,
  BookState,
  ExtractResult,
  OutlineChapter,
  Paragraph,
  PipelineReport,
  RebuildResult,
  RebuildWarning,
  ResolvedScope,
  TermEntry,
  TranslationStats,
} from './types.js'
import type { BookPaths, BookIdentity } from './book.js'
import { addRange, figureChapter, pageRangeLabel, saveBookState } from './book.js'
import type { PdfWorker } from './worker.js'
import type { TranslationEngine } from './translate/engine.js'
import type { TranslationCache } from './translate/cache.js'
import { fallbackSummary, buildSystemPrompt } from './translate/prompts.js'
import { paragraphSourceText } from './translate/source-text.js'
import { mapWithConcurrency } from './translate/concurrency.js'

export interface OutlinePipelineOptions {
  worker: PdfWorker
  paths: BookPaths
  identity: BookIdentity
  langPair: string
  previous?: BookState
  rescan: boolean
  getEngine: () => TranslationEngine
  signal: AbortSignal
}

export interface OutlinePipelineResult {
  state: BookState
  reused: boolean
  warnings: string[]
}

function normalizeOutline(raw: BookOutline): BookOutline {
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.chapters) || typeof raw.pageCount !== 'number') {
    throw new Error('章节识别结果格式无效')
  }
  const pageCount = raw.pageCount
  const chapters: OutlineChapter[] = raw.chapters.map((chapter, index) => {
    const start = Math.max(0, Math.min(chapter.pageStart, pageCount - 1))
    const end = Math.max(start, Math.min(chapter.pageEnd, pageCount - 1))
    return {
      id: typeof chapter.id === 'string' && chapter.id !== '' ? chapter.id : `ch-${index + 1}`,
      title: typeof chapter.title === 'string' && chapter.title.trim() !== '' ? chapter.title.trim() : `Chapter ${index + 1}`,
      pageStart: start,
      pageEnd: end,
      pageCount: end - start + 1,
      sampleText: typeof chapter.sampleText === 'string' ? chapter.sampleText : '',
      sections: Array.isArray(chapter.sections)
        ? chapter.sections.map((section, sIndex) => ({
            id: typeof section.id === 'string' && section.id !== '' ? section.id : `sec-${index + 1}-${sIndex + 1}`,
            title: section.title,
            pageStart: Math.max(start, Math.min(section.pageStart, end)),
            pageEnd: Math.max(start, Math.min(section.pageEnd, end)),
          }))
        : [],
    }
  })
  if (chapters.length === 0) {
    chapters.push({
      id: 'ch-1',
      title: '全书 / Whole book',
      pageStart: 0,
      pageEnd: Math.max(0, pageCount - 1),
      pageCount,
      sampleText: '',
      sections: [],
    })
  }
  return {
    pageCount,
    source: raw.source ?? 'fallback',
    toc: Array.isArray(raw.toc) ? raw.toc : [],
    chapters,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  }
}

function summaryPagesLabel(chapter: OutlineChapter): string {
  return pageRangeLabel(chapter.pageStart, chapter.pageEnd)
}

/**
 * Detects the book outline and writes zhan_jie.md. Existing summaries are
 * reused by chapter id; missing/fallback summaries are regenerated with the
 * configured engine. Each completed summary is persisted immediately so a
 * crash never loses more than the summary currently in flight.
 */
export async function runOutlinePipeline(options: OutlinePipelineOptions): Promise<OutlinePipelineResult> {
  const { worker, paths, identity, langPair, previous, rescan, getEngine, signal } = options
  const warnings: string[] = []
  const reused = previous !== undefined && !rescan

  let outline: BookOutline
  let state: BookState
  if (reused && previous !== undefined) {
    outline = previous.outline
    state = previous
  } else {
    const raw = await worker.command<BookOutline>('outline', { path: paths.inputPath })
    outline = normalizeOutline(raw)
    warnings.push(...outline.warnings)
    if (previous !== undefined) {
      // A rescan keeps every summary whose chapter still has the same id+title.
      const previousById = new Map(previous.outline.chapters.map(c => [c.id, c]))
      const preserved: Record<string, string> = {}
      for (const chapter of outline.chapters) {
        const old = previousById.get(chapter.id)
        const summary = previous.summaries[chapter.id]
        if (old !== undefined && old.title === chapter.title && summary !== undefined && summary.trim() !== '') {
          preserved[chapter.id] = summary
        }
      }
      state = {
        ...previous,
        outline,
        langPair,
        summaries: preserved,
        summaryFallbacks: previous.summaryFallbacks.filter(id => preserved[id] === undefined),
        book: identity,
        updatedAt: new Date().toISOString(),
      }
    } else {
      state = emptyStateFor(identity, langPair, outline)
    }
  }

  if (state.langPair !== langPair) {
    throw new Error(`该项目已建立 ${state.langPair} 的章节纪要；当前请求是 ${langPair}。请换一个输出目录，或显式恢复原语言对。`)
  }

  await saveBookState(paths, state)

  let engine: TranslationEngine | undefined
  let engineFailure: string | undefined
  const ensureEngine = (): TranslationEngine => {
    if (engine !== undefined) return engine
    if (engineFailure !== undefined) throw new Error(engineFailure)
    try {
      engine = getEngine()
      return engine
    } catch (e) {
      engineFailure = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  const missing = state.outline.chapters.filter(c => (state.summaries[c.id] ?? '').trim() === '')
  let persist = Promise.resolve()
  const persistSoon = (): Promise<void> => {
    persist = persist.then(() => saveBookState(paths, state), () => saveBookState(paths, state))
    return persist
  }

  await mapWithConcurrency(missing, 3, async chapter => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
    try {
      const result = await ensureEngine().summarize({
        chapterTitle: chapter.title,
        pages: summaryPagesLabel(chapter),
        sampleText: chapter.sampleText,
        langPair,
      }, signal)
      const text = result.text.trim()
      if (text === '') throw new Error('模型返回空摘要')
      state.summaries[chapter.id] = text
      state.summaryFallbacks = state.summaryFallbacks.filter(id => id !== chapter.id)
    } catch (e) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
      const detail = e instanceof Error ? e.message : String(e)
      state.summaries[chapter.id] = fallbackSummary(chapter.title, chapter.sampleText)
      if (!state.summaryFallbacks.includes(chapter.id)) state.summaryFallbacks.push(chapter.id)
      warnings.push(`章节 ${chapter.id} “${chapter.title}” 摘要生成失败：${detail}。已写入节选回退。`)
    }
    await persistSoon()
  })
  await persist

  await saveBookState(paths, state)
  return { state, reused, warnings }
}

function emptyStateFor(identity: BookIdentity, langPair: string, outline: BookOutline): BookState {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    book: identity,
    langPair,
    outline,
    summaries: {},
    summaryFallbacks: [],
    translatedPages: [],
    activePages: [],
    ranges: [],
    createdAt: now,
    updatedAt: now,
  }
}

export interface TranslationPipelineOptions {
  worker: PdfWorker
  paths: BookPaths
  state: BookState
  scope: ResolvedScope
  langPair: string
  termbase: TermEntry[]
  engine: TranslationEngine
  cache: TranslationCache
  config: { concurrency: number; maxParagraphs: number; maxChars: number }
  signal: AbortSignal
}

interface PendingParagraph {
  id: number
  page: number
  text: string
  key: string
  paragraph: Paragraph
}

interface TranslationBatchJob {
  chapterId: string
  chapterTitle: string
  systemPrompt: string
  paragraphs: PendingParagraph[]
}

function chunkPending(
  paragraphs: PendingParagraph[],
  maxParagraphs: number,
  maxChars: number,
): PendingParagraph[][] {
  const out: PendingParagraph[][] = []
  let current: PendingParagraph[] = []
  let chars = 0
  const flush = (): void => {
    if (current.length > 0) out.push(current)
    current = []
    chars = 0
  }
  for (const p of paragraphs) {
    if (current.length > 0 && (current.length >= maxParagraphs || chars + p.text.length > maxChars)) flush()
    current.push(p)
    chars += p.text.length
  }
  flush()
  return out
}

/**
 * Translates the requested scope, folds it into the pages already translated,
 * and rebuilds the PDF from the union. Pages/paragraphs whose translation is
 * absent (safety fallback) are left untouched instead of being redacted.
 */
export async function runTranslationPipeline(options: TranslationPipelineOptions): Promise<PipelineReport> {
  const { worker, paths, state, scope, langPair, termbase, engine, cache, config, signal } = options
  const started = Date.now()
  const stats: TranslationStats = {
    apiCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    cacheHits: 0,
    translatedParagraphs: 0,
    failedParagraphs: 0,
    skippedParagraphs: 0,
    totalParagraphs: 0,
    cacheHitRate: 0,
    engine: engine.id,
  }
  const failures: { id: number; page: number; reason: string }[] = []
  const translations = new Map<number, string>()
  const pending: PendingParagraph[] = []
  const previousPages = new Set(state.translatedPages)
  const previousActivePages = new Set(state.activePages ?? [])
  // Claim the new range before any request. If the process dies mid-run, a later
  // run for a different range still re-extracts these pages and recovers the
  // paragraphs that already reached the journal cache.
  const activePages = new Set(previousActivePages)
  for (const page of scope.pages) {
    if (!previousPages.has(page)) activePages.add(page)
  }
  state.activePages = [...activePages].sort((a, b) => a - b)
  const unionPages = [...new Set([...state.translatedPages, ...state.activePages, ...scope.pages])]
    .sort((a, b) => a - b)
  if (unionPages.length === 0) throw new Error('没有可翻译的页面')
  await saveBookState(paths, state)

  await cache.load()
  const extracted = await worker.command<ExtractResult>('extract', {
    path: paths.inputPath,
    pages: unionPages,
  })
  if (!Array.isArray(extracted.pages)) throw new Error('worker extract 返回格式无效')

  for (const page of extracted.pages) {
    for (const paragraph of page.paragraphs) {
      stats.totalParagraphs += 1
      const text = paragraphSourceText(paragraph)
      if (paragraph.type === 'code' || text.trim() === '') {
        stats.skippedParagraphs += 1
        continue
      }
      const key = cache.key(text, langPair)
      const hit = cache.get(key)
      if (hit !== undefined) {
        stats.cacheHits += 1
        translations.set(paragraph.id, hit)
        continue
      }
      pending.push({ id: paragraph.id, page: page.index, text, key, paragraph })
    }
  }

  const byChapter = new Map<string, { chapter: OutlineChapter | undefined; items: PendingParagraph[] }>()
  for (const item of pending) {
    const chapter = figureChapter(state.outline, item.page)
    const key = chapter?.id ?? 'unknown'
    const entry = byChapter.get(key) ?? { chapter, items: [] }
    entry.items.push(item)
    byChapter.set(key, entry)
  }

  const jobs: TranslationBatchJob[] = []
  for (const entry of byChapter.values()) {
    const chapterContext = entry.chapter !== undefined ? state.summaries[entry.chapter.id] : undefined
    const systemPrompt = buildSystemPrompt({ langPair, termbase, chapterContext })
    for (const items of chunkPending(entry.items, config.maxParagraphs, config.maxChars)) {
      jobs.push({
        chapterId: entry.chapter?.id ?? 'unknown',
        chapterTitle: entry.chapter?.title ?? '未知章节',
        systemPrompt,
        paragraphs: items,
      })
    }
  }

  try {
    await mapWithConcurrency(jobs, Math.max(1, config.concurrency), async job => {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
      try {
        const result = await engine.translateBatch({
          paragraphs: job.paragraphs.map(p => ({ id: p.id, text: p.text })),
          systemPrompt: job.systemPrompt,
        }, signal)
        stats.apiCalls += 1
        stats.tokensIn += result.usage.promptTokens
        stats.tokensOut += result.usage.completionTokens
        for (const p of job.paragraphs) {
          const translated = result.translations.get(p.id)
          if (translated === undefined) throw new Error(`missing translation for paragraph ${p.id}`)
          await cache.put(p.key, translated)
          translations.set(p.id, translated)
          stats.translatedParagraphs += 1
        }
      } catch (e) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
        const reason = e instanceof Error ? e.message : String(e)
        for (const p of job.paragraphs) {
          stats.failedParagraphs += 1
          failures.push({ id: p.id, page: p.page + 1, reason })
          // No cache write: a retry must be able to fill this paragraph.
        }
      }
      await cache.save()
    })
  } finally {
    await cache.save()
  }

  stats.cacheHitRate = stats.cacheHits + stats.translatedParagraphs > 0
    ? stats.cacheHits / (stats.cacheHits + stats.translatedParagraphs)
    : 0

  const rebuildPages = extracted.pages.map(page => {
    const items: { id: number; text: string }[] = []
    for (const paragraph of page.paragraphs) {
      const translated = translations.get(paragraph.id)
      const original = paragraphSourceText(paragraph)
      if (translated === undefined || translated.trim() === '' || translated === original) continue
      items.push({ id: paragraph.id, text: translated })
    }
    return { index: page.index, paragraphs: items }
  }).filter(page => page.paragraphs.length > 0)

  const rebuild = await worker.command<RebuildResult>('rebuild', {
    inputPath: paths.inputPath,
    outputPath: paths.translatedPath,
    pages: rebuildPages,
  })
  const warnings: RebuildWarning[] = Array.isArray(rebuild.warnings) ? rebuild.warnings : []

  const failedIds = new Set(failures.map(failure => failure.id))
  const isComplete = (page: number): boolean => {
    const extractedPage = extracted.pages.find(p => p.index === page)
    if (extractedPage === undefined) return false
    return extractedPage.paragraphs.every(paragraph => !failedIds.has(paragraph.id))
  }
  const completedScopePages = scope.pages.filter(isComplete)
  // A page claimed by an interrupted earlier run is re-extracted here too. Once
  // every paragraph on it is translated (normally from the journal cache), mark
  // it complete instead of leaving it "in progress" forever.
  const recoveredPages = [...previousActivePages]
    .filter(page => !scope.pages.includes(page) && isComplete(page))
  // A page that failed in this run must stay resumable even if an earlier run
  // had marked it complete: otherwise a later scope would never retry it.
  const failedPageNumbers = new Set(failures.map(failure => failure.page - 1))
  const translatedPagesUnion = [...new Set([...state.translatedPages, ...completedScopePages, ...recoveredPages])]
    .filter(page => !failedPageNumbers.has(page))
    .sort((a, b) => a - b)
  const finished = new Set(translatedPagesUnion)
  state.activePages = [...new Set([...activePages, ...scope.pages])]
    .filter(page => !finished.has(page))
    .sort((a, b) => a - b)
  stats.durationMs = Date.now() - started
  state.lastStats = stats
  if (completedScopePages.length > 0) addRange(state, scope, completedScopePages, stats)
  state.translatedPages = translatedPagesUnion
  await saveBookState(paths, state)

  return {
    translatedPath: paths.translatedPath,
    pagesRequested: scope.pages.length,
    pagesCompleted: completedScopePages.length,
    pagesInOutput: translatedPagesUnion.length,
    paragraphsTotal: stats.totalParagraphs,
    paragraphsTranslated: stats.translatedParagraphs,
    paragraphsCached: stats.cacheHits,
    paragraphsFailed: stats.failedParagraphs,
    paragraphsSkipped: stats.skippedParagraphs,
    cacheHitRate: stats.cacheHitRate,
    stats,
    failures,
    warnings,
    translatedPages: translatedPagesUnion,
    completedPages: completedScopePages,
    scope,
    previousPages: previousPages.size,
  }
}
