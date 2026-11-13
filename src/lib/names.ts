/**
 * Whether an answer names the subject, outside any link: one of its
 * distinctive names (Control Center's `subject.brand_names`, never a generic
 * word), whole word and in any case, in the answer's text with every URL and
 * bare domain taken out first, so a citation is not counted as a mention.
 */

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi
/** A bare domain, with any path: two or more labels and a top-level label of two letters or more. */
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The names worth looking for: trimmed, two characters or more, each once. */
export function brandNamesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const n of raw) {
    if (typeof n !== 'string') continue
    const t = n.trim().replace(/\s+/g, ' ')
    if (t.length < 2 || t.length > 80 || out.some(o => o.toLowerCase() === t.toLowerCase())) continue
    out.push(t)
  }
  return out
}

/** True when the text names one of `names` outside a URL; null when there are no names to look for. */
export function nameMentioned(text: string, names: readonly string[]): boolean | null {
  const list = brandNamesOf(names)
  if (!list.length) return null
  const stripped = String(text ?? '').replace(URL_RE, ' ').replace(DOMAIN_RE, ' ')
  return list.some(n => new RegExp(`(?<![A-Za-z0-9])${escapeRe(n).replace(/ /g, '\\s+')}(?![A-Za-z0-9])`, 'i').test(stripped))
}
