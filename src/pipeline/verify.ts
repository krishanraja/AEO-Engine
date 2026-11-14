/**
 * The verify run (`--mode verify`, src/index.ts): an off-week re-check of the
 * questions Krish's approved go-live names (src/protocol/verify.ts), and
 * nothing else.
 *
 * - Only the payload's query ids are asked. Each question's words are read
 *   from the subject's last research packet as Control Center serves it
 *   (`subject.prior.queries`, by query_id); one it cannot find is skipped and
 *   counted, never guessed.
 * - Each question is asked by exactly one subject, the first that holds it
 *   (src/schema/verify.ts, verifyOwners), `samples` times (3) on every packet
 *   engine and no other (a gated engine such as Gemini is not asked), each
 *   ask charged to the ledger before it is made, the Claude Code lane free.
 *   The ledger's cap is this subject's share of the approved amount: the
 *   amount split over the questions found across every subject, to the cent,
 *   down, so the shares never add up to more than the amount.
 * - No model call: no transcripts, no proposal, no digest, no voice pass, no
 *   site audit, no kits, no brand checks and no cited-pages sheet.
 * - The panel is moved against the last research panel Control Center serves
 *   (`subject.prior.queries[].panel`), so a question that became won or was
 *   lost is reported as an event.
 * - A packet goes to Control Center only when its context lists the
 *   `run_kind` feature, with `run_kind: verify`: without it Control Center
 *   would read the packet as a research week. Otherwise the results go only
 *   into the sealed summary, and from there into the verify report.
 * - Nothing it measures counts toward the North Star share.
 */
