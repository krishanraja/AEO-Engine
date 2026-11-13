/**
 * The verify lane: a small off-week re-check of the questions a venture
 * shipped a page for, or a kit Krish approved, so a shipped page does not
 * wait a fortnight for one noisy reading (brief section I; GET-GOING Steps 1
 * and 9).
 *
 * Krish ruled on 15 October that research runs fortnightly, on cost. A verify
 * run in the off week changes that ruling, so it runs only on his approved
 * decision, through the Autonomy steps in AGENTS.md:
 *
 * 1. The plan, `aeo:verify-plan:v1`, a standing plan behind `strategy`,
 *    proposed by the daily report once there is a shipped question or a kit
 *    plan he approved, and never again after his No.
 * 2. The go-live, `aeo:verify:<the Sunday>`, behind `spend`, naming the plan,
 *    proposed by the daily report on the Thursday to Saturday before an
 *    even-week Sunday while the plan is approved: canonical JSON of
 *    `{amount_usd, date, query_ids, samples}`, the questions the last full
 *    research run tracked as shipped or a kit in flight, the amount the price
 *    table's estimate rounded up to whole dollars, at most the plan's cap.
 * 3. Live: on that Sunday the research workflow's plan job (src/protocol/verify-cli.ts)
 *    rebuilds the payload it would run from the same research report and
 *    runs it only on his approved decision whose payload_sha256 matches, in
 *    his words when he amended it and its digest checks out, once.
 *
 * An approved plan never goes live by itself, and nothing here spends: the
 * research workflow's verify job does, with exactly the payload this file
 * decided. Pure, apart from nothing: every read is the caller's.
 */
import { canonicalJson, sha256Hex } from '../lib/canonical.js'
import { CAPS, DEFAULT_ENGINES, PRICE_USD_PER_CALL } from '../config/run.js'
import { amendedVersion, type PlanDecision } from '../schema/kit.js'
import type { Proposal } from '../schema/report.js'
import { parseVerifyPayload, VERIFY_HARD_MAX_USD, VERIFY_SAMPLES, verifyPayloadText, type VerifyPayload } from '../schema/verify.js'
import { isoWeek } from './measure.js'

export const VERIFY_PLAN_ID = 'aeo:verify-plan:v1'
export const VERIFY_PREFIX = 'aeo:verify:'
export const verifyGoLiveId = (date: string) => `${VERIFY_PREFIX}${date}`
/** The verify run's protocol run_id: one a Sunday, apart from the research run's. */
export const verifyRunId = (date: string) => `aeo:${date}:verify`
/** The event that closes a verify go-live: the run happened, with its evidence. */
export const VERIFY_DONE_EVENT = 'verify_ran'
/** The event that would close the standing plan: his No stops it, and nothing else does. */
export const VERIFY_PLAN_EVENT = 'verify_plan_stopped'
/**
 * How far back his decisions on the verify plan are read: to the day the plan
 * id was made, so a No he gave is never forgotten by a lookback window.
 */
export const VERIFY_EPOCH = '2026-11-13T00:00:00.000Z'
/** The research report's line naming the questions a verify run would re-ask, which the daily report and the plan job read back. */
export const VERIFY_LINE_HEAD = 'Questions a verify run would re-ask in the off week (shipped, or a kit in flight):'

const DAY_MS = 86_400_000
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const sha = (exactPayload: string | null, amountUsd: number | null) => sha256Hex(canonicalJson({ amount_usd: amountUsd, exact_payload: exactPayload }))

/** The plan's words, exactly as the brief set them, with the amount filled in. */
export function verifyPlanText(amountUsd: number = CAPS.VERIFY_MAX_USD, maxQuestions: number = CAPS.VERIFY_MAX_QUESTIONS): string {
  return `In the off week, re-ask only the questions a venture has declared shipped (or a kit Krish approved), three samples on every engine, at most ${maxQuestions} questions and at most ${amountUsd} dollars a run. Results never count in the North Star share.`
}

/** The standing verify plan: behind strategy, the plan as its payload and the cap as its amount, so he can change either. */
export function verifyPlanProposal(expiresAt: Date, amountUsd: number = CAPS.VERIFY_MAX_USD): Proposal {
  const text = verifyPlanText(amountUsd)
  return {
    stage: 'plan',
    proposal_id: VERIFY_PLAN_ID,
    title: 'Re-check shipped questions in the off week, up to 3 USD a run'.replace('3 USD', `${amountUsd} USD`),
    why: 'A venture that ships a page waits two to four weeks for one noisy reading. A small re-check in the off week says sooner whether it won. It changes the 15 October ruling that research runs fortnightly, so it waits for his yes; each run is then its own go-live on his list, with its amount, and never counts in the share.',
    kind: 'prepared',
    wall: 'strategy',
    amount_usd: amountUsd,
    channel: null,
    objective_key: null,
    exact_payload: text,
    payload_sha256: sha(text, amountUsd),
    evidence: [],
    close_condition: { event: VERIFY_PLAN_EVENT, reference: VERIFY_PLAN_ID },
    expires_at: expiresAt.toISOString(),
  }
}

