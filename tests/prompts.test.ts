import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserMessage, parseBatchResponse } from '../src/translate/prompts.js'
import type { TranslationBatch } from '../src/translate/chunker.js'

const batch: TranslationBatch = {
  paragraphs: [
    { id: 3, bbox: [0, 0, 1, 1], firstLineAnchor: [0, 0], lines: [{ text: 'Hello world', bbox: [0, 0, 1, 1], origin: [0, 0], spans: [] }], type: 'body', readingOrder: 0, confidence: 1, table: null },
    { id: 7, bbox: [0, 0, 1, 1], firstLineAnchor: [0, 0], lines: [{ text: 'Second', bbox: [0, 0, 1, 1], origin: [0, 0], spans: [] }], type: 'body', readingOrder: 1, confidence: 1, table: null },
  ],
  skipIds: [],
}

describe('prompts', () => {
  it('系统提示包含语言对与术语表', () => {
    const sys = buildSystemPrompt({ langPair: 'en→zh', termbase: [{ src: 'API', dst: '应用程序接口', locked: false }] })
    expect(sys).toContain('en→zh')
    expect(sys).toContain('API')
  })

  it('用户消息携带段落 id 与文本', () => {
    const msg = buildUserMessage(batch)
    expect(msg).toContain('"3"')
    expect(msg).toContain('Hello world')
  })

  it('用户消息把 PDF 硬换行合并为连续段落', () => {
    const wrapped: TranslationBatch = {
      paragraphs: [{
        ...batch.paragraphs[0]!,
        lines: [
          { text: 'A sentence that was', bbox: [0, 0, 1, 1], origin: [0, 0], spans: [] },
          { text: 'hard-wrapped by the PDF.', bbox: [0, 0, 1, 1], origin: [0, 0], spans: [] },
        ],
      }],
      skipIds: [],
    }
    const msg = buildUserMessage(wrapped)
    expect(msg).toContain('A sentence that was hard-wrapped by the PDF.')
    expect(msg).not.toContain('was\\nhard-wrapped')
  })

  it('系统提示要求自然折行而不是照搬 PDF 行', () => {
    const sys = buildSystemPrompt({ langPair: 'en→zh', termbase: [] })
    expect(sys).toContain('硬换行')
    expect(sys).toContain('自然折行')
  })

  it('解析 JSON 响应为 id→译文', () => {
    const parsed = parseBatchResponse(JSON.stringify({ 3: '你好，世界', 7: '第二' }), [3, 7])
    expect(parsed.get(3)).toBe('你好，世界')
    expect(parsed.size).toBe(2)
  })

  it('缺 id 时报错', () => {
    expect(() => parseBatchResponse(JSON.stringify({ 3: 'only' }), [3, 7])).toThrow(/missing/)
  })

  it('容错解析代码块包裹的 JSON', () => {
    const parsed = parseBatchResponse('```json\n{"3":"x"}\n```', [3])
    expect(parsed.get(3)).toBe('x')
  })

  it('null 响应体报非对象错误', () => {
    expect(() => parseBatchResponse('null', [3])).toThrow(/not a JSON object/)
  })

  it('非字符串值报 invalid', () => {
    expect(() => parseBatchResponse(JSON.stringify({ 3: 42 }), [3])).toThrow(/invalid value/)
  })
})
