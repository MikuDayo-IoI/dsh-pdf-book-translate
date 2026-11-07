import { describe, expect, it } from 'vitest'
import type { Paragraph } from '../src/types.js'
import { paragraphSourceText } from '../src/translate/source-text.js'

function paragraph(lines: string[], type: Paragraph['type'] = 'body'): Paragraph {
  return {
    id: 1,
    bbox: [0, 0, 100, 100],
    firstLineAnchor: [0, 10],
    lines: lines.map((text, index) => ({
      text,
      bbox: [0, index * 14, 100, index * 14 + 12],
      origin: [0, index * 14 + 10],
      spans: [],
    })),
    type,
    readingOrder: 0,
    confidence: 1,
    table: null,
    alignment: 'left',
  }
}

describe('paragraphSourceText', () => {
  it('把 PDF 硬换行还原为连续段落', () => {
    expect(paragraphSourceText(paragraph(['This is a', 'wrapped paragraph.']))).toBe(
      'This is a wrapped paragraph.',
    )
  })

  it('合并行尾连字符断词', () => {
    expect(paragraphSourceText(paragraph(['inter-', 'national']))).toBe('international')
    expect(paragraphSourceText(paragraph(['state-of-the-', 'art']))).toBe('state-of-the-art')
  })

  it('中文跨行不插入空格', () => {
    expect(paragraphSourceText(paragraph(['这是第一行', '接着第二行']))).toBe('这是第一行接着第二行')
  })

  it('行首标点前不插入空格', () => {
    expect(paragraphSourceText(paragraph(['Hello', '，world']))).toBe('Hello，world')
    expect(paragraphSourceText(paragraph(['Hello', 'world.']))).toBe('Hello world.')
  })

  it('代码段保留原始换行', () => {
    expect(paragraphSourceText(paragraph(['def f():', '    return 1'], 'code'))).toBe(
      'def f():\n    return 1',
    )
  })

  it('列表项和标题的折行按空格连接', () => {
    expect(paragraphSourceText(paragraph(['• a long list item', 'continued here'], 'list-item'))).toBe(
      '• a long list item continued here',
    )
    expect(paragraphSourceText(paragraph(['A Long Chapter', 'Title'], 'heading'))).toBe(
      'A Long Chapter Title',
    )
  })
})
