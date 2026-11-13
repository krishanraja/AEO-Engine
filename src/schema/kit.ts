/**
 * The diagnosis and win-kit shapes the protocol reads from the sealed run
 * summary. They live here, not in src/pipeline/, so the protocol code (the
 * daily directive's path) never imports the pipeline, not even for a type:
 * the cost wall (tests/protocol.test.ts) holds it to that.
 */

/** Why a question is not won (src/pipeline/52-diagnose.ts), checked in this order. */
export const GAP_CLASSES = ['won', 'cited_not_first', 'retrieved_not_cited', 'not_retrieved', 'no_page', 'unknown'] as const
export type GapClass = (typeof GAP_CLASSES)[number]

/** What a kit asks to be done: update a page of ours, write a new one, or be present off site only. */
export type TargetKind = 'new_page' | 'update_page' | 'off_site_only'

/** What one subject's top kit carries into the sealed run summary (src/pipeline/62-kits.ts, kitCandidate). */
export interface KitCandidate {
  product_slug: string
  query_id: string
  priority: number
  title: string
  /** The kit rendered as plain text for Krish, at most 8000 characters. */
  exact_payload: string
  gap_class: GapClass
  target_kind: TargetKind
  /** The target page's URL, else its host: the close condition's reference. */
  reference: string
}

/** The site reader's counts for one subject. */
export interface SiteCounts { hosts: number; pages: number; requests: number; errors: number; gates_failed: number; cited_read: number }

/**
 * What the diagnosis found for one subject, for the sealed summary: counts of
 * each gap class, the site reader's counts, how many kits were prepared, and
 * the top kit. Never in the packet or a log.
 */
export interface SubjectDiagnosis {
  gap_classes: Record<GapClass, number>
  kits: number
  held: boolean
  kit_candidate: KitCandidate | null
  /**
   * The next kits after the top one, in priority order, at most two. The
   * research report reads them only when Krish has already decided the top
   * one, so a kit he declined (or approved) never comes back as a fresh ask.
   */
  kit_backups: KitCandidate[]
  site: SiteCounts | null
}

/** How many kits after the top one a subject's sealed summary carries. */
export const KIT_BACKUPS_MAX = 2
