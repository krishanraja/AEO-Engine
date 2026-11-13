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
  type ReportStatus,
} from '../schema/report.js'
import { fortnightStart, nextScheduledRun, SCHEDULE_LATE_MS, upcomingRun, type RunSummary, type SubjectSummary } from './measure.js'
import type { KitCandidate } from '../schema/kit.js'
import { buildEngineState, inWords, type RepoState } from './state.js'

export const SPEND_PROPOSAL_ID = 'aeo:spend:max-usd-per-run'
/** A win kit's proposal id: aeo:kit:<product_slug>:<first 8 of query_id>, stable across runs for one question. */
export const KIT_PROPOSAL_PREFIX = 'aeo:kit:'
export const kitProposalId = (productSlug: string, queryId: string) => `${KIT_PROPOSAL_PREFIX}${productSlug}:${queryId.slice(0, 8)}`
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

/** A decision as the reports read it: the id, his answer, when, and the payload it was made on. */
export type DecisionLite = Pick<Decision, 'proposal_id' | 'decided_at' | 'payload_sha256'> & { decision: string }

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

function envelope(e: Envelope, status: ReportStatus, objectives: ObjectiveReading[], activity: ActivityLine[], proposals: Proposal[], holds: Hold[], state: EngineState | null = null, served: readonly string[] = []): EngineReport {
  const extra: EngineState & { answers_served?: string[] } = {}
  // 1.22.0: the venture requests this run asked, only where the directive serves them.
  if (e.answers && served.length) extra.answers_served = [...served].slice(0, ANSWERS_SERVED_MAX)
  if (state?.priorities?.length) extra.priorities = state.priorities
  if (state?.obsessions?.length) extra.obsessions = state.obsessions
  if (state?.next_steps?.length) extra.next_steps = state.next_steps
  if (state?.instruction_acks?.length) extra.instruction_acks = state.instruction_acks
  return sealReport({
    schema_version: extra.answers_served ? ANSWERS_VERSION : state ? STATE_VERSION : '1.0.0',
    engine_id: ENGINE.engine_id,
    product_slug: ENGINE.product_slug,
    run_id: e.runId,
    mode: e.mode,
    observed_at: e.observedAt.toISOString(),
    source: { revision: e.revision.slice(0, 128) || 'unknown', captured_at: e.capturedAt.toISOString() },
    status,
    objectives,
    activity: activity.slice(0, 40),
    proposals: proposals.slice(0, 10),
    events: [],
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
 * proposes one kit a run itself). Prepared, behind strategy: AEO never
 * publishes, so it is never a post; his yes sends it to the product's build
 * session or its growth engine to ship, and AEO acts on nothing.
 */
export function kitProposal(k: KitCandidate, expiresAt: Date): Proposal {
  const reference = k.reference.trim() || null
  const why = `${KIT_WHY[k.gap_class]} The kit says what to change and why, from this run's answers and a fetch-only read of the pages involved. AEO ships nothing: the product's build session or its growth engine does, and the next research run checks whether it is cited first.`
  return {
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
    close_condition: { event: 'kit_shipped', reference: reference ? reference.slice(0, 500) : null },
    expires_at: expiresAt.toISOString(),
  }
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
  if (candidates.length && input.scope !== 'all') {
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
  if (passedOver && input.scope === 'all') activity.push(line(`${plural(passedOver, 'win kit')} Krish already decided ${passedOver === 1 ? 'was' : 'were'} left off his list.`))

  // Why the questions are not won, by gap class (counts only): each venture
  // by name, the prospects together (their "ours" is Mindmake's pages).
  // Last, so the 40-line cap can only ever cut this detail.
  const classLine = (g: Record<string, number>) => {
    const parts = [`${g.won} won`, `${g.cited_not_first} cited not first`, `${g.retrieved_not_cited} retrieved not cited`, `${g.not_retrieved} with a page not retrieved`, `${g.no_page} with no page`]
    if (g.unknown) parts.push(`${g.unknown} not answered`)
    return parts.join(', ')
  }
  for (const p of placed) {
    const g = p.s.ok && p.s.kind === 'venture' ? p.s.gap_classes : undefined
    if (!g) continue
    activity.push(line(`Why ${p.label}'s questions are not won: ${classLine(g)}; ${p.s.held ? 'held, so no kit' : `${plural(p.s.kits ?? 0, 'win kit')} prepared`}.`))
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
  const report = envelope(input, degraded ? 'degraded' : 'ready', [objective], activity, proposals, holds, state, served)
  // A kit is built from pages and answers this engine does not write. If its
  // words would make the report one Control Center refuses, the kit is held
  // back and the report still lands: the fortnight's reading matters more
  // than one kit.
  if (kitAsk && !validateReport(report).ok) {
    const held: Hold = { reason: 'kit_not_proposed', detail: `The top win kit, for ${kitAsk.proposal_id.split(':')[2]}, carried text a report may not carry, so it is not on his list this run.` }
    return envelope(input, degraded ? 'degraded' : 'ready', [objective], activity.filter(a => a !== kitLine), proposals.filter(p => p !== kitAsk), [...holds, held], state, served)
  }
  return report
}

/** The research run_id the dispatch looks for: one full run a day. */
export const researchRunId = (date: string) => `aeo:${date}:research`

export interface StoredResearch { run_id: string; accepted_at: string; report: Record<string, unknown> }

export interface DirectiveInput extends Envelope {
  /** `instruction` (1.20.0) is Krish's open instruction by id; the report acts on it only through `state`, when the directive serves the engine's state. */
  directive: { directive_id: string; chosen_by: string; decisions_since: Array<{ proposal_id: string; decision: string; decided_at: string; payload_sha256: string | null }>; instruction?: InstructionRef | null } | null
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
  const carried: Proposal[] = []
  const lastProposals = i.last && Array.isArray(i.last.report.proposals) ? (i.last.report.proposals as Proposal[]) : []
  for (const p of lastProposals) {
    if (!p || p.wall === 'none') continue
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
  return envelope(i, status, [objective], activity, carried, [], stateFor(i, objective, acks, next))
}
