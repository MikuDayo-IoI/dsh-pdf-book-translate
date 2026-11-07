import type { TermEntry } from '../types.js'
import type { TranslationBatch } from './chunker.js'
import { paragraphSourceText } from './source-text.js'

export type { TermEntry }

export interface PromptOptions {
  langPair: string
  termbase: TermEntry[]
  chapterContext?: string
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const terms = opts.termbase
    .map(t => {
      // Newlines in terminology would corrupt the numbered rule list.
      const src = t.src.replace(/[\r\n]+/g, ' ')
      const dst = t.dst.replace(/[\r\n]+/g, ' ')
      return t.locked ? `- ${src}（保留原文，不翻译）` : `- ${src} → ${dst}`
    })
    .join('\n')
  const context = opts.chapterContext?.trim()
  const rules = [
    `你是专业书籍翻译引擎。语言对：${opts.langPair}。`,
    '规则：',
    '1. 不得合并或拆分段落；每个段落独立翻译，保持段落边界。',
    '2. 每个段落是一个连续语义单元。PDF 中的硬换行只是排版结果，不要照搬为译文换行；译文应按目标语言自然折行。仅代码、诗歌或原文明确逐行的清单保留换行。',
    '3. 代码、变量名、URL、数字、公式与参考文献编号保持不变。',
    '4. 术语表优先遵守；locked 术语保留原文。',
    '5. 只输出 JSON 对象，不要 Markdown 代码围栏或解释。键为段落 id（字符串），值为译文。',
    '6. 译文要自然、准确，并与书籍其他章节的译名保持一致。',
    '术语表：',
    terms || '（无）',
  ]
  if (context !== undefined && context !== '') {
    rules.push('当前章节背景（仅用于统一译名与语气，不要复述）：', context.slice(0, 1600))
  }
  return rules.join('\n')
}

export function buildUserMessage(batch: TranslationBatch): string {
  const items = batch.paragraphs.map(p => ({
    id: String(p.id),
    text: paragraphSourceText(p),
  }))
  return JSON.stringify(items)
}

export function parseJsonObject(content: string): Record<string, unknown> {
  let cleaned = content.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall through to brace extraction: some models wrap JSON in prose.
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  throw new Error('translation response is not a JSON object')
}

export function parseBatchResponse(content: string, expectedIds: number[]): Map<number, string> {
  const obj = parseJsonObject(content)
  const result = new Map<number, string>()
  for (const id of expectedIds) {
    const key = String(id)
    if (!(key in obj)) {
      throw new Error(`translation response missing id ${id}`)
    }
    const value = obj[key]
    if (typeof value !== 'string') {
      throw new Error(`translation response invalid value for id ${id}`)
    }
    result.set(id, value)
  }
  return result
}

export function buildSummaryPrompt(chapterTitle: string, pages: string, sampleText: string, langPair: string): {
  system: string
  user: string
} {
  const target = langPair.split(/→|->|=>/)[1]?.trim() ?? '中文'
  return {
    system: [
      `你是书籍编辑，正在为翻译项目编写章节纪要。语言对：${langPair}。`,
      `请用目标语言（${target}）输出 180–350 字的章节摘要。`,
      '摘要必须说明：本章主题、核心概念/论证、关键术语、与其他章节的关系（若可判断）。',
      '不要逐段复述，不要添加原文没有的信息；保留专名和术语。',
      '只输出摘要正文，不要标题、Markdown 标题或“本章介绍了”式空话。',
    ].join('\n'),
    user: `章节：${chapterTitle}\nPDF 页码：${pages}\n\n章节采样文本：\n${sampleText.slice(0, 7000)}`,
  }
}

export function fallbackSummary(chapterTitle: string, sampleText: string): string {
  const text = sampleText.replace(/\s+/g, ' ').trim()
  if (text === '') return `《${chapterTitle}》暂无可提取文本。`
  return `《${chapterTitle}》节选：${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`
}
