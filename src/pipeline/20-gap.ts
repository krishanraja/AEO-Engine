/**
 * Stage 20: the gap. From the last four weeks of probes: which hosts the
 * engines cite on the questions where we are absent, and, for an aspiration,
 * which of its own pages the engines cite (kept with URLs for the playbook).
 */
import { citedHosts, hostMatches, hostOf, pathPatternOf } from '../lib/domains.js'
import { CLEAN } from '../lib/text.js'
import type { ContextSubject, PriorProbe } from '../schema/context.js'
import type { CompetitorGap, Engine } from '../schema/packet.js'

export interface Outranked { question: string; competitor_domains: string[]; engines: Engine[] }
export interface TheyCited { url: string; host: string; path_pattern: string; times: number; questions: string[] }
export interface HostTally { times: number; questions: string[] }

export interface GapResult {
  outranked: Outranked[]
  competitor_gap: CompetitorGap
  tally: Map<string, HostTally>
  they_cited: TheyCited[]
}

export interface ProbeLike { question: string; engine: Engine; we_cited: boolean; citations: string[] }

function isOurs(host: string, ourDomains: readonly string[]): boolean {
  return ourDomains.some(d => hostMatches(host, d))
}

function inCompetitorList(host: string, competitorDomains: readonly string[]): boolean {
  return competitorDomains.some(d => hostMatches(host, d))
}

/** Hosts cited where we were absent, most cited first. Intersected with competitor_domains when that list exists. */
export function tallyHosts(probes: readonly ProbeLike[], ourDomains: readonly string[], competitorDomains: readonly string[]): Map<string, HostTally> {
  const tally = new Map<string, HostTally>()
  for (const p of probes) {
    if (p.we_cited) continue
    for (const host of citedHosts(p.citations)) {
      if (isOurs(host, ourDomains)) continue
      if (competitorDomains.length && !inCompetitorList(host, competitorDomains)) continue
      const t = tally.get(host) ?? { times: 0, questions: [] }
      t.times++
      if (!t.questions.includes(p.question)) t.questions.push(p.question)
      tally.set(host, t)
    }
  }
  return new Map([...tally.entries()].sort((a, b) => b[1].times - a[1].times || a[0].localeCompare(b[0])))
}

export function competitorGapFrom(tally: Map<string, HostTally>): CompetitorGap {
  const top = tally.entries().next()
  if (top.done) return { domain: null, times_cited: 0, questions: [] }
  const [domain, t] = top.value
  return { domain: domain.slice(0, 120), times_cited: t.times, questions: t.questions.map(q => CLEAN(q, 400)).slice(0, 10) }
}

export function outrankedFrom(probes: readonly ProbeLike[], ourDomains: readonly string[], competitorDomains: readonly string[]): Outranked[] {
  const byQuestion = new Map<string, { hosts: Map<string, number>; engines: Set<Engine> }>()
  for (const p of probes) {
    if (p.we_cited) continue
    const hosts = citedHosts(p.citations).filter(h => !isOurs(h, ourDomains) && (!competitorDomains.length || inCompetitorList(h, competitorDomains)))
    if (!hosts.length) continue
    const row = byQuestion.get(p.question) ?? { hosts: new Map(), engines: new Set() }
    for (const h of hosts) row.hosts.set(h, (row.hosts.get(h) ?? 0) + 1)
    row.engines.add(p.engine)
    byQuestion.set(p.question, row)
  }
  return [...byQuestion.entries()].map(([question, row]) => ({
    question,
    competitor_domains: [...row.hosts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([h]) => h).slice(0, 12),
    engines: [...row.engines],
  }))
}

/** For an aspiration: the subject's own pages the engines cite, by URL, with the questions that drew them. */
export function theyCitedFrom(probes: readonly ProbeLike[], ownDomains: readonly string[]): TheyCited[] {
  const byUrl = new Map<string, TheyCited>()
  for (const p of probes) {
    for (const url of p.citations) {
      const host = hostOf(url)
      if (!host || !isOurs(host, ownDomains)) continue
      const row = byUrl.get(url) ?? { url, host, path_pattern: pathPatternOf(url), times: 0, questions: [] }
      row.times++
      if (!row.questions.includes(p.question)) row.questions.push(p.question)
      byUrl.set(url, row)
    }
  }
  return [...byUrl.values()].sort((a, b) => b.times - a.times || a.url.localeCompare(b.url))
}

function asProbeLike(rows: readonly PriorProbe[]): ProbeLike[] {
  return rows.map(r => ({ question: r.question, engine: r.engine, we_cited: !!r.we_cited, citations: Array.isArray(r.competitors_cited) ? r.competitors_cited : [] }))
}

export function gapFor(subject: ContextSubject, krishHitsDomains: readonly string[]): GapResult {
  const probes = asProbeLike(Array.isArray(subject.probes_4w) ? subject.probes_4w : [])
  const competitorDomains = Array.isArray(subject.competitor_domains) ? subject.competitor_domains : []
  const tally = tallyHosts(probes, krishHitsDomains, competitorDomains)
  return {
    outranked: outrankedFrom(probes, krishHitsDomains, competitorDomains),
    competitor_gap: competitorGapFrom(tally),
    tally,
    they_cited: subject.kind === 'aspiration' ? theyCitedFrom(probes, subject.domains ?? []) : [],
  }
}