export type PlanStateName = 'none' | 'open' | 'declined' | 'held' | 'stale' | 'done'
export interface VerifyPlanState { state: PlanStateName; cap: number; decision: PlanDecision | null }

/**
 * The plan, as his decisions leave it. Any No stops it for good. His latest
 * yes opens it, on the plan as it is proposed today (a yes on words since
 * changed is stale, and it is proposed again); an amended yes whose digest
 * does not check out holds it. The cap is his amended amount when he changed
 * it, never above VERIFY_HARD_MAX_USD, else CAPS.VERIFY_MAX_USD.
 */
export function verifyPlanState(decisions: ReadonlyArray<PlanDecision | null | undefined>): VerifyPlanState {
  const mine = decisions.filter((d): d is PlanDecision => !!d && d.proposal_id === VERIFY_PLAN_ID)
  const base = { cap: CAPS.VERIFY_MAX_USD }
  if (!mine.length) return { ...base, state: 'none', decision: null }
  const latest = mine.reduce((a, b) => (Date.parse(b.decided_at) > Date.parse(a.decided_at) ? b : a))
  if (mine.some(d => d.decision === 'declined')) return { ...base, state: 'declined', decision: latest }
  if (latest.decision === 'done') return { ...base, state: 'done', decision: latest }
  if (latest.decision !== 'approved') return { ...base, state: 'none', decision: latest }
  const current = verifyPlanProposal(new Date(0)).payload_sha256
  if (latest.payload_sha256 !== current) return { ...base, state: 'stale', decision: latest }
  const own = amendedVersion(latest)
  if (own && !own.ok) return { ...base, state: 'held', decision: latest }
  const amended = own && own.ok && typeof latest.amount_usd === 'number' && latest.amount_usd > 0 ? Math.min(latest.amount_usd, VERIFY_HARD_MAX_USD) : null
  return { state: 'open', cap: amended ?? CAPS.VERIFY_MAX_USD, decision: latest }
}

/**
 * The Sunday a go-live is proposed for: on a Thursday, Friday or Saturday
 * (UTC), the coming Sunday when it falls in an even ISO week (an off week of
 * the fortnightly research). Else null.
 */
export function goLiveSunday(now: Date): string | null {
  const day = now.getUTCDay()
  if (day < 4) return null
  const sunday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (7 - day)))
  return isoWeek(sunday) % 2 === 0 ? ymd(sunday) : null
}

/** Whether a YYYY-MM-DD is a Sunday in an even ISO week: the only day a verify run goes live. */
export function isOffWeekSunday(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 0 && isoWeek(d) % 2 === 0
}

/**
 * The price table's estimate for a verify run of `questions` questions,
 * `samples` asks each on every default packet engine, the Claude probes on
 * the Claude Code lane (free). In dollars, to the cent.
 */
export function verifyEstimateUsd(questions: number, samples: number = VERIFY_SAMPLES): number {
  const perAsk = DEFAULT_ENGINES.reduce((n, e) => n + PRICE_USD_PER_CALL[e === 'claude' ? 'claude_code' : e], 0)
  return Math.round(questions * samples * perAsk * 100) / 100
}

/** The research report's line naming the questions a verify run would re-ask, at most 500 characters. Null when there are none. */
export function verifyIdsLine(ids: readonly string[]): string | null {
  const kept: string[] = []
  for (const id of ids) {
    const next = `${VERIFY_LINE_HEAD} ${[...kept, id].join(', ')}.`
    if (next.length > 500) break
    kept.push(id)
  }
  return kept.length ? `${VERIFY_LINE_HEAD} ${kept.join(', ')}.` : null
}

/** The questions a stored research report says a verify run would re-ask, in its order. Only this engine's own line is read. */
export function verifyIdsIn(report: Record<string, unknown> | null | undefined): string[] {
  const activity = report && Array.isArray(report.activity) ? report.activity : []
  for (const a of activity) {
    const text = typeof a === 'string' ? a : typeof (a as { line?: unknown } | null)?.line === 'string' ? (a as { line: string }).line : ''
    if (text.startsWith(VERIFY_LINE_HEAD)) return [...new Set(text.slice(VERIFY_LINE_HEAD.length).match(UUID_G) ?? [])]
  }
  return []
}

export interface GoLive { payload: VerifyPayload; text: string; sha: string; proposal: Proposal }

