export type TextAlignment = 'left' | 'center' | 'right' | 'justify'

export interface Span {
  text: string
  bbox: [number, number, number, number]
  font: string
  size: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  origin: [number, number]
  mono: boolean
}

export interface Line {
  text: string
  bbox: [number, number, number, number]
  origin: [number, number]
  spans: Span[]
}

export type ParagraphType = 'body' | 'heading' | 'list-item' | 'code' | 'table-cell'

export interface Paragraph {
  id: number
  bbox: [number, number, number, number]
  firstLineAnchor: [number, number]
  lines: Line[]
  type: ParagraphType
  readingOrder: number
  confidence: number
  table: { row: number; col: number } | null
  alignment: TextAlignment
}

export interface TextLayerInfo {
  pageCount: number
  hasTextLayer: boolean
  pages: { index: number; charCount: number }[]
}

export interface ExtractResult {
  pages: { index: number; paragraphs: Paragraph[] }[]
}

export interface RebuildWarning {
  page: number
  paraId: number
  kind: 'overflow' | 'font-fallback' | 'empty'
  detail: string
}

export interface RebuildResult {
  warnings: RebuildWarning[]
}

export interface OutlineSection {
  id: string
  title: string
  pageStart: number
  pageEnd: number
}

export interface OutlineChapter {
  id: string
  title: string
  pageStart: number
  pageEnd: number
  sections: OutlineSection[]
  sampleText: string
  pageCount: number
}

export type OutlineSource = 'toc' | 'heuristic' | 'fallback'

export interface BookOutline {
  pageCount: number
  source: OutlineSource
  toc: { level: number; title: string; page: number }[]
  chapters: OutlineChapter[]
  warnings: string[]
}

export interface TermEntry {
  src: string
  dst: string
  locked: boolean
}

export interface TranslationRange {
  /** 0-based pages explicitly requested in this run. */
  pages: number[]
  /** 1-based human-readable scope, e.g. "1-20,35". */
  label: string
  requestedAt: string
  completedAt: string
  /** 0-based pages actually completed in this range. */
  completedPages: number[]
}

export interface TranslationStats {
  apiCalls: number
  tokensIn: number
  tokensOut: number
  durationMs: number
  cacheHits: number
  translatedParagraphs: number
  failedParagraphs: number
  skippedParagraphs: number
  totalParagraphs: number
  cacheHitRate: number
  engine: string
}

export interface BookState {
  schemaVersion: 1
  book: {
    name: string
    path: string
    pageCount: number
    bytes: number
    modifiedMs: number
  }
  langPair: string
  outline: BookOutline
  /** chapter id → summary text. */
  summaries: Record<string, string>
  summaryFallbacks: string[]
  /** Sorted 0-based pages whose translation was rebuilt successfully. */
  translatedPages: number[]
  /**
   * Sorted 0-based pages claimed by an unfinished run. They are persisted before
   * translation starts so a later range still re-extracts and rebuilds the
   * paragraph translations already present in the cache.
   */
  activePages: number[]
  ranges: TranslationRange[]
  lastStats?: TranslationStats
  createdAt: string
  updatedAt: string
}

export interface ResolvedScope {
  pages: number[]
  label: string
  source: 'pages' | 'chapters' | 'sections' | 'all' | 'resume'
}

export interface TranslationReport {
  status: 'translated' | 'scope_required'
  inputPath: string
  outputDir: string
  zhanJiePath: string
  statePath: string
  translatedPath?: string
  comparisonPath?: string
  pagesRequested: number
  pagesCompleted: number
  pagesInOutput: number
  paragraphsTotal: number
  paragraphsTranslated: number
  paragraphsCached: number
  paragraphsFailed: number
  paragraphsSkipped: number
  cacheHitRate: number
  apiCalls: number
  tokensIn: number
  tokensOut: number
  durationMs: number
  engine: string
  mergedRanges: number
  previousTranslatedPages: number
  totalTranslatedPages: number
  failures: { id: number; page: number; reason: string }[]
  warnings: RebuildWarning[]
  outline: BookOutline
  summaries: Record<string, string>
  scope?: ResolvedScope
  availableChapters?: { id: string; title: string; pages: string }[]
  message: string
}

export interface OutlineReport {
  status: 'outlined'
  inputPath: string
  outputDir: string
  zhanJiePath: string
  statePath: string
  pageCount: number
  source: OutlineSource
  chapters: {
    id: string
    title: string
    pages: string
    sections: { id: string; title: string; pages: string }[]
    summary: string
  }[]
  reused: boolean
  summaryFallbacks: string[]
  warnings: string[]
  message: string
}

export interface StatusReport {
  status: 'not_initialized' | 'ready'
  inputPath: string
  outputDir: string
  zhanJiePath: string
  statePath: string
  cachePath: string
  translatedPath?: string
  comparisonPath?: string
  pageCount?: number
  langPair?: string
  chapters?: { id: string; title: string; pages: string; summary: string }[]
  translatedPages?: number
  inProgressPages?: number
  inProgressIntervals?: string[]
  translatedRanges?: string[]
  mergedIntervals?: string[]
  cacheEntries?: number
  lastStats?: TranslationStats
  outputsExist?: { translated: boolean; comparison: boolean }
  message: string
}

export interface PipelineReport {
  translatedPath: string
  pagesRequested: number
  pagesCompleted: number
  pagesInOutput: number
  paragraphsTotal: number
  paragraphsTranslated: number
  paragraphsCached: number
  paragraphsFailed: number
  paragraphsSkipped: number
  cacheHitRate: number
  stats: TranslationStats
  failures: { id: number; page: number; reason: string }[]
  warnings: RebuildWarning[]
  translatedPages: number[]
  completedPages: number[]
  previousPages: number
  scope: ResolvedScope
}
