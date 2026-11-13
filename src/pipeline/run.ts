/**
 * The run: every stage composed, per subject. The clients are injected, so
 * the same code runs live and against fixtures.
 */
import { randomUUID } from 'node:crypto'
import { CAPS } from '../config/run.js'
import type { ControlCenterClient, EngineClient, FirefliesClient, ModelClient } from '../clients/types.js'
import type { SiteFetcher } from '../clients/site.js'
import { subjectsConfig, isHeld } from '../config/subjects.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import type { UsageMeter } from '../lib/usage.js'
import type { AeoContext, ContextSubject } from '../schema/context.js'
import { inPacket, openGatedEngines, type AeoPacket, type Engine, type GatedEngine } from '../schema/packet.js'
import type { AnswerRequest } from '../schema/report.js'
import { normaliseQuery } from '../lib/text.js'
import type { Taste } from '../schema/report.js'
import { krishHitsDomains, loadContext } from './00-context.js'
import { classifyTranscripts, gatherTranscripts, themesForSubject, type Attribution, type Gathered } from './10-transcripts.js'
import { gapFor } from './20-gap.js'
import { proposeQueries } from './30-propose.js'
import { probeLimitFor, probeQueries, type ProbeEvidence, type ProbeOutcome } from './40-probe.js'
import type { ProbeDetail } from '../lib/probeDetail.js'
import { EMPTY_AUDIT, failedGates, siteAudit, type HostAuditResult, type SiteAudit } from './15-site.js'
import { firstCitedEntries, matchPages, readFirstCited, thirdPartyPerHost, type CitedEntry, type PageMatch } from './45-pages.js'
import { scoreQueries, rowPriority } from './50-score.js'
import { diagnoseAll, type Diagnosis } from './52-diagnose.js'
import { buildKits, gapCounts, kitCandidate } from './62-kits.js'
import { KIT_BACKUPS_MAX, type SubjectDiagnosis } from '../schema/kit.js'
import { withFallback } from './stage.js'
import { writeDigest } from './60-digest.js'
import { applyVoice } from './65-voice.js'
import { ship, writePacket, type ShipResult } from './70-ship.js'

export interface RunDeps {
  cc: ControlCenterClient
  /** Null when no Fireflies key is configured; the packet then says so. */
  fireflies: FirefliesClient | null
  engines: EngineClient[]
  model: ModelClient
  ledger: Ledger
  /**
   * What the run actually spent, in tokens read off the responses.
   *
   * Distinct from `ledger`, which is the CAP: a flat per-call estimate charged
   * before each call so the run cannot quietly become a 200-call invoice. The
   * cap decides whether to make the next call; this records what the last one
   * really cost. Reporting the first as spend would have put an estimate in
   * the usage meter wearing the clothes of a measurement.
   */
  usage: UsageMeter
  /** Mints a query id for a new query. Random live; derived from the key offline so fixtures compare. */
  mintId: (key: string) => string
  now: Date
  /**
   * Krish's approved voice rules from today's directive (protocol 1.5.0), or
   * null/undefined when unknown. Only the wording-only voice pass (stage 65) reads them.
   */
  taste?: Taste | null
  /**
   * 1.22.0: the venture engines' open requests from today's directive
   * (answer_requests). A venture subject asks its own product's questions
   * verbatim, first (stage 30). Undefined or empty: none.
   */
  requests?: AnswerRequest[]
  /**
   * compare mode (src/config/run.ts, CLAUDE_LANES): the API lane, asked beside
   * the Claude Code lane on each subject's first questions and tallied in the
   * sealed summary. Its answers never enter the packet.
   */
  shadow?: EngineClient
  /** The Claude lane this run resolved (src/config/run.ts). Undefined offline. */
  claudeLane?: string
  /**
   * The site reader (src/clients/site.ts), fetch only: the pages cited first,
   * and our own hosts' audit when there is no shared one. Absent or null: no
   * page is read here (a retry attempt reads none).
   */
  site?: SiteFetcher | null
  /**
   * The run's own-host audit, read once by its site job (src/site.ts,
   * --site-in). When set, even empty, our own hosts come only from it and are
   * never requested here: a host many subjects share is read once a run.
   */
  sharedAudit?: ReadonlyMap<string, HostAuditResult>
}

