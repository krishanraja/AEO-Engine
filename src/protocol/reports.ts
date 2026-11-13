/**
 * The two protocol reports this engine writes, as pure functions:
 *
 *   research  after a paid research run (the fortnightly schedule, or a run
 *             Krish starts by hand): the objective from the packets, one
 *             activity line per subject, and a spend proposal only when the
 *             cap stopped probes.
 *   directive after the daily wake-up from Control Center: no paid call at
 *             all. It says when the last research run was and when the next
 *             is, and carries the objective from the last research report.
 *
 * Neither ever carries anything on docs/NEVER-PUBLISH.md: no prospect or
 * aspiration name or slug (they are numbered), no answer, citation, theme or
 * call, and no spend figure in a line. The one dollar amount is the spend
 * proposal's `amount_usd`, which the protocol requires for a spend ask.
 *
 * Protocol 1.20.0. When the directive says `features.engine_state`, both
 * reports speak 1.20.0 and carry the engine's state (src/protocol/state.ts)
 * and what it did with Krish's instruction, by id only: never his words.
 * Without it they stay 1.0.0, exactly as before.
 */
import { canonicalJson, sha256Hex } from '../lib/canonical.js'
import {
  ACK_LINE_MAX,
  ANSWERS_SERVED_MAX,
  ANSWERS_VERSION,
  ENGINE,
  OBJECTIVE_KEY,
  sealReport,
  STAGES_VERSION,
  STATE_VERSION,
  stateLineOk,
  validateReport,
  type ActivityLine,
  type Decision,
  type EngineReport,
  type EngineState,
  type Hold,
  type InstructionAck,
  type InstructionRef,
  type ObjectiveReading,
  type Proposal,
  type ReportEvent,
  type ReportStatus,
  type SchemaVersion,
} from '../schema/report.js'
import { fortnightStart, nextScheduledRun, SCHEDULE_LATE_MS, upcomingRun, type RunSummary, type SubjectSummary } from './measure.js'
import { checkInId, CHECKIN_PREFIX, GAP_CLASSES, KIT_PROPOSAL_PREFIX, kitPlans, kitProposalId, planIdOfCheckIn, type GapClass, type KitCandidate, type KitPlan, type PlanDecision } from '../schema/kit.js'
import { emptyStates, engineWon, PANEL_STATES, SAMPLES_PER_CONTESTED, WIN_SAMPLES, type TrackedQuestion } from '../schema/panel.js'
import { buildEngineState, inWords, type RepoState } from './state.js'
import { sha8 } from '../lib/text.js'
import { CAPS } from '../config/run.js'
import type { BrandCheckResult } from '../schema/brand.js'
import type { CitedPagesCounts } from '../schema/citedPages.js'
import type { OutcomeCounts } from '../schema/outcome.js'
import { buildGoLive, checkInSundays, goLiveDecisionAt, goLiveSunday, nextOffWeekSunday, pastOffWeekSundays, planWeek, renderVerifyCheckIn, SKIP_LOOKBACK_DAYS, sundayOutcomes, VERIFY_CHECKIN_ID, VERIFY_DONE_EVENT, VERIFY_PLAN_ID, verifyGoLiveId, verifyIdsIn, verifyIdsLine, verifyPlanProposal, verifyPlanState, type VerifyRunRead } from './verify.js'
import type { VerifyPayload } from '../schema/verify.js'

export const SPEND_PROPOSAL_ID = 'aeo:spend:max-usd-per-run'
// A win kit's plan id, aeo:kit:<product_slug>:<first 8 of query_id>, and its
// check-in's, aeo:checkin:<product_slug>:<first 8>, live in src/schema/kit.ts
// with the rule that reads his decisions on them.
export { CHECKIN_PREFIX, checkInId, KIT_PROPOSAL_PREFIX, kitProposalId }
export const SPEND_TARGET = 'AEO_MAX_USD_PER_RUN'
/** A fortnightly engine reads as stale after 15 days (ENGINE-PROTOCOL.md, Health). */
export const STALE_DAYS = 15
/**
 * How far back a research run reads Krish's decisions before it picks a kit:
 * about four research runs. A kit he declined or approved in that time never
 * comes back as a fresh ask (approved: it is in flight, Phase 3's "kit in
 * flight"); after it, its question may be proposed again if it still leads.
 */
export const DECISIONS_LOOKBACK_DAYS = 60

/**
 * A decision as the reports read it: the id, his answer, when, and the
 * payload it was made on; and, when he amended it, his version and its
 * digest (1.1.0), which a kit plan's check-in reads as his redirect.
 */
export type DecisionLite = Pick<Decision, 'proposal_id' | 'decided_at' | 'payload_sha256'> & { decision: string } & Partial<Pick<Decision, 'stage' | 'amended' | 'amended_sha256' | 'exact_payload' | 'amount_usd'>>

/** One decision per proposal: the latest by decided_at, from any number of lists (the directive's seven days, a longer GET). */
export function latestDecisions(...lists: ReadonlyArray<readonly DecisionLite[] | null | undefined>): Map<string, DecisionLite> {
  const out = new Map<string, DecisionLite>()
  for (const list of lists) for (const d of list ?? []) {
    if (!d || typeof d.proposal_id !== 'string') continue
    const had = out.get(d.proposal_id)
    if (!had || Date.parse(d.decided_at) > Date.parse(had.decided_at)) out.set(d.proposal_id, d)
  }
  return out
}

/**
 * The win kit still waiting on his list from a stored research report: a kit
 * proposal he has not decided (any version) and that has not expired. Null
 * when there is none.
 */
export function pendingKitOf(report: Record<string, unknown> | null | undefined, decisions: readonly DecisionLite[], at: Date): Proposal | null {
  const proposals = report && Array.isArray(report.proposals) ? (report.proposals as Proposal[]) : []
  const decided = new Set(decisions.map(d => d.proposal_id))
  for (const p of proposals) {
    if (!p || typeof p.proposal_id !== 'string' || !p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX)) continue
    if (decided.has(p.proposal_id)) continue
    if (p.expires_at && Date.parse(p.expires_at) <= at.getTime()) continue
    return p
  }
  return null
}
const DAY_MS = 86_400_000

export interface Envelope {
  runId: string
  mode: 'live' | 'synthetic'
  observedAt: Date
  revision: string
  capturedAt: Date
  /** 1.20.0: set only when the directive served `features.engine_state`. Absent or null: a 1.0.0 report, as before. */
  state?: StateContext | null
  /** 1.22.0: true when the directive served `features.answer_requests`, so a research report may say which it asked. */
  answers?: boolean
}

/** What a 1.20.0 report is built from, besides the run itself. */
export interface StateContext {
  /** This repository's own docs, read at the run's commit. */
  repo: RepoState
  /** Krish's open instruction from the directive, its words already dropped. */
  instruction: InstructionRef | null
  /** True when one of this engine's own recent live reports already named it, so it was acked before. */
  seen: boolean
  /** This workflow run's public page, for an ack's evidence, or null. */
  evidenceUrl: string | null
}

/**
 * The measurement changed after the research run of 8 November 2026, the
 * last one made by the earlier code: the first citation became the first
 * source an answer cites in its text, and ChatGPT was required to search. A
 * research report says so while its week begins before this date (the
 * scheduled runs of 22 November and 6 December, and any run Krish starts by
 * hand before them), so the reading is not taken for a change in the answers.
 *
 * The line names the last run of the old measurement rather than the first
 * of the new: the first scheduled one is 22 November, but a run started by
 * hand after this code merges would already measure the new way, and a line
 * saying "changed on 22 November" would then name a date still to come.
 */
export const METHOD_NOTE_BEFORE_WEEK = '2026-12-07'
export const METHOD_NOTE = 'Measurement changed after the 8 November run: first citation is now the first source an answer cites in its text, and ChatGPT is required to search.'

/** Control Center stores an instruction `expired` once it is this many days old (ENGINE-PROTOCOL.md, 1.20.0). */
export const INSTRUCTION_LIFE_DAYS = 7

/**
 * Where Krish starts a paid research run by hand. Control Center's brief said
 * "press Run now", but no page in Control Center draws that press any more,
 * and no Run now dispatch has reached this repository since 2026-09-08; the
 * Actions button on the research workflow (AEO weekly) is the press that works.
 */
export const START_BY_HAND = 'Run workflow on AEO weekly in GitHub Actions'

const dayInWords = (d: Date) => inWords(d).replace(/ at .*$/, '')

/**
 * When paid research will next meet an open instruction. An instruction lapses
 * INSTRUCTION_LIFE_DAYS after Krish gives it and the research runs
 * fortnightly, so this says whether the next scheduled run comes in time
 * (allowing for GitHub starting it late), and when the instruction lapses if
 * not. Dates in words: a date and time in digits reads as a phone number to
 * Control Center's guard.
 */
export function researchTail(given: InstructionRef, at: Date, next: Date): string {
  const lapses = Date.parse(given.given_at) + INSTRUCTION_LIFE_DAYS * DAY_MS
  if (next.getTime() + SCHEDULE_LATE_MS < lapses) return `The next scheduled run, ${dayInWords(next)}, picks it up; to start sooner, press ${START_BY_HAND}.`
  if (lapses > at.getTime()) return `The next scheduled run, ${dayInWords(next)}, comes after it lapses on ${dayInWords(new Date(lapses))}; press ${START_BY_HAND} before then.`
  return `Press ${START_BY_HAND}.`
}

/** An ack line: the whole of it when Control Center will take it, else its short form. */
function ackLine(whole: string, short: string): string {
  return stateLineOk(whole, ACK_LINE_MAX) ? whole : short
}

/** The ack for an instruction the daily run cannot act on: only paid research can, and the daily run never starts it (the cost wall). */
export function needsResearch(given: InstructionRef, at: Date, next: Date): string {
  const head = 'Needs a paid research run, which this daily run never starts.'
  return ackLine(`${head} ${researchTail(given, at, next)}`, `${head} Press ${START_BY_HAND}.`)
}

/**
 * The version a report sends: the lowest that carries every field it uses
 * (the protocol's "Versions" rule). answers_served is 1.22.0, the engine's
 * state 1.20.0, a proposal's stage or parent 1.1.0; otherwise 1.0.0.
 */
export function versionFor(r: { answers_served?: unknown; state: boolean; proposals: readonly Proposal[] }): SchemaVersion {
  if (r.answers_served) return ANSWERS_VERSION
  if (r.state) return STATE_VERSION
  if (r.proposals.some(p => 'stage' in p || 'parent_proposal_id' in p)) return STAGES_VERSION
  return '1.0.0'
}

function envelope(e: Envelope, status: ReportStatus, objectives: ObjectiveReading[], activity: ActivityLine[], proposals: Proposal[], holds: Hold[], state: EngineState | null = null, served: readonly string[] = [], events: readonly ReportEvent[] = []): EngineReport {
  const extra: EngineState & { answers_served?: string[] } = {}
  // 1.22.0: the venture requests this run asked, only where the directive serves them.
  if (e.answers && served.length) extra.answers_served = [...served].slice(0, ANSWERS_SERVED_MAX)
  if (state?.priorities?.length) extra.priorities = state.priorities
  if (state?.obsessions?.length) extra.obsessions = state.obsessions
  if (state?.next_steps?.length) extra.next_steps = state.next_steps
  if (state?.instruction_acks?.length) extra.instruction_acks = state.instruction_acks
  const sent = proposals.slice(0, 10)
  return sealReport({
    schema_version: versionFor({ answers_served: extra.answers_served, state: !!state, proposals: sent }),
    engine_id: ENGINE.engine_id,
    product_slug: ENGINE.product_slug,
    run_id: e.runId,
    mode: e.mode,
    observed_at: e.observedAt.toISOString(),
    source: { revision: e.revision.slice(0, 128) || 'unknown', captured_at: e.capturedAt.toISOString() },
    status,
    objectives,
    activity: activity.slice(0, 40),
    proposals: sent,
    events: events.slice(0, EVENTS_MAX),
    holds: holds.slice(0, 40),
    ...extra,
  })
}

