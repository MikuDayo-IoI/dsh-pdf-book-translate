import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireBookLock,
  addRange,
  loadBookState,
  parsePageSpec,
  resolvePaths,
  resolveScope,
  saveBookState,
} from '../src/book.js'
import type { BookIdentity, BookOutline, BookState, TranslationStats } from '../src/types.js'
import { TranslationCache } from '../src/translate/cache.js'

function outline(): BookOutline {
  return {
    pageCount: 10,
    source: 'heuristic',
    toc: [],
    warnings: [],
    chapters: [
      {
        id: 'ch-1',
        title: 'Chapter One',
        pageStart: 0,
        pageEnd: 4,
        pageCount: 5,
        sampleText: 'one',
        sections: [
          { id: 'sec-1-1', title: 'Opening', pageStart: 0, pageEnd: 1 },
          { id: 'sec-1-2', title: 'Middle', pageStart: 2, pageEnd: 4 },
        ],
      },
      {
        id: 'ch-2',
        title: 'Chapter Two',
        pageStart: 5,
        pageEnd: 9,
        pageCount: 5,
        sampleText: 'two',
        sections: [],
      },
    ],
  }
}

function state(identity: BookIdentity): BookState {
  return {
    schemaVersion: 1,
    book: identity,
    langPair: 'en→zh',
    outline: outline(),
    summaries: { 'ch-1': '第一章纪要', 'ch-2': '第二章纪要' },
    summaryFallbacks: [],
    translatedPages: [0, 1],
    activePages: [],
    ranges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('PDF 书籍范围与断点', () => {
  it('解析 1-based 页码范围并拒绝越界', () => {
    expect(parsePageSpec('1-3, 5，7', 8)).toEqual([0, 1, 2, 4, 6])
    expect(parsePageSpec('p2', 3)).toEqual([1])
    expect(() => parsePageSpec('0', 3)).toThrow()
    expect(() => parsePageSpec('2-9', 8)).toThrow()
    expect(() => parsePageSpec('5-2', 8)).toThrow()
  })

  it('按章、节解析范围并合并页码', () => {
    const book = outline()
    const byChapter = resolveScope(book, { chapters: ['ch-1'] })
    expect(byChapter?.pages).toEqual([0, 1, 2, 3, 4])
    const bySection = resolveScope(book, { sections: ['sec-1-2'] })
    expect(bySection?.pages).toEqual([2, 3, 4])
    const merged = resolveScope(book, { pages: '9', chapters: ['ch-1'] })
    expect(merged?.pages).toEqual([0, 1, 2, 3, 4, 8])
    expect(resolveScope(book, {})).toBeUndefined()
  })

  it('重复执行同一范围只更新记录，不重复累加', () => {
    const identity: BookIdentity = {
      name: 'book.pdf',
      path: '/book.pdf',
      pageCount: 10,
      bytes: 100,
      modifiedMs: 1,
    }
    const book = state(identity)
    const stats: TranslationStats = {
      apiCalls: 1,
      tokensIn: 10,
      tokensOut: 20,
      durationMs: 1,
      cacheHits: 0,
      translatedParagraphs: 1,
      failedParagraphs: 0,
      skippedParagraphs: 0,
      totalParagraphs: 1,
      cacheHitRate: 0,
      engine: 'test',
    }
    const first = resolveScope(book.outline, { pages: '1-2' })!
    const third = resolveScope(book.outline, { pages: '3' })!
    addRange(book, first, first.pages, stats)
    addRange(book, first, first.pages, stats)
    addRange(book, third, third.pages, stats)
    expect(book.ranges).toHaveLength(2)
    expect(book.ranges.map((range) => range.label)).toEqual(['页 1-2', '页 3'])
  })

  it('zhan_jie.md 单独即可恢复章节纪要与已翻译页', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdfbook-'))
    try {
      const paths = resolvePaths(join(dir, 'book.pdf'), dir, 'en→zh')
      const identity: BookIdentity = {
        name: 'book.pdf',
        path: join(dir, 'book.pdf'),
        pageCount: 10,
        bytes: 100,
        modifiedMs: 1,
      }
      await saveBookState(paths, state(identity))
      await unlink(paths.statePath)
      const restored = await loadBookState(paths, identity)
      expect(restored?.summaries['ch-1']).toBe('第一章纪要')
      expect(restored?.translatedPages).toEqual([0, 1])
      expect(restored?.outline.chapters[0]?.sections).toHaveLength(2)
      expect(await readFile(paths.zhanJiePath, 'utf8')).toContain('DSH_BOOK_STATE_B64')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('未完成范围会随 zhan_jie.md 持久化，供后续任意范围续跑', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdfbook-active-'))
    try {
      const paths = resolvePaths(join(dir, 'book.pdf'), dir, 'en→zh')
      const identity: BookIdentity = {
        name: 'book.pdf',
        path: join(dir, 'book.pdf'),
        pageCount: 10,
        bytes: 100,
        modifiedMs: 1,
      }
      const pending = state(identity)
      pending.activePages = [3, 4]
      await saveBookState(paths, pending)
      await unlink(paths.statePath)
      const restored = await loadBookState(paths, identity)
      expect(restored?.activePages).toEqual([3, 4])
      expect(await readFile(paths.zhanJiePath, 'utf8')).toContain('进行中页')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('journal 在进程被强杀后仍能恢复最后完成的段落', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdfcache-'))
    try {
      const cachePath = join(dir, '.translate-cache.json')
      const cache = new TranslationCache(cachePath)
      const key = cache.key('last paragraph', 'en→zh')
      await cache.put(key, '最后一段')
      // Deliberately no save(): the journal alone must survive.
      const reopened = new TranslationCache(cachePath)
      await reopened.load()
      expect(reopened.get(key)).toBe('最后一段')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('同一项目只允许一个写任务', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdflock-'))
    try {
      const lockPath = join(dir, '.translate.lock')
      const lock = await acquireBookLock(lockPath, 'test')
      await expect(acquireBookLock(lockPath, 'second')).rejects.toThrow('另一个翻译任务')
      await lock.release()
      const again = await acquireBookLock(lockPath, 'after release')
      await again.release()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