import { randomUUID } from 'node:crypto'
import { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import { normaliseQuery } from '../lib/text.js'
import type { AeoContext, ContextSubject, PriorQuery } from '../schema/context.js'
import { inPacket, openGatedEngines, packetFeatures, type AeoPacket, type Engine } from '../schema/packet.js'
import { verifyOwners, type VerifyPayload } from '../schema/verify.js'
import type { PanelSelection } from './55-panel.js'
import { krishHitsDomains, loadContext } from './00-context.js'
import { competitorGapFrom, tallyHosts } from './20-gap.js'
import type { ProposedQuery } from './30-propose.js'
import { probeQueries } from './40-probe.js'
import { resample } from './41-samples.js'
import { scoreQueries } from './50-score.js'
import { panelFor, shippedOf } from './55-panel.js'
import { attachFeatures } from './68-features.js'
import { ship, writePacket } from './70-ship.js'
import { brandNamesFor, subjectsConfig } from '../config/subjects.js'
import { brandNamesOf } from '../lib/names.js'
import { defaultOutPath, type RunDeps, type RunFailure, type RunOpts, type RunResult, type SubjectResult } from './run.js'

/** The payload's questions a subject holds: its last research packet's queries, by query_id, in the payload's order. */
export function verifyQuestions(subject: Pick<ContextSubject, 'prior'>, ids: readonly string[]): ProposedQuery[] {
  const byId = new Map<string, PriorQuery>()
  for (const q of subject.prior?.queries ?? []) if (q && typeof q.query_id === 'string' && typeof q.query === 'string') byId.set(q.query_id.toLowerCase(), q)
  const out: ProposedQuery[] = []
  for (const id of ids) {
    const q = byId.get(id.toLowerCase())
    if (!q) continue
    out.push({ query_id: q.query_id.toLowerCase(), query: q.query.slice(0, 400), source: 'watch_carry', touchpoint_id: null, prior: q, norm: normaliseQuery(q.query), requested: false })
  }
  return out
}

/** A subject's share of the approved amount: the amount over the questions found, times this subject's, to the cent and down. */
export function verifyShare(amountUsd: number, mine: number, found: number): number {
  if (found <= 0 || mine <= 0) return 0
  return Math.floor((amountUsd * mine / found) * 100 + 1e-9) / 100
}

async function verifySubject(subject: ContextSubject, questions: ProposedQuery[], ctx: AeoContext, deps: RunDeps, opts: RunOpts, payload: VerifyPayload): Promise<{ packet: AeoPacket; post: boolean; result: Omit<SubjectResult, 'shipped' | 'slug' | 'packet'> }> {
  const ctxDomains = krishHitsDomains(ctx, subject)
  const open = openGatedEngines(ctx.packet_features).filter(e => (deps.countGated ?? []).includes(e))
  const features = packetFeatures(ctx.packet_features)
  // Only the packet's engines are asked: a gated engine's answers would never count, and its asks would spend the amount.
  const asking = deps.engines.filter(e => inPacket(e.engine, open))
  const engines = asking.map(e => e.engine) as Engine[]
  const names = (() => { try { return brandNamesFor(subject, subjectsConfig()) } catch { return Array.isArray(subject.brand_names) ? subject.brand_names : [] } })()
  const outcome = await probeQueries(asking, questions, ctxDomains, deps.ledger, subject.never_say ?? [], questions.length, 0, { open, brandNames: brandNamesOf(names), preordered: true })
  const rounds = Math.max(0, payload.samples - 1)
  const sampled = rounds > 0 ? await resample(asking, outcome, questions, ctxDomains, deps.ledger, 0, { open, rounds }) : null
  const set = new Set<string>(engines)
  const details = new Map<string, NonNullable<ReturnType<NonNullable<typeof outcome.detailsByQuery>['get']>>>()
  for (const [k, v] of outcome.detailsByQuery ?? []) {
    const kept = v.filter(d => set.has(d.engine))
    if (kept.length) details.set(k, kept)
  }
  const queries = scoreQueries(questions, outcome, [], subject, ctxDomains)
  const shipped = shippedOf(subject)
  const selection: PanelSelection = {
    ordered: questions,
    tiers: new Map(questions.map(q => [q.query_id, 'shipped' as const])),
    limit: questions.length,
    counts: { requested: 0, shipped: questions.length, kit: 0, won: 0, contested: 0, exploratory: 0 },
    sample: new Set(questions.map(q => q.query_id)),
  }
  const panel = panelFor({
    selection, asked: outcome.asked ?? new Set(), details, prior: subject.prior, week: opts.weekStart, shipped, kitPrefixes: [],
    sampledIds: rounds > 0 ? new Set(questions.map(q => q.query_id)) : new Set(), partial: outcome.partial, probes4w: subject.probes_4w,
    sampled: sampled?.questions ?? 0, sampleAnswers: sampled?.answers ?? 0, sampleSkippedCap: sampled?.skipped_cap ?? 0,
  })
  const thisRun = queries.flatMap(q => q.probes.map(p => ({ question: p.question, engine: p.engine, we_cited: p.we_cited, citations: p.citations })))
  const base: AeoPacket = {
    schema_version: 1,
    run_id: randomUUID(),
    command_id: null,
    subject: { id: subject.id, kind: subject.kind, slug: subject.slug, product_slug: subject.product_slug ?? null },
    week_start: opts.weekStart,
    generated_at: new Date().toISOString(),
    engines,
    // A verify run reads no calls.
    themes_status: 'not_applicable',
    themes: [],
    calls: { considered: 0, attributed: 0 },
    queries,
    strongest_signal: null,
    recommendations: [],
    not_worth_chasing: [],
    watch_list: [],
    competitor_gap: competitorGapFrom(tallyHosts(thisRun, ctxDomains, subject.competitor_domains ?? [])),
    playbook: null,
    approach_hook: null,
    stats: {
      queries: queries.length,
      probes: outcome.probes,
      probes_failed: outcome.probes_failed,
      probes_skipped_cap: outcome.probes_skipped_cap,
      cost_usd: Math.round(queries.reduce((s, q) => s + q.probes.reduce((t, p) => t + p.cost_usd, 0), 0) * 10000) / 10000,
      engines: engines.length,
      transcripts: 0,
      digest_writer: 'fallback',
    },
  }
  // Posted only with run_kind listed, and then as a verify run.
  const post = features.includes('run_kind')
  const packet = post ? attachFeatures(base, { features, details, evidence: new Map(), panels: panel.panels, neverSay: subject.never_say ?? [], runKind: 'verify' }).packet : base
  const flat = [...details.values()].flat()
  log('verify_subject', { subject: subject.slug, questions: questions.length, probes: outcome.probes, failed: outcome.probes_failed, skipped_cap: outcome.probes_skipped_cap, sampled: sampled?.questions ?? 0, won_now: panel.summary.won_now.length, lost_now: panel.summary.lost_now.length, packet: post })
  return {
    packet,
    post,
    result: {
      domains: ctxDomains,
      details: flat,
      panel: panel.summary,
      more: { verify: { found: questions.map(q => q.query_id), asked: queries.filter(q => q.probes.length).length, samples: payload.samples } },
    },
  }
}

/**
 * The verify run over the subjects asked for. A subject that holds none of
 * the payload's questions is passed over (the workflow runs only the
 * subjects that hold one). Never a model call.
 */
export async function runVerifyAll(deps: RunDeps, opts: RunOpts, payload: VerifyPayload): Promise<RunResult & { missing: number }> {
  const { ctx, selected } = await loadContext(deps.cc, opts.subject)
  // Whether Control Center's meter reads billing rows (src/lib/usage.ts, postRows).
  deps.usage.acceptBilling(ctx.packet_features)
  // Each question to exactly one subject, so no two jobs ask it and the shares never pass the amount.
  const owners = verifyOwners(ctx.subjects, payload.query_ids)
  const found = new Map<string, ProposedQuery[]>()
  for (const s of ctx.subjects) found.set(s.id, verifyQuestions(s, payload.query_ids.filter(id => owners.get(id.toLowerCase()) === s.slug)))
  const foundIds = new Set([...found.values()].flatMap(qs => qs.map(q => q.query_id)))
  const missing = payload.query_ids.filter(id => !foundIds.has(id.toLowerCase())).length
  const mine = selected.reduce((n, s) => n + (found.get(s.id)?.length ?? 0), 0)
  const share = Math.min(deps.ledger.capUsd, verifyShare(payload.amount_usd, mine, foundIds.size))
  deps.ledger = new Ledger(share)
  log('verify_start', { date: payload.date, questions: payload.query_ids.length, found: foundIds.size, missing, selected: selected.length, cap_usd: share, samples: payload.samples })
  const results: SubjectResult[] = []
  const failures: RunFailure[] = []
  const bundle = opts.dry && !!opts.outPath && selected.length > 1
  for (const subject of selected) {
    const qs = found.get(subject.id) ?? []
    if (!qs.length) { log('verify_subject', { subject: subject.slug, questions: 0 }); continue }
    try {
      const v = await verifySubject(subject, qs, ctx, deps, opts, payload)
      const outPath = bundle ? null : opts.outPath ?? defaultOutPath(subject.slug, opts.weekStart)
      const shipped = v.post ? await ship(deps.cc, v.packet, { dry: opts.dry, outPath, features: packetFeatures(ctx.packet_features) }) : { mode: 'held' as const }
      results.push({ slug: subject.slug, packet: v.packet, shipped, ...v.result })
    } catch (e) {
      failures.push({ slug: subject.slug, kind: subject.kind, error: errText(e) })
      log('subject_failed', { subject: subject.slug, error: errText(e) })
    }
  }
  if (bundle && opts.outPath && results.some(r => r.shipped.mode !== 'held')) writePacket(opts.outPath, results.filter(r => r.shipped.mode !== 'held').map(r => r.packet))
  log('verify_done', { subjects: results.length, failed: failures.length, ledger_usd: deps.ledger.total, cap_usd: deps.ledger.capUsd })
  return { results, failures, missing }
}