/** An ack, at the report's time, with this run's page as its evidence. */
function ack(ctx: StateContext, at: Date, state: InstructionAck['state'], text: string): InstructionAck {
  return { instruction_id: (ctx.instruction as InstructionRef).id, state, line: text, at: at.toISOString(), evidence_url: ctx.evidenceUrl }
}

/** The 1.20.0 state for a report: its lines from the repository, plus the acks, or null for a 1.0.0 report. */
function stateFor(e: Envelope, objective: ObjectiveReading, acks: InstructionAck[], nextRun: Date = nextScheduledRun(e.observedAt)): EngineState | null {
  if (!e.state) return null
  return { ...buildEngineState({ repo: e.state.repo, objective, nextRun }), ...(acks.length ? { instruction_acks: acks } : {}) }
}

const line = (s: string): ActivityLine => ({ line: s.slice(0, 500), evidence_url: null })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

function missing(reason: string, windowStart: string | null = null, windowEnd: string | null = null): ObjectiveReading {
  return { key: OBJECTIVE_KEY, value: null, unit: 'questions', window_start: windowStart, window_end: windowEnd, timezone: 'UTC', availability: 'missing', reason: reason.slice(0, 500) }
}

/** A walled proposal's payload digest: SHA-256 of canonical JSON of exactly { amount_usd, exact_payload }, the shape an amendment's digest takes. */
export function wordsPayloadSha(exactPayload: string | null, amountUsd: number | null = null): string {
  return sha256Hex(canonicalJson({ amount_usd: amountUsd, exact_payload: exactPayload }))
}

/** Why a kit, in one plain paragraph, from its gap class. Counts and classes only. */
const KIT_WHY: Record<KitCandidate['gap_class'], string> = {
  won: 'It is cited first already.',
  cited_not_first: 'The assistants cite us for this question, but not first.',
  retrieved_not_cited: 'An assistant\'s search returns a page of ours for this question, and its answer cites others.',
  not_retrieved: 'We have a page for this question that no assistant\'s search returned.',
  no_page: 'No page of ours answers this question, and the assistants cite others.',
  unknown: 'No assistant answered this question.',
}

/**
 * The one win kit this research run puts on Krish's list (Ruling, Krish,
 * 2026-11-13: until Control Center carries kits to the venture engines, AEO
 * proposes one kit a run itself). A kit is a plan for one question (protocol
 * 1.1.0, `stage: plan`, GET-GOING Step 1): prepared, behind strategy, with
 * the kit itself as the plan he can change. AEO never publishes, so it never
 * proposes a go-live for it: his yes sends it to the product's build session
 * or its growth engine to ship, and AEO checks in on it after each research
 * run until the question is won (`kit_won` closes it) or he stops it.
 */
export function kitProposal(k: KitCandidate, expiresAt: Date): Proposal {
  const reference = k.reference.trim() || null
  const why = `${KIT_WHY[k.gap_class]} The kit says what to change and why, from this run's answers and a fetch-only read of the pages involved. AEO ships nothing: the product's build session or its growth engine does, and the next research run checks whether it is cited first.`
  return {
    stage: 'plan',
    proposal_id: kitProposalId(k.product_slug, k.query_id),
    title: `Win '${k.title}' for ${k.product_slug}`.slice(0, 160),
    why: why.slice(0, 1000),
    kind: 'prepared',
    wall: 'strategy',
    amount_usd: null,
    channel: null,
    objective_key: OBJECTIVE_KEY,
    exact_payload: k.exact_payload,
    payload_sha256: wordsPayloadSha(k.exact_payload),
    evidence: reference && /^https:\/\/\S+$/.test(reference) ? [{ label: 'The page the kit changes', url: reference.slice(0, 500) }] : [],
    close_condition: { event: KIT_WON_EVENT, reference: reference ? reference.slice(0, 500) : null },
    expires_at: expiresAt.toISOString(),
  }
}

// ---------- the autonomy loop for kits: check-ins and events (GET-GOING Step 1) ----------

/** The event that closes a kit plan: its question is won by the repeat-sample rule. */
export const KIT_WON_EVENT = 'kit_won'
export const QUESTION_WON_EVENT = 'question_won'
export const QUESTION_LOST_EVENT = 'question_lost'
/** The event a check-in names: Krish answered it, which only he does. */
export const CHECK_IN_EVENT = 'check_in_answered'
/** Check-ins one report carries, oldest plan first. */
export const CHECKINS_MAX = 3
/** AGENTS.md: at least one check-in a week while a plan is open, so the daily report renews one this many days after the last research run. */
export const CHECKIN_WEEK_DAYS = 7
export const EVENTS_MAX = 40

/** How close each gap class is to a first citation, for "against the plan". Unknown has no place. */
const GAP_RANK: Record<GapClass, number | null> = { won: 5, cited_not_first: 4, retrieved_not_cited: 3, not_retrieved: 2, no_page: 1, unknown: null }
const GAP_WORDS: Record<GapClass, string> = {
  won: 'won, cited first',
  cited_not_first: 'cited, not first',
  retrieved_not_cited: 'retrieved, not cited',
  not_retrieved: 'our page is not retrieved',
  no_page: 'no page of ours answers it',
  unknown: 'no engine answered',
}

const isGap = (v: string): v is GapClass => (GAP_CLASSES as readonly string[]).includes(v)

/**
 * The gap class a plan's own text names: a check-in's "Gap class at approval"
 * line first (carried forward run to run), else a kit's "Why it is not won:
 * ... (class)" line. Null when the text names none. Only this engine's own
 * rendering is read, never a guess from anything else.
 */
export function gapClassIn(text: string | null | undefined): GapClass | null {
  const t = String(text ?? '')
  const carried = /^- Gap class at approval: ([a-z_]+)\b/m.exec(t)
  if (carried && isGap(carried[1])) return carried[1]
  const kit = /^Why it is not won: .*\(([a-z_]+)\)\s*$/m.exec(t)
  return kit && isGap(kit[1]) ? kit[1] : null
}

/** The question a plan's own text names (its "Question:" line), or null. */
export function questionIn(text: string | null | undefined): string | null {
  const m = /^Question: (.+)$/m.exec(String(text ?? ''))
  return m ? m[1].trim().slice(0, 400) : null
}

/** A proposal's payload in a stored report, by id, or null. */
function payloadIn(report: Record<string, unknown> | null | undefined, id: string): string | null {
  const proposals = report && Array.isArray(report.proposals) ? (report.proposals as Proposal[]) : []
  const p = proposals.find(x => x && x.proposal_id === id)
  return typeof p?.exact_payload === 'string' ? p.exact_payload : null
}

/**
 * The line a research report carries the kit plans kit_won closed in, so
 * every later report reads them as done: Control Center closes the plan on
 * the event, but no decision says so, and only the last research report is
 * read back. Each plan id with the day it was closed.
 */
export const CLOSED_LINE_HEAD = 'Kit plans closed by kit_won, checked in on no more:'
const CLOSED_ENTRY_RE = /(aeo:kit:[a-z0-9-]+:[0-9a-f]{8})(?: \((\d{4}-\d{2}-\d{2})\))?/g
/** At most this many closed plans are carried, newest closure first: a plan stays open six weeks, and a run proposes one kit. */
const CLOSED_CARRIED_MAX = 10

/**
 * The kit plans a stored research report says kit_won closed, each with the
 * day it was closed ('' when not said): the plans its events closed, and those
 * its closure line carries forward from earlier reports. Only this engine's
 * own report is read.
 */
export function closedByKitWon(report: Record<string, unknown> | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!report) return out
  for (const e of Array.isArray(report.events) ? report.events : []) {
    const ev = e as Partial<ReportEvent> | null
    if (ev?.event === KIT_WON_EVENT && typeof ev.proposal_id === 'string' && ev.proposal_id.startsWith(KIT_PROPOSAL_PREFIX)) out.set(ev.proposal_id, String(ev.at ?? '').slice(0, 10))
  }
  for (const a of Array.isArray(report.activity) ? report.activity : []) {
    const text = typeof a === 'string' ? a : typeof (a as ActivityLine | null)?.line === 'string' ? (a as ActivityLine).line : ''
    if (!text.startsWith(CLOSED_LINE_HEAD)) continue
    for (const m of text.slice(CLOSED_LINE_HEAD.length).matchAll(CLOSED_ENTRY_RE)) if (!out.has(m[1])) out.set(m[1], m[2] ?? '')
  }
  return out
}

/** Whether kit_won closed this plan: closed, and not approved again after the day it was closed. */
export function closedPlan(plan: KitPlan, closed: ReadonlyMap<string, string>): boolean {
  const day = closed.get(plan.plan_id)
  if (day === undefined) return false
  return !day || plan.approved_at.slice(0, 10) <= day
}

/** The closure line for a report, newest closure first, or null when no plan is closed. */
function closedLine(closed: ReadonlyMap<string, string>): ActivityLine | null {
  const entries = [...closed].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).slice(0, CLOSED_CARRIED_MAX)
  if (!entries.length) return null
  return line(`${CLOSED_LINE_HEAD} ${entries.map(([id, day]) => (day ? `${id} (${day})` : id)).join(', ')}.`)
}

/** One engine's part, in words: "chatgpt (first on 2 of 3 samples)". */
function engineWords(e: TrackedQuestion['engines'][number]): string {
  return e.n > 1 ? `${e.engine} (first on ${e.first} of ${e.n} samples, cited on ${e.cited})` : `${e.engine} (${e.first ? 'first' : e.cited ? 'cited, not first' : 'not cited'})`
}

export interface CheckInFacts {
  plan: KitPlan
  question: string | null
  gapAtApproval: GapClass | null
  /** This run's measurement of the question, or null when it was not asked. */
  tracked: TrackedQuestion | null
  /** Why it was not measured, when `tracked` is null. */
  notMeasured: string | null
  runId: string
  observedAt: Date
  next: Date
}

/**
 * A check-in, as plain text for Krish: how the question did against the plan,
 * measured this run, with no answer text, and what comes next. At most 8000
 * characters; his redirect, when he gave one, is quoted last and cut first.
 */
