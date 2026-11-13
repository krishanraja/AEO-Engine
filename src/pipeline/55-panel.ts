/**
 * Stage 55: the panel. Which questions are probed, in what order, and where
 * each one stands after probing, run after run, so the engine can show the
 * week each question was won (docs/NORTH_STAR.md).
 *
 * selectPanel orders what is probed, by tier (src/schema/panel.ts,
 * PANEL_TIERS): a venture's requests, the questions it shipped a page for,
 * the questions of a kit plan Krish approved, the questions won last run,
 * those cited anywhere last run, then the rest in today's order. The first
 * three tiers are never cut by the general probe limit; the hard ceiling
 * still bounds them.
 *
 * advancePanel moves each probed question's panel forward from the one
 * Control Center served back (subject.prior.queries[].panel). Without it the
 * question's history is unknown: won_at, lost_at and streak are null, and
 * first_seen is this week only for a query_id new this run whose words the
 * four weeks of probes do not hold. A question already won when first
 * tracked has no win week, since it may have been won long before. A packet
 * question this run did not ask keeps its served panel as it was. Nothing is
 * guessed.
 */
import { CAPS } from '../config/run.js'
import type { ProbeDetail } from '../lib/probeDetail.js'
import { normaliseQuery } from '../lib/text.js'
import type { ContextSubject, PriorProbe, PriorQuery, PriorWeek, ShippedDeclaration } from '../schema/context.js'
import { inPacket } from '../schema/packet.js'
import type { GapClass } from '../schema/kit.js'
import {
  emptyStates,
  engineWon,
  heldWin,
  PANEL_STATES,
  PANEL_TIERS,
  PROTECTED_TIERS,
  SAMPLES_PER_CONTESTED,
  stateOf,
  type EngineSamples,
  type Panel,
  type PanelChange,
  type PanelStateName,
  type PanelTier,
  type SubjectPanel,
  type TrackedQuestion,
} from '../schema/panel.js'
import type { ProposedQuery } from './30-propose.js'
import { orderForProbing, probeLimitFor } from './40-probe.js'

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/** The packet carries at most this many queries (src/schema/packet.ts). */
const MAX_PACKET_QUERIES = 60

export interface PanelContext {
  /** Last week's packet as Control Center serves it back: its queries, each with the panel this engine sent, when it is served. */
  prior?: PriorWeek | null
  /** The last four weeks of probes: "cited anywhere last run" when no panel is served. */
  probes4w?: readonly PriorProbe[]
  /** The pages the venture said it shipped (context subject.shipped and 1.23.0 request shipped). */
  shipped?: readonly ShippedDeclaration[]
  /** The first 8 characters of the query ids of the kit plans Krish approved for this subject's product. */
  kitPrefixes?: readonly string[]
}

/** A served panel, read loosely: anything not the shape src/schema/panel.ts says is unknown (null), never repaired. */
export function readPanel(raw: unknown): Panel | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (!(PANEL_STATES as readonly string[]).includes(p.state as string)) return null
  // The packet's own date rule (src/schema/packet.ts, Checker.ymd): the shape and a real day.
  const day = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' && YMD_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined)
  const first_seen = day(p.first_seen)
  const last_asked = day(p.last_asked)
  const won_at = day(p.won_at)
  const lost_at = day(p.lost_at)
  if (first_seen === undefined || won_at === undefined || lost_at === undefined || !last_asked) return null
  const streak = p.streak === null ? null : Number.isInteger(p.streak) && (p.streak as number) >= 1 ? (p.streak as number) : undefined
  if (streak === undefined) return null
  return { state: p.state as PanelStateName, first_seen, last_asked, won_at, lost_at, streak }
}

/** Last run's panel per query_id, as served. Empty when none is. */
export function priorPanels(prior: PriorWeek | null | undefined): Map<string, Panel> {
  const out = new Map<string, Panel>()
  for (const q of prior?.queries ?? []) {
    const p = readPanel((q as PriorQuery).panel)
    if (p && typeof q.query_id === 'string') out.set(q.query_id, p)
  }
  return out
}

