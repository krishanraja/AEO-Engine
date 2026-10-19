/**
 * What a research run measured, reduced to counts for the protocol report.
 *
 * `queries_cited_first` is "questions where Mindmake or its products are
 * cited first". The rule, applied to a probed question in a packet: it counts
 * when at least one assistant that answered it gave one of our domains as its
 * FIRST citation. "Our domains" is the same list the probe stage reads
 * (krishHitsDomains): a venture's own domains, and Mindmake's and Krish's for
 * a prospect. An aspiration is another company's site, so it is researched
 * and reported as activity but never counted toward the objective.
 *
 * Nothing here is a cost to a model: it reads packets the run already wrote.
 */
import { hostMatches, hostOf } from '../lib/domains.js'
import type { AeoPacket, SubjectKind } from '../schema/packet.js'

export interface SubjectSummary {
  slug: string
  kind: SubjectKind | null
  product_slug: string | null
  ok: boolean
  /** Null when the subject failed: unknown, never zero. */
  questions: number | null
  probed_questions: number | null
  cited_first: number | null
  probes: number | null
  probes_failed: number | null
  probes_skipped_cap: number | null
}

/** One research job's output: one subject in the workflow, any number locally. */
export interface RunSummary {
  v: 1
  subject_arg: string
  week_start: string
  generated_at: string
  engines: string[]
  /** This job's share of the run's cap, and the estimate charged against it. */
  cap_usd: number
  spent_usd: number
  /** The dearest single probe in the price table for this run's engines. */
  max_probe_usd: number
  /** Set when the run failed before any subject (no context, for example). */
  error_code: string | null
  subjects: SubjectSummary[]
}

/** True when this probe's first citation is on one of our domains. */
export function firstCitationIsOurs(citations: readonly string[], domains: readonly string[]): boolean {
  const first = citations[0]
  if (!first) return false
  const host = hostOf(first)
  return !!host && domains.some(d => hostMatches(host, d))
}

export function countCitedFirst(packet: AeoPacket, domains: readonly string[]): { probed_questions: number; cited_first: number } {
  let probed = 0
  let first = 0
  for (const q of packet.queries) {
    if (!q.probes.length) continue
    probed++
    if (q.probes.some(p => firstCitationIsOurs(p.citations, domains))) first++
  }
  return { probed_questions: probed, cited_first: first }
}

export function summariseSubject(packet: AeoPacket, domains: readonly string[]): SubjectSummary {
  const c = countCitedFirst(packet, domains)
  return {
    slug: packet.subject.slug,
    kind: packet.subject.kind,
    product_slug: packet.subject.product_slug,
    ok: true,
    questions: packet.queries.length,
    probed_questions: c.probed_questions,
    cited_first: c.cited_first,
    probes: packet.stats.probes,
    probes_failed: packet.stats.probes_failed,
    probes_skipped_cap: packet.stats.probes_skipped_cap,
  }
}

export function failedSubject(slug: string, kind: SubjectKind | null): SubjectSummary {
  return { slug, kind, product_slug: null, ok: false, questions: null, probed_questions: null, cited_first: null, probes: null, probes_failed: null, probes_skipped_cap: null }
}

/** ISO 8601 week number of a date, in UTC. */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

/**
 * The next scheduled research run strictly after `now`: Sunday 04:00 UTC in
 * an odd ISO week, the rule in .github/workflows/aeo-weekly.yml.
 */
export function nextScheduledRun(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0))
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7))
  while (d.getTime() <= now.getTime() || isoWeek(d) % 2 === 0) d.setUTCDate(d.getUTCDate() + 7)
  return d
}

/** The fortnight a research run reports: the two ISO weeks ending with the packets' week. */
export function fortnightStart(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 7)
  return d.toISOString()
}

/** The summary one research job leaves for the report job. */
export function buildRunSummary(i: {
  subjectArg: string
  weekStart: string
  now: Date
  engines: readonly string[]
  capUsd: number
  spentUsd: number
  maxProbeUsd: number
  results: ReadonlyArray<{ packet: AeoPacket; domains: readonly string[] }>
  failures: ReadonlyArray<{ slug: string; kind: SubjectKind | null }>
  errorCode: string | null
}): RunSummary {
  return {
    v: 1,
    subject_arg: i.subjectArg,
    week_start: i.weekStart,
    generated_at: i.now.toISOString(),
    engines: [...i.engines],
    cap_usd: i.capUsd,
    spent_usd: i.spentUsd,
    max_probe_usd: i.maxProbeUsd,
    error_code: i.errorCode,
    subjects: [...i.results.map(r => summariseSubject(r.packet, r.domains)), ...i.failures.map(f => failedSubject(f.slug, f.kind))],
  }
}