export function renderCheckIn(f: CheckInFacts): string {
  const t = f.tracked
  const day = dayInWords(f.observedAt)
  const lines = [
    `Check-in on the win kit plan ${f.plan.plan_id}`,
    `Product: ${f.plan.product_slug}`,
    `Question: ${f.question ?? 'not known to this run (asked by its query id only)'}`,
    `Approved: ${dayInWords(new Date(f.plan.approved_at))}${f.plan.redirect ? `; redirected by Krish on ${dayInWords(new Date(f.plan.redirect.at))}` : ''}`,
    '',
    t ? `Measured by the research run on ${day} (${f.runId}), with no answer text:` : `Not measured by the research run on ${day} (${f.runId}): ${f.notMeasured ?? 'the question was not asked'}.`,
    `- Gap class at approval: ${f.gapAtApproval ?? 'not known (the plan as approved is not in the reports this run read)'}`,
  ]
  let against = 'not measured this run'
  if (t) {
    const now = t.gap_class
    lines.push(`- Gap class now: ${now ? `${now} (${GAP_WORDS[now]})` : 'not diagnosed'}`)
    lines.push(`- Panel state now: ${t.panel.state}${t.panel.streak !== null ? `, ${t.panel.streak} ${t.panel.streak === 1 ? 'run' : 'runs'} in this state` : ''}${t.panel.won_at ? `; won in the week of ${t.panel.won_at}` : ''}${t.panel.lost_at ? `; lost in the week of ${t.panel.lost_at}` : ''}`)
    lines.push(`- Assistants that answered: ${t.engines.length}${t.engines.length ? ` (${t.engines.map(engineWords).join('; ')})` : ''}`)
    lines.push(`- Assistants citing us: ${t.engines.filter(e => e.cited > 0).length}; citing us first: ${t.engines.filter(e => e.first > 0).length}; first on ${WIN_SAMPLES} of ${SAMPLES_PER_CONTESTED} samples: ${t.engines.filter(e => engineWon(e, t.sampled === true)).length}`)
    lines.push(`- A shipped URL declared: ${t.shipped_url ? `yes, ${t.shipped_url}` : 'no'}`)
    const a = f.gapAtApproval ? GAP_RANK[f.gapAtApproval] : null
    const b = now ? GAP_RANK[now] : null
    against = a === null || b === null ? 'not comparable (a class is not known)' : b > a ? 'closer to a first citation than at approval' : b < a ? 'further from a first citation than at approval' : 'no change since approval'
  }
  lines.push('', `Against the plan: ${against}.`)
  lines.push(`Plan: ${f.plan.redirect ? `Krish's redirect of ${dayInWords(new Date(f.plan.redirect.at))}, quoted below` : `the kit as proposed (${f.plan.plan_id})`}.`)
  lines.push(`Next: the research run of ${dayInWords(f.next)} asks it again, ${SAMPLES_PER_CONTESTED} times on each assistant; a first citation on ${WIN_SAMPLES} of ${SAMPLES_PER_CONTESTED} samples on one assistant closes the plan with ${KIT_WON_EVENT}. AEO ships nothing: the product's build session or its growth engine does.`)
  lines.push('His yes keeps the plan going, his change redirects it, and his No stops it for good.')
  const head = lines.join('\n').replace(/\u2014|\u2013/g, ',')
  if (!f.plan.redirect?.text) return head.slice(0, 8000)
  const quoted = `\n\nHis redirect, as he wrote it:\n${f.plan.redirect.text}`.replace(/\u2014|\u2013/g, ',')
  return (head + quoted).length <= 8000 ? head + quoted : `${(head + quoted).slice(0, 8000 - 20)}\n(cut to fit)`
}

/** A check-in on a kit plan: behind strategy, naming its plan, his "On track?". */
export function checkInProposal(plan: KitPlan, payload: string, question: string | null, expiresAt: Date, evidenceUrl: string | null = null): Proposal {
  const words = question ? question.replace(/\s+/g, ' ') : null
  const short = words && words.length > 100 ? `${words.slice(0, 100).replace(/\s+\S*$/, '')}...` : words
  return {
    stage: 'check_in',
    parent_proposal_id: plan.plan_id,
    proposal_id: checkInId(plan.plan_id),
    title: (short ? `On track? Win '${short}' for ${plan.product_slug}` : `On track? The win kit plan for ${plan.product_slug}`).slice(0, 160),
    why: `How the question did against the kit plan Krish approved on ${dayInWords(new Date(plan.approved_at))}, measured with no answer text. His yes keeps it going, his change redirects it, and his No stops the plan for good.`.slice(0, 1000),
    kind: 'advice',
    wall: 'strategy',
    amount_usd: null,
    channel: null,
    objective_key: OBJECTIVE_KEY,
    exact_payload: payload,
    payload_sha256: wordsPayloadSha(payload),
    evidence: evidenceUrl && /^https:\/\/\S+$/.test(evidenceUrl) ? [{ label: 'The research run', url: evidenceUrl.slice(0, 500) }] : [],
    close_condition: { event: CHECK_IN_EVENT, reference: plan.plan_id },
    expires_at: expiresAt.toISOString(),
  }
}

/** The question this plan is for, in a run's summaries: its venture's tracked question whose id starts with the plan's. */
function trackedFor(plan: KitPlan, placed: readonly Placed[]): { tracked: TrackedQuestion | null; why: string | null } {
  const subject = placed.find(p => p.s.kind === 'venture' && p.s.product_slug === plan.product_slug)
  if (!subject) return { tracked: null, why: `no research job for ${plan.product_slug} reported this run` }
  if (!subject.s.ok) return { tracked: null, why: `the research for ${plan.product_slug} failed this run` }
  const tracked = (subject.s.panel?.tracked ?? []).find(t => t.query_id.startsWith(plan.q8)) ?? null
  return tracked ? { tracked, why: null } : { tracked: null, why: 'this run\'s research did not track its question (it was not asked, or the plan was not read before the research)' }
}

/** The spend ask's payload: the amount and the variable it would change. */
export function spendPayloadSha(amountUsd: number): string {
  return sha256Hex(canonicalJson({ amount_usd: amountUsd, target: SPEND_TARGET }))
}

export interface ResearchInput extends Envelope {
  /** 'all' when the run covered every active subject; 'one' for a single-subject run started by hand. */
  scope: 'all' | 'one'
  /** The slugs the plan job handed out, one research job each. */
  expected: string[]
  summaries: RunSummary[]
  /** The whole run's cap, AEO_MAX_USD_PER_RUN. */
  totalCapUsd: number
  /** Set when the plan could not read the subject list. */
  planError: string | null
  /**
   * His decisions over the last DECISIONS_LOOKBACK_DAYS, read before this
   * report is built (a free GET). Null: they could not be read, so no kit is
   * proposed, since one he declined could come back. Undefined: none given.
   */
  decisions?: DecisionLite[] | null
  /**
   * The kit still waiting on his list from the last full research report
   * (pendingKitOf). A full run keeps that one slot: it renews the same kit when
   * it is still a candidate, else carries it as it is, and never adds a second.
   */
  pendingKit?: Proposal | null
  /**
   * The last full research report (the one pendingKit came from), or null.
   * A kit plan's check-in reads the class the plan was made at from it: the
   * kit's own text, or the last check-in's, carried forward run to run.
   */
  lastReport?: Record<string, unknown> | null
  /** features.aeo_kits_delivered: the venture engines carry the kits, so no kit plan is proposed here; check-ins on approved plans go on. */
  kitsDelivered?: boolean
  /** This workflow run's public page, the run evidence a check-in and an event name. */
  runPage?: string | null
}

interface Placed { s: SubjectSummary; label: string; counts: boolean; noSummary: boolean }

/** Ventures by name; prospects, aspirations and anything unknown by number only. */
function place(input: ResearchInput): Placed[] {
  const bySlug = new Map<string, { s: SubjectSummary; noSummary: boolean }>()
  for (const sum of input.summaries) for (const s of sum.subjects) bySlug.set(s.slug, { s, noSummary: false })
  // A run started by hand may name its subject by uuid; the job's summary records the
  // argument it was given, so that covers the planned entry too.
  const coveredArgs = new Set(input.summaries.map(s => s.subject_arg))
  for (const slug of input.expected) {
    if (!bySlug.has(slug) && !coveredArgs.has(slug)) bySlug.set(slug, { s: { slug, kind: null, product_slug: null, ok: false, questions: null, probed_questions: null, cited_first: null, probes: null, probes_failed: null, probes_skipped_cap: null }, noSummary: true })
  }
  const all = [...bySlug.values()].sort((a, b) => a.s.slug.localeCompare(b.s.slug))
  const ventures = all.filter(x => x.s.kind === 'venture')
  const prospects = all.filter(x => x.s.kind === 'prospect')
  const aspirations = all.filter(x => x.s.kind === 'aspiration')
  const unknown = all.filter(x => x.s.kind === null)
  return [
    ...ventures.map(x => ({ ...x, label: x.s.product_slug ?? x.s.slug, counts: true })),
    ...prospects.map((x, i) => ({ ...x, label: `prospect ${i + 1} of ${prospects.length}`, counts: true })),
    ...aspirations.map((x, i) => ({ ...x, label: `aspiration ${i + 1} of ${aspirations.length}`, counts: false })),
    ...unknown.map((x, i) => ({ ...x, label: `unnamed subject ${i + 1} of ${unknown.length}`, counts: true })),
  ]
}

/** The events a cited page's mention sends when it changes (src/pipeline/48-cited-pages.ts). */
export const MENTION_ACQUIRED_EVENT = 'mention_acquired'
export const MENTION_LOST_EVENT = 'mention_lost'
/** A brand check's suggestion: aeo:brand:<product>:<sha8 of the question>, stable across runs. */
export const BRAND_PREFIX = 'aeo:brand:'
export const BRAND_FIXED_EVENT = 'brand_check_passed'
export const brandProposalId = (product: string, question: string) => `${BRAND_PREFIX}${product}:${sha8(question.trim().replace(/\s+/g, ' ').toLowerCase())}`

/**
 * The questions a verify run would re-ask: each venture's tracked questions
 * (shipped, or a kit in flight), held ventures included, since a verify run
 * only measures; those not yet won first, shipped before kit, then by id. At
 * most CAPS.VERIFY_MAX_QUESTIONS.
 */
export function verifyCandidates(placed: ReadonlyArray<{ s: SubjectSummary }>, max: number = CAPS.VERIFY_MAX_QUESTIONS): string[] {
  const rows = placed.flatMap(p => (p.s.ok && p.s.kind === 'venture' ? p.s.panel?.tracked ?? [] : []))
  const seen = new Set<string>()
  return rows
    .filter(t => t.tiers.includes('shipped') || t.tiers.includes('kit'))
    .sort((a, b) => Number(a.panel.state === 'won') - Number(b.panel.state === 'won') || Number(!a.tiers.includes('shipped')) - Number(!b.tiers.includes('shipped')) || a.query_id.localeCompare(b.query_id))
    .map(t => t.query_id.toLowerCase())
    .filter(id => (seen.has(id) ? false : (seen.add(id), true)))
    .slice(0, max)
}

/** "AI referrals: N sessions to M answer pages in 28 days", GA4 and Clarity apart; unknown when neither was served. */
export function referralsPart(o: OutcomeCounts | undefined): string {
  if (!o) return 'AI referrals: unknown (no search signals served)'
  if (!o.pages) return 'AI referrals: no answer page tracked yet (no shipped page and no kit target page)'
  const one = (name: string, r: OutcomeCounts['ga4']) => (r ? `${name} ${plural(r.sessions, 'session')} to ${plural(r.pages, 'answer page')}` : null)
  const parts = [one('GA4', o.ga4), one('Clarity', o.clarity)].filter(Boolean)
  if (!parts.length) return 'AI referrals: unknown (no AI-referral readings served)'
  return `AI referrals: ${parts.join(', ')} in ${o.days} days (counted apart, never summed)`
}

/** One venture's counts: its cited pages, AI referrals and brand checks, as sentences. Null with nothing measured. */
export function ventureMeasures(label: string, c: CitedPagesCounts | undefined, o: OutcomeCounts | undefined, b: SubjectSummary['brand_checks']): string | null {
  const parts: string[] = []
  if (c) parts.push(`Cited pages: ${c.rows} tracked, ${c.link + c.name} mention ${label}, ${c.to_check} to check${c.mention_ok_false ? `, ${c.mention_ok_false} carrying a phrase a brand check forbids` : ''}`)
  parts.push(referralsPart(o))
  if (b && b.checks) parts.push(`Brand checks: ${b.passed} of ${b.answered} passed${b.checks > b.answered ? ` (${b.checks - b.answered} not answered)` : ''}`)
  return parts.length ? `${parts.join('. ')}.` : null
}

/** A failed brand check, as one strategy suggestion: the venture, the question and which phrases failed on which engine, never an answer's words. */
export function brandProposal(product: string, r: BrandCheckResult, expiresAt: Date): Proposal {
  const failing = r.engines.filter(e => !e.pass)
  const lines = [
    `Brand check failed for ${product}`,
    `Question: ${r.question}`,
    '',
    ...r.engines.map(e => (e.pass ? `- ${e.engine}: passed` : `- ${e.engine}: ${[...e.must_not.map(x => `used "${x}", which it must not`), ...e.must.map(x => `left out "${x}", which it must say`)].join('; ')}`)),
    '',
    'What to do: make the pages the assistants read say it plainly, the venture\'s own pages first, in its own words. AEO ships nothing: the product\'s build session or its growth engine does, and the next research run asks the check again.',
  ]
  const payload = lines.join('\n').replace(/\u2014|\u2013/g, ',').slice(0, 8000)
  return {
    proposal_id: brandProposalId(product, r.question),
    title: `Fix how the assistants describe ${product}`.slice(0, 160),
    why: `An assistant's answer to one of ${product}'s brand checks broke its rules on ${plural(failing.length, 'engine')}: the phrases are named, never the answer. No kit was proposed this run, so this is the one suggestion on his list.`.slice(0, 1000),
    kind: 'advice',
    wall: 'strategy',
    amount_usd: null,
    channel: null,
    objective_key: null,
    exact_payload: payload,
    payload_sha256: wordsPayloadSha(payload),
    evidence: [],
    close_condition: { event: BRAND_FIXED_EVENT, reference: brandProposalId(product, r.question) },
    expires_at: expiresAt.toISOString(),
  }
}

export function buildResearchReport(input: ResearchInput): EngineReport {
  const placed = place(input)
  const engines = [...new Set(input.summaries.flatMap(s => s.engines))]
  const weekStart = input.summaries.map(s => s.week_start).sort().at(-1) ?? null
  const activity: ActivityLine[] = []
  const holds: Hold[] = []

  if (input.planError) {
    activity.push(line(`Could not read the subject list from Control Center (${input.planError}), so no subject was researched.`))
    holds.push({ reason: input.planError.slice(0, 200), detail: 'The plan job could not list the subjects; nothing was probed and nothing was guessed.' })
  }
  for (const p of placed) {
    const s = p.s
    if (p.noSummary) { activity.push(line(`Research for ${p.label} left no readable summary, so it is counted as failed.`)); continue }
    if (!s.ok) { activity.push(line(`Research failed for ${p.label}; nothing was written or guessed for it.`)); continue }
    const who = s.kind === 'prospect' ? 'Mindmake was' : 'ours was'
    const anywhere = typeof s.cited_any === 'number' ? ` and cited anywhere on ${s.cited_any}` : ''
    const tail = p.counts ? `; ${who} the first citation on ${plural(s.cited_first ?? 0, 'question')}${anywhere}` : '; aspirations are not counted toward questions cited first'
    activity.push(line(`Probed ${s.probed_questions} of ${plural(s.questions ?? 0, 'question')} for ${p.label} on ${plural(engines.length, 'assistant')}${tail}.`))
  }
  // How often each assistant searched before it answered, over every subject
  // that reported (counts only). An answer with no search is the assistant's
  // memory, not what a buyer's search would find.
  const byEngine = new Map<string, { probes: number; searched: number }>()
  for (const p of placed) {
    if (!p.s.ok || !p.s.engines) continue
    for (const [engine, c] of Object.entries(p.s.engines)) {
      const e = byEngine.get(engine) ?? { probes: 0, searched: 0 }
      e.probes += c.probes
      e.searched += c.searched
      byEngine.set(engine, e)
    }
  }
  const engineOrder = [...engines, ...[...byEngine.keys()].filter(e => !engines.includes(e)).sort()]
  // A gated engine (gemini) is measured beside the packets and never counted
  // toward questions cited first until Control Center opens it (docs/PACKET.md).
  const gated = new Set(placed.flatMap(p => (p.s.ok ? p.s.gated_engines ?? [] : [])))
  for (const engine of engineOrder) {
    const e = byEngine.get(engine)
    if (e) activity.push(line(`${engine}: searched on ${e.searched} of ${plural(e.probes, 'ask')}${gated.has(engine) ? '; measured beside the packets, not counted toward questions cited first' : ''}.`))
  }
  // The Claude Code lane runs on a subscription with a rolling limit, and
  // Gemini on a free tier this engine keeps a share of: say what each stopped.
  const sum = (k: 'probes_skipped_limit' | 'probes_limit_warning' | 'probes_fallback' | 'probes_skipped_free_tier') => placed.reduce((n, p) => n + (p.s.ok ? p.s[k] ?? 0 : 0), 0)
  const limited = sum('probes_skipped_limit')
  const fellBack = sum('probes_fallback')
  if (limited || fellBack) activity.push(line(`The Claude Code subscription's limit stopped ${plural(limited + fellBack, 'Claude ask')}${fellBack ? `; the paid API answered ${fellBack} of them` : ''}.`))
  // Past a warning threshold the subscription still serves, so these asks
  // were answered; said so the shared subscription's headroom is visible.
  const warned = sum('probes_limit_warning')
  if (warned) activity.push(line(`The Claude Code subscription was past its warning threshold on ${plural(warned, 'Claude ask')}, still answered.`))
  const freeTier = sum('probes_skipped_free_tier')
  if (freeTier) activity.push(line(`Gemini's free-tier share for this run was used up, so ${plural(freeTier, 'Gemini ask')} ${freeTier === 1 ? 'was' : 'were'} skipped.`))
  if (weekStart && weekStart < METHOD_NOTE_BEFORE_WEEK) activity.push(line(METHOD_NOTE))

  // Beside "any assistant" (the objective), how many questions a majority of
  // the assistants that answered cited first, on the first sample; and the
  // panel: each question's state with repeat samples on the contested ones.
  // Counts only, over the subjects that count.
  const countedOk = placed.filter(p => p.counts && p.s.ok)
  const majority = countedOk.filter(p => typeof p.s.cited_first_majority === 'number')
  if (majority.length) activity.push(line(`Cited first by a majority of the assistants that answered: ${plural(majority.reduce((n, p) => n + (p.s.cited_first_majority ?? 0), 0), 'question')}; by any assistant: ${plural(majority.reduce((n, p) => n + (p.s.cited_first ?? 0), 0), 'question')} (first sample only, so readings stay comparable).`))
  const paneled = countedOk.filter(p => p.s.panel)
  if (paneled.length) {
    const states = emptyStates()
    for (const p of paneled) for (const k of PANEL_STATES) states[k] += p.s.panel?.states[k] ?? 0
    const sampled = paneled.reduce((n, p) => n + (p.s.panel?.sampled ?? 0), 0)
    const answers = paneled.reduce((n, p) => n + (p.s.panel?.sample_answers ?? 0), 0)
    const capped = paneled.reduce((n, p) => n + (p.s.panel?.sample_skipped_cap ?? 0), 0)
    const stopped = capped ? `; the spend cap stopped ${plural(capped, 're-ask')}, and an assistant left on one answer of a re-sampled question cannot win it alone` : ''
    activity.push(line(`Panel across the counted subjects: ${PANEL_STATES.map(k => `${states[k]} ${k}`).join(', ')}. ${plural(sampled, 'contested question')} ${sampled === 1 ? 'was' : 'were'} re-asked up to twice more on each assistant that answered (${plural(answers, 'more answer')})${stopped}; won means first on ${WIN_SAMPLES} of ${SAMPLES_PER_CONTESTED} samples on one assistant.`))
    if (paneled.some(p => p.s.panel?.history === false)) activity.push(line('Control Center does not serve last run\'s panel back yet, so each question\'s history (won, lost, streak) stays unknown and no panel move is reported; a question first asked this run starts with its first week.'))
  }

  const skipped = placed.reduce((n, p) => n + (p.s.probes_skipped_cap ?? 0), 0)
  if (skipped > 0) {
    activity.push(line(`The spend cap stopped ${plural(skipped, 'question and assistant pair')} from being asked.`))
    holds.push({ reason: 'spend_cap_reached', detail: `${plural(skipped, 'question and assistant pair')} were not asked because the run reached its cap; the cap is a ceiling the run counts against.` })
  }
  // 1.22.0: the venture engines' requests this run asked, by count and product only (never a question).
  const served = [...new Set(input.summaries.flatMap(s => s.subjects.flatMap(x => (x.ok ? x.served ?? [] : []))))]
  if (served.length) {
    const products = [...new Set(placed.filter(p => p.s.ok && (p.s.served ?? []).length).map(p => p.label))]
    activity.push(line(`Asked ${plural(served.length, 'venture request')} for AI answers, word for word (${products.join(', ')}).`))
  }
  // A request not asked in full stays open in Control Center for a later run.
  // Said here, by product and count (never a question), so a request the cap
  // or a failed call stopped is not mistaken for one still waiting its turn.
  for (const p of placed) {
    const n = p.s.ok ? p.s.requests_unserved ?? 0 : 0
    if (n <= 0) continue
    const why = (p.s.probes_skipped_cap ?? 0) > 0 ? 'the spend cap stopped some of its questions' : 'a failed call or the probe limit left some of its questions unasked'
    const text = `${plural(n, 'venture request')} for ${p.label} ${n === 1 ? 'was' : 'were'} not asked in full: ${why}. ${n === 1 ? 'It stays' : 'They stay'} open for a later run.`
    activity.push(line(text))
    holds.push({ reason: 'answer_request_not_served', detail: text })
  }
  const next = nextScheduledRun(input.observedAt)
  activity.push(line(`Next scheduled research run: ${utc(next)} (Sundays at 04:00 UTC in odd ISO weeks).`))
  // The questions a verify run would re-ask in the off week (src/protocol/verify.ts):
  // the ones a venture shipped a page for or a kit Krish approved is in flight
  // on. The daily report and the plan job read this line back, so it goes early.
  const verifyLine = verifyIdsLine(verifyCandidates(placed))
  if (verifyLine) activity.push(line(verifyLine))

  // The objective: measured only when this was a full run and every subject
  // that counts reported. A partial count would read as a fall, not a gap.
  const counted = placed.filter(p => p.counts)
  const failedCount = counted.filter(p => !p.s.ok).length
  const winStart = weekStart ? fortnightStart(weekStart) : null
  const winEnd = input.observedAt.toISOString()
  let objective: ObjectiveReading
  if (input.planError) objective = missing('The subject list could not be read, so no question was probed this run.')
  else if (input.scope !== 'all') objective = missing('This run covered one subject, so it is not the fortnight count; the full research run measures it.', winStart, winEnd)
  else if (!counted.length) objective = missing('No venture or prospect was researched this run, so there is nothing to count.', winStart, winEnd)
  else if (failedCount) objective = missing(`Research failed for ${failedCount} of ${counted.length} counted subjects, so the count would be partial.`, winStart, winEnd)
  else objective = { key: OBJECTIVE_KEY, value: counted.reduce((n, p) => n + (p.s.cited_first ?? 0), 0), unit: 'questions', window_start: winStart, window_end: winEnd, timezone: 'UTC', availability: 'measured', reason: null }

  const proposals: Proposal[] = []
  if (skipped > 0) {
    // What each job's share would have needed to ask every pair, at the price
    // table's dearest probe: an estimate, rounded up to whole dollars.
    const jobs = input.summaries.length + placed.filter(p => p.noSummary).length
    const share = Math.max(0, ...input.summaries.map(sum => sum.spent_usd + sum.subjects.reduce((n, s) => n + (s.probes_skipped_cap ?? 0), 0) * sum.max_probe_usd))
    const amount = Math.max(Math.ceil(share * Math.max(jobs, 1)), Math.floor(input.totalCapUsd) + 1)
    proposals.push({
      proposal_id: SPEND_PROPOSAL_ID,
      title: `Raise the research spend cap to ${amount} USD a run`,
      why: `The cap stopped ${plural(skipped, 'question and assistant pair')} on this run. At the price table's estimates, a cap of ${amount} USD would have asked every one. Only Krish changes ${SPEND_TARGET}; this engine never spends past it.`,
      kind: 'advice',
      wall: 'spend',
      amount_usd: amount,
      channel: 'repository_variable',
      objective_key: OBJECTIVE_KEY,
      exact_payload: null,
      payload_sha256: spendPayloadSha(amount),
      evidence: [],
      close_condition: { event: 'spend_cap_raised', reference: SPEND_TARGET },
      expires_at: next.toISOString(),
    })
  }

  // One win kit on his list: the highest-priority candidate across the
  // ventures that are not held (ties on product, then query), passing over
  // any he has already decided. A held venture never carries one; the check
  // is repeated here so a summary cannot slip one past.
  const candidates = placed
    .filter(p => p.s.ok && p.s.kind === 'venture' && !p.s.held && p.s.kit_candidate && p.s.kit_candidate.exact_payload)
    .flatMap(p => [p.s.kit_candidate as KitCandidate, ...(p.s.kit_backups ?? [])])
    .filter(k => k && k.exact_payload)
    .sort((a, b) => b.priority - a.priority || a.product_slug.localeCompare(b.product_slug) || a.query_id.localeCompare(b.query_id))
  const decided = new Set((input.decisions ?? []).map(d => d.proposal_id))
  const open = candidates.filter(k => !decided.has(kitProposalId(k.product_slug, k.query_id)))
  const passedOver = new Set(candidates.filter(k => decided.has(kitProposalId(k.product_slug, k.query_id))).map(k => kitProposalId(k.product_slug, k.query_id))).size
  let kitAsk: Proposal | null = null
  let kitLine: ActivityLine | null = null
  if (input.kitsDelivered) {
    // The venture engines carry the kits now (features.aeo_kits_delivered):
    // no kit plan from here, and the check-ins below go on.
    if (candidates.length) activity.push(line('The venture engines carry the win kits now, so this engine proposes no kit plan itself; its check-ins on the plans Krish approved go on.'))
  } else if (candidates.length && input.scope !== 'all') {
    // A run of one subject is started by hand between the full runs; a kit
    // from it would sit beside the full run's with nothing to take either back.
    activity.push(line('A run of one subject puts no win kit on Krish\'s list; the full research run does.'))
  } else if (candidates.length && input.decisions === null) {
    holds.push({ reason: 'kit_not_proposed', detail: 'His decisions could not be read before this report, so no win kit is proposed: one he declined could come back.' })
  } else if (input.pendingKit) {
    // One kit at a time: the one already waiting is kept current, never joined by a second.
    const waiting = input.pendingKit
    const fresh = open.find(k => kitProposalId(k.product_slug, k.query_id) === waiting.proposal_id)
    kitAsk = fresh ? kitProposal(fresh, next) : waiting
    kitLine = line(fresh
      ? `The win kit already on Krish's list, for ${fresh.product_slug}, is kept current; no second kit is added.`
      : `The win kit already on Krish's list, for ${waiting.proposal_id.split(':')[2] ?? 'a venture'}, stays as it is until he decides; no second kit is added.`)
  } else if (open[0]) {
    kitAsk = kitProposal(open[0], next)
    kitLine = line(`One win kit is on Krish's list, for ${open[0].product_slug}; the next research run checks it.`)
  }
  if (kitAsk && kitLine) {
    proposals.push(kitAsk)
    activity.push(kitLine)
  }
  if (passedOver && input.scope === 'all' && !input.kitsDelivered) activity.push(line(`${plural(passedOver, 'win kit')} Krish already decided ${passedOver === 1 ? 'was' : 'were'} left off his list.`))

  // A failed brand check on a venture that is not held becomes one strategy
  // suggestion, only when no kit proposal was made this run, so his list
  // carries at most one AEO proposal a run besides check-ins. Never one he
  // already decided; never an answer's words.
  let brandAsk: Proposal | null = null
  let brandLine: ActivityLine | null = null
  if (!kitAsk && input.scope === 'all' && input.decisions !== null) {
    const decidedIds = new Set((input.decisions ?? []).map(d => d.proposal_id))
    for (const p of placed) {
      if (!p.s.ok || p.s.kind !== 'venture' || p.s.held || !p.s.product_slug) continue
      const failed = (p.s.brand_checks?.results ?? []).find(r => r.pass === false && !decidedIds.has(brandProposalId(p.s.product_slug as string, r.question)))
      if (!failed) continue
      brandAsk = brandProposal(p.s.product_slug, failed, next)
      brandLine = line(`One brand check that failed, for ${p.label}, is on Krish's list as a suggestion; no kit was proposed this run.`)
      break
    }
  }
  if (brandAsk && brandLine) {
    proposals.push(brandAsk)
    activity.push(brandLine)
  }

  // The autonomy loop for kits (GET-GOING Step 1). Each kit plan Krish
  // approved in the last six weeks, oldest first: won, it closes with
  // kit_won; otherwise a check-in says how its question did against the plan.
  // His No on a check-in stopped its plan for good; his change redirects it.
  // Only a full run checks in, from his decisions read before this report.
  const events: ReportEvent[] = []
  const at = input.observedAt.toISOString()
  const evidenceUrl = input.runPage && /^https:\/\/\S+$/.test(input.runPage) ? input.runPage.slice(0, 500) : null
  if (input.scope === 'all' && input.decisions) {
    const plans = kitPlans(input.decisions, input.observedAt)
    // kit_won closes a plan: one an earlier report closed gets no check-in and no second kit_won.
    const closedEarlier = closedByKitWon(input.lastReport)
    const closed = new Map<string, string>()
    const wonNow: string[] = []
    if (plans.stopped.length) activity.push(line(`${plural(plans.stopped.length, 'kit plan')} Krish stopped with a No on a check-in ${plans.stopped.length === 1 ? 'gets' : 'get'} no more check-ins.`))
    for (const plan of plans.held) holds.push({ reason: 'amendment_unverified', detail: `His approval of ${plan.plan_id} came in an amended version whose digest does not check out, so the plan is held: no check-ins and no kit in flight until a decision on it that checks out.` })
    let checkIns = 0
    let waiting = 0
    for (const plan of plans.open) {
      if (closedPlan(plan, closedEarlier)) { closed.set(plan.plan_id, closedEarlier.get(plan.plan_id) ?? ''); continue }
      if (plan.unverified) holds.push({ reason: 'amendment_unverified', detail: `His newest change to ${plan.plan_id} did not match its digest, so it is not acted on; ${plan.redirect ? 'his earlier change that checks out stands' : 'the plan stands as he approved it'}.` })
      const { tracked, why: notMeasured } = trackedFor(plan, placed)
      if (tracked?.panel.state === 'won') {
        events.push({ event: KIT_WON_EVENT, proposal_id: plan.plan_id, at, evidence_url: evidenceUrl })
        closed.set(plan.plan_id, at.slice(0, 10))
        const first = tracked.engines.filter(e => engineWon(e, tracked.sampled === true))
        wonNow.push(`${plan.product_slug}, cited first by ${first.map(e => `${e.engine} on ${e.first} of ${e.n} ${e.n === 1 ? 'sample' : 'samples'}`).join(', ') || 'an assistant'}`)
        continue
      }
      if (checkIns >= CHECKINS_MAX) { waiting++; continue }
      const kitText = payloadIn(input.lastReport, plan.plan_id)
      const lastCheckIn = payloadIn(input.lastReport, checkInId(plan.plan_id))
      const question = tracked?.question ?? questionIn(lastCheckIn) ?? questionIn(plan.redirect?.text) ?? questionIn(kitText)
      const gapAtApproval = gapClassIn(lastCheckIn) ?? gapClassIn(kitText) ?? gapClassIn(plan.redirect?.text)
      const payload = renderCheckIn({ plan, question, gapAtApproval, tracked, notMeasured, runId: input.runId, observedAt: input.observedAt, next })
      proposals.push(checkInProposal(plan, payload, question, next, evidenceUrl))
      checkIns++
    }
    if (wonNow.length) activity.push(line(`${plural(wonNow.length, 'kit plan')} won this run and closed with ${KIT_WON_EVENT} (run ${input.runId}): ${wonNow.join('; ')}.`))
    const carried = closedLine(closed)
    if (carried) activity.push(carried)
    if (checkIns) activity.push(line(`${plural(checkIns, 'check-in')} on the kit plans Krish approved ${checkIns === 1 ? 'is' : 'are'} on his list, oldest plan first.`))
    if (waiting) activity.push(line(`${plural(waiting, 'more open kit plan')} ${waiting === 1 ? 'waits' : 'wait'} for a later check-in (at most ${CHECKINS_MAX} a report).`))
  } else if (input.scope === 'all' && input.decisions === null) {
    holds.push({ reason: 'check_in_not_proposed', detail: 'His decisions could not be read before this report, so no check-in is proposed: a plan he stopped could be checked in on again.' })
  }

  // A brand check that passes now closes the brand proposal made for it
  // (brand_check_passed, its close_condition): one Krish approved, or one the
  // last full research report carried and he has not decided. A proposal is
  // for one question (its id carries the question's digest), so it closes
  // when that question's check passed on every engine that answered it. Not
  // when he declined it or it is done, and not twice in a row: the last
  // report's own event counts as sent.
  if (input.decisions !== null) {
    const latest = latestDecisions(input.decisions)
    const lastProposals = new Set((input.lastReport && Array.isArray(input.lastReport.proposals) ? (input.lastReport.proposals as Proposal[]) : []).map(p => p?.proposal_id))
    const sentBefore = new Set((input.lastReport && Array.isArray(input.lastReport.events) ? (input.lastReport.events as ReportEvent[]) : []).filter(e => e?.event === BRAND_FIXED_EVENT).map(e => e.proposal_id))
    const fixed: string[] = []
    for (const p of placed) {
      if (!p.s.ok || p.s.kind !== 'venture' || !p.s.product_slug) continue
      for (const r of p.s.brand_checks?.results ?? []) {
        if (r.pass !== true) continue
        const id = brandProposalId(p.s.product_slug, r.question)
        const d = latest.get(id)
        const made = d ? d.decision === 'approved' : lastProposals.has(id)
        if (!made || sentBefore.has(id) || fixed.includes(id)) continue
        events.push({ event: BRAND_FIXED_EVENT, proposal_id: id, at, evidence_url: evidenceUrl })
        fixed.push(id)
      }
    }
    if (fixed.length) {
      const byProduct = new Map<string, number>()
      for (const id of fixed) { const product = id.split(':')[2] ?? 'a venture'; byProduct.set(product, (byProduct.get(product) ?? 0) + 1) }
      activity.push(line(`${plural(fixed.length, 'brand check proposal')} closed with ${BRAND_FIXED_EVENT}, ${fixed.length === 1 ? 'its check' : 'their checks'} passing on every assistant that answered this run: ${[...byProduct].map(([k, n]) => `${k} (${n})`).join(', ')}.`))
    }
  }

  // Panel moves this run, for the subjects that count: a question that became
  // won (first on 2 of 3 samples on one assistant, or its one sample) or was
  // lost. One event each, as the report schema allows (kit_won first), and
  // one line for them all with the run's evidence: engines and sample counts
  // only. The count of events past the report's limit goes first, so the
  // 40-line cap can never cut it.
  const moved: Array<{ label: string; won: number; lost: number }> = []
  const wonEngines = new Set<string>()
  let firstAll = 0
  let samplesAll = 0
  for (const p of placed) {
    const panel = p.counts && p.s.ok ? p.s.panel : undefined
    if (!panel || (!panel.won_now.length && !panel.lost_now.length)) continue
    for (const _ of panel.won_now) events.push({ event: QUESTION_WON_EVENT, proposal_id: null, at, evidence_url: evidenceUrl })
    for (const _ of panel.lost_now) events.push({ event: QUESTION_LOST_EVENT, proposal_id: null, at, evidence_url: evidenceUrl })
    for (const c of panel.won_now) { for (const e of c.engines) wonEngines.add(e); firstAll += c.first; samplesAll += c.samples }
    moved.push({ label: p.label, won: panel.won_now.length, lost: panel.lost_now.length })
  }
  // Mentions acquired and lost on the cited pages since the sheet Control
  // Center served (src/pipeline/48-cited-pages.ts): one event each, and one
  // line in counts. Without a served sheet there is no transition.
  const mentionMoves: Array<{ label: string; acquired: number; lost: number; since: string | null }> = []
  for (const p of placed) {
    const c = p.s.ok && p.s.kind === 'venture' ? p.s.cited_pages : undefined
    if (!c?.acquired && !c?.lost) continue
    const a = Object.values(c.acquired ?? {}).reduce((n, x) => n + (x ?? 0), 0)
    const l = Object.values(c.lost ?? {}).reduce((n, x) => n + (x ?? 0), 0)
    for (let k = 0; k < a; k++) events.push({ event: MENTION_ACQUIRED_EVENT, proposal_id: null, at, evidence_url: evidenceUrl })
    for (let k = 0; k < l; k++) events.push({ event: MENTION_LOST_EVENT, proposal_id: null, at, evidence_url: evidenceUrl })
    if (a || l) mentionMoves.push({ label: p.label, acquired: a, lost: l, since: typeof c.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.since) ? c.since : null })
  }
  if (events.length > EVENTS_MAX) activity.push(line(`${events.length - EVENTS_MAX} ${mentionMoves.length ? 'panel and mention events' : 'panel events'} past the report's ${EVENTS_MAX} are counted here only.`))
  if (mentionMoves.length) {
    const a = mentionMoves.reduce((n, m) => n + m.acquired, 0)
    const l = mentionMoves.reduce((n, m) => n + m.lost, 0)
    // The served sheet is an earlier run's: named by its research week, never this run's id.
    const weeks = [...new Set(mentionMoves.map(m => m.since).filter((w): w is string => !!w))].sort()
    const which = weeks.length ? ` from the research ${weeks.length === 1 ? 'week' : 'weeks'} of ${weeks.join(' and ')}` : ''
    activity.push(line(`Cited-page mentions since the sheet Control Center served${which}: ${plural(a, 'mention')} acquired, ${l} lost. ${mentionMoves.map(m => `${m.label}: ${m.acquired} acquired, ${m.lost} lost`).join('; ')}.`))
  }
  if (moved.length) {
    const won = moved.reduce((n, m) => n + m.won, 0)
    const lost = moved.reduce((n, m) => n + m.lost, 0)
    const head = `Panel moves this run (${input.runId}): ${plural(won, 'question')} became won${won ? ` (first on ${firstAll} of ${samplesAll} answers${wonEngines.size ? `, by ${[...wonEngines].join(', ')}` : ''})` : ''}, ${plural(lost, 'question')} lost.`
    // By subject, as many as fit one line.
    let text = `${head} By subject:`
    let shown = 0
    for (const m of moved) {
      const part = `${shown ? ';' : ''} ${m.label}: ${m.won} won, ${m.lost} lost`
      const rest = moved.length - shown - 1
      if ((text + part).length + (rest ? ` and ${rest} more.`.length : 1) > 500) break
      text += part
      shown++
    }
    text += shown < moved.length ? `${shown ? ';' : ''} and ${moved.length - shown} more.` : '.'
    activity.push(line(text))
  }

  // Why the questions are not won, by gap class (counts only): each venture
  // by name, the prospects together (their "ours" is Mindmake's pages).
  // Last, so the 40-line cap can only ever cut this detail.
  const classLine = (g: Record<string, number>) => {
    const parts = [`${g.won} won`, `${g.cited_not_first} cited not first`, `${g.retrieved_not_cited} retrieved not cited`, `${g.not_retrieved} with a page not retrieved`, `${g.no_page} with no page`]
    if (g.unknown) parts.push(`${g.unknown} not answered`)
    return parts.join(', ')
  }
  // Each venture's gap classes, then its cited pages, AI referrals and brand
  // checks (src/pipeline/48, 63 and 42), counts only and never a URL, on one
  // line a venture when they fit, so the line count does not grow.
  for (const p of placed) {
    if (!p.s.ok || p.s.kind !== 'venture') continue
    const g = p.s.gap_classes
    const measures = ventureMeasures(p.label, p.s.cited_pages, p.s.outcomes, p.s.brand_checks)
    const why = g ? `Why ${p.label}'s questions are not won: ${classLine(g)}; ${p.s.held ? 'held, so no kit' : `${plural(p.s.kits ?? 0, 'win kit')} prepared`}.` : null
    const alone = measures ? `For ${p.label}: ${measures}` : null
    const both = why && measures ? `${why} ${measures}` : why ?? alone
    if (both && both.length <= 500) activity.push(line(both))
    else {
      if (why) activity.push(line(why))
      if (alone) activity.push(line(alone))
    }
  }
  const prospects = placed.filter(p => p.s.ok && p.s.kind === 'prospect' && p.s.gap_classes)
  if (prospects.length) {
    const sum: Record<string, number> = {}
    for (const p of prospects) for (const [k, v] of Object.entries(p.s.gap_classes ?? {})) sum[k] = (sum[k] ?? 0) + v
    activity.push(line(`Why the questions of ${plural(prospects.length, 'prospect')} are not won by Mindmake's pages: ${classLine(sum)}.`))
  }
  // The site reader, counts only: fetch only, never a script run.
  const site = placed.reduce((acc, p) => {
    const x = p.s.ok ? p.s.site : undefined
    if (x) { acc.pages += x.pages; acc.hosts += x.hosts; acc.gates += x.gates_failed; acc.cited += x.cited_read; acc.n++ }
    return acc
  }, { pages: 0, hosts: 0, gates: 0, cited: 0, n: 0 })
  // Our hosts are read once a run and shared, so these sum each subject's
  // view: a host two subjects share counts once for each, and says so.
  if (site.n) activity.push(line(`The diagnoses used ${plural(site.pages, 'page')} of our own from ${plural(site.hosts, 'host audit')} (each host read once a run; one shared by subjects counts once for each), with ${plural(site.gates, 'failed site gate')} among them, and read ${plural(site.cited, 'page')} cited first, fetch only, never a script run.`))

  const degraded = !!input.planError || placed.some(p => !p.s.ok)

  // Krish's instruction (1.20.0). This run is the paid research the daily
  // run's ack asked for, so it moves the instruction on: started when the
  // research ran, blocked when it did not. It never claims done: the research
  // probes Control Center's subject list and never reads his words, so done
  // is his to say with Clear.
  const acks: InstructionAck[] = []
  const ctx = input.state
  if (ctx?.instruction) {
    const id = ctx.instruction.id
    const day = dayInWords(input.observedAt)
    activity.unshift(line(ctx.seen ? `Krish's instruction ${id} was open during this research run.` : `Received Krish's instruction ${id} in this research run.`))
    if (!ctx.seen) acks.push(ack(ctx, input.observedAt, 'received', `Read in the research run on ${day}.`))
    const researched = placed.filter(p => p.s.ok).length
    const tail = researchTail(ctx.instruction, input.observedAt, next)
    const short = `Press ${START_BY_HAND}.`
    if (input.planError) {
      const head = `The research run on ${day} could not read the subject list, so nothing was researched.`
      acks.push(ack(ctx, input.observedAt, 'blocked', ackLine(`${head} ${tail}`, `${head} ${short}`)))
    } else if (degraded) {
      const head = `The research run on ${day} failed for ${placed.length - researched} of ${placed.length} subjects.`
      acks.push(ack(ctx, input.observedAt, 'blocked', ackLine(`${head} ${tail}`, `${head} ${short}`)))
    } else acks.push(ack(ctx, input.observedAt, 'started', `A paid research run finished on ${day} with this instruction open: ${researched} of ${placed.length} subjects researched. It probes Control Center's subject list, never the instruction's words.`))
  }
  const state = stateFor(input, objective, acks)
  const report = envelope(input, degraded ? 'degraded' : 'ready', [objective], activity, proposals, holds, state, served, events)
  if (validateReport(report).ok) return report
  // A kit or a check-in is built from pages, answers and his own words that
  // this engine does not write. If one would make the report one Control
  // Center refuses, it is held back and the report still lands: the
  // fortnight's reading matters more than one ask.
  const extra = [...holds]
  let keep = proposals
  let lines = activity
  if (kitAsk) {
    extra.push({ reason: 'kit_not_proposed', detail: `The top win kit, for ${kitAsk.proposal_id.split(':')[2]}, carried text a report may not carry, so it is not on his list this run.` })
    keep = keep.filter(p => p !== kitAsk)
    lines = lines.filter(a => a !== kitLine)
  }
  if (brandAsk) {
    const alone = envelope(input, 'ready', [objective], [], [brandAsk], [], null)
    if (!validateReport(alone).ok) {
      extra.push({ reason: 'brand_check_not_proposed', detail: `The brand check proposal for ${brandAsk.proposal_id.split(':')[2]} carried text a report may not carry, so it is not on his list this run.` })
      keep = keep.filter(p => p !== brandAsk)
      lines = lines.filter(a => a !== brandLine)
    }
  }
  for (const p of keep.filter(x => x.stage === 'check_in')) {
    const alone = envelope(input, 'ready', [objective], [], [p], [], null)
    if (validateReport(alone).ok) continue
    extra.push({ reason: 'check_in_not_proposed', detail: `The check-in on ${p.parent_proposal_id ?? 'a kit plan'} carried text a report may not carry, so it is not on his list this run.` })
    keep = keep.filter(x => x !== p)
  }
  return envelope(input, degraded ? 'degraded' : 'ready', [objective], lines, keep, extra, state, served, events)
}