/**
 * The go-live for a Sunday: the first questions (in the research report's
 * order) whose estimate fits the cap, at most CAPS.VERIFY_MAX_QUESTIONS; the
 * amount the estimate rounded up to whole dollars, at most the cap. Null when
 * no question fits. The same inputs always give the same words and digest.
 */
export function buildGoLive(date: string, ids: readonly string[], cap: number, source: { run_id: string } | null): GoLive | null {
  let n = Math.min(ids.length, CAPS.VERIFY_MAX_QUESTIONS)
  while (n > 0 && verifyEstimateUsd(n) > cap + 1e-9) n--
  if (n <= 0) return null
  const estimate = verifyEstimateUsd(n)
  const amount = Math.min(Math.max(1, Math.ceil(estimate - 1e-9)), cap)
  const payload: VerifyPayload = { date, query_ids: [...ids.slice(0, n)].map(q => q.toLowerCase()).sort(), samples: VERIFY_SAMPLES, amount_usd: amount }
  const text = verifyPayloadText(payload)
  const digest = sha(text, amount)
  const sunday = new Date(`${date}T00:00:00Z`)
  return {
    payload,
    text,
    sha: digest,
    proposal: {
      stage: 'go_live',
      parent_proposal_id: VERIFY_PLAN_ID,
      proposal_id: verifyGoLiveId(date),
      title: `Verify run on ${date}: re-ask ${n} shipped ${n === 1 ? 'question' : 'questions'}, up to ${amount} USD`.slice(0, 160),
      why: `Under the verify plan he approved: re-ask ${n} ${n === 1 ? 'question' : 'questions'} a venture shipped a page for or a kit he approved is in flight on, ${VERIFY_SAMPLES} times on every engine, in the off week. The amount is the price table's estimate of ${estimate.toFixed(2)} USD rounded up, the Claude Code lane free. It runs once, at that Sunday's scheduled slot, only on his yes whose digest matches, and never counts in the share.`.slice(0, 1000),
      kind: 'prepared',
      wall: 'spend',
      amount_usd: amount,
      channel: 'research_workflow',
      objective_key: null,
      exact_payload: text,
      payload_sha256: digest,
      evidence: source ? [{ label: `The questions the research run ${source.run_id} tracked as shipped or a kit in flight`, url: null }] : [],
      close_condition: { event: VERIFY_DONE_EVENT, reference: verifyRunId(date) },
      expires_at: new Date(sunday.getTime() + DAY_MS).toISOString(),
    },
  }
}

export type VerifyDecision = { run: true; payload: VerifyPayload; amended: boolean } | { run: false; reason: string }

/**
 * Whether the plan job runs a verify on `date`, and with what. Runs only when
 * the plan is open, his latest decision on that Sunday's go-live approves
 * it, no verify report for that Sunday exists yet (once), and the decision's
 * payload_sha256 is the digest of the payload rebuilt now from the same
 * research report. Amended: his version, when its digest checks out and it
 * reads as a payload for that date; never the engine's. Anything else is a
 * skip with its reason. Pure.
 */
export function decideVerify(i: { date: string; decisions: ReadonlyArray<PlanDecision | null | undefined>; expected: Pick<GoLive, 'payload' | 'sha'> | null; alreadyRan: boolean }): VerifyDecision {
  if (!isOffWeekSunday(i.date)) return { run: false, reason: 'not_an_off_week_sunday' }
  const plan = verifyPlanState(i.decisions)
  if (plan.state !== 'open') return { run: false, reason: `plan_${plan.state}` }
  const id = verifyGoLiveId(i.date)
  const mine = i.decisions.filter((d): d is PlanDecision => !!d && d.proposal_id === id)
  if (!mine.length) return { run: false, reason: 'no_decision' }
  const d = mine.reduce((a, b) => (Date.parse(b.decided_at) > Date.parse(a.decided_at) ? b : a))
  if (d.decision !== 'approved') return { run: false, reason: `go_live_${d.decision}` }
  if (i.alreadyRan) return { run: false, reason: 'already_ran' }
  if (!i.expected) return { run: false, reason: 'no_payload_to_match' }
  if (d.payload_sha256 !== i.expected.sha) return { run: false, reason: 'sha_mismatch' }
  if (d.amended === true) {
    const v = amendedVersion(d)
    if (!v || !v.ok) return { run: false, reason: 'amendment_unverified' }
    const parsed = parseVerifyPayload(v.text, { date: i.date })
    if (!parsed.ok) return { run: false, reason: `amendment_${parsed.reason}` }
    if (typeof d.amount_usd === 'number' && d.amount_usd !== parsed.payload.amount_usd) return { run: false, reason: 'amendment_amount_mismatch' }
    return { run: true, payload: parsed.payload, amended: true }
  }
  return { run: true, payload: { ...i.expected.payload, query_ids: [...i.expected.payload.query_ids] }, amended: false }
}
