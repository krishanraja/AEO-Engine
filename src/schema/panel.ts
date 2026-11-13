/**
 * The panel: where each probed question stands, run after run, so the engine
 * can show the week each question was won (docs/NORTH_STAR.md). Shapes only,
 * and the one rule that turns an answer's samples into a state; the stage
 * that selects and advances the panel is src/pipeline/55-panel.ts. They live
 * here so the protocol code reads them without importing the pipeline.
 */
import type { GapClass } from './kit.js'

/**
 * A question's state this run, checked in this order:
 *
 *   won        first citation ours on at least 2 of 3 samples on at least one
 *              engine when the question was picked for repeat samples, else on
 *              its single sample
 *   contested  first citation ours on some sample, under that bar on every engine
 *   cited      ours cited, never first
 *   retrieved  a page of ours retrieved by an engine's search, not cited
 *   absent     answered, and none of the above
 *   unknown    no engine answered it this run; or a question that held a win
 *              read short of won while the spend cap or a failed call kept an
 *              engine from answering in full, so the run cannot say it was lost
 */
export const PANEL_STATES = ['won', 'contested', 'cited', 'retrieved', 'absent', 'unknown'] as const
export type PanelStateName = (typeof PANEL_STATES)[number]

/**
 * What is probed first, in this order (src/pipeline/55-panel.ts, selectPanel):
 * a venture's requests, the questions a venture said it shipped a page for,
 * the questions of a kit plan Krish approved, the questions won last run, the
 * questions cited anywhere last run, and the rest.
 */
export const PANEL_TIERS = ['requested', 'shipped', 'kit', 'won', 'contested', 'exploratory'] as const
export type PanelTier = (typeof PANEL_TIERS)[number]
/** The tiers the general probe limit never cuts (MAX_PROBED_QUERIES_HARD still bounds them). */
export const PROTECTED_TIERS: readonly PanelTier[] = ['requested', 'shipped', 'kit']

/**
 * One question's panel, as the packet's `panel` feature carries it. Every
 * date is a research week: the packet's week_start, the Monday (UTC) of the
 * week the run asked it, so "the week it was won" reads straight off won_at.
 */
export interface Panel {
  state: PanelStateName
  /** The week this query_id was first asked, or null when the history before this run is unknown. */
  first_seen: string | null
  /** The week it was asked last: this run's, or the served one for a packet question this run did not ask. */
  last_asked: string
  /** The latest week it became won, or null (never won, or unknown). */
  won_at: string | null
  /** The latest week it went from won to not won, or null. */
  lost_at: string | null
  /** Consecutive runs in this state, this one included, or null when unknown. */
  streak: number | null
}

/** One engine's samples of one question: answered, first citation ours, ours cited anywhere. */
export interface SampleCounts { n: number; first: number; cited: number }

/** Samples taken of a contested question: the first pass and the two re-asks. */
export const SAMPLES_PER_CONTESTED = 3
/** First citations on this many samples of one engine make a sampled question won. */
export const WIN_SAMPLES = 2

/**
 * Whether one engine's samples meet the win rule. `sampled`: the question was
 * picked for repeat samples, so only first citations on WIN_SAMPLES of an
 * engine's answers win it, and an engine left on one answer (the spend cap or
 * a failure stopped its re-asks) cannot win it alone. Otherwise its single
 * sample decides. Without `sampled`, more than one sample means it was.
 */
export function engineWon(s: SampleCounts, sampled = false): boolean {
  if (sampled || s.n >= 2) return s.first >= WIN_SAMPLES
  return s.n === 1 && s.first >= 1
}

/** The state from each engine's samples and whether a page of ours was retrieved. No engine: unknown. */
export function stateOf(engines: ReadonlyArray<SampleCounts & { retrieved?: boolean }>, sampled = false): PanelStateName {
  if (!engines.length) return 'unknown'
  if (engines.some(e => engineWon(e, sampled))) return 'won'
  if (engines.some(e => e.first > 0)) return 'contested'
  if (engines.some(e => e.cited > 0)) return 'cited'
  if (engines.some(e => e.retrieved === true)) return 'retrieved'
  return 'absent'
}

/**
 * Whether a panel holds a win: true when it is won, or was won and not lost
 * since (an unknown run in between keeps it); false when a run measured it
 * short of won, or it was lost and not won since; null when its history
 * cannot say (an unknown run with no win or loss on record). Within one week
 * the order of a won_at and a lost_at that fall on it cannot be told apart,
 * so such a week reads as lost unless the state says won.
 */
export function heldWin(p: Panel): boolean | null {
  if (p.state === 'won') return true
  if (p.state !== 'unknown') return false
  if (p.won_at !== null && (p.lost_at === null || p.lost_at < p.won_at)) return true
  return p.won_at === null && p.lost_at === null ? null : false
}

/** One engine's part in a tracked question: its samples, by name. */
export interface EngineSamples extends SampleCounts { engine: string }

/**
 * A question the report checks in on: the question of a kit plan Krish
 * approved, or one a venture said it shipped a page for. Its words travel in
 * the sealed summary only, and from there into a check-in on his list; never
 * a log. Counts and classes otherwise, never an answer.
 */
export interface TrackedQuestion {
  query_id: string
  question: string
  tiers: PanelTier[]
  /** The gap class this run (sample one), or null when the subject was not diagnosed. */
  gap_class: GapClass | null
  panel: Panel
  /** The packet's engines that answered, with their samples. */
  engines: EngineSamples[]
  /** True when it was picked for repeat samples, so the win rule needs 2 of an engine's answers. Absent in a summary from before 2026-11-13. */
  sampled?: boolean
  /** The URL a venture declared it shipped for this question, or null. */
  shipped_url: string | null
}

/** A question that became won, or was lost, this run: ids and counts only. */
export interface PanelChange { query_id: string; engines: string[]; samples: number; first: number }

/**
 * What one subject's panel did this run, for the sealed summary and the
 * protocol report. `history` says whether Control Center served last run's
 * panel; without it every history is unknown, and no change is reported.
 */
export interface SubjectPanel {
  states: Record<PanelStateName, number>
  /** Questions re-asked for repeat samples (at least one re-ask made), and the extra answers they gave. */
  sampled: number
  sample_answers: number
  /** Re-asks the spend cap stopped. Absent in a summary from before 2026-11-13. */
  sample_skipped_cap?: number
  won_now: PanelChange[]
  lost_now: PanelChange[]
  tracked: TrackedQuestion[]
  history: boolean
}

export function emptyStates(): Record<PanelStateName, number> {
  return { won: 0, contested: 0, cited: 0, retrieved: 0, absent: 0, unknown: 0 }
}