/** The research run_id the dispatch looks for: one full run a day. */
export const researchRunId = (date: string) => `aeo:${date}:research`

export interface StoredResearch { run_id: string; accepted_at: string; report: Record<string, unknown> }

export interface DirectiveInput extends Envelope {
  /** `instruction` (1.20.0) is Krish's open instruction by id; the report acts on it only through `state`, when the directive serves the engine's state. */
  directive: { directive_id: string; chosen_by: string; decisions_since: DecisionLite[]; instruction?: InstructionRef | null } | null
  /**
   * His decisions read with a GET before this report, back past the last
   * research report: the directive's decisions_since covers seven days and a
   * kit lives about fourteen, so a decline on day one still drops it on day
   * eight. Merged with decisions_since, the latest per proposal winning.
   */
  decisions?: DecisionLite[] | null
  directiveError: string | null
  /** The newest full research report found, or null. */
  last: StoredResearch | null
  lastError: string | null
  /** features.aeo_kits_delivered: the venture engines carry the kits, so an undecided kit plan is no longer carried here. */
  kitsDelivered?: boolean
  /**
   * His decisions on the verify plan, its check-in and its go-lives, read
   * back to VERIFY_EPOCH so a No is never forgotten (src/protocol/verify.ts).
   * Null: they could not be read, so nothing about the verify lane is
   * proposed. Undefined: the daily report reads `decisions` instead.
   */
  verifyDecisions?: DecisionLite[] | null
  /**
   * The verify reports read back for the recent off-week Sundays
   * (verifySundaysToRead): a stored one means that Sunday's verify run ran.
   * Undefined: none was read.
   */
  verifyRuns?: VerifyRunRead[] | null
}