export interface RunOpts {
  subject: string
  weekStart: string
  dry: boolean
  outPath: string | null
  commandId: number | null
}

/**
 * `domains` is the list the probes were read against. `details` is what each
 * probe measured about us from its raw inline citations (never in the
 * packet); the protocol report counts first citations from it. `served`: the
 * venture requests whose every question was asked (1.22.0). `unserved`: how
 * many of this subject's requests were not asked in full (the spend cap, a
 * failed call or the probe limit stopped a question), a count only.
 */
export interface SubjectResult { slug: string; packet: AeoPacket; shipped: ShipResult; domains: string[]; details?: ProbeDetail[]; served?: string[]; unserved?: number; extras?: ProbeExtras; diagnosis?: SubjectDiagnosis }

export type { SubjectDiagnosis }

/**
 * What the probes counted beyond the packet's stats, for the sealed summary
 * only: the subscription's limit, the API fallback, Gemini's free tier, a
 * gated engine's failures, typed URLs dropped, and the compare tally.
 */
export type ProbeExtras = Pick<ProbeOutcome, 'probes_skipped_limit' | 'probes_limit_warning' | 'probes_fallback' | 'probes_skipped_free_tier' | 'gated_failed' | 'gated_skipped_cap' | 'typed_urls_dropped' | 'compare'> & {
  /** The engines asked whose probes stayed out of the packet (gated). */
  gated_engines?: string[]
}

/** One subject's packet and the measurement that travels beside it. */
export interface SubjectRun { packet: AeoPacket; details: ProbeDetail[]; domains: string[]; extras?: ProbeExtras; open?: GatedEngine[]; diagnosis?: SubjectDiagnosis }

/** A per-question map kept to the packet's engines. */
function packetOnly<T extends { engine: string }>(m: ReadonlyMap<string, readonly T[]> | undefined, engines: ReadonlySet<string>): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const [k, v] of m ?? []) {
    const kept = v.filter(x => engines.has(x.engine))
    if (kept.length) out.set(k, kept)
  }
  return out
}

/**
 * Stages 15, 45, 52: the site audit, our best page per question, the pages
 * cited first, and why each question is not won. Each stage degrades to its
 * fallback rather than fail the subject. The audit is started before the
 * probes and awaited after them, so it adds no time to a subject's run.
 */
async function diagnoseSubject(
  subject: ContextSubject,
  domains: readonly string[],
  proposed: ReadonlyArray<{ query_id: string; query: string }>,
  outcome: ProbeOutcome,
  engines: readonly Engine[],
  auditing: Promise<SiteAudit>,
): Promise<{ audit: SiteAudit; diagnoses: Map<string, Diagnosis>; matches: Map<string, PageMatch>; details: Map<string, ProbeDetail[]>; evidence: Map<string, ProbeEvidence[]>; entries: Map<string, CitedEntry[]> }> {
  const set = new Set<string>(engines)
  const details = packetOnly(outcome.detailsByQuery, set)
  const evidence = packetOnly(outcome.evidenceByQuery, set)
  const audit = await auditing
  const matches = await withFallback('page_match', () => matchPages(proposed, audit.pages), () => new Map<string, PageMatch>(), { subject: subject.slug })
  const entries = await withFallback('first_cited', () => firstCitedEntries(evidence, domains), () => new Map<string, CitedEntry[]>(), { subject: subject.slug })
  const diagnoses = await withFallback('diagnose', () => diagnoseAll(proposed, details, matches, entries, evidence, domains), () => new Map<string, Diagnosis>(), { subject: subject.slug })
  return { audit, diagnoses, matches, details, evidence, entries }
}

