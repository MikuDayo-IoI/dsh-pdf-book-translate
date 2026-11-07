import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type {
  BookOutline,
  BookState,
  OutlineChapter,
  ResolvedScope,
  TranslationRange,
  TranslationStats,
} from './types.js'

export interface BookPaths {
  inputPath: string
  outputDir: string
  baseName: string
  targetLang: string
  statePath: string
  zhanJiePath: string
  cachePath: string
  cacheJournalPath: string
  translatedPath: string
  comparisonPath: string
  lockPath: string
}

export interface BookIdentity {
  name: string
  path: string
  pageCount: number
  bytes: number
  modifiedMs: number
}

export function targetLanguage(langPair: string): string {
  const parts = langPair.split(/→|->|=>/)
  const target = (parts[1] ?? langPair).trim()
  return target.replace(/[^A-Za-z0-9_-]+/g, '') || 'out'
}

export function resolvePaths(inputPath: string, outputDir: string | undefined, langPair: string): BookPaths {
  const baseName = basename(inputPath, extname(inputPath)) || 'book'
  const dir = outputDir !== undefined && outputDir.trim() !== ''
    ? outputDir
    : join(dirname(inputPath), `${baseName}-translation`)
  const targetLang = targetLanguage(langPair)
  const cachePath = join(dir, '.translate-cache.json')
  return {
    inputPath,
    outputDir: dir,
    baseName,
    targetLang,
    statePath: join(dir, '.pdf-book-state.json'),
    zhanJiePath: join(dir, 'zhan_jie.md'),
    cachePath,
    cacheJournalPath: `${cachePath}l`,
    translatedPath: join(dir, `${baseName}.${targetLang}.pdf`),
    comparisonPath: join(dir, `${baseName}.${targetLang}.compare.pdf`),
    lockPath: join(dir, '.translate.lock'),
  }
}

export async function bookIdentity(inputPath: string, pageCount: number): Promise<BookIdentity> {
  const info = await stat(inputPath)
  return {
    name: basename(inputPath),
    path: inputPath,
    pageCount,
    bytes: info.size,
    modifiedMs: Math.round(info.mtimeMs),
  }
}

export function emptyState(identity: BookIdentity, langPair: string, outline: BookOutline): BookState {
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

function isState(value: unknown): value is BookState {
  if (value === null || typeof value !== 'object') return false
  const state = value as Partial<BookState>
  return state.schemaVersion === 1
    && typeof state.langPair === 'string'
    && typeof state.book === 'object'
    && state.book !== null
    && typeof state.book.name === 'string'
    && typeof state.book.pageCount === 'number'
    && typeof state.outline === 'object'
    && state.outline !== null
    && Array.isArray(state.outline.chapters)
    && typeof state.summaries === 'object'
    && state.summaries !== null
    && Array.isArray(state.translatedPages)
}

function normalizeState(state: BookState): BookState {
  const translatedPages = [...new Set(state.translatedPages.filter(p => Number.isInteger(p) && p >= 0))].sort((a, b) => a - b)
  const translated = new Set(translatedPages)
  const activePages = [...new Set(
    (Array.isArray(state.activePages) ? state.activePages : [])
      .filter(p => Number.isInteger(p) && p >= 0 && !translated.has(p)),
  )].sort((a, b) => a - b)
  return {
    ...state,
    summaries: Object.fromEntries(
      Object.entries(state.summaries ?? {}).filter(([, value]) => typeof value === 'string'),
    ),
    summaryFallbacks: Array.isArray(state.summaryFallbacks) ? state.summaryFallbacks : [],
    translatedPages,
    activePages,
    ranges: Array.isArray(state.ranges) ? state.ranges : [],
  }
}

async function readJsonState(path: string): Promise<BookState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isState(parsed) ? normalizeState(parsed) : undefined
  } catch {
    return undefined
  }
}

export function parseMarkdownState(markdown: string): BookState | undefined {
  const match = /<!--\s*DSH_BOOK_STATE_B64:([A-Za-z0-9+/=]+)\s*-->/.exec(markdown)
  if (match === null) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8')) as unknown
    return isState(parsed) ? normalizeState(parsed) : undefined
  } catch {
    return undefined
  }
}

