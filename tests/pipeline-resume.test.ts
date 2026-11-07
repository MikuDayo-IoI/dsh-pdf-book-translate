import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaths } from '../src/book.js'
import type { BookOutline, BookState } from '../src/types.js'
import type { PdfWorker } from '../src/worker.js'
import type { TranslationEngine } from '../src/translate/engine.js'
import { TranslationCache } from '../src/translate/cache.js'
import { runTranslationPipeline } from '../src/pipeline.js'

function outline(pageCount: number): BookOutline {
  return {
    pageCount,
    source: 'fallback',
    toc: [],
    warnings: [],
    chapters: [{
      id: 'ch-1',
      title: 'Whole book',
      pageStart: 0,
      pageEnd: pageCount - 1,
      pageCount,
      sampleText: 'sample',
      sections: [],
    }],
  }
}

function paragraph(id: number, text: string) {
  return {
    id,
    bbox: [20, 20, 400, 40],
    firstLineAnchor: 'left',
    type: 'body' as const,
    readingOrder: 0,
    confidence: 1,
    lines: [{
      text,
      bbox: [20, 20, 400, 40],
      origin: [20, 30],
      spans: [{
        text,
        bbox: [20, 20, 400, 40],
        font: 'helv',
        size: 11,
        color: '#000000',
        bold: false,
        italic: false,
        underline: false,
        origin: [20, 30],
        mono: false,
      }],
    }],
  }
}

describe('翻译断点恢复', () => {
  it('旧 active 页在本次缓存补全后会被标记为已完成', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdf-book-resume-'))
    try {
      const inputPath = join(dir, 'book.pdf')
      const paths = resolvePaths(inputPath, join(dir, 'out'), 'en→zh')
      const cache = new TranslationCache(paths.cachePath)
      await cache.put(cache.key('alpha', 'en→zh'), '译文一')
      await cache.put(cache.key('beta', 'en→zh'), '译文二')
      await cache.save()

      const state: BookState = {
        schemaVersion: 1,
        book: { name: 'book.pdf', path: inputPath, pageCount: 3, bytes: 1, modifiedMs: 1 },
        langPair: 'en→zh',
        outline: outline(3),
        summaries: { 'ch-1': 'summary' },
        summaryFallbacks: [],
        translatedPages: [],
        activePages: [0, 1],
        ranges: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const extracted = {
        pages: [
          { index: 0, paragraphs: [paragraph(0, 'alpha')] },
          { index: 1, paragraphs: [paragraph(1_000_000, 'beta')] },
          { index: 2, paragraphs: [paragraph(2_000_000, 'gamma')] },
        ],
      }
      const rebuildCalls: { pages: { index: number; paragraphs: { id: number; text: string }[] }[] }[] = []
      const worker = {
        async command(command: string, payload: { pages?: unknown }) {
          if (command === 'extract') return extracted
          if (command === 'rebuild') {
            rebuildCalls.push(payload as never)
            return { warnings: [] }
          }
          throw new Error(`unexpected command ${command}`)
        },
      } as unknown as PdfWorker

      const engine: TranslationEngine = {
        id: 'stub',
        async translateBatch() {
          return {
            translations: new Map([[2_000_000, '译文三']]),
            usage: { promptTokens: 10, completionTokens: 5 },
          }
        },
        async summarize() {
          return { text: 'summary', usage: { promptTokens: 1, completionTokens: 1 } }
        },
      }

      const report = await runTranslationPipeline({
        worker,
        paths,
        state,
        scope: { pages: [2], label: '页 3', source: 'pages' },
        langPair: 'en→zh',
        termbase: [],
        engine,
        cache,
        config: { concurrency: 2, maxParagraphs: 8, maxChars: 3000 },
        signal: new AbortController().signal,
      })

      expect(report.pagesCompleted).toBe(1)
      expect(report.translatedPages).toEqual([0, 1, 2])
      expect(state.translatedPages).toEqual([0, 1, 2])
      expect(state.activePages).toEqual([])
      expect(state.ranges.map(range => range.completedPages)).toEqual([[2]])
      expect(report.paragraphsCached).toBe(2)
      expect(report.paragraphsTranslated).toBe(1)
      expect(rebuildCalls[0]?.pages.map(page => page.index)).toEqual([0, 1, 2])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
