/**
 * Stage 50: the demand score, out of 100, from three proxies that are each
 * measured this run. There is no prompt-volume corpus for AI assistants; the
 * labels on every row say so.
 *
 *   llm_demand          0 to 40   10 per engine that gave a substantive, cited answer
 *   transcript_evidence 0 to 30   10 per call evidence item whose theme overlaps the query
 *   rising_volume       0 to 30   Google volume and movement when a striking-distance
 *                                 row matches; else 15 when we went from absent to cited
 */
import { CAPS } from '../config/run.js'
import { citedHosts, hostMatches } from '../lib/domains.js'
import { normaliseQuery, overlap } from '../lib/text.js'
import type { ContextSubject } from '../schema/context.js'
import type { DemandBasis, Engine, Evidence, PacketQuery, Probe, QueryStatus, Theme, Trend } from '../schema/packet.js'
import type { ProposedQuery } from './30-propose.js'
import type { ProbeOutcome } from './40-probe.js'

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

export function scoreQueries(proposed: readonly ProposedQuery[], outcome: ProbeOutcome, themes: readonly Theme[], subject: ContextSubject, krishHitsDomains: readonly string[]): PacketQuery[] {
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
  assignStatus(rows)
  return rows
}

/** recommend: the top 3 to 5 that are absent on at least two probed engines (or on all when fewer than two). watch: score >= 30. drop: the rest. */
export function assignStatus(rows: PacketQuery[]): void {
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
