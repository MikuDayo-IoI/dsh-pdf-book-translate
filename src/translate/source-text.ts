import type { Paragraph } from '../types.js'

/**
 * Joins the visual lines of a PDF paragraph back into the continuous text the
 * author wrote. PDF generators hard-wrap lines at the column edge; those line
 * breaks are layout artifacts, not paragraph breaks. Translation must see the
 * paragraph as a whole, otherwise every rendered line becomes a separate
 * sentence and the renderer cannot reflow the translated text naturally.
 *
 * Code is intentionally left untouched: its line breaks carry meaning.
 */
export function paragraphSourceText(paragraph: Paragraph): string {
  const raw = paragraph.lines.map(line => line.text)
  if (raw.length === 0) return ''
  if (paragraph.type === 'code') return raw.join('\n')

  const lines = raw.map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return ''
  let joined = lines[0] as string
  for (let i = 1; i < lines.length; i += 1) {
    const next = lines[i] as string
    if (isHyphenBreak(joined, next)) {
      joined = joined.slice(0, -1) + next
    } else if (/[A-Za-z]-$/.test(joined) && /^[a-z]/.test(next)) {
      // Real compound hyphen at the line edge: keep the hyphen, drop the break.
      joined += next
    } else if (needsSpace(joined, next)) {
      joined += ' ' + next
    } else {
      joined += next
    }
  }
  return joined
}

function isHyphenBreak(left: string, right: string): boolean {
  if (!/[A-Za-z]-$/.test(left)) return false
  if (!/^[a-z]/.test(right)) return false
  // A line-end hyphen is ambiguous: "inter-\nnational" is hyphenation, while
  // "state-of-the-\nart" / "well-\nknown" are real compound hyphens. Only
  // de-hyphenate common prefixes; otherwise keep the hyphen and just join.
  if ((left.match(/-/g) ?? []).length > 1) return false
  const prefix = /([A-Za-z]+)-$/.exec(left)?.[1]?.toLowerCase() ?? ''
  return HYPHEN_PREFIXES.has(prefix)
}

const HYPHEN_PREFIXES = new Set([
  'anti', 'co', 'counter', 'cross', 'de', 'extra', 'inter', 'intra', 'macro',
  'meta', 'micro', 'multi', 'neo', 'non', 'over', 'post', 'pre', 'proto',
  'pseudo', 'quasi', 're', 'semi', 'sub', 'super', 'trans', 'ultra', 'un',
  'under',
])

// CJK ideographs, kana, hangul, full-width forms and CJK punctuation.
const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const NO_SPACE_BEFORE = /^[,.;:!?%)}\]、。，；：！？）》」』】]/
const NO_SPACE_AFTER = /[(\[{（《「『【]$/

function needsSpace(left: string, right: string): boolean {
  const previous = left.slice(-1)
  const next = right.charAt(0)
  if (previous === '' || next === '') return false
  if (NO_SPACE_BEFORE.test(next)) return false
  if (NO_SPACE_AFTER.test(previous)) return false
  if (CJK.test(previous) && CJK.test(next)) return false
  return true
}
