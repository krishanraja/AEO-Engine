import { createHash } from 'node:crypto'

/**
 * Krish's hard rule is no em dashes, and a model that is told that will reach
 * for the ASCII stand-ins instead. So the sweep kills the real characters AND
 * the substitutes: "--", and a hyphen used as a spaced dash. Word-internal
 * hyphens (AI-native, full-time) are left alone. Ported from Control Center's
 * api/growth/council-run.ts so both sides clean the same way.
 */
export const CLEAN = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[\u2014\u2015\u2013]/g, ',')
    .replace(/\s*-{2,}\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s*,(\s*,)+/g, ',')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** An @handle: an at sign not glued to a preceding word character, then 2+ handle characters. */
export const HANDLE_RE = /(^|[^A-Za-z0-9._])@[A-Za-z0-9_]{2,}/g
export const EM_DASH_RE = /\u2014/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strip anything that identifies a person: email addresses, @handles, and
 * every string on the subject's never-say list (case-insensitive). Applied to
 * every theme, paraphrase and digest string before it leaves the engine.
 */
export function scrubPII(s: string, neverSay: readonly string[] = []): string {
  let out = String(s ?? '')
  out = out.replace(EMAIL_RE, '')
  out = out.replace(HANDLE_RE, '$1')
  for (const term of neverSay) {
    const t = String(term ?? '').trim()
    if (t.length < 2) continue
    out = out.replace(new RegExp(escapeRe(t), 'gi'), '')
  }
  return out.replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim()
}

/** First 8 hex characters of sha256. */
export function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}

/** The opaque short reference a packet carries for a transcript. Never the id itself. */
export function callRef(transcriptId: string): string {
  return sha8(transcriptId)
}

export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'do', 'does',
  'i', 'we', 'my', 'our', 'you', 'your', 'it', 'its', 'this', 'that', 'how', 'what', 'which', 'should',
  'can', 'could', 'would', 'will', 'as', 'at', 'by', 'from', 'vs', 'versus', 'into', 'than', 'me', 'us',
])

/** Lower-case word tokens with punctuation and stop words removed. */
export function tokensOf(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

/** The dedupe key for a query: tokens joined, so two phrasings of one question collide. */
export function normaliseQuery(q: string): string {
  return tokensOf(q).join(' ')
}

/** Shared non-stop tokens between two strings. */
export function overlap(a: string, b: string): number {
  const ta = new Set(tokensOf(a))
  let n = 0
  for (const t of new Set(tokensOf(b))) if (ta.has(t)) n++
  return n
}

/** Tolerant JSON extraction from a model text response (handles ```json fences). */
export function robustJson(txt: string): unknown {
  let t = String(txt || '').trim()
  if (t.startsWith('```')) t = t.split('```')[1].replace(/^json/, '').trim()
  try { return JSON.parse(t) } catch { /* fall through */ }
  const i = t.indexOf('{'), j = t.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)) } catch { /* noop */ } }
  return null
}

/** Turn one clause of an icp_trigger into the question a buyer would type. */
export function toQuestion(raw: string): string {
  const s = CLEAN(raw, 400)
  if (!s) return ''
  const capped = s.charAt(0).toUpperCase() + s.slice(1)
  return /[?]$/.test(capped) ? capped : `${capped}?`
}

/** icp_trigger is written as buyer questions separated by " / ". */
export function questionsFrom(icpTrigger: string): string[] {
  const parts = String(icpTrigger || '').split('/').map(p => p.trim()).filter(p => p.length >= 12)
  const source = parts.length ? parts : [String(icpTrigger || '').trim()]
  const out: string[] = []
  for (const p of source) {
    const q = toQuestion(p)
    if (q && !out.includes(q)) out.push(q)
    if (out.length >= 4) break
  }
  return out
}
