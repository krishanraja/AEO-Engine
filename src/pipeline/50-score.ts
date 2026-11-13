/**
 * Stage 50: the demand score, out of 100, from three proxies that are each
 * measured this run, and each question's status. There is no prompt-volume
 * corpus for AI assistants; the labels on every row say so.
 *
 * Status, since 2026-11-13, by the diagnosis (52-diagnose.ts) rather than by
 * "absent on two or more engines": recommend goes to the questions where we
 * are not cited at all (retrieved but not cited, a page not retrieved, no
 * page), ranked by kit priority (distance to first, demand, winnability);
 * watch takes every question we are cited on (won, and cited not first) and
 * the rest at WATCH_MIN_SCORE or above; drop the remainder.
 *
 *   llm_demand          0 to 40   10 per engine that gave a substantive, cited answer
 *   transcript_evidence 0 to 30   10 per call evidence item whose theme overlaps the query
 *   rising_volume       0 to 30   Google volume and movement when a striking-distance
 *                                 row matches; else 15 when we went from absent to cited
 */
import { CAPS } from '../config/run.js'
import { citedHosts, hostMatches } from '../lib/domains.js'
import { ownedByPlatforms } from '../lib/platforms.js'
import { normaliseQuery, overlap } from '../lib/text.js'
import type { ContextSubject } from '../schema/context.js'
import type { DemandBasis, Engine, Evidence, PacketQuery, Probe, QueryStatus, Theme, Trend } from '../schema/packet.js'
import type { ProposedQuery } from './30-propose.js'
import type { ProbeOutcome } from './40-probe.js'
import { kitPriority, RECOMMEND_CLASSES, type Diagnosis, type GapClass } from './52-diagnose.js'

export const LABEL_PROXIES = 'no prompt-volume corpus; proxies only'
export const LABEL_VOLUME = 'Google volume via DataForSEO'

const SUBSTANTIVE_CHARS = 200
const SUBSTANTIVE_CITATIONS = 2
const MIN_THEME_OVERLAP = 3

function llmDemand(probes: readonly Probe[]): number {
  const n = probes.filter(p => p.answer_snapshot.length >= SUBSTANTIVE_CHARS && p.citations.length >= SUBSTANTIVE_CITATIONS).length
  return Math.min(40, 10 * n)
}

export function callEvidenceFor(query: string, themes: readonly Theme[]): Evidence[] {
  const out: Evidence[] = []
  for (const t of themes) {
    if (overlap(query, t.theme) < MIN_THEME_OVERLAP) continue
    for (const e of t.evidence) {
      if (out.some(x => x.call_ref === e.call_ref && x.paraphrase === e.paraphrase)) continue
      out.push(e)
      if (out.length >= 10) return out
    }
  }
  return out
}

function risingVolume(q: ProposedQuery, probes: readonly Probe[], subject: ContextSubject): { score: number; usedVolume: boolean } {
  const row = (subject.striking_distance ?? []).find(r => normaliseQuery(r.query) === q.norm)
  if (row) {
    let score = 0
    if ((row.search_volume ?? 0) >= 100) score += 15
    if (typeof row.current_position === 'number' && typeof row.previous_position === 'number' && row.current_position < row.previous_position) score += 15
    return { score, usedVolume: true }
  }
  // The prior-week rows carry no per-engine citation flag, so the flip from
  // absent to cited is read from the four-week probe history by question.
  const priorAbsent = new Set<Engine>()
  for (const p of subject.probes_4w ?? []) if (!p.we_cited && normaliseQuery(p.question) === q.norm) priorAbsent.add(p.engine)
  const flipped = q.prior && probes.some(p => p.we_cited && priorAbsent.has(p.engine))
  return { score: flipped ? 15 : 0, usedVolume: false }
}