/** The verify plan's check-in: behind strategy, naming the plan, his "On track?". */
export function verifyCheckInProposal(payload: string, expiresAt: Date): Proposal {
  return {
    stage: 'check_in',
    parent_proposal_id: VERIFY_PLAN_ID,
    proposal_id: VERIFY_CHECKIN_ID,
    title: 'On track? The off-week verify plan',
    why: 'How the verify plan Krish approved is going: each off-week Sunday it covers, run or skipped and why, the questions re-asked and the panel moves, in counts. His yes keeps it going, and his No stops the plan for good. This engine can take only a change to the amount: a change to other words holds the plan.',
    kind: 'advice',
    wall: 'strategy',
    amount_usd: null,
    channel: null,
    objective_key: null,
    exact_payload: payload,
    payload_sha256: wordsPayloadSha(payload),
    evidence: [],
    close_condition: { event: CHECK_IN_EVENT, reference: VERIFY_PLAN_ID },
    expires_at: expiresAt.toISOString(),
  }
}

/**
 * The verify lane's asks on the daily report (src/protocol/verify.ts): the
 * standing plan, once there is a shipped question or a kit plan he approved,
 * and never again after his No; with the plan approved, on the Thursday to
 * Saturday before an even-week Sunday, that Sunday's go-live behind spend (a
 * go-live he has decided is not asked again); and, while the plan is open,
 * its check-in, after each off-week Sunday that ran or was skipped and at
 * least weekly. After an off-week Sunday whose go-live he approved and no
 * verify report is stored, a line and a hold say it did not run, with the
 * reason when the records say it, else unknown. Nothing here runs or spends:
 * the research workflow's plan job does, on his approved decision.
 */
