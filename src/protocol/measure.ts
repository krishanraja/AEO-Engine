/**
 * What a research run measured, reduced to counts for the protocol report.
 *
 * `queries_cited_first` is "questions where Mindmake or its products are
 * cited first". The rule, applied to a probed question in a packet: it counts
 * when at least one assistant that answered it gave one of our domains as its
 * FIRST citation. "Our domains" is the same list the probe stage reads
 * (krishHitsDomains): a venture's own domains, and Mindmake's and Krish's for
 * a prospect, with Krish's ruled corrections applied. An aspiration is
 * another company's site, so it is researched and reported as activity but
 * never counted toward the objective.
 *
 * Since 2026-11-13 the first citation is the first source the answer cites in
 * its text (src/clients/types.ts, EngineAnswer), read from the probe's detail
 * (src/lib/probeDetail.ts), which is taken before the packet's cleaning can
 * drop that source; and a domain with a path counts only under that path.
 *
 * Nothing here is a cost to a model: it reads what the run already measured.
 */
import type { CompareCounts } from '../lib/compare.js'
import { urlMatchesDomain } from '../lib/domains.js'
import type { ProbeDetail } from '../lib/probeDetail.js'
import type { AeoPacket, SubjectKind } from '../schema/packet.js'
import { KIT_BACKUPS_MAX, type GapClass, type KitCandidate, type SiteCounts, type SubjectDiagnosis } from '../schema/kit.js'
import type { SubjectPanel } from '../schema/panel.js'

/**
 * One engine's answers in a subject, as counts: answered, searched, cited no
 * source, first cited source ours, ours cited anywhere. The last two are
 * absent in summaries written before 2026-11-13's second change.
 */
export interface EngineCounts { probes: number; searched: number; zero_citation: number; first_host_ours?: number; cited_any?: number }

/**
 * What a subject's probes counted beyond the packet's stats (src/pipeline/run.ts,
 * ProbeExtras), as a research job hands it to the summary. Counts only.
 */
export interface SubjectExtras {
  probes_skipped_limit?: number
  probes_limit_warning?: number
  probes_fallback?: number
  probes_skipped_free_tier?: number
  gated_engines?: string[]
  gated_failed?: number
  gated_skipped_cap?: number
  typed_urls_dropped?: number
  compare?: CompareCounts
}

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
  /** 1.22.0: the venture requests (ids only) whose every question this subject asked. */
  served?: string[]
  /** How many of this subject's venture requests were not asked in full this run. A count; absent when none. */
  requests_unserved?: number
  /** Probed questions where any answer named one of our domains, in its text or an inline citation. Absent: not measured. */
  cited_any?: number
  /** Per engine, counts only, gated engines included. Absent: not measured. */
  engines?: Record<string, EngineCounts>
  /** Claude probes the Claude Code subscription's limit stopped, unrecovered (each is also in probes_failed). */
  probes_skipped_limit?: number
  /** Claude probes answered while the subscription was past a warning threshold and still serving. */
  probes_limit_warning?: number
  /** Claude probes the limit handed to the API lane, which answered (code_then_api). */
  probes_fallback?: number
  /** Gemini probes not asked because the job reached its free-tier share. */
  probes_skipped_free_tier?: number
  /** Engines asked whose probes stayed out of the packet and out of cited_first (gemini until the context opens it). */
  gated_engines?: string[]
  gated_failed?: number
  gated_skipped_cap?: number
  /** URLs the Claude Code lane's answers typed that no search returned, dropped from their citations. */
  typed_urls_dropped?: number
  /** compare mode: the Claude Code lane and the API lane on the subject's first questions (src/lib/compare.ts). */
  claude_compare?: CompareCounts
  /** Why each question is not won, counted by gap class (src/pipeline/52-diagnose.ts). Absent: not diagnosed. */
  gap_classes?: Record<GapClass, number>
  /** Win kits prepared for this subject. Absent: not diagnosed. */
  kits?: number
  /** The product is held: measured, and no kit was prepared (config/subjects.json or Control Center). */
  held?: boolean
  /**
   * The subject's top win kit, rendered for Krish (src/pipeline/62-kits.ts).
   * The one field here that is not a count: it holds a question and URLs, so
   * it travels only in this sealed summary and to Control Center, never in a
   * log or a public artifact.
   */
  kit_candidate?: KitCandidate
  /** The next kits after the top one (at most KIT_BACKUPS_MAX), sealed like it: read only when Krish already decided the top one. */
  kit_backups?: KitCandidate[]
  /** The site reader's counts: our hosts and pages read, requests, failures, failed gates, and first-cited pages read. */
  site?: SiteCounts
  /**
   * Probed questions where more than half of the packet's engines that
   * answered gave our first citation, on the first sample: the "majority of
   * engines" count beside cited_first's "any engine". Absent: not measured.
   */
  cited_first_majority?: number
  /**
   * The panel (src/schema/panel.ts): each state's count, the questions
   * re-sampled, what became won or was lost this run (ids and counts), and the
   * questions tracked for a check-in. The tracked questions' words are the one
   * part that is not a count, sealed like the kit candidate. Absent: an
   * aspiration, or a summary written before 2026-11-13's panel change.
   */
  panel?: SubjectPanel
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
  /**
   * Web search requests the Claude probe responses reported as billed in this
   * job (usage.server_tool_use.web_search_requests). A count, kept here
   * rather than in the usage meter's POST, whose shape is Control Center's.
   */
  search_requests?: number
  /** Which way the Claude probes reached Claude this job (src/config/run.ts, CLAUDE_LANES). */
  claude_lane?: string
  /** Calls and input plus output tokens billed to the Claude Code subscription, never to the API (src/lib/usage.ts). */
  subscription_calls?: number
  subscription_tokens?: number
}

