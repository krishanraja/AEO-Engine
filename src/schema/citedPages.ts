/**
 * The cited-pages sheet's row (src/pipeline/48-cited-pages.ts), as the
 * packet's `cited_pages` feature carries it and as a kit's off-site entries
 * read it. Shapes only, here so the packet, the kit and the protocol read
 * them without importing the pipeline.
 *
 * Ruling (Krish, 2026-11-13): AEO keeps a sheet per venture of the pages AI
 * assistants cite for its questions and checks whether each page already
 * mentions the venture; outreach from the sheet comes later, venture by
 * venture, with his yes. AEO measures and checks; it never finds a contact,
 * never writes or sends outreach and never negotiates.
 */
import type { SourceType } from '../lib/sourceType.js'
import type { Engine } from './packet.js'

/**
 * Whether a page mentions the venture: `link` (an <a href> to one of its
 * domains), `name` (a distinctive name as a whole word in its visible text),
 * `none` (read, and neither), `unchecked` (not read this run).
 */
export const MENTIONS = ['link', 'name', 'none', 'unchecked'] as const
export type Mention = (typeof MENTIONS)[number]

export interface CitedPageRow {
  /** Normalised: no fragment, no utm_* parameter, the host lower-cased without www, the path kept. */
  url: string
  host: string
  page_type: SourceType
  /** The tracked questions it was cited for. */
  questions: number
  engines: Engine[]
  /** Answers that cited it, this run and the four weeks of probes Control Center serves. */
  times_cited: number
  /** Answers whose first citation it was. */
  times_first: number
  mention: Mention
  /** False when a brand check's must_not phrase is on the page (refresh needed); true when mentioned and none is; null otherwise. */
  mention_ok: boolean | null
  /** The day it was read for a mention (YYYY-MM-DD), or null when not read this run. */
  checked_at: string | null
  /** One of the general platforms (src/lib/platforms.ts): kept, never an outreach target. */
  platform: boolean
  /** One of the venture's own pages: kept, never an outreach target. */
  own: boolean
}

/** A sheet row is an outreach target when it is neither ours nor a general platform. */
export const isOutreachTarget = (r: Pick<CitedPageRow, 'own' | 'platform'>): boolean => !r.own && !r.platform

/** Mentioned: a link or the name. */
export const mentioned = (m: Mention | undefined | null): boolean => m === 'link' || m === 'name'

/** One venture's sheet in counts, for the sealed summary and the report. */
export interface CitedPagesCounts {
  rows: number
  own: number
  platform: number
  /** Rows that are outreach targets. */
  targets: number
  /** Rows read for a mention this run (fetched or reused), and of those how many were reused from the pages-cited-first read. */
  checked: number
  reused: number
  link: number
  name: number
  none: number
  /** Rows a brand check's must_not phrase was found on. */
  mention_ok_false: number
  /** Outreach targets not shown to mention the venture (none or unchecked): the rows the venture's engine has to check. */
  to_check: number
  /** Mentions acquired and lost since the sheet Control Center served, by page type; absent when none was served. */
  acquired?: Partial<Record<SourceType, number>>
  lost?: Partial<Record<SourceType, number>>
}