/**
 * The questions cited anywhere in the last run the four-week history holds
 * (the newest run_id, or the newest day when runs carry none), by query_id
 * and by their words. Read only for a question with no served panel.
 */
export function citedLastRun(probes: readonly PriorProbe[] | undefined): { ids: Set<string>; norms: Set<string> } {
  const out = { ids: new Set<string>(), norms: new Set<string>() }
  const list = (probes ?? []).filter(p => p && typeof p.run_at === 'string' && !Number.isNaN(Date.parse(p.run_at)))
  if (!list.length) return out
  const newest = list.reduce((a, b) => (Date.parse(b.run_at) > Date.parse(a.run_at) ? b : a))
  const sameRun = (p: PriorProbe) => (newest.run_id ? p.run_id === newest.run_id : p.run_at.slice(0, 10) === newest.run_at.slice(0, 10))
  for (const p of list) {
    if (!sameRun(p) || !p.we_cited) continue
    if (typeof p.query_id === 'string' && p.query_id) out.ids.add(p.query_id)
    if (typeof p.question === 'string') out.norms.add(normaliseQuery(p.question))
  }
  return out
}

/** The shipped page a question has, by query_id first, then by its words. */
export function shippedFor(q: Pick<ProposedQuery, 'query_id' | 'norm'>, shipped: readonly ShippedDeclaration[] | undefined): ShippedDeclaration | null {
  for (const s of shipped ?? []) if (s.query_id && s.query_id.toLowerCase() === q.query_id) return s
  for (const s of shipped ?? []) if (s.question && normaliseQuery(s.question) === q.norm) return s
  return null
}

/**
 * The shipped declarations a context serves (subject.shipped), read loosely:
 * a URL, and a query_id or the question's words, or the entry is dropped.
 */
export function shippedOf(subject: Pick<ContextSubject, 'shipped'>, extra: readonly ShippedDeclaration[] = []): ShippedDeclaration[] {
  const out: ShippedDeclaration[] = []
  for (const raw of [...(Array.isArray(subject.shipped) ? subject.shipped : []), ...extra]) {
    if (!raw || typeof raw !== 'object') continue
    const url = typeof raw.url === 'string' && /^https?:\/\/\S+$/i.test(raw.url.trim()) ? raw.url.trim().slice(0, 500) : null
    const query_id = typeof raw.query_id === 'string' && raw.query_id ? raw.query_id.toLowerCase() : undefined
    const question = typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim().slice(0, 400) : undefined
    if (!url || (!query_id && !question)) continue
    out.push({ ...(query_id ? { query_id } : {}), ...(question ? { question } : {}), url, shipped_at: typeof raw.shipped_at === 'string' ? raw.shipped_at : null })
  }
  return out
}

/** One question's tier. */
export function tierOf(q: ProposedQuery, ctx: PanelContext, panels: ReadonlyMap<string, Panel>, cited: { ids: Set<string>; norms: Set<string> }): PanelTier {
  if (q.requested) return 'requested'
  if (shippedFor(q, ctx.shipped)) return 'shipped'
  if ((ctx.kitPrefixes ?? []).includes(q.query_id.slice(0, 8))) return 'kit'
  const p = panels.get(q.query_id)
  if (p && heldWin(p) === true) return 'won'
  if (p) return p.state === 'contested' || p.state === 'cited' ? 'contested' : 'exploratory'
  return cited.ids.has(q.query_id) || cited.norms.has(q.norm) ? 'contested' : 'exploratory'
}

export interface PanelSelection {
  /** Every proposed question, in probing order: tier by tier, today's order within each. */
  ordered: ProposedQuery[]
  tiers: Map<string, PanelTier>
  /** How many of `ordered` are probed: the usual limit, stretched to hold every protected question, never above the hard ceiling. */
  limit: number
  counts: Record<PanelTier, number>
  /**
   * The questions re-sampled first whatever tier they took (a requested
   * question can be any of these too): a shipped page, a kit in flight, or a
   * win held last run (src/pipeline/41-samples.ts).
   */
  sample: Set<string>
}