/** True when this probe's first citation is on one of our domains (path-aware: urlMatchesDomain). */
export function firstCitationIsOurs(citations: readonly string[], domains: readonly string[]): boolean {
  const first = citations[0]
  if (!first) return false
  return domains.some(d => urlMatchesDomain(first, d))
}

/** Details grouped by question. */
function byQuery(details: readonly ProbeDetail[]): Map<string, ProbeDetail[]> {
  const m = new Map<string, ProbeDetail[]>()
  for (const d of details) m.set(d.query_id, [...(m.get(d.query_id) ?? []), d])
  return m
}

/**
 * Probed questions, and those where at least one answer's first citation is
 * ours. A question's details, when the run kept them, decide; a question
 * without them (a packet read back on its own) falls back to the packet's
 * cleaned citation list, which is all it carries.
 */
export function countCitedFirst(packet: AeoPacket, domains: readonly string[], details: readonly ProbeDetail[] = []): { probed_questions: number; cited_first: number } {
  // Only the packet's engines count: a gated engine (gemini) is measured
  // beside the packet and never moves the North Star while it is gated.
  const engines = new Set<string>(packet.engines)
  const kept = byQuery(details.filter(d => engines.has(d.engine)))
  let probed = 0
  let first = 0
  for (const q of packet.queries) {
    if (!q.probes.length) continue
    probed++
    const d = kept.get(q.query_id)
    if (d ? d.some(x => x.first_host_ours) : q.probes.some(p => firstCitationIsOurs(p.citations, domains))) first++
  }
  return { probed_questions: probed, cited_first: first }
}

/**
 * Questions cited anywhere, and each engine's counts, from the details. Null
 * when the run kept none. `packetEngines`, when given, limits the question
 * count to the packet's engines, as cited_first is; every engine, gated ones
 * included, keeps its own counts.
 */
export function countDetails(details: readonly ProbeDetail[], packetEngines?: readonly string[]): { cited_any: number; engines: Record<string, EngineCounts> } | null {
  if (!details.length) return null
  const counted = packetEngines ? details.filter(d => packetEngines.includes(d.engine)) : details
  let citedAny = 0
  for (const ds of byQuery(counted).values()) if (ds.some(d => d.cited_any)) citedAny++
  const engines: Record<string, EngineCounts> = {}
  for (const d of details) {
    const e = (engines[d.engine] ??= { probes: 0, searched: 0, zero_citation: 0, first_host_ours: 0, cited_any: 0 })
    e.probes++
    if (d.searched) e.searched++
    if (d.zero_citation) e.zero_citation++
    if (d.first_host_ours) e.first_host_ours = (e.first_host_ours ?? 0) + 1
    if (d.cited_any) e.cited_any = (e.cited_any ?? 0) + 1
  }
  return { cited_any: citedAny, engines }
}

/**
 * Probed questions where a majority of the packet's engines that answered
 * gave our first citation (first sample only, as cited_first). Null when the
 * run kept no details.
 */
export function countMajorityFirst(packet: AeoPacket, details: readonly ProbeDetail[]): number | null {
  if (!details.length) return null
  const engines = new Set<string>(packet.engines)
  const kept = byQuery(details.filter(d => engines.has(d.engine)))
  let n = 0
  for (const q of packet.queries) {
    const ds = kept.get(q.query_id) ?? []
    if (ds.length && ds.filter(d => d.first_host_ours).length * 2 > ds.length) n++
  }
  return n
}

