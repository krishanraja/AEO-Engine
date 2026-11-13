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
 * While the plan is open the daily report checks in on it (`stage:
 * check_in`, VERIFY_CHECKIN_ID) after each off-week Sunday's verify run ran or
 * was skipped and at least weekly, in counts; his No on a check-in stops the
 * plan for good. His change to the plan is taken only when it changes the
 * amount: any other change to its words holds the plan, never guessed at.
 *
 * An approved plan never goes live by itself, and nothing here spends: the
 * research workflow's verify job does, with exactly the payload this file
 * decided. Pure, apart from nothing: every read is the caller's.
 */
import { canonicalJson, sha256Hex } from '../lib/canonical.js'
import { CAPS, DEFAULT_ENGINES, PRICE_USD_PER_CALL } from '../config/run.js'
import { inWords } from './state.js'
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
/** The verify plan's check-in, renewed by the daily report while the plan is open: one id, its words changing with each week and each off-week Sunday. */
export const VERIFY_CHECKIN_ID = 'aeo:verify-checkin:v1'
/** Whether a decision is about the verify lane: the plan, its check-in, or a go-live. */
export const isVerifyDecisionId = (id: string) => id === VERIFY_PLAN_ID || id === VERIFY_CHECKIN_ID || id.startsWith(VERIFY_PREFIX)
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

/**
 * `held` is an amendment whose digest does not check out; `held_words` one
 * that checks out and changes more than the amount, which this engine does
 * not guess at.
 */
export type PlanStateName = 'none' | 'open' | 'declined' | 'held' | 'held_words' | 'stale' | 'done'
export interface VerifyPlanState { state: PlanStateName; cap: number; decision: PlanDecision | null }

const newest = (list: readonly PlanDecision[]) => list.reduce((a, b) => (Date.parse(b.decided_at) > Date.parse(a.decided_at) ? b : a))

/**
 * Whether an amended plan changes only its amount: his words are the plan's
 * as proposed, at the cap or at his own amount (the plan's words name it).
 */
export function amountOnly(text: string | null, amountUsd: number | null | undefined): boolean {
  if (text === verifyPlanText()) return true
  return typeof amountUsd === 'number' && amountUsd > 0 && text === verifyPlanText(amountUsd)
}

/**
 * The plan, as his decisions leave it. Any No, on the plan or on its
 * check-in, stops it for good. His latest yes opens it, on the plan as it is
 * proposed today (a yes on words since changed is stale, and it is proposed
 * again). An amended yes is held when its digest does not check out
 * (`held`), and when it changes anything but the amount (`held_words`): the
 * engine takes only an amount change and never guesses at other words. An
 * amended yes on the check-in, newer than his latest decision on the plan, is
 * held the same way, until a newer decision on the plan or a plain yes on a
 * later check-in. The cap is his amended amount when he changed it, never
 * above VERIFY_HARD_MAX_USD, else CAPS.VERIFY_MAX_USD.
 */