/** Whether a question is one the repeat samples take first: a shipped page, a kit in flight, or a win held last run. */
function samplesFirst(q: ProposedQuery, ctx: PanelContext, panels: ReadonlyMap<string, Panel>): boolean {
  if (shippedFor(q, ctx.shipped)) return true
  if ((ctx.kitPrefixes ?? []).includes(q.query_id.slice(0, 8))) return true
  const p = panels.get(q.query_id)
  return !!p && heldWin(p) === true
}

export function selectPanel(proposed: readonly ProposedQuery[], ctx: PanelContext = {}): PanelSelection {
  const panels = priorPanels(ctx.prior)
  const cited = citedLastRun(ctx.probes4w)
  const today = orderForProbing(proposed)
  const tiers = new Map<string, PanelTier>()
  for (const q of today) tiers.set(q.query_id, tierOf(q, ctx, panels, cited))
  const ordered = PANEL_TIERS.flatMap(t => today.filter(q => tiers.get(q.query_id) === t))
  const counts = Object.fromEntries(PANEL_TIERS.map(t => [t, 0])) as Record<PanelTier, number>
  for (const t of tiers.values()) counts[t]++
  const requested = counts.requested
  const protectedCount = PROTECTED_TIERS.reduce((n, t) => n + counts[t], 0)
  const limit = Math.min(CAPS.MAX_PROBED_QUERIES_HARD, Math.max(probeLimitFor(requested), protectedCount))
  const sample = new Set(today.filter(q => samplesFirst(q, ctx, panels)).map(q => q.query_id))
  return { ordered, tiers, limit, counts, sample }
}

/**
 * The questions the panel needs that the proposal left out: last week's
 * question for a kit Krish approved, a shipped page or a win, carried with
 * its id; and a shipped question named only by its words, asked as a new
 * one. Appended after the proposal, inside the packet's limit on queries.
 */
export function panelQuestions(
  proposed: readonly ProposedQuery[],
  subject: Pick<ContextSubject, 'id'> & { prior?: PriorWeek | null },
  ctx: PanelContext,
  mintId: (key: string) => string,
): ProposedQuery[] {
  const have = new Set(proposed.map(q => q.query_id))
  const norms = new Set(proposed.map(q => q.norm))
  const panels = priorPanels(ctx.prior)
  const add: ProposedQuery[] = []
  const room = () => proposed.length + add.length < MAX_PACKET_QUERIES
  for (const p of subject.prior?.queries ?? []) {
    if (!room()) break
    if (typeof p?.query_id !== 'string' || typeof p.query !== 'string' || have.has(p.query_id)) continue
    const norm = normaliseQuery(p.query)
    if (!norm || norms.has(norm)) continue
    const q: ProposedQuery = { query_id: p.query_id, query: p.query.slice(0, 400), source: 'watch_carry', touchpoint_id: null, prior: p, norm, requested: false }
    const served = panels.get(p.query_id)
    const needed = !!shippedFor(q, ctx.shipped) || (ctx.kitPrefixes ?? []).includes(p.query_id.slice(0, 8)) || (!!served && heldWin(served) === true)
    if (!needed) continue
    add.push(q)
    have.add(q.query_id)
    norms.add(norm)
  }
  for (const s of ctx.shipped ?? []) {
    if (!room()) break
    if (!s.question) continue
    const norm = normaliseQuery(s.question)
    if (!norm || norms.has(norm)) continue
    add.push({ query_id: mintId(`${subject.id}|${norm}`), query: s.question.slice(0, 400), source: 'seed', touchpoint_id: null, prior: null, norm, requested: false })
    norms.add(norm)
  }
  return add.length ? [...proposed, ...add] : [...proposed]
}

/**
 * The questions re-asked for repeat samples, in probing order: a shipped
 * question, a kit in flight or a win held last run (whatever tier it took,
 * requested included), then any cited anywhere this run; only those a packet
 * engine answered, at most `max`. `engines`: the packet's engines (without
 * it, every engine but the gated ones). Only they decide a win, so a gated
 * engine's answer (Gemini, measured beside the packet) neither makes a
 * question contested nor takes a slot.
 */