/** The venture requests a subject answers: a venture subject, its own product's requests only. Pure. */
export function requestsFor(subject: Pick<ContextSubject, 'kind' | 'product_slug'>, requests: readonly AnswerRequest[] | undefined): AnswerRequest[] {
  if (subject.kind !== 'venture' || !subject.product_slug) return []
  return (requests ?? []).filter(r => r.product_slug === subject.product_slug)
}

/** The requests a packet served: every one of a request's questions is in it and was put to at least one assistant. Pure. */
export function servedBy(packet: Pick<AeoPacket, 'queries'>, requests: readonly AnswerRequest[]): string[] {
  const asked = new Set(packet.queries.filter(q => q.probes.length > 0).map(q => normaliseQuery(q.query)))
  return requests.filter(r => r.questions.every(q => asked.has(normaliseQuery(q)))).map(r => r.request_id)
}
export interface RunFailure { slug: string; kind: ContextSubject['kind']; error: string }
export interface RunResult { results: SubjectResult[]; failures: RunFailure[] }

export interface Shared { ctx: AeoContext; gathered: Gathered; attribution: Map<string, Attribution> }

export async function runSubject(subject: ContextSubject, shared: Shared, deps: RunDeps, opts: RunOpts): Promise<SubjectRun> {
  const { ctx } = shared
  const domains = krishHitsDomains(ctx, subject)
  // A gated engine (gemini) is asked, and its probes stay out of the packet
  // until the context's packet_features open it (src/schema/packet.ts).
  const open = openGatedEngines(ctx.packet_features)
  const engines = deps.engines.map(e => e.engine).filter(e => inPacket(e, open)) as Engine[]
  const gated = deps.engines.map(e => e.engine).filter(e => !inPacket(e, open))
  log('subject_start', { subject: subject.slug, kind: subject.kind, hit_domains: domains.length })

  const themes = await themesForSubject(deps.model, subject, shared.gathered, shared.attribution, deps.ledger)
  const gap = gapFor(subject, domains)
  const requested = requestsFor(subject, deps.requests).flatMap(r => r.questions)
  if (requested.length) log('answer_requests', { subject: subject.slug, questions: requested.length })
  const proposed = await proposeQueries(deps.model, deps.ledger, subject, ctx, themes.themes, gap, deps.mintId, requested)
  // Every requested question is probed, with a few of the engine's own beside
  // them, within the hard ceiling (CAPS, 40-probe.ts probeLimitFor) and the
  // subject's USD share. The share keeps back what the digest, and the voice
  // pass when a rule is approved, will be charged after the probes.
  const limit = probeLimitFor(proposed.filter(q => q.requested).length)
  const reserve = deps.ledger.priceOf('digest') + (deps.taste?.approved_voice_rules?.length ? deps.ledger.priceOf('voice') : 0)
  const shadow = deps.shadow ? { client: deps.shadow, questions: CAPS.COMPARE_API_QUESTIONS_PER_SUBJECT } : undefined
  // The diagnosis is about OUR pages: a venture's, or Mindmake's and Krish's
  // for a prospect. An aspiration's "ours" is another company's site, so it
  // is neither audited nor diagnosed, and keeps the status rule it had.
  const diagnosing = subject.kind !== 'aspiration'
  // The site audit reads our own hosts while the probes run, or takes them
  // from the run's shared audit, which then makes no request here.
  const site = diagnosing ? deps.site ?? null : null
  const sharedAudit = diagnosing ? deps.sharedAudit : undefined
  const auditing = site || sharedAudit ? withFallback('site_audit', () => siteAudit(subject, site, domains, CAPS.SITE_MAX_PAGES_PER_SUBJECT, sharedAudit), EMPTY_AUDIT, { subject: subject.slug }) : Promise.resolve(EMPTY_AUDIT)
  const outcome = await probeQueries(deps.engines, proposed, domains, deps.ledger, subject.never_say ?? [], limit, reserve, { open, shadow })
  const diag = await diagnoseSubject(subject, domains, proposed, outcome, engines, auditing)
  const queries = scoreQueries(proposed, outcome, themes.themes, subject, domains, diagnosing ? diag.diagnoses : undefined)
  // The pages cited first are read now, the highest-priority questions first,
  // and the diagnosis takes their features; its classes do not change.
  let diagnoses = diag.diagnoses
  let citedRead = 0
  if (site && diag.entries.size) {
    const order = queries.filter(q => q.probes.length).sort((a, b) => rowPriority(b, diagnoses).priority - rowPriority(a, diagnoses).priority || a.query_id.localeCompare(b.query_id))
    // Fewer pages a host when the run has many subjects, so one run never reads more than the per-host budget of any host.
    const maxPerHost = thirdPartyPerHost(ctx.subjects.filter(s => s.kind !== 'aspiration').length)
    const read = await withFallback('first_cited_read', () => readFirstCited(order, diag.entries, site, { subject: subject.slug, maxPerHost }), null, { subject: subject.slug })
    if (read) {
      citedRead = read.read
      diag.entries = read.byQuery
      diagnoses = await withFallback('diagnose', () => diagnoseAll(proposed, diag.details, diag.matches, read.byQuery, diag.evidence, domains), diagnoses, { subject: subject.slug })
    }
  }
  // The digest judges and drafts with no taste; the approved voice rules are
  // applied afterwards to its drafted words only (stage 65), never to a choice.
  const judged = await writeDigest(deps.model, deps.ledger, { subject, ctx, weekStart: opts.weekStart, engines, queries, themes, gap, krishHitsDomains: domains, ...(diagnosing ? { diagnoses } : {}) })
  const digest = await applyVoice(deps.model, deps.ledger, subject, deps.taste ?? null, judged)

  const packet: AeoPacket = {
    schema_version: 1,
    run_id: randomUUID(),
    command_id: opts.commandId,
    subject: { id: subject.id, kind: subject.kind, slug: subject.slug, product_slug: subject.product_slug ?? null },
    week_start: opts.weekStart,
    generated_at: new Date().toISOString(),
    engines,
    themes_status: themes.themes_status,
    themes: themes.themes,
    calls: themes.calls,
    queries,
    strongest_signal: digest.strongest_signal,
    recommendations: digest.recommendations,
    not_worth_chasing: digest.not_worth_chasing,
    watch_list: digest.watch_list,
    competitor_gap: digest.competitor_gap,
    playbook: digest.playbook,
    approach_hook: digest.approach_hook,
    stats: {
      queries: queries.length,
      probes: outcome.probes,
      probes_failed: outcome.probes_failed,
      probes_skipped_cap: outcome.probes_skipped_cap,
      cost_usd: round4(queries.reduce((s, q) => s + q.probes.reduce((t, p) => t + p.cost_usd, 0), 0)),
      engines: engines.length,
      transcripts: themes.calls.considered,
      digest_writer: digest.digest_writer,
    },
  }
  const details = [...(outcome.detailsByQuery?.values() ?? [])].flat()
  const extras: ProbeExtras = {
    probes_skipped_limit: outcome.probes_skipped_limit,
    probes_limit_warning: outcome.probes_limit_warning,
    probes_fallback: outcome.probes_fallback,
    probes_skipped_free_tier: outcome.probes_skipped_free_tier,
    gated_failed: outcome.gated_failed,
    gated_skipped_cap: outcome.gated_skipped_cap,
    typed_urls_dropped: outcome.typed_urls_dropped,
    ...(outcome.compare ? { compare: outcome.compare } : {}),
    ...(gated.length ? { gated_engines: gated } : {}),
  }
  if (!diagnosing) return { packet, details, domains, extras, open }
  // Stage 62: the win kits, for a venture whose product is not held.
  const held = await withFallback('held', () => isHeld(subject, subjectsConfig()), true, { subject: subject.slug })
  // A question the packet says is not worth chasing gets no kit.
  const walled = new Set(digest.not_worth_chasing.map(w => w.query_id))
  const kits = held ? [] : await withFallback('kits', () => buildKits({
    subject, queries, diagnoses, evidence: diag.evidence, details: diag.details, cited: diag.entries, audit: diag.audit, domains, engines, config: subjectsConfig(), walled,
  }), [], { subject: subject.slug })
  const top = kits[0] ? await withFallback('kit_render', () => kitCandidate(kits[0]), null, { subject: subject.slug }) : null
  const backups = top ? await withFallback('kit_render', () => kits.slice(1, 1 + KIT_BACKUPS_MAX).map(kitCandidate), [], { subject: subject.slug }) : []
  const classes = gapCounts(diagnoses)
  log('diagnosed', { subject: subject.slug, ...classes, kits: kits.length, held })
  const diagnosis: SubjectDiagnosis = {
    gap_classes: classes,
    kits: kits.length,
    held,
    kit_candidate: top,
    kit_backups: backups,
    site: site || sharedAudit ? { hosts: diag.audit.hosts.length, pages: diag.audit.pages.length, requests: diag.audit.requests, errors: diag.audit.errors, gates_failed: failedGates(diag.audit), cited_read: citedRead } : null,
  }
  return { packet, details, domains, extras, open, diagnosis }
}