async function readMarkdownState(path: string): Promise<BookState | undefined> {
  try {
    return parseMarkdownState(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

function mergeStates(a: BookState, b: BookState): BookState {
  const newer = Date.parse(a.updatedAt) >= Date.parse(b.updatedAt) ? a : b
  const older = newer === a ? b : a
  const summaries: Record<string, string> = { ...older.summaries, ...newer.summaries }
  const fallback = new Set([...older.summaryFallbacks, ...newer.summaryFallbacks])
  for (const [id, text] of Object.entries(summaries)) {
    if (text.trim() !== '' && !fallback.has(id)) fallback.delete(id)
  }
  const ranges: TranslationRange[] = [...older.ranges, ...newer.ranges]
  const seen = new Set<string>()
  const translatedPages = [...new Set([...older.translatedPages, ...newer.translatedPages])].sort((x, y) => x - y)
  const translated = new Set(translatedPages)
  const activePages = [...new Set([...(older.activePages ?? []), ...(newer.activePages ?? [])])]
    .filter(page => !translated.has(page))
    .sort((x, y) => x - y)
  return normalizeState({
    ...newer,
    summaries,
    summaryFallbacks: [...fallback].filter(id => summaries[id] === undefined || summaries[id]!.trim() === ''),
    translatedPages,
    activePages,
    ranges: ranges.filter(r => {
      const key = `${r.requestedAt}|${r.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    createdAt: older.createdAt,
    updatedAt: new Date().toISOString(),
  })
}

/**
 * Restores the book state from the machine file and/or zhan_jie.md.
 * zhan_jie.md is an equal source of truth: if the JSON state is lost, the
 * base64 snapshot embedded in the Markdown resumes translated ranges.
 */
export async function loadBookState(paths: BookPaths, identity: BookIdentity): Promise<BookState | undefined> {
  const [jsonState, mdState] = await Promise.all([
    readJsonState(paths.statePath),
    readMarkdownState(paths.zhanJiePath),
  ])
  const candidates = [jsonState, mdState].filter((s): s is BookState => s !== undefined)
    .filter(s => s.book.name === identity.name && s.book.pageCount === identity.pageCount)
  if (candidates.length === 0) return undefined
  let merged = candidates[0]!
  for (const state of candidates.slice(1)) merged = mergeStates(merged, state)
  // A moved/renamed input keeps its relative identity, but state must point at
  // the current absolute path so later runs do not open a stale file.
  merged = { ...merged, book: identity, updatedAt: new Date().toISOString() }
  return merged
}

function atomicWrite(path: string, data: string): Promise<void> {
  return (async () => {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, data, 'utf8')
    await rename(temp, path)
  })()
}

export function pageRangeLabel(start: number, end: number): string {
  return start === end ? String(start + 1) : `${start + 1}–${end + 1}`
}

export function pageSpecLabel(pages: readonly number[]): string {
  return intervalStrings(pages).join(',')
}

export function intervalStrings(pages: readonly number[]): string[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const out: string[] = []
  let start: number | undefined
  let prev: number | undefined
  for (const page of sorted) {
    if (start === undefined) {
      start = page
      prev = page
      continue
    }
    if (page === prev! + 1) {
      prev = page
      continue
    }
    out.push(pageRangeLabel(start, prev!))
    start = page
    prev = page
  }
  if (start !== undefined) out.push(pageRangeLabel(start, prev!))
  return out
}

export function renderZhanJie(state: BookState): string {
  const pad = (n: number): string => String(n).padStart(4, '0')
  const lines: string[] = [
    '# zhan_jie.md · 章节纪要',
    '',
    '> 本文件由 PDF 书籍翻译插件生成：既供译者/AI 了解全书结构，也内嵌一份机器可读的断点状态。',
    '> 删除本文件会丢失章节纪要；翻译缓存仍在 `.translate-cache.json`。',
    '',
    `- 书籍：${state.book.name}`,
    `- PDF 页数：${state.book.pageCount}`,
    `- 语言对：${state.langPair}`,
    `- 已翻译页：${state.translatedPages.length > 0 ? intervalStrings(state.translatedPages).join(', ') : '（尚无）'}`,
    ...(state.activePages.length > 0
      ? [`- 进行中页：${intervalStrings(state.activePages).join(', ')}（中断后重跑会自动补全）`]
      : []),
    `- 更新时间：${state.updatedAt}`,
    '',
  ]
  for (const chapter of state.outline.chapters) {
    lines.push(`## ${chapter.id} · ${chapter.title}`, '')
    lines.push(`- PDF 页码：${pageRangeLabel(chapter.pageStart, chapter.pageEnd)}（共 ${chapter.pageCount} 页）`)
    if (chapter.sections.length > 0) {
      lines.push(`- 节：${chapter.sections.map(s => `${s.title}（${pageRangeLabel(s.pageStart, s.pageEnd)}）`).join('；')}`)
    }
    lines.push('', '### 内容摘要', '')
    const summary = state.summaries[chapter.id]?.trim()
    lines.push(summary !== undefined && summary !== '' ? summary : '（待生成）', '')
  }
  const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64')
  lines.push('<!-- DSH_BOOK_STATE_B64:' + encoded + ' -->', '')
  return lines.join('\n')
}

export async function saveBookState(paths: BookPaths, state: BookState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  // Markdown first: if the process dies before JSON, the Markdown snapshot is
  // still a complete resume point.
  await atomicWrite(paths.zhanJiePath, renderZhanJie(state))
  await atomicWrite(paths.statePath, JSON.stringify(state, null, 2))
}

export function figureChapter(outline: BookOutline, page: number): OutlineChapter | undefined {
  return outline.chapters.find(c => page >= c.pageStart && page <= c.pageEnd)
}

export function parsePageSpec(spec: string, pageCount: number): number[] {
  const text = spec.trim().replace(/[，、;；]/g, ',')
  if (text === '') throw new Error('页码范围为空。示例：1-20,35,40-45')
  const pages = new Set<number>()
  for (const raw of text.split(',')) {
    const token = raw.trim().replace(/^p(?:age)?\s*/i, '')
    if (token === '') continue
    const range = /^(\d+)\s*(?:-|–|—|~|至|到)\s*(\d+)$/.exec(token)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < 1 || start > end) {
        throw new Error(`无效页码范围：${token}（页码从 1 开始，且起点不能大于终点）`)
      }
      if (end > pageCount) throw new Error(`页码 ${end} 超出 PDF 范围（共 ${pageCount} 页）`)
      for (let p = start; p <= end; p += 1) pages.add(p - 1)
      continue
    }
    if (!/^\d+$/.test(token)) throw new Error(`无法识别的页码范围：${token}`)
    const page = Number(token)
    if (page < 1 || page > pageCount) throw new Error(`页码 ${page} 超出 PDF 范围（共 ${pageCount} 页）`)
    pages.add(page - 1)
  }
  if (pages.size === 0) throw new Error('页码范围为空。示例：1-20,35,40-45')
  return [...pages].sort((a, b) => a - b)
}

export interface ScopeArgs {
  pages?: string
  chapters?: string[]
  sections?: string[]
  all?: boolean
}

export function resolveScope(outline: BookOutline, args: ScopeArgs): ResolvedScope | undefined {
  const collected = new Set<number>()
  const labels: string[] = []
  let source: ResolvedScope['source'] | undefined

  if (args.all === true) {
    for (let p = 0; p < outline.pageCount; p += 1) collected.add(p)
    labels.push('全书')
    source = 'all'
  }
  if (args.pages !== undefined && args.pages.trim() !== '') {
    for (const page of parsePageSpec(args.pages, outline.pageCount)) collected.add(page)
    labels.push(`页 ${args.pages.trim()}`)
    source = source ?? 'pages'
  }
  if (args.chapters !== undefined && args.chapters.length > 0) {
    for (const raw of args.chapters) {
      const key = raw.trim()
      const chapter = outline.chapters.find(c => c.id === key)
        ?? outline.chapters.find(c => c.title.toLowerCase() === key.toLowerCase())
      if (chapter === undefined) {
        throw new Error(`未找到章节 “${raw}”。可用章节：${outline.chapters.map(c => `${c.id}=${c.title}`).join('；')}`)
      }
      for (let p = chapter.pageStart; p <= chapter.pageEnd; p += 1) collected.add(p)
      labels.push(`${chapter.id}（${pageRangeLabel(chapter.pageStart, chapter.pageEnd)}）`)
    }
    source = source ?? 'chapters'
  }
  if (args.sections !== undefined && args.sections.length > 0) {
    for (const raw of args.sections) {
      const key = raw.trim()
      let found: { chapter: OutlineChapter; section: OutlineChapter['sections'][number] } | undefined
      for (const chapter of outline.chapters) {
        const section = chapter.sections.find(s => s.id === key)
          ?? chapter.sections.find(s => s.title.toLowerCase() === key.toLowerCase())
        if (section !== undefined) {
          found = { chapter, section }
          break
        }
      }
      if (found === undefined) {
        const all = outline.chapters.flatMap(c => c.sections.map(s => `${s.id}=${s.title}`))
        throw new Error(`未找到节 “${raw}”。可用节：${all.length > 0 ? all.join('；') : '（本书未识别出节）'}`)
      }
      for (let p = found.section.pageStart; p <= found.section.pageEnd; p += 1) collected.add(p)
      labels.push(`${found.section.id}（${pageRangeLabel(found.section.pageStart, found.section.pageEnd)}）`)
    }
    source = source ?? 'sections'
  }
  if (collected.size === 0) return undefined
  return {
    pages: [...collected].sort((a, b) => a - b),
    label: labels.join(' + '),
    source: source!,
  }
}

export function availableChapters(outline: BookOutline): { id: string; title: string; pages: string }[] {
  return outline.chapters.map(c => ({
    id: c.id,
    title: c.title,
    pages: intervalStrings(pagesOfChapter(c)).join(','),
  }))
}

export function pagesOfChapter(chapter: OutlineChapter): number[] {
  const pages: number[] = []
  for (let p = chapter.pageStart; p <= chapter.pageEnd; p += 1) pages.push(p)
  return pages
}

export function addRange(state: BookState, scope: ResolvedScope, completedPages: number[], stats: TranslationStats): void {
  const now = new Date().toISOString()
  const pages = [...new Set(completedPages)].sort((a, b) => a - b)
  const record: TranslationRange = {
    pages: scope.pages,
    label: scope.label,
    requestedAt: now,
    completedAt: now,
    completedPages: pages,
  }
  // Re-running the same scope should update its record, not list it twice.
  const existing = state.ranges.findIndex((range) => {
    const prior = [...new Set(range.completedPages)].sort((a, b) => a - b)
    return prior.length === pages.length && prior.every((page, index) => page === pages[index])
  })
  if (existing >= 0) state.ranges[existing] = record
  else state.ranges.push(record)
  state.lastStats = stats
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

export interface BookLock {
  release(): Promise<void>
}

interface LockRecord {
  pid: number
  purpose: string
  startedAt: string
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * One writer per book project. A crashed process leaves its PID in the lock
 * file; the next run proves the PID is dead and takes the lock over.
 */
export async function acquireBookLock(lockPath: string, purpose: string): Promise<BookLock> {
  await mkdir(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx')
      const record: LockRecord = { pid: process.pid, purpose, startedAt: new Date().toISOString() }
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.close()
      return {
        async release(): Promise<void> {
          try {
            const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord
            if (current.pid === process.pid) await unlink(lockPath)
          } catch {
            // Already gone or unreadable: nothing useful to release.
          }
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let record: Partial<LockRecord> = {}
      let ageMs = 0
      try {
        record = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockRecord>
        ageMs = Date.now() - (await stat(lockPath)).mtimeMs
      } catch {
        // Torn/empty lock file: treat as stale after a short grace period.
      }
      const pid = typeof record.pid === 'number' ? record.pid : -1
      if (processAlive(pid)) {
        throw new Error(`项目正在被另一个翻译任务使用（PID ${pid}，${record.purpose ?? 'unknown'}）。请等待该任务结束或关闭它后重试。`)
      }
      if (ageMs < 10_000 && pid === -1) {
        throw new Error('项目锁文件正在创建中，请稍后重试。')
      }
      await unlink(lockPath).catch(() => undefined)
    }
  }
  throw new Error('无法获取项目锁，请检查输出目录权限。')
}