export function sampleSet(
  selection: PanelSelection,
  details: ReadonlyMap<string, readonly ProbeDetail[]> | undefined,
  max: number = CAPS.MAX_SAMPLED_QUESTIONS_PER_SUBJECT,
  engines?: ReadonlySet<string>,
): ProposedQuery[] {
  const counts = (engine: ProbeDetail['engine']) => (engines ? engines.has(engine) : inPacket(engine, []))
  const own = (q: ProposedQuery) => (details?.get(q.query_id) ?? []).filter(d => counts(d.engine))
  const first = selection.ordered.filter(q => selection.sample.has(q.query_id) && own(q).length > 0)
  const cited = selection.ordered.filter(q => !first.includes(q) && own(q).some(d => d.cited_any))
  return [...first, ...cited].slice(0, Math.max(0, max))
}

/** One engine's samples, read off its first answer's detail. */
export function samplesOf(d: ProbeDetail): EngineSamples & { retrieved: boolean } {
  const s = d.samples ?? { n: 1, first: d.first_host_ours ? 1 : 0, cited: d.cited_any ? 1 : 0 }
  return { engine: d.engine, n: s.n, first: s.first, cited: s.cited, retrieved: d.retrieved_ours }
}

/** A question's panel after this run, and whether it became won or was lost by it. */
export interface PanelStep { panel: Panel; won: boolean; lost: boolean }

/**
 * A question's panel after this run, and its move. `week` is this run's
 * week_start. `isNew`: the query_id was minted this run and its words are
 * not in the four weeks of probes, so its first week is this one.
 *
 * With no prior panel the history is unknown: won_at, lost_at and streak are
 * null and no move is reported, even for a question won now, since it may
 * have been won long before it was first asked. With one, a move is a change
 * in whether it holds a win (heldWin): won after a run measured it short of
 * won is a win this week; short of won after a held win is a loss this week.
 * Unknown is never a loss, and a prior whose won-status is unknown (heldWin
 * null) gives no move either way rather than a guessed week.
 *
 * A second run in the same week adds nothing to the streak and reports no
 * move unless the won-status changed; a change within the week is a move
 * like any other, and cannot undo the earlier run's won_at or lost_at.
 */
export function stepPanel(prior: Panel | null | undefined, now: { state: PanelStateName; week: string; isNew: boolean }): PanelStep {
  const { state, week } = now
  if (!prior) return { panel: { state, first_seen: now.isNew ? week : null, last_asked: week, won_at: null, lost_at: null, streak: null }, won: false, lost: false }
  const sameWeek = prior.last_asked === week
  const before = heldWin(prior)
  const won = state === 'won' && before === false
  const lost = state !== 'won' && state !== 'unknown' && before === true
  const streak = prior.state === state ? (prior.streak === null ? null : sameWeek ? prior.streak : prior.streak + 1) : 1
  return {
    panel: { state, first_seen: prior.first_seen, last_asked: week, won_at: won ? week : prior.won_at, lost_at: lost ? week : prior.lost_at, streak },
    won,
    lost,
  }
}

/** A question's panel after this run (stepPanel, without the move). */
export function advancePanel(prior: Panel | null | undefined, now: { state: PanelStateName; week: string; isNew: boolean }): Panel {
  return stepPanel(prior, now).panel
}

/** The question ids and words the four weeks of probes hold: a question among them was asked before, whatever id it has now. */
function seenIn(probes: readonly PriorProbe[] | undefined): { ids: Set<string>; norms: Set<string> } {
  const out = { ids: new Set<string>(), norms: new Set<string>() }
  for (const p of probes ?? []) {
    if (!p) continue
    if (typeof p.query_id === 'string' && p.query_id) out.ids.add(p.query_id.toLowerCase())
    if (typeof p.question === 'string' && p.question.trim()) out.norms.add(normaliseQuery(p.question))
  }
  return out
}

export interface PanelResult {
  panels: Map<string, Panel>
  summary: SubjectPanel
}

/**
 * Every packet question's panel, from its packet engines' details (samples
 * included), and what the subject's panel did this run. `asked` are the
 * questions put to an engine; one none answered is unknown. A question this
 * run did not ask (past the probe limit, or the cap stopped every engine on
 * it) keeps the panel Control Center served, unchanged, so its history is
 * never dropped; it is not counted in this run's states.
 */
