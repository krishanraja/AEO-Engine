/**
 * The verify run's payload (src/protocol/verify.ts): what Krish approves on a
 * verify go-live, and exactly what the run re-asks. Canonical JSON of
 * `{amount_usd, date, query_ids, samples}`, the query ids sorted, so the
 * daily report that proposes it and the plan job that runs it compute one
 * digest from one rule. Here, not in src/protocol/, because the research CLI
 * reads it too.
 */
import { canonicalJson } from '../lib/canonical.js'

/** Samples a verify run takes of each question on every packet engine. */
export const VERIFY_SAMPLES = 3
/**
 * The most a verify run may spend, whatever a payload says, his amended one
 * included: check:config holds CAPS.VERIFY_MAX_USD at or under it.
 */
export const VERIFY_HARD_MAX_USD = 5
/** The most questions one verify payload may name (CAPS.VERIFY_MAX_QUESTIONS is the engine's own proposal). */
export const VERIFY_HARD_MAX_QUESTIONS = 10

export interface VerifyPayload { date: string; query_ids: string[]; samples: number; amount_usd: number }

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The payload as the go-live's exact_payload: canonical JSON, the query ids lower-cased, each once and sorted. */
export function verifyPayloadText(p: VerifyPayload): string {
  return canonicalJson({ amount_usd: p.amount_usd, date: p.date, query_ids: [...new Set(p.query_ids.map(q => q.toLowerCase()))].sort(), samples: p.samples })
}

export type VerifyParse = { ok: true; payload: VerifyPayload } | { ok: false; reason: string }

/**
 * Reads a payload (its text, or the parsed object) strictly: exactly the four
 * keys, a real date (and the one expected, when given), one to ten query ids
 * that are uuids, samples a whole number from 1 to 3, and an amount above 0
 * and at most VERIFY_HARD_MAX_USD. Anything else is refused with a code,
 * never repaired.
 */
export function parseVerifyPayload(raw: unknown, expect: { date?: string } = {}): VerifyParse {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw) } catch { return { ok: false, reason: 'payload_not_json' } }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'payload_not_object' }
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  if (keys !== 'amount_usd,date,query_ids,samples') return { ok: false, reason: 'payload_keys' }
  if (typeof o.date !== 'string' || !YMD_RE.test(o.date) || Number.isNaN(Date.parse(`${o.date}T00:00:00Z`))) return { ok: false, reason: 'payload_date' }
  if (expect.date && o.date !== expect.date) return { ok: false, reason: 'payload_date_mismatch' }
  if (!Array.isArray(o.query_ids) || !o.query_ids.length || o.query_ids.length > VERIFY_HARD_MAX_QUESTIONS) return { ok: false, reason: 'payload_query_ids' }
  const ids = o.query_ids.map(q => (typeof q === 'string' ? q.toLowerCase() : ''))
  if (!ids.every(q => UUID_RE.test(q)) || new Set(ids).size !== ids.length) return { ok: false, reason: 'payload_query_ids' }
  if (!Number.isInteger(o.samples) || (o.samples as number) < 1 || (o.samples as number) > VERIFY_SAMPLES) return { ok: false, reason: 'payload_samples' }
  if (typeof o.amount_usd !== 'number' || !Number.isFinite(o.amount_usd) || o.amount_usd <= 0 || o.amount_usd > VERIFY_HARD_MAX_USD) return { ok: false, reason: 'payload_amount' }
  return { ok: true, payload: { date: o.date, query_ids: [...ids].sort(), samples: o.samples as number, amount_usd: o.amount_usd } }
}

/** A subject as the verify assignment reads it: its slug, kind and last research packet's questions. */
export interface VerifyHolder { slug: string; kind?: string | null; prior?: { queries?: ReadonlyArray<{ query_id?: unknown; query?: unknown } | null> | null } | null }

const KIND_RANK: Record<string, number> = { venture: 0, prospect: 1, aspiration: 2 }

/**
 * Which subject re-asks each of the payload's questions: the first that
 * holds it in its last research packet (a query_id with its words), ventures
 * first, then by slug. Each query id goes to exactly one subject, so the
 * subjects' shares of the approved amount (src/pipeline/verify.ts,
 * verifyShare) never add up to more than the amount, and the verify matrix
 * (src/protocol/verify-cli.ts) runs only subjects that own one. Lower-cased
 * query id to slug. Pure.
 */
export function verifyOwners(subjects: ReadonlyArray<VerifyHolder> | null | undefined, ids: readonly string[]): Map<string, string> {
  const wanted = new Set(ids.map(q => q.toLowerCase()))
  const ordered = [...(Array.isArray(subjects) ? subjects : [])]
    .filter(s => s && typeof s.slug === 'string')
    .sort((a, b) => (KIND_RANK[String(a.kind)] ?? 3) - (KIND_RANK[String(b.kind)] ?? 3) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  const out = new Map<string, string>()
  for (const s of ordered) {
    for (const q of s.prior?.queries ?? []) {
      if (!q || typeof q.query_id !== 'string' || typeof q.query !== 'string') continue
      const id = q.query_id.toLowerCase()
      if (wanted.has(id) && !out.has(id)) out.set(id, s.slug)
    }
  }
  return out
}
