/**
 * The Brave index check (brief G4; protocol, "AEO-Engine's index check").
 * Does a kit's target page rank on Brave for its question? Claude's web
 * search draws on Brave, so a page Brave does not rank is one Claude cannot
 * retrieve.
 *
 * Control Center holds the Brave key and asks Brave the question, never the
 * page; this engine only decides what to look up, through the research desk's
 * `index_check` kind (`<https page> | <question>`). It holds no search key
 * (check:config refuses one in src/ and the workflows).
 *
 * The cap (Ruling, Krish, 2026-11-14: Brave at $5 per 1,000 calls, at most
 * $0.05 a day): at most INDEX_CHECK_MAX_PER_DAY a UTC day, or fewer when
 * Control Center offers fewer. The checks this engine already asked today,
 * read back from the desk, count against it, so a second run the same day
 * asks only the rest; when that history cannot be read, nothing is sent,
 * because an unknown count is never zero. Request ids are fixed per day and
 * question, so a retry replays its stored answer and is never asked twice.
 *
 * What it returns is counts only: the questions, pages and answers stay in
 * Control Center's research desk (this repository and its logs are public).
 */
import type { RunSummary } from './measure.js'
import type { KitCandidate } from '../schema/kit.js'

/** Brave's price, its pricing page read 2026-11-14: $5 per 1,000 requests. */
export const BRAVE_USD_PER_CALL = 0.005
/** Krish's daily ceiling for Brave (2026-11-14). */
export const INDEX_CHECK_MAX_USD_PER_DAY = 0.05
/** Checks a UTC day: the ceiling over the price, 10. */
export const INDEX_CHECK_MAX_PER_DAY = Math.floor(INDEX_CHECK_MAX_USD_PER_DAY / BRAVE_USD_PER_CALL + 1e-9)
export const INDEX_CHECK_KIND = 'index_check'
const QUERY_MAX = 400

export interface ResearchRequest { request_id: string; kind: string; subject_ref: string; query: string; why: string }
export interface ResearchRow { request_id: string; kind: string; status: string; requested_at: string; answer?: string | null }

/** The research desk, as GrowthEngineHttp opens it (and a test's stand-in). */
export interface ResearchDesk {
  getCapabilities(): Promise<unknown>
  listResearch(): Promise<ResearchRow[]>
  postResearch(requests: ResearchRequest[]): Promise<ResearchRow[] | Array<{ request_id: string; kind: string; status: string }>>
}

export interface IndexCheckOutcome {
  /** asked | cap_reached | nothing_to_check | held (not offered, or today's count unknown) | failed */
  status: 'asked' | 'cap_reached' | 'nothing_to_check' | 'held' | 'failed'
  planned: number
  used_today: number | null
  asked: number
  answered: number
  over_cap: number
  failed: number
  skipped_cap: number
  usd_estimate: number
}

function rec(x: unknown): Record<string, unknown> { return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {} }

/** The day's cap Control Center offers this engine for index_check, or null when it offers none. */
export function offeredPerDay(capabilities: unknown): number | null {
  const research = rec(rec(capabilities).research)
  const kinds = Array.isArray(research.kinds) ? research.kinds : []
  if (!kinds.includes(INDEX_CHECK_KIND)) return null
  const n = Number(rec(research.per_day)[INDEX_CHECK_KIND])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

function dayOf(d: Date): string { return d.toISOString().slice(0, 10) }

/**
 * One check per kit whose target is one of our https pages and whose question
 * is known: every subject's top kit first, then the backups, one per query id.
 */
export function planIndexChecks(summaries: readonly RunSummary[], now: Date): ResearchRequest[] {
  const tops: KitCandidate[] = []
  const backups: KitCandidate[] = []
  for (const s of summaries) for (const sub of s.subjects) {
    if (sub.kit_candidate) tops.push(sub.kit_candidate)
    for (const b of sub.kit_backups ?? []) backups.push(b)
  }
  const seen = new Set<string>()
  const out: ResearchRequest[] = []
  for (const k of [...tops, ...backups]) {
    const page = k.reference
    const question = (k.question ?? '').replace(/\s+/g, ' ').trim()
    if (!/^https:\/\//.test(page) || !question || seen.has(k.query_id)) continue
    const query = `${page} | ${question}`
    if (query.length > QUERY_MAX) continue
    seen.add(k.query_id)
    out.push({
      request_id: `aeo:index:${dayOf(now)}:${k.query_id.slice(0, 12)}`,
      kind: INDEX_CHECK_KIND,
      subject_ref: `product:${k.product_slug}`,
      query,
      why: 'Whether Brave, which Claude\'s search draws on, ranks the kit\'s page for its question',
    })
  }
  return out
}

export async function runIndexChecks(desk: ResearchDesk, summaries: readonly RunSummary[], now: Date): Promise<IndexCheckOutcome> {
  const plan = planIndexChecks(summaries, now)
  const out: IndexCheckOutcome = { status: 'held', planned: plan.length, used_today: null, asked: 0, answered: 0, over_cap: 0, failed: 0, skipped_cap: 0, usd_estimate: 0 }
  let offered: number | null
  try { offered = offeredPerDay(await desk.getCapabilities()) } catch { return out }
  if (offered === null) return out
  if (!plan.length) return { ...out, status: 'nothing_to_check' }
  let rows: ResearchRow[]
  try { rows = await desk.listResearch() } catch { return out }
  const today = dayOf(now)
  const used = rows.filter(r => r.kind === INDEX_CHECK_KIND && String(r.requested_at).slice(0, 10) === today).length
  out.used_today = used
  const cap = Math.min(INDEX_CHECK_MAX_PER_DAY, offered)
  const room = Math.max(0, cap - used)
  const send = plan.slice(0, room)
  out.skipped_cap = plan.length - send.length
  if (!send.length) return { ...out, status: 'cap_reached' }
  let answers: Array<{ status: string }>
  try { answers = await desk.postResearch(send) } catch { return { ...out, status: 'failed', failed: send.length } }
  out.asked = send.length
  out.usd_estimate = Math.round(send.length * BRAVE_USD_PER_CALL * 10000) / 10000
  for (const a of answers) {
    if (a.status === 'answered' || a.status === 'empty') out.answered++
    else if (a.status === 'over_cap') out.over_cap++
    else out.failed++
  }
  out.status = out.skipped_cap > 0 || out.over_cap > 0 ? 'cap_reached' : 'asked'
  return out
}