export function panelFor(i: {
  selection: PanelSelection
  asked: ReadonlySet<string>
  /** The packet engines' details only (a gated engine's never decide the panel). */
  details: ReadonlyMap<string, readonly ProbeDetail[]>
  prior: PriorWeek | null | undefined
  week: string
  gapClasses?: ReadonlyMap<string, GapClass>
  shipped?: readonly ShippedDeclaration[]
  /** The kit plans in flight, by the first 8 of their query ids: tracked for their check-ins whatever tier the question took. */
  kitPrefixes?: readonly string[]
  /** The questions picked for repeat samples (sampleSet), whether or not their re-asks were made: the win rule needs 2 of an engine's answers on each. */
  sampledIds?: ReadonlySet<string>
  /** The questions a packet engine did not answer in the first pass (the cap, its free tier, or a failed call): stage 40's `partial`. */
  partial?: ReadonlySet<string>
  /** The last four weeks of probes: a question whose words they hold is not new, whatever its id. */
  probes4w?: readonly PriorProbe[]
  sampled: number
  sampleAnswers: number
  /** Re-asks the spend cap stopped. */
  sampleSkippedCap?: number
}): PanelResult {
  const served = priorPanels(i.prior)
  const panels = new Map<string, Panel>()
  const states = emptyStates()
  const won: PanelChange[] = []
  const lost: PanelChange[] = []
  const tracked: TrackedQuestion[] = []
  const seen = seenIn(i.probes4w)
  for (const q of i.selection.ordered) {
    const prior = served.get(q.query_id) ?? null
    if (!i.asked.has(q.query_id)) {
      if (prior) panels.set(q.query_id, { ...prior })
      continue
    }
    const raw = i.details.get(q.query_id) ?? []
    const engines = raw.map(samplesOf)
    // Picked for repeat samples: named in the sample set, or stage 41 started its counts.
    const sampled = i.sampledIds?.has(q.query_id) === true || raw.some(d => d.samples !== undefined && d.samples !== null)
    let state = stateOf(engines, sampled)
    // A reading the cap or a failed call cut short (an engine not asked, or
    // its re-asks not all made) cannot overturn a win: read short of won, the
    // question is unknown this run rather than lost.
    const short = i.partial?.has(q.query_id) === true || (sampled && engines.some(e => e.n < SAMPLES_PER_CONTESTED))
    if (short && prior && state !== 'won' && state !== 'unknown' && heldWin(prior) !== false) state = 'unknown'
    const isNew = q.prior === null && !seen.ids.has(q.query_id) && !seen.norms.has(q.norm)
    const step = stepPanel(prior, { state, week: i.week, isNew })
    const panel = step.panel
    panels.set(q.query_id, panel)
    states[state]++
    const change = (list: EngineSamples[]): PanelChange => ({ query_id: q.query_id, engines: list.map(e => e.engine), samples: engines.reduce((n, e) => n + e.n, 0), first: engines.reduce((n, e) => n + e.first, 0) })
    if (step.won) won.push(change(engines.filter(e => engineWon(e, sampled))))
    if (step.lost) lost.push(change(engines))
    // A question can be both shipped and a kit in flight; it is tracked as both.
    const shipped = shippedFor(q, i.shipped)
    const kit = (i.kitPrefixes ?? []).includes(q.query_id.slice(0, 8)) || i.selection.tiers.get(q.query_id) === 'kit'
    if (shipped || kit) {
      tracked.push({
        query_id: q.query_id,
        question: q.query,
        tiers: [...(shipped ? ['shipped' as const] : []), ...(kit ? ['kit' as const] : [])],
        gap_class: i.gapClasses?.get(q.query_id) ?? null,
        panel,
        engines: engines.map(({ engine, n, first, cited }) => ({ engine, n, first, cited })),
        shipped_url: shipped?.url ?? null,
        sampled,
      })
    }
  }
  return { panels, summary: { states, sampled: i.sampled, sample_answers: i.sampleAnswers, sample_skipped_cap: i.sampleSkippedCap ?? 0, won_now: won, lost_now: lost, tracked, history: served.size > 0 } }
}