function round4(n: number): number { return Math.round(n * 10000) / 10000 }

export function defaultOutPath(slug: string, weekStart: string): string {
  return `out/packet.${slug}.${weekStart}.json`
}

export async function runAll(deps: RunDeps, opts: RunOpts): Promise<RunResult> {
  const { ctx, selected } = await loadContext(deps.cc, opts.subject)
  log('context_loaded', { subjects: ctx.subjects.length, selected: selected.map(s => s.slug), week_start: opts.weekStart })
  const needsCalls = selected.some(s => s.kind !== 'aspiration')
  const gathered: Gathered = needsCalls ? await gatherTranscripts(deps.fireflies, deps.now) : { status: 'ok', transcripts: [] }
  const attribution = gathered.transcripts.length ? await classifyTranscripts(deps.model, gathered.transcripts, ctx.subjects, deps.ledger) : new Map<string, Attribution>()
  const shared: Shared = { ctx, gathered, attribution }

  const results: SubjectResult[] = []
  const failures: RunFailure[] = []
  const bundle = opts.dry && !!opts.outPath && selected.length > 1
  for (const subject of selected) {
    try {
      const { packet, details, domains, extras, open, diagnosis } = await runSubject(subject, shared, deps, opts)
      const outPath = bundle ? null : opts.outPath ?? defaultOutPath(subject.slug, opts.weekStart)
      const shipped = await ship(deps.cc, packet, { dry: opts.dry, outPath, open })
      const asked = requestsFor(subject, deps.requests)
      const served = opts.dry ? [] : servedBy(packet, asked)
      const unserved = opts.dry ? 0 : asked.length - served.length
      if (unserved) log('answer_requests_unserved', { subject: subject.slug, requests: asked.length, unserved, skipped_cap: packet.stats.probes_skipped_cap })
      results.push({ slug: subject.slug, packet, shipped, domains, details, served, unserved, extras, ...(diagnosis ? { diagnosis } : {}) })
      log('subject_done', { subject: subject.slug, queries: packet.stats.queries, probes: packet.stats.probes, cost_usd: packet.stats.cost_usd, ledger_usd: deps.ledger.total })
    } catch (e) {
      failures.push({ slug: subject.slug, kind: subject.kind, error: errText(e) })
      log('subject_failed', { subject: subject.slug, error: errText(e) })
    }
  }
  if (bundle && opts.outPath && results.length) {
    writePacket(opts.outPath, results.map(r => r.packet))
    log('packets_written', { path: opts.outPath, count: results.length })
  }
  log('run_done', { subjects: results.length, failed: failures.length, ledger_usd: deps.ledger.total, cap_usd: CAPS.MAX_USD_PER_RUN })
  return { results, failures }
}