function competitorDomains(probes: readonly Probe[], ours: readonly string[]): string[] {
  const count = new Map<string, number>()
  for (const p of probes) for (const h of citedHosts(p.citations)) {
    if (ours.some(d => hostMatches(h, d))) continue
    count.set(h, (count.get(h) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h.slice(0, 120)).slice(0, 12)
}

function trendOf(score: number, q: ProposedQuery): Trend {
  if (!q.prior) return 'new'
  const delta = score - (Number(q.prior.demand_score) || 0)
  if (delta >= CAPS.TREND_STEP) return 'up'
  if (delta <= -CAPS.TREND_STEP) return 'down'
  return 'flat'
}

export function scoreQueries(proposed: readonly ProposedQuery[], outcome: ProbeOutcome, themes: readonly Theme[], subject: ContextSubject, krishHitsDomains: readonly string[], diagnoses?: ReadonlyMap<string, Diagnosis>): PacketQuery[] {
  const rows: PacketQuery[] = proposed.map(q => {
    const probes = outcome.probesByQuery.get(q.query_id) ?? []
    const call_evidence = callEvidenceFor(q.query, themes)
    const rising = risingVolume(q, probes, subject)
    const basis: DemandBasis = {
      llm_demand: llmDemand(probes),
      transcript_evidence: Math.min(30, 10 * call_evidence.length),
      rising_volume: Math.min(30, rising.score),
      labels: rising.usedVolume ? [LABEL_PROXIES, LABEL_VOLUME] : [LABEL_PROXIES],
    }
    const demand_score = Math.min(100, basis.llm_demand + basis.transcript_evidence + basis.rising_volume)
    return {
      query_id: q.query_id,
      query: q.query,
      source: q.source,
      demand_score,
      demand_basis: basis,
      call_evidence,
      gap: {
        we_cited_engines: probes.filter(p => p.we_cited).map(p => p.engine),
        competitor_domains: competitorDomains(probes, krishHitsDomains),
      },
      trend: trendOf(demand_score, q),
      status: 'drop' as QueryStatus,
      touchpoint_id: q.touchpoint_id,
      probes,
    }
  })
  rows.sort((a, b) => b.demand_score - a.demand_score || a.query.localeCompare(b.query))
  assignStatus(rows, diagnoses)
  return rows
}

/**
 * A row's class and platform ownership when the diagnosis kept none for it:
 * unknown with no probe; cited (not first, as far as the packet can tell)
 * when any answer cited us; else no page, owned when general platforms are
 * most of the hosts cited.
 */
export function classFromProbes(r: PacketQuery): { gap_class: GapClass; owned_by_platform: boolean } {
  if (!r.probes.length) return { gap_class: 'unknown', owned_by_platform: false }
  if (r.probes.some(p => p.we_cited)) return { gap_class: 'cited_not_first', owned_by_platform: false }
  return { gap_class: 'no_page', owned_by_platform: ownedByPlatforms(r.gap.competitor_domains).length > 0 }
}

/** A row's kit priority, from its diagnosis when there is one. */
export function rowPriority(r: PacketQuery, diagnoses?: ReadonlyMap<string, Diagnosis>): { gap_class: GapClass; priority: number } {
  const d = diagnoses?.get(r.query_id) ?? classFromProbes(r)
  return { gap_class: d.gap_class, priority: kitPriority(d.gap_class, r.demand_score, d.owned_by_platform) }
}

/**
 * With a diagnosis (a venture or a prospect): recommend takes, of the
 * questions we are not cited on at all, the top 3 by kit priority (ties on
 * query_id), and up to 5 while they score WATCH_MIN_SCORE or more; watch takes
 * every question we are cited on (won, cited not first) and the rest at
 * WATCH_MIN_SCORE or more; drop the remainder.
 *
 * Without one (an aspiration, whose "ours" is another company's site, or a
 * caller that ran no diagnosis) the rule it had: recommend the top 3 to 5
 * that are absent on at least two probed engines (or on all when fewer than
 * two); watch from WATCH_MIN_SCORE. Row order (demand) is unchanged either way.
 */
export function assignStatus(rows: PacketQuery[], diagnoses?: ReadonlyMap<string, Diagnosis>): void {
  if (!diagnoses) { assignStatusByAbsence(rows); return }
  const ranked = rows
    .map(r => ({ r, ...rowPriority(r, diagnoses) }))
    .filter(x => RECOMMEND_CLASSES.includes(x.gap_class) && x.r.probes.length > 0)
    .sort((a, b) => b.priority - a.priority || a.r.query_id.localeCompare(b.r.query_id))
  const recommend = new Set<string>()
  ranked.forEach((x, i) => {
    if (recommend.size >= 5) return
    if (i < 3 || x.r.demand_score >= CAPS.WATCH_MIN_SCORE) recommend.add(x.r.query_id)
  })
  for (const r of rows) {
    const cls = rowPriority(r, diagnoses).gap_class
    r.status = recommend.has(r.query_id) ? 'recommend' : cls === 'won' || cls === 'cited_not_first' || r.demand_score >= CAPS.WATCH_MIN_SCORE ? 'watch' : 'drop'
  }
}

/** The rule before the diagnosis: absent on at least two probed engines (or on all when fewer than two), demand order. */
export function assignStatusByAbsence(rows: PacketQuery[]): void {
  const absentOn = (r: PacketQuery) => r.probes.filter(p => !p.we_cited).length
  const eligible = rows.filter(r => {
    const probed = new Set(r.probes.map(p => p.engine)).size
    if (!probed) return false
    const absent = absentOn(r)
    return probed >= 2 ? absent >= 2 : absent === probed
  })
  const recommend = new Set<string>()
  eligible.forEach((r, i) => {
    if (recommend.size >= 5) return
    if (i < 3 || r.demand_score >= CAPS.WATCH_MIN_SCORE) recommend.add(r.query_id)
  })
  for (const r of rows) r.status = recommend.has(r.query_id) ? 'recommend' : r.demand_score >= CAPS.WATCH_MIN_SCORE ? 'watch' : 'drop'
}
