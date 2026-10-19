/**
 * The two protocol reports this engine writes, as pure functions:
 *
 *   research  after a paid research run (the fortnightly schedule, or Run
 *             now): the objective from the packets, one activity line per
 *             subject, and a spend proposal only when the cap stopped probes.
 *   directive after the daily wake-up from Control Center: no paid call at
 *             all. It says when the last research run was and when the next
 *             is, and carries the objective from the last research report.
 *
 * Neither ever carries anything on docs/NEVER-PUBLISH.md: no prospect or
 * aspiration name or slug (they are numbered), no answer, citation, theme or
 * call, and no spend figure in a line. The one dollar amount is the spend
 * proposal's `amount_usd`, which the protocol requires for a spend ask.
 */
import { canonicalJson, sha256Hex } from '../lib/canonical.js'
import {
  ENGINE,
  OBJECTIVE_KEY,
  sealReport,
  type ActivityLine,
  type EngineReport,
  type Hold,
  type ObjectiveReading,
  type Proposal,
  type ReportStatus,
} from '../schema/report.js'
import { fortnightStart, nextScheduledRun, type RunSummary, type SubjectSummary } from './measure.js'

export const SPEND_PROPOSAL_ID = 'aeo:spend:max-usd-per-run'
export const SPEND_TARGET = 'AEO_MAX_USD_PER_RUN'
/** A fortnightly engine reads as stale after 15 days (ENGINE-PROTOCOL.md, Health). */
export const STALE_DAYS = 15
const DAY_MS = 86_400_000

export interface Envelope { runId: string; mode: 'live' | 'synthetic'; observedAt: Date; revision: string; capturedAt: Date }

function envelope(e: Envelope, status: ReportStatus, objectives: ObjectiveReading[], activity: ActivityLine[], proposals: Proposal[], holds: Hold[]): EngineReport {
  return sealReport({
    schema_version: '1.0.0',
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
  })
}

const line = (s: string): ActivityLine => ({ line: s.slice(0, 500), evidence_url: null })
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`

function missing(reason: string, windowStart: string | null = null, windowEnd: string | null = null): ObjectiveReading {
  return { key: OBJECTIVE_KEY, value: null, unit: 'questions', window_start: windowStart, window_end: windowEnd, timezone: 'UTC', availability: 'missing', reason: reason.slice(0, 500) }
}

/** The spend ask's payload: the amount and the variable it would change. */
export function spendPayloadSha(amountUsd: number): string {
  return sha256Hex(canonicalJson({ amount_usd: amountUsd, target: SPEND_TARGET }))
}

export interface ResearchInput extends Envelope {
  /** 'all' when the run covered every active subject; 'one' for a single-subject Run now. */
  scope: 'all' | 'one'
  /** The slugs the plan job handed out, one research job each. */
  expected: string[]
  summaries: RunSummary[]
  /** The whole run's cap, AEO_MAX_USD_PER_RUN. */
  totalCapUsd: number
  /** Set when the plan could not read the subject list. */
  planError: string | null
}

interface Placed { s: SubjectSummary; label: string; counts: boolean; noSummary: boolean }

/** Ventures by name; prospects, aspirations and anything unknown by number only. */
function place(input: ResearchInput): Placed[] {
  const bySlug = new Map<string, { s: SubjectSummary; noSummary: boolean }>()
  for (const sum of input.summaries) for (const s of sum.subjects) bySlug.set(s.slug, { s, noSummary: false })
  // A Run now may name its subject by uuid; the job's summary records the
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
    const tail = p.counts ? `; ${who} the first citation on ${plural(s.cited_first ?? 0, 'question')}` : '; aspirations are not counted toward questions cited first'
    activity.push(line(`Probed ${s.probed_questions} of ${plural(s.questions ?? 0, 'question')} for ${p.label} on ${plural(engines.length, 'assistant')}${tail}.`))
  }

  const skipped = placed.reduce((n, p) => n + (p.s.probes_skipped_cap ?? 0), 0)
  if (skipped > 0) {
    activity.push(line(`The spend cap stopped ${plural(skipped, 'question and assistant pair')} from being asked.`))
    holds.push({ reason: 'spend_cap_reached', detail: `${plural(skipped, 'question and assistant pair')} were not asked because the run reached its cap; the cap is a ceiling the run counts against.` })
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

  const degraded = !!input.planError || placed.some(p => !p.s.ok)
  return envelope(input, degraded ? 'degraded' : 'ready', [objective], activity, proposals, holds)
}

/** The research run_id the dispatch looks for: one full run a day. */
export const researchRunId = (date: string) => `aeo:${date}:research`

export interface StoredResearch { run_id: string; accepted_at: string; report: Record<string, unknown> }

export interface DirectiveInput extends Envelope {
  directive: { directive_id: string; chosen_by: string; decisions_since: Array<{ proposal_id: string; decision: string; decided_at: string; payload_sha256: string | null }> } | null
  directiveError: string | null
  /** The newest full research report found, or null. */
  last: StoredResearch | null
  lastError: string | null
}

function carriedObjective(i: DirectiveInput): ObjectiveReading {
  const next = utc(nextScheduledRun(i.observedAt))
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
  const next = nextScheduledRun(i.observedAt)
  if (i.last) activity.push(line(`Last full research run reported at ${utc(new Date(String(i.last.report.observed_at ?? i.last.accepted_at)))} (${i.last.run_id}).`))
  else if (i.lastError) activity.push(line(`Could not read back the last research report (${i.lastError}).`))
  else activity.push(line(`No full research run has reported in the last ${STALE_DAYS} days.`))
  activity.push(line(`Next scheduled research run: ${utc(next)} (Sundays at 04:00 UTC in odd ISO weeks).`))
  if (i.directive) activity.push(line(`Read directive ${i.directive.directive_id} (next action chosen by ${i.directive.chosen_by || 'rule'}). A directive never starts paid research here; only the fortnightly schedule and Run now do.`))
  else activity.push(line(`Could not read today's directive (${i.directiveError ?? 'unknown'}); no work was started from it.`))

  // Walled asks from the last research report stay in front of him until he
  // answers them or they expire. Same id and same payload, so nothing changes
  // unless he has decided.
  const decided = new Map<string, { decision: string; decided_at: string; payload_sha256: string | null }>()
  for (const d of i.directive?.decisions_since ?? []) decided.set(d.proposal_id, d)
  const carried: Proposal[] = []
  const lastProposals = i.last && Array.isArray(i.last.report.proposals) ? (i.last.report.proposals as Proposal[]) : []
  for (const p of lastProposals) {
    if (!p || p.wall === 'none') continue
    const d = decided.get(p.proposal_id)
    if (d) {
      const same = d.payload_sha256 === p.payload_sha256
      activity.push(line(same
        ? `Krish ${d.decision} "${p.title}" on ${d.decided_at.slice(0, 10)}. This engine still changes nothing behind a wall; ${p.wall === 'spend' ? `the cap moves only when he sets ${SPEND_TARGET}` : 'the action stays his'}.`
        : `Krish ${d.decision} an earlier version of "${p.title}"; the current payload differs, so it is still his to decide.`))
      if (same) continue
    }
    if (p.expires_at && Date.parse(p.expires_at) <= i.observedAt.getTime()) continue
    carried.push(p)
  }

  const objective = carriedObjective(i)
  const status: ReportStatus = objective.availability === 'measured' && i.directive ? 'ready' : 'degraded'
  return envelope(i, status, [objective], activity, carried, [])
}
