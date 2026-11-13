/**
 * Stage 52: the diagnosis. Pure. Per question, from every answer's probe
 * detail (the packet's engines), our best page and the pages cited first: why
 * we are not the first citation, as one gap class, checked in this order.
 *
 *   won                  an engine's first inline citation is ours
 *   cited_not_first      an engine cites us, not first
 *   retrieved_not_cited  an engine's search returned a page of ours, and the answer cited others
 *   not_retrieved        a page of ours answers the question, and no engine's search returned one
 *   no_page              no page of ours answers it
 *   unknown              no engine answered it
 *
 * Each class names its fix: a cited page is moved up, a retrieved page made
 * worth citing, an unretrieved page made findable, a missing page written.
 */
import { urlMatchesDomain } from '../lib/domains.js'
import type { ProbeDetail } from '../lib/probeDetail.js'
import { ownedByPlatforms } from '../lib/platforms.js'
import type { SourceType } from '../lib/sourceType.js'
import { GAP_CLASSES, type GapClass } from '../schema/kit.js'
import type { ProbeEvidence } from './40-probe.js'
import { carryable, type CitedEntry, type CitedFeatures, type PageMatch } from './45-pages.js'

export { GAP_CLASSES, type GapClass }

/** How each class reads to a person. */
export const GAP_LABEL: Record<GapClass, string> = {
  won: 'won, cited first',
  cited_not_first: 'cited, not first',
  retrieved_not_cited: 'retrieved, not cited',
  not_retrieved: 'our page is not retrieved',
  no_page: 'no page of ours answers it',
  unknown: 'no engine answered',
}

export interface Diagnosis {
  query_id: string
  gap_class: GapClass
  our_best_url: string | null
  alignment: number
  /**
   * The page of ours an engine already cited (cited_not_first: the one at the
   * best position, then engine order) or its search returned
   * (retrieved_not_cited: the first, in engine order), or null. The page to
   * fix when the matcher found none: the engines have already named it.
   */
  our_cited_url: string | null
  /** `url` is null when the page cited first cannot be carried (an email or a handle in it). */
  first_cited: { host: string; url: string | null; source_type: SourceType; features: CitedFeatures } | null
  /**
   * The pages cited first are mostly general platforms (src/lib/platforms.ts):
   * a wall more than a gap. Counted per engine, so two engines citing one
   * platform first are two votes, as the digest's rule counts hosts cited.
   */
  owned_by_platform: boolean
}

export function gapClassOf(details: readonly ProbeDetail[], ourBestUrl: string | null): GapClass {
  if (!details.length) return 'unknown'
  if (details.some(d => d.first_host_ours)) return 'won'
  if (details.some(d => d.cited_any)) return 'cited_not_first'
  if (details.some(d => d.retrieved_ours)) return 'retrieved_not_cited'
  if (ourBestUrl) return 'not_retrieved'
  return 'no_page'
}

/**
 * Our own URL the engines already named for a question: for cited_not_first,
 * the citation of ours at the best position across engines (engine order on
 * a tie); for retrieved_not_cited, the first of ours in an engine's search
 * results. Carried only when it can be (no email or handle). Null otherwise.
 */
export function ourCitedUrl(gap: GapClass, evidence: readonly ProbeEvidence[] | undefined, domains: readonly string[]): string | null {
  if (!evidence?.length || !domains.length) return null
  const ours = (u: string) => domains.some(d => urlMatchesDomain(u, d))
  if (gap === 'cited_not_first') {
    let best: { url: string; pos: number } | null = null
    for (const ev of evidence) {
      for (const [i, raw] of ev.citations.entries()) {
        if (!ours(raw)) continue
        const url = carryable(raw)
        if (!url) continue
        if (!best || i < best.pos) best = { url, pos: i }
        break
      }
    }
    return best?.url ?? null
  }
  if (gap === 'retrieved_not_cited') {
    for (const ev of evidence) for (const raw of ev.retrieved) if (ours(raw)) { const url = carryable(raw); if (url) return url }
  }
  return null
}

export function diagnose(queryId: string, details: readonly ProbeDetail[], match: PageMatch | undefined, cited: readonly CitedEntry[] | undefined, evidence?: readonly ProbeEvidence[], domains: readonly string[] = []): Diagnosis {
  const our = match?.our_best_url ?? null
  const first = cited?.[0]
  // One vote per engine's first citation, not one per distinct host.
  const firsts = (cited ?? []).map(c => c.host).filter(Boolean)
  const gap_class = gapClassOf(details, our)
  return {
    query_id: queryId,
    gap_class,
    our_best_url: our,
    alignment: match?.alignment ?? 0,
    our_cited_url: ourCitedUrl(gap_class, evidence, domains),
    first_cited: first ? { host: first.host, url: first.url, source_type: first.source_type, features: first.features } : null,
    owned_by_platform: firsts.length > 0 && ownedByPlatforms(firsts).length > 0,
  }
}

/** Every question's diagnosis. `details` and `evidence` are the packet engines' only; `domains` are ours. */
export function diagnoseAll(
  queries: ReadonlyArray<{ query_id: string }>,
  details: ReadonlyMap<string, readonly ProbeDetail[]>,
  matches: ReadonlyMap<string, PageMatch>,
  cited: ReadonlyMap<string, readonly CitedEntry[]>,
  evidence?: ReadonlyMap<string, readonly ProbeEvidence[]>,
  domains: readonly string[] = [],
): Map<string, Diagnosis> {
  const out = new Map<string, Diagnosis>()
  for (const q of queries) out.set(q.query_id, diagnose(q.query_id, details.get(q.query_id) ?? [], matches.get(q.query_id), cited.get(q.query_id), evidence?.get(q.query_id), domains))
  return out
}

/** How close each class is to a first citation: the kit priority's first factor. Won and unknown get no kit. */
export const CLASS_WEIGHT: Record<GapClass, number> = { won: 0, cited_not_first: 4, retrieved_not_cited: 3, not_retrieved: 2, no_page: 1, unknown: 0 }

/**
 * A kit's priority: class weight x (1 + demand / 100) x (0.5 when general
 * platforms own the first citation, else 1). Distance to first, demand,
 * winnability. Rounded to three places for display; ties break on query_id
 * wherever it is sorted.
 */
export function kitPriority(gap: GapClass, demand: number, ownedByPlatform: boolean): number {
  const p = CLASS_WEIGHT[gap] * (1 + Math.max(0, Math.min(100, demand)) / 100) * (ownedByPlatform ? 0.5 : 1)
  return Math.round(p * 1000) / 1000
}

/** The classes a recommendation or a kit is made for: absent, or present and not first. */
export const KIT_CLASSES: readonly GapClass[] = ['cited_not_first', 'retrieved_not_cited', 'not_retrieved', 'no_page']
/** The classes a recommendation (a page to make or fix) is drawn from: we are not cited at all. */
export const RECOMMEND_CLASSES: readonly GapClass[] = ['retrieved_not_cited', 'not_retrieved', 'no_page']