export function verifyAsks(i: { decisions: readonly DecisionLite[] | null; last: StoredResearch | null; openKitPlans: number; at: Date; next: Date; runs?: readonly VerifyRunRead[] | null }): { proposals: Proposal[]; lines: ActivityLine[]; holds: Hold[] } {
  const out: { proposals: Proposal[]; lines: ActivityLine[]; holds: Hold[] } = { proposals: [], lines: [], holds: [] }
  // Unread decisions could hide his No: nothing is proposed.
  if (!i.decisions) return out
  const decisions = i.decisions as PlanDecision[]
  const plan = verifyPlanState(decisions)
  const ids = verifyIdsIn(i.last?.report)
  // The last off-week Sunday: an approved go-live with no verify report stored did not run.
  const recent = pastOffWeekSundays(i.at, SKIP_LOOKBACK_DAYS)[0]
  if (recent && goLiveDecisionAt(decisions, recent)?.decision === 'approved') {
    const [o] = sundayOutcomes([recent], decisions, i.runs, i.last)
    if (o.state === 'skipped') {
      const why = o.reason === 'unknown' ? 'why is not known to this engine (the workflow did not start, failed, or its research job refused)' : `skipped: ${o.reason}`
      out.lines.push(line(`Krish approved the verify run for ${recent}, and no verify report for it is stored, so it did not run (${why}).`))
      out.holds.push({ reason: (o.reason ?? 'unknown').slice(0, 200), detail: `The verify go-live ${verifyGoLiveId(recent)} was approved and did not run: no verify report for ${recent} is stored. Reason: ${o.reason === 'unknown' ? 'unknown' : o.reason}. It is not run later: a go-live runs only on its own Sunday.` })
    } else if (o.state === 'unread') {
      out.lines.push(line(`Krish approved the verify run for ${recent}, and its verify report could not be read back (${o.reason}), so whether it ran is not known.`))
    }
  }
  if (plan.state === 'declined') { out.lines.push(line('Krish declined the verify plan, so no off-week verify run is proposed, now or later.')); return out }
  if (plan.state === 'done') return out
  if (plan.state === 'held') {
    out.holds.push({ reason: 'amendment_unverified', detail: 'His approval of the verify plan came in an amended version whose digest does not check out, so no verify run is proposed until a decision on it that checks out.' })
    return out
  }
  if (plan.state === 'held_words') {
    out.holds.push({ reason: 'verify_plan_amended_words', detail: 'His change to the verify plan changes more than its amount, and this engine can take only an amount change, so the plan is held: no go-live is proposed and no verify run goes ahead until he approves the plan as proposed, or with only its amount changed.' })
    return out
  }
  if (plan.state === 'none' || plan.state === 'stale') {
    if (!ids.length && !i.openKitPlans) return out
    out.proposals.push(verifyPlanProposal(i.next))
    out.lines.push(line(`The standing verify plan is on Krish's list: ${ids.length ? plural(ids.length, 'question') : 'no question yet'} tracked as shipped or a kit in flight by the last full research run, and ${plural(i.openKitPlans, 'kit plan')} he approved.`))
    return out
  }
  // The check-in, while the plan is open: after an off-week Sunday that ran or
  // was skipped, and at least weekly. The same week and Sundays render the
  // same words, so it waits on his list as one ask; one he answered is not
  // asked again.
  if (plan.state === 'open' && plan.decision) {
    const covered = [...checkInSundays(plan.decision.decided_at, i.at)].sort()
    const outcomes = sundayOutcomes(covered, decisions, i.runs, i.last)
    const event = outcomes.some(o => o.state === 'ran' || o.state === 'skipped')
    if (planWeek(plan.decision.decided_at, i.at).week >= 1 || event) {
      const payload = renderVerifyCheckIn({ plan, at: i.at, outcomes, nextSunday: nextOffWeekSunday(i.at) })
      const ask = verifyCheckInProposal(payload, i.next)
      const answered = latestDecisions(i.decisions).get(VERIFY_CHECKIN_ID)
      if (!answered || answered.payload_sha256 !== ask.payload_sha256) {
        out.proposals.push(ask)
        out.lines.push(line(`The verify plan's check-in is on Krish's list: ${plural(outcomes.filter(o => o.state === 'ran').length, 'verify run')} done and ${outcomes.filter(o => o.state === 'skipped').length} skipped in the Sundays it covers.`))
      }
    }
  }
  const sunday = goLiveSunday(i.at)
  if (!sunday) return out
  const id = verifyGoLiveId(sunday)
  const mine = i.decisions.filter(d => d.proposal_id === id)
  if (mine.length) {
    const d = mine.reduce((a, b) => (Date.parse(b.decided_at) > Date.parse(a.decided_at) ? b : a))
    out.lines.push(line(`Krish ${d.decision} the verify run for ${sunday}${d.decision === 'approved' ? '; it runs once, at that Sunday\'s scheduled slot, only if its digest still matches' : ''}.`))
    return out
  }
  if (!ids.length) { out.lines.push(line(`The last full research run tracked no question as shipped or a kit in flight, so no verify run is proposed for ${sunday}.`)); return out }
  const go = buildGoLive(sunday, ids, plan.cap, i.last ? { run_id: i.last.run_id } : null)
  if (!go) { out.lines.push(line(`No question fits the verify plan's cap of ${plan.cap} USD, so no verify run is proposed for ${sunday}.`)); return out }
  out.proposals.push(go.proposal)
  out.lines.push(line(`The verify run for ${sunday} is on Krish's list: ${plural(go.payload.query_ids.length, 'question')}, ${go.payload.samples} samples on every engine, up to ${go.payload.amount_usd} USD. It runs only on his yes, and never counts in the share.`))
  return out
}