export function verifyPlanState(decisions: ReadonlyArray<PlanDecision | null | undefined>): VerifyPlanState {
  const mine = decisions.filter((d): d is PlanDecision => !!d && d.proposal_id === VERIFY_PLAN_ID)
  const checkIns = decisions.filter((d): d is PlanDecision => !!d && d.proposal_id === VERIFY_CHECKIN_ID)
  const base = { cap: CAPS.VERIFY_MAX_USD }
  if (!mine.length) return { ...base, state: 'none', decision: null }
  const latest = newest(mine)
  if (mine.some(d => d.decision === 'declined') || checkIns.some(d => d.decision === 'declined')) return { ...base, state: 'declined', decision: latest }
  if (latest.decision === 'done') return { ...base, state: 'done', decision: latest }
  if (latest.decision !== 'approved') return { ...base, state: 'none', decision: latest }
  const current = verifyPlanProposal(new Date(0)).payload_sha256
  if (latest.payload_sha256 !== current) return { ...base, state: 'stale', decision: latest }
  const own = amendedVersion(latest)
  if (own && !own.ok) return { ...base, state: 'held', decision: latest }
  if (own && own.ok && !amountOnly(own.text, latest.amount_usd)) return { ...base, state: 'held_words', decision: latest }
  const lastCheckIn = checkIns.length ? newest(checkIns) : null
  if (lastCheckIn && lastCheckIn.decision === 'approved' && Date.parse(lastCheckIn.decided_at) > Date.parse(latest.decided_at)) {
    const theirs = amendedVersion(lastCheckIn)
    if (theirs) return { ...base, state: theirs.ok ? 'held_words' : 'held', decision: latest }
  }
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
 * `samples` asks each on every default packet engine, each at its paid API
 * price, Claude's included: the daily report cannot see whether the verify
 * job holds the Claude Code token, and without it the Claude probes fall back
 * to the paid API (resolveClaudeLane), so the amount covers that. On the
 * Claude Code lane the Claude asks are free and the run spends less. In
 * dollars, to the cent.
 */
export function verifyEstimateUsd(questions: number, samples: number = VERIFY_SAMPLES): number {
  const perAsk = DEFAULT_ENGINES.reduce((n, e) => n + PRICE_USD_PER_CALL[e], 0)
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

// ---------- after an off-week Sunday: what the daily report reads back ----------

/** A stored verify report as the daily report read it for one off-week Sunday: the report, or null when none is stored; `error` when the read failed. */
export interface VerifyRunRead { date: string; report: Record<string, unknown> | null; error: string | null }

/** The Sundays the daily report reads verify reports for, newest first, at most this many. */
export const VERIFY_READS_MAX = 2
/** How far back the daily report looks for an off-week Sunday whose approved go-live did not run. */
export const SKIP_LOOKBACK_DAYS = 7

const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
const endOf = (date: string) => Date.parse(`${date}T23:59:59.999Z`)
const dayWords = (date: string) => inWords(new Date(`${date}T12:00:00Z`)).replace(/ at .*$/, '')

/** The off-week Sundays before `at`'s day (never `at`'s own), newest first, back `days` days. */
export function pastOffWeekSundays(at: Date, days: number): string[] {
  const out: string[] = []
  for (let back = 1; back <= days; back++) {
    const d = ymd(new Date(dayStart(at) - back * DAY_MS))
    if (isOffWeekSunday(d)) out.push(d)
  }
  return out
}

/** His latest decision on a Sunday's go-live as it stood at the end of that Sunday, or null. */
export function goLiveDecisionAt(decisions: ReadonlyArray<PlanDecision | null | undefined>, date: string): PlanDecision | null {
  const id = verifyGoLiveId(date)
  const mine = decisions.filter((d): d is PlanDecision => !!d && d.proposal_id === id && !(Date.parse(d.decided_at) > endOf(date)))
  return mine.length ? newest(mine) : null
}

/** The week of the open plan a day falls in: whole weeks since he approved it, and the day that week began. */
export function planWeek(approvedAt: string, at: Date): { week: number; from: Date } {
  const approved = new Date(approvedAt)
  const days = Math.round((dayStart(at) - dayStart(approved)) / DAY_MS)
  const week = Math.max(0, Math.floor(days / 7))
  return { week, from: new Date(dayStart(approved) + week * 7 * DAY_MS) }
}

/**
 * The off-week Sundays the daily report reads a verify report for, newest
 * first, at most VERIFY_READS_MAX: the latest one in the last
 * SKIP_LOOKBACK_DAYS when its go-live was approved (so a run that did not
 * happen is said), and, while the plan is open, those since he approved it
 * that the week's check-in covers (from three weeks before the week began).
 * Pure.
 */
export function verifySundaysToRead(decisions: ReadonlyArray<PlanDecision | null | undefined>, at: Date): string[] {
  const out = new Set<string>()
  const recent = pastOffWeekSundays(at, SKIP_LOOKBACK_DAYS)[0]
  if (recent && goLiveDecisionAt(decisions, recent)?.decision === 'approved') out.add(recent)
  const plan = verifyPlanState(decisions)
  if (plan.state === 'open' && plan.decision) for (const d of checkInSundays(plan.decision.decided_at, at)) out.add(d)
  return [...out].sort().reverse().slice(0, VERIFY_READS_MAX)
}

/** The off-week Sundays a check-in covers: since the plan was approved, from three weeks before the plan's week began, before today. */
export function checkInSundays(approvedAt: string, at: Date): string[] {
  const { from } = planWeek(approvedAt, at)
  const floor = Math.max(dayStart(new Date(approvedAt)), from.getTime() - 21 * DAY_MS)
  return pastOffWeekSundays(at, 35).filter(d => Date.parse(`${d}T00:00:00Z`) >= floor).slice(0, VERIFY_READS_MAX)
}

/** What a stored verify report says, in counts: whether it closed the go-live, questions asked of the payload's, samples, and the panel moves. Only this engine's own lines and events are read. */
export interface VerifyRunFacts { ran: boolean; asked: number | null; total: number | null; samples: number | null; won: number; lost: number }

export function verifyRunFacts(report: Record<string, unknown>): VerifyRunFacts {
  const events = Array.isArray(report.events) ? (report.events as Array<{ event?: unknown } | null>) : []
  const count = (name: string) => events.filter(e => e?.event === name).length
  const lines = (Array.isArray(report.activity) ? report.activity : []).map(a => (typeof a === 'string' ? a : typeof (a as { line?: unknown } | null)?.line === 'string' ? (a as { line: string }).line : ''))
  const head = lines.find(l => /^Verify run aeo:\d{4}-\d{2}-\d{2}:verify, /.test(l)) ?? ''
  const asked = /: asked (\d+) of (\d+) questions?\b/.exec(head)
  const samples = /, (\d+) samples? on each of /.exec(head)
  return { ran: count(VERIFY_DONE_EVENT) > 0, asked: asked ? Number(asked[1]) : null, total: asked ? Number(asked[2]) : null, samples: samples ? Number(samples[1]) : null, won: count('question_won'), lost: count('question_lost') }
}

/**
 * Why an approved go-live for `date` did not run, as far as the records the
 * plan job read say: the decisions as they stood at the end of that Sunday,
 * and the last full research report when it is the one the plan job read (a
 * research run no later than that Sunday). The reason decideVerify would give
 * from them; 'unknown' when they say it should have run (the workflow did not
 * start, failed, or its research job refused), or when the research report
 * read now is newer than that Sunday. Pure.
 */
export function skipReason(date: string, decisions: ReadonlyArray<PlanDecision | null | undefined>, last: { run_id: string; report: Record<string, unknown> } | null): string {
  const asOf = decisions.filter((d): d is PlanDecision => !!d && !(Date.parse(d.decided_at) > endOf(date)))
  const day = /^aeo:(\d{4}-\d{2}-\d{2}):research$/.exec(last?.run_id ?? '')?.[1] ?? null
  if (!last || !day || day > date) return 'unknown'
  const plan = verifyPlanState(asOf)
  const expected = buildGoLive(date, verifyIdsIn(last.report), plan.cap, { run_id: last.run_id })
  const d = decideVerify({ date, decisions: asOf, expected, alreadyRan: false })
  return d.run ? 'unknown' : d.reason
}

/** One off-week Sunday in a check-in: ran, skipped (an approved go-live with no verify report), declined, not approved, or not read. */
export type SundayState = 'ran' | 'skipped' | 'declined' | 'not_approved' | 'unread'
export interface SundayOutcome { date: string; state: SundayState; reason: string | null; facts: VerifyRunFacts | null }

/** Each Sunday's outcome, from his decisions and the verify reports read. A stored report means it ran, whatever the decision now says. */
export function sundayOutcomes(dates: readonly string[], decisions: ReadonlyArray<PlanDecision | null | undefined>, runs: ReadonlyArray<VerifyRunRead> | null | undefined, last: { run_id: string; report: Record<string, unknown> } | null): SundayOutcome[] {
  return dates.map(date => {
    const read = (runs ?? []).find(r => r.date === date) ?? null
    if (read?.report) return { date, state: 'ran', reason: null, facts: verifyRunFacts(read.report) }
    const d = goLiveDecisionAt(decisions, date)
    if (!d) return { date, state: 'not_approved', reason: null, facts: null }
    if (d.decision === 'declined') return { date, state: 'declined', reason: null, facts: null }
    if (d.decision !== 'approved') return { date, state: 'not_approved', reason: null, facts: null }
    if (!read || read.error) return { date, state: 'unread', reason: read?.error ?? 'not_read', facts: null }
    return { date, state: 'skipped', reason: skipReason(date, decisions, last), facts: null }
  })
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** One Sunday, in words for the check-in: counts only. */
function sundayWords(o: SundayOutcome): string {
  const day = dayWords(o.date)
  if (o.state === 'ran') {
    const f = o.facts as VerifyRunFacts
    const asked = f.asked !== null && f.total !== null ? `asked ${f.asked} of ${plural(f.total, 'question')}` : 'asked an unstated number of questions'
    return `- ${day}: ran (${verifyRunId(o.date)}), ${asked}${f.samples !== null ? `, ${plural(f.samples, 'sample')} on each assistant` : ''}; against the last research panel ${plural(f.won, 'question')} became won and ${f.lost} lost${f.ran ? '' : '; nothing was asked, so the go-live was not closed'}.`
  }
  if (o.state === 'skipped') return `- ${day}: Krish approved its go-live and it did not run (${o.reason === 'unknown' ? 'why is not known to this engine' : `skipped: ${o.reason}`}).`
  if (o.state === 'declined') return `- ${day}: he declined its go-live, so it did not run.`
  if (o.state === 'unread') return `- ${day}: its verify report could not be read (${o.reason}), so whether it ran is not known.`
  return `- ${day}: no go-live was approved, so it did not run.`
}

export interface VerifyCheckInFacts { plan: VerifyPlanState; at: Date; outcomes: readonly SundayOutcome[]; nextSunday: string | null }

/**
 * The verify plan's check-in, as plain text for Krish: the week of the plan,
 * each off-week Sunday it covers (ran, with the questions asked, the samples
 * and the panel moves; or skipped with its reason; or why it did not run),
 * the totals, and what comes next. Counts only: never a question, an answer
 * or a URL. The same week and the same Sundays always render the same words.
 */
export function renderVerifyCheckIn(f: VerifyCheckInFacts): string {
  const d = f.plan.decision as PlanDecision
  const { week, from } = planWeek(d.decided_at, f.at)
  const ran = f.outcomes.filter(o => o.state === 'ran')
  const skipped = f.outcomes.filter(o => o.state === 'skipped')
  const asked = ran.reduce((n, o) => n + (o.facts?.asked ?? 0), 0)
  const lines = [
    `Check-in on the verify plan ${VERIFY_PLAN_ID}`,
    `Approved: ${dayWords(d.decided_at.slice(0, 10))}; at most ${f.plan.cap} USD a run, at most ${CAPS.VERIFY_MAX_QUESTIONS} questions, ${VERIFY_SAMPLES} samples on every engine.`,
    `Week ${week + 1} of the plan, from ${dayWords(ymd(from))}.`,
    '',
    'Off-week verify runs it covers:',
    ...(f.outcomes.length ? f.outcomes.map(sundayWords) : ['- none yet.']),
    '',
    `Totals: ${plural(ran.length, 'run')} done, ${skipped.length} skipped; ${plural(asked, 'question')} re-asked; panel moves: ${ran.reduce((n, o) => n + (o.facts?.won ?? 0), 0)} won, ${ran.reduce((n, o) => n + (o.facts?.lost ?? 0), 0)} lost. A verify run never counts in the North Star share.`,
    `Next: ${f.nextSunday ? `the off-week Sunday ${dayWords(f.nextSunday)}; its go-live comes to his list on the Thursday before, when the last full research run tracked a shipped question or a kit in flight.` : 'the next off-week Sunday; its go-live comes to his list on the Thursday before.'}`,
    'His yes keeps the plan going. This engine can take only a change to the amount, so a change to any other words holds the plan. His No stops it for good.',
  ]
  return lines.join('\n').replace(/\u2014|\u2013/g, ',').slice(0, 8000)
}

/** The next off-week Sunday after `at`'s day. */
export function nextOffWeekSunday(at: Date): string | null {
  for (let ahead = 1; ahead <= 14; ahead++) {
    const d = ymd(new Date(dayStart(at) + ahead * DAY_MS))
    if (isOffWeekSunday(d)) return d
  }
  return null
}