/** The extras a summary carries: counts above zero, the gated list when there is one, the compare tally when it ran. */
function extrasOf(x: SubjectExtras | undefined): Partial<SubjectSummary> {
  if (!x) return {}
  const out: Partial<SubjectSummary> = {}
  const n = (k: 'probes_skipped_limit' | 'probes_limit_warning' | 'probes_fallback' | 'probes_skipped_free_tier' | 'gated_failed' | 'gated_skipped_cap' | 'typed_urls_dropped') => {
    const v = x[k]
    if (typeof v === 'number' && v > 0) out[k] = v
  }
  n('probes_skipped_limit'); n('probes_limit_warning'); n('probes_fallback'); n('probes_skipped_free_tier'); n('gated_failed'); n('gated_skipped_cap'); n('typed_urls_dropped')
  if (x.gated_engines?.length) out.gated_engines = [...x.gated_engines]
  if (x.compare && x.compare.questions > 0) out.claude_compare = x.compare
  return out
}

/** The diagnosis a summary carries: counts, the held flag, and the top kit. */
function diagnosisOf(x: SubjectDiagnosis | undefined): Partial<SubjectSummary> {
  if (!x) return {}
  return {
    gap_classes: { ...x.gap_classes },
    kits: x.kits,
    ...(x.held ? { held: true } : {}),
    ...(x.kit_candidate && !x.held ? { kit_candidate: x.kit_candidate } : {}),
    ...(x.kit_candidate && !x.held && x.kit_backups?.length ? { kit_backups: x.kit_backups.slice(0, KIT_BACKUPS_MAX) } : {}),
    ...(x.site ? { site: { ...x.site } } : {}),
  }
}

export function summariseSubject(packet: AeoPacket, domains: readonly string[], served: readonly string[] = [], details: readonly ProbeDetail[] = [], unserved = 0, extras?: SubjectExtras, diagnosis?: SubjectDiagnosis, panel?: SubjectPanel): SubjectSummary {
  const c = countCitedFirst(packet, domains, details)
  const d = countDetails(details, packet.engines)
  const majority = countMajorityFirst(packet, details)
  return {
    ...(served.length ? { served: [...served] } : {}),
    ...(unserved > 0 ? { requests_unserved: unserved } : {}),
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
    ...(d ? { cited_any: d.cited_any, engines: d.engines } : {}),
    ...(majority !== null && packet.subject.kind !== 'aspiration' ? { cited_first_majority: majority } : {}),
    ...extrasOf(extras),
    ...diagnosisOf(diagnosis),
    ...(panel && packet.subject.kind !== 'aspiration' ? { panel } : {}),
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

/**
 * How late GitHub may start a scheduled research run. The schedule says 04:00
 * UTC; the research runs from 2026-09-27 to 2026-11-08 started between 08:50
 * and 10:56 UTC, because GitHub queues scheduled workflows.
 */
export const SCHEDULE_LATE_MS = 12 * 3_600_000

/**
 * The scheduled research run still to come. On a research Sunday the daily
 * wake (about 05:10 UTC) lands after the 04:00 slot but hours before GitHub
 * starts the run, so until that run has reported, today's slot is still the
 * one to come, not the one a fortnight later. Otherwise the next slot.
 */
export function upcomingRun(now: Date, reportedToday: boolean): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0))
  const since = now.getTime() - today.getTime()
  if (!reportedToday && today.getUTCDay() === 0 && isoWeek(today) % 2 === 1 && since >= 0 && since < SCHEDULE_LATE_MS) return today
  return nextScheduledRun(now)
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
  results: ReadonlyArray<{ packet: AeoPacket; domains: readonly string[]; served?: readonly string[]; details?: readonly ProbeDetail[]; unserved?: number; extras?: SubjectExtras; diagnosis?: SubjectDiagnosis; panel?: SubjectPanel }>
  failures: ReadonlyArray<{ slug: string; kind: SubjectKind | null }>
  errorCode: string | null
  /** Web search requests the Claude probes reported (UsageMeter.searchesBy('aeo-probe')). */
  searchRequests?: number
  claudeLane?: string
  subscription?: { calls: number; tokens: number }
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
    subjects: [...i.results.map(r => summariseSubject(r.packet, r.domains, r.served ?? [], r.details ?? [], r.unserved ?? 0, r.extras, r.diagnosis, r.panel)), ...i.failures.map(f => failedSubject(f.slug, f.kind))],
    ...(typeof i.searchRequests === 'number' ? { search_requests: i.searchRequests } : {}),
    ...(i.claudeLane ? { claude_lane: i.claudeLane } : {}),
    ...(i.subscription && i.subscription.calls > 0 ? { subscription_calls: i.subscription.calls, subscription_tokens: i.subscription.tokens } : {}),
  }
}