/**
 * The weekly check-in the daily report renews while a plan is open
 * (AGENTS.md: at least once a week), CHECKIN_WEEK_DAYS or more after the last
 * research run. Nothing is measured between research runs, so it carries that
 * run's check-in under a header naming the week; the same week renders the
 * same words, so it waits on his list without coming back to him every day.
 */
/** Whole UTC calendar days from a to b: the daily wake on the seventh day after a research run counts seven, whatever the hours. */
export function daysBetween(a: Date, b: Date): number {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.round((day(b) - day(a)) / DAY_MS)
}

export function weeklyCheckIn(plan: KitPlan, research: { run_id: string; observed_at: Date; report: Record<string, unknown> }, at: Date, next: Date): { payload: string; question: string | null } {
  const days = daysBetween(research.observed_at, at)
  const week = Math.max(1, Math.floor(days / CHECKIN_WEEK_DAYS))
  const from = new Date(research.observed_at.getTime() + week * CHECKIN_WEEK_DAYS * DAY_MS)
  const body = payloadIn(research.report, checkInId(plan.plan_id))
  const kitText = payloadIn(research.report, plan.plan_id)
  const question = questionIn(body) ?? questionIn(plan.redirect?.text) ?? questionIn(kitText)
  const head = `Weekly check-in for the week from ${dayInWords(from)}: nothing is measured between research runs, so the figures are those of the research run on ${dayInWords(research.observed_at)} (${research.run_id}); the next research run is ${dayInWords(next)}.`
  // Why the last research report carries no check-in on it, by cause: he
  // approved it after that run, or the run held it back under its limit of
  // check-ins, or the run carried none on it for another reason.
  const checkIns = Array.isArray(research.report.proposals) ? (research.report.proposals as Proposal[]).filter(p => p && typeof p.proposal_id === 'string' && p.proposal_id.startsWith(CHECKIN_PREFIX)).length : 0
  const why = Date.parse(plan.approved_at) > research.observed_at.getTime()
    ? 'No research run has measured it since he approved it.'
    : checkIns >= CHECKINS_MAX
      ? `The research run on ${dayInWords(research.observed_at)} held its check-in back: a report carries at most ${CHECKINS_MAX}, oldest plan first. The next research run reports it.`
      : `The research run on ${dayInWords(research.observed_at)} carried no check-in on it, so its figures are not in the report this run reads; the next research run reports them.`
  const rest = body ?? [
    `Check-in on the win kit plan ${plan.plan_id}`,
    `Product: ${plan.product_slug}`,
    `Question: ${question ?? 'not known to this run (asked by its query id only)'}`,
    `Approved: ${dayInWords(new Date(plan.approved_at))}`,
    `- Gap class at approval: ${gapClassIn(kitText) ?? gapClassIn(plan.redirect?.text) ?? 'not known (the plan as approved is not in the reports this run read)'}`,
    why,
    `Next: the research run of ${dayInWords(next)} asks it ${SAMPLES_PER_CONTESTED} times on each assistant; a first citation on ${WIN_SAMPLES} of ${SAMPLES_PER_CONTESTED} samples on one assistant closes the plan with ${KIT_WON_EVENT}.`,
    'His yes keeps the plan going, his change redirects it, and his No stops it for good.',
  ].join('\n')
  const newer = plan.redirect && Date.parse(plan.redirect.at) > research.observed_at.getTime() && plan.redirect.text
    ? `\n\nHis redirect of ${dayInWords(new Date(plan.redirect.at))}, which the next research run works to:\n${plan.redirect.text}`
    : ''
  const text = `${head}\n\n${rest}${newer}`.replace(/\u2014|\u2013/g, ',')
  return { payload: text.length <= 8000 ? text : `${text.slice(0, 8000 - 20)}\n(cut to fit)`, question }
}

function carriedObjective(i: DirectiveInput, nextRun: Date): ObjectiveReading {
  const next = utc(nextRun)
  if (i.lastError) return missing(`The last research report could not be read back (${i.lastError}); the next research run is ${next}.`)
  if (!i.last) return missing(`No full research run has reported in the last ${STALE_DAYS} days, and only a research run measures this; the next is ${next}.`)
  const objs = Array.isArray(i.last.report.objectives) ? (i.last.report.objectives as ObjectiveReading[]) : []
  const o = objs.find(x => x && x.key === OBJECTIVE_KEY)
  if (!o) return missing(`The last research report (${i.last.run_id}) carried no reading for this objective.`)
  const at = Date.parse(o.window_end ?? String(i.last.report.observed_at ?? ''))
  const reading: ObjectiveReading = { key: OBJECTIVE_KEY, value: o.value ?? null, unit: o.unit || 'questions', window_start: o.window_start ?? null, window_end: o.window_end ?? null, timezone: o.timezone ?? 'UTC', availability: o.availability, reason: o.reason ?? null }
  if (o.availability !== 'measured') return { ...reading, value: o.availability === 'missing' ? null : reading.value, reason: `From the research run ${i.last.run_id}: ${o.reason ?? 'not measured'}`.slice(0, 500) }
  if (!Number.isFinite(at) || i.observedAt.getTime() - at > STALE_DAYS * DAY_MS) return { ...reading, availability: 'stale', reason: `Measured by the research run ${i.last.run_id}, more than ${STALE_DAYS} days ago.` }
  return reading
}

export function buildDirectiveReport(i: DirectiveInput): EngineReport {
  const activity: ActivityLine[] = []
  // On a research Sunday this wake lands after the 04:00 slot and hours
  // before GitHub starts the run, so today's run is still the one to come
  // until it has reported.
  const reportedToday = i.last?.run_id === researchRunId(i.observedAt.toISOString().slice(0, 10))
  const next = upcomingRun(i.observedAt, reportedToday)
  const pendingToday = next.getTime() <= i.observedAt.getTime()
  if (i.last) activity.push(line(`Last full research run reported at ${utc(new Date(String(i.last.report.observed_at ?? i.last.accepted_at)))} (${i.last.run_id}).`))
  else if (i.lastError) activity.push(line(`Could not read back the last research report (${i.lastError}).`))
  else activity.push(line(`No full research run has reported in the last ${STALE_DAYS} days.`))
  activity.push(line(pendingToday
    ? `Today's scheduled research run (the ${utc(next)} slot) has not reported yet; GitHub starts scheduled runs hours late.`
    : `Next scheduled research run: ${utc(next)} (Sundays at 04:00 UTC in odd ISO weeks).`))
  if (i.directive) activity.push(line(`Read directive ${i.directive.directive_id} (next action chosen by ${i.directive.chosen_by || 'rule'}). A directive never starts paid research here; only the fortnightly schedule and a run Krish starts by hand do.`))
  else activity.push(line(`Could not read today's directive (${i.directiveError ?? 'unknown'}); no work was started from it.`))

  // Walled asks from the last research report stay in front of him until he
  // answers them or they expire. Same id and same payload, so nothing changes
  // unless he has decided.
  const decided = latestDecisions(i.directive?.decisions_since, i.decisions)
  // The kit plans his decisions leave open, stopped or done (src/schema/kit.ts).
  const plans = kitPlans([...(i.directive?.decisions_since ?? []), ...(i.decisions ?? [])] as PlanDecision[], i.observedAt)
  // A plan the last research report closed with kit_won (or carried as closed) is done here too.
  const wonClosed = closedByKitWon(i.last?.report)
  const open = plans.open.filter(p => !closedPlan(p, wonClosed))
  const openPlans = new Set(open.map(p => p.plan_id))
  const closedPlans = new Set([...plans.stopped, ...plans.done, ...plans.held, ...plans.open.filter(p => !openPlans.has(p.plan_id))].map(p => p.plan_id))
  // Only a full read of his decisions can say a plan is no longer open; with
  // the directive's seven days alone, only a stop or a close it shows counts.
  const plansKnown = Array.isArray(i.decisions)
  const carried: Proposal[] = []
  const lastProposals = i.last && Array.isArray(i.last.report.proposals) ? (i.last.report.proposals as Proposal[]) : []
  for (const p of lastProposals) {
    if (!p || p.wall === 'none') continue
    // A check-in goes only while its plan is open: his No on any version
    // stopped it for good, and a won or done plan needs none.
    if (p.proposal_id.startsWith(CHECKIN_PREFIX)) {
      const parent = planIdOfCheckIn(p.proposal_id)
      if (closedPlans.has(parent) || (plansKnown && !openPlans.has(parent))) continue
    }
    // The venture engines carry the kits now: an undecided kit plan is not carried.
    if (i.kitsDelivered && p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX) && !decided.has(p.proposal_id)) continue
    const d = decided.get(p.proposal_id)
    if (d) {
      const same = d.payload_sha256 === p.payload_sha256
      const isKit = p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX)
      activity.push(line(same
        ? `Krish ${d.decision} "${p.title}" on ${d.decided_at.slice(0, 10)}. This engine still changes nothing behind a wall; ${p.wall === 'spend' ? `the cap moves only when he sets ${SPEND_TARGET}` : isKit ? 'a kit ships through the product\'s build session or its growth engine, never from here' : 'the action stays his'}.`
        : `Krish ${d.decision} an earlier version of "${p.title}"; the current payload differs, so it is still his to decide.`))
      if (same) continue
    }
    if (p.expires_at && Date.parse(p.expires_at) <= i.observedAt.getTime()) continue
    carried.push(p)
  }

  if (i.kitsDelivered && lastProposals.some(p => p?.proposal_id?.startsWith(KIT_PROPOSAL_PREFIX) && !decided.has(p.proposal_id))) {
    activity.push(line('The venture engines carry the win kits now, so the kit plan Krish has not decided is no longer carried here; its check-ins go on once he approves one.'))
  }

  // The weekly check-in (AGENTS.md: at least one a week while a plan is
  // open): a week or more after the last research run, each open plan's
  // check-in is renewed under that week's header, oldest plan first. One he
  // already answered for this week is not asked again. On a research Sunday
  // before today's run has reported, the check-ins wait for it: the research
  // run checks in itself, hours later, with figures of its own.
  if (i.last && open.length && !pendingToday) {
    const observed = new Date(String(i.last.report.observed_at ?? i.last.accepted_at))
    if (Number.isFinite(observed.getTime()) && daysBetween(observed, i.observedAt) >= CHECKIN_WEEK_DAYS) {
      let renewed = 0
      for (const plan of open) {
        if (renewed >= CHECKINS_MAX) break
        const weekly = weeklyCheckIn(plan, { run_id: i.last.run_id, observed_at: observed, report: i.last.report }, i.observedAt, next)
        const proposal = checkInProposal(plan, weekly.payload, weekly.question, next)
        const answered = decided.get(proposal.proposal_id)
        const at = carried.findIndex(p => p.proposal_id === proposal.proposal_id)
        if (answered && answered.payload_sha256 === proposal.payload_sha256) { if (at >= 0) carried.splice(at, 1); continue }
        if (at >= 0) carried[at] = proposal
        else carried.push(proposal)
        renewed++
      }
      if (renewed) activity.push(line(`${plural(renewed, 'weekly check-in')} on the kit plans Krish approved ${renewed === 1 ? 'is' : 'are'} on his list, a week or more after the last research run.`))
    }
  }

  // The verify lane: the standing plan, and an off week's go-live.
  const verify = verifyAsks({ decisions: i.verifyDecisions === undefined ? (i.decisions === null ? null : [...(i.directive?.decisions_since ?? []), ...(i.decisions ?? [])]) : i.verifyDecisions === null ? null : [...(i.directive?.decisions_since ?? []), ...i.verifyDecisions], last: i.last, openKitPlans: open.length, at: i.observedAt, next, runs: i.verifyRuns })
  for (const p of verify.proposals) if (!carried.some(c => c.proposal_id === p.proposal_id)) carried.push(p)
  activity.push(...verify.lines)

  const objective = carriedObjective(i, next)
  const status: ReportStatus = objective.availability === 'measured' && i.directive ? 'ready' : 'degraded'

  // Krish's instruction (1.20.0), first in the report. This run reads and
  // reports only, and the cost wall keeps paid research off a directive, so
  // the first time it is read it is acked received and then blocked on the
  // one thing that unblocks it: a paid research run, the next scheduled one
  // if it comes before the instruction lapses, or one he starts by hand.
  // After that, a line says it is still open and no ack repeats.
  const acks: InstructionAck[] = []
  const ctx = i.state
  if (ctx?.instruction) {
    const id = ctx.instruction.id
    if (ctx.seen) {
      activity.unshift(line(`Krish's instruction ${id} is still open; this engine acked it in an earlier report.`))
    } else {
      const needs = needsResearch(ctx.instruction, i.observedAt, next)
      activity.unshift(line(`Received Krish's instruction ${id}. This daily run reads and reports only. ${needs}`))
      acks.push(ack(ctx, i.observedAt, 'received', `Read in the daily run on ${dayInWords(i.observedAt)}, which reads and reports only.`))
      acks.push(ack(ctx, i.observedAt, 'blocked', needs))
    }
  }
  return envelope(i, status, [objective], activity, carried, verify.holds, stateFor(i, objective, acks, next))
}

// ---------- the verify run's report (src/protocol/verify.ts) ----------

export interface VerifyReportInput extends Envelope {
  /** The slugs the plan job handed out: the subjects that hold one of the payload's questions. */
  expected: string[]
  summaries: RunSummary[]
  /** The payload the plan job ran, as it wrote it; null when it could not be read. */
  payload: VerifyPayload | null
  planError: string | null
  /** This workflow run's public page: the closing event's evidence. */
  runPage?: string | null
}

/**
 * The verify run's report: the go-live's closing event (`verify_ran`, naming
 * `aeo:verify:<date>`, with the workflow run as its evidence), question_won
 * and question_lost for each question whose panel moved against the last
 * research panel, and one line of counts: the run, the questions asked of
 * the payload's, the samples and the engines. No objective: a verify run
 * never measures queries_cited_first, which stays the research run's. No
 * proposal. Never a question, an answer or a URL.
 */
export function buildVerifyReport(input: VerifyReportInput): EngineReport {
  const placed = place({ ...input, scope: 'all', totalCapUsd: 0 })
  const activity: ActivityLine[] = []
  const holds: Hold[] = []
  const events: ReportEvent[] = []
  const at = input.observedAt.toISOString()
  const evidenceUrl = input.runPage && /^https:\/\/\S+$/.test(input.runPage) ? input.runPage.slice(0, 500) : null
  const engines = [...new Set(input.summaries.flatMap(s => s.engines))]
  const payload = input.payload
  const date = payload?.date ?? input.runId.split(':')[1] ?? ''
  const found = new Set(placed.flatMap(p => (p.s.ok ? p.s.verify?.found ?? [] : [])))
  const total = payload?.query_ids.length ?? 0
  const notFound = payload ? payload.query_ids.filter(id => !found.has(id)).length : 0
  const asked = placed.reduce((n, p) => n + (p.s.ok ? p.s.verify?.asked ?? 0 : 0), 0)
  const samples = payload?.samples ?? 0
  const failed = placed.filter(p => !p.s.ok)
  const capped = placed.reduce((n, p) => n + (p.s.ok ? p.s.probes_skipped_cap ?? 0 : 0) + (p.s.ok ? p.s.panel?.sample_skipped_cap ?? 0 : 0), 0)

  if (input.planError) {
    activity.push(line(`Verify run ${input.runId}: the plan could not hand out its subjects (${input.planError}), so nothing was asked.`))
    holds.push({ reason: input.planError.slice(0, 200), detail: 'The verify run asked nothing; the go-live stays open until it expires, and nothing was guessed.' })
  }
  for (const p of failed) activity.push(line(`Verify research failed for ${p.label}; nothing was written or guessed for it.`))

  // Panel moves against the last research panel, for the subjects that count.
  let won = 0
  let lost = 0
  for (const p of placed) {
    const panel = p.counts && p.s.ok ? p.s.panel : undefined
    if (!panel) continue
    for (const _ of panel.won_now) { events.push({ event: QUESTION_WON_EVENT, proposal_id: null, at, evidence_url: evidenceUrl }); won++ }
    for (const _ of panel.lost_now) { events.push({ event: QUESTION_LOST_EVENT, proposal_id: null, at, evidence_url: evidenceUrl }); lost++ }
  }

  if (!input.planError && payload) {
    const head = `Verify run ${input.runId}, Krish's go-live ${verifyGoLiveId(date)}: asked ${asked} of ${plural(total, 'question')}${notFound ? ` (${notFound} not found in the last research packets)` : ''}, ${samples} ${samples === 1 ? 'sample' : 'samples'} on each of ${plural(engines.length, 'assistant')} (${engines.join(', ') || 'none'})`
    const moves = `; against the last research panel ${plural(won, 'question')} became won and ${lost} lost`
    const tail = `${capped ? `; the cap stopped ${plural(capped, 'ask')}` : ''}. A verify run never counts toward questions cited first.`
    activity.push(line(`${head}${moves}${tail}`))
    // Closed once it asked: the evidence is the workflow run, and the counts are the line above.
    if (asked > 0) events.unshift({ event: VERIFY_DONE_EVENT, proposal_id: verifyGoLiveId(date), at, evidence_url: evidenceUrl })
    else holds.push({ reason: 'verify_nothing_asked', detail: `None of the go-live's ${plural(total, 'question')} could be asked (not found, the cap, or a failed call), so it is not closed.` })
  } else if (!payload && !input.planError) {
    holds.push({ reason: 'verify_payload_unread', detail: 'The verify run could not read the payload its plan job wrote, so nothing was asked.' })
  }
  if (events.length > EVENTS_MAX) activity.push(line(`${events.length - EVENTS_MAX} panel events past the report's ${EVENTS_MAX} are counted here only.`))

  const degraded = !!input.planError || failed.length > 0 || !payload
  const objective = missing(`A verify run does not measure it; the research run of ${utc(nextScheduledRun(input.observedAt))} does.`)
  const state = stateFor(input, objective, [])
  return envelope(input, degraded ? 'degraded' : 'ready', [], activity, [], holds, state, [], events)
}

