/**
 * The run: every stage composed, per subject. The clients are injected, so
 * the same code runs live and against fixtures.
 */
import { randomUUID } from 'node:crypto'
import { CAPS } from '../config/run.js'
import type { ControlCenterClient, EngineClient, FirefliesClient, ModelClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import type { AeoContext, ContextSubject } from '../schema/context.js'
import type { AeoPacket } from '../schema/packet.js'
import { krishHitsDomains, loadContext } from './00-context.js'
import { classifyTranscripts, gatherTranscripts, themesForSubject, type Attribution, type Gathered } from './10-transcripts.js'
import { gapFor } from './20-gap.js'
import { proposeQueries } from './30-propose.js'
import { probeQueries } from './40-probe.js'
import { scoreQueries } from './50-score.js'
import { writeDigest } from './60-digest.js'
import { ship, writePacket, type ShipResult } from './70-ship.js'

export interface RunDeps {
  cc: ControlCenterClient
  /** Null when no Fireflies key is configured; the packet then says so. */
  fireflies: FirefliesClient | null
  engines: EngineClient[]
  model: ModelClient
  ledger: Ledger
  /** Mints a query id for a new query. Random live; derived from the key offline so fixtures compare. */
  mintId: (key: string) => string
  now: Date
}

export interface RunOpts {
  subject: string
  weekStart: string
  dry: boolean
  outPath: string | null
  commandId: number | null
}

export interface SubjectResult { slug: string; packet: AeoPacket; shipped: ShipResult }
export interface RunResult { results: SubjectResult[]; failures: Array<{ slug: string; error: string }> }

export interface Shared { ctx: AeoContext; gathered: Gathered; attribution: Map<string, Attribution> }

export async function runSubject(subject: ContextSubject, shared: Shared, deps: RunDeps, opts: RunOpts): Promise<AeoPacket> {
  const { ctx } = shared
  const domains = krishHitsDomains(ctx, subject)
  const engines = deps.engines.map(e => e.engine)
  log('subject_start', { subject: subject.slug, kind: subject.kind, hit_domains: domains.length })

  const themes = await themesForSubject(deps.model, subject, shared.gathered, shared.attribution, deps.ledger)
  const gap = gapFor(subject, domains)
  const proposed = await proposeQueries(deps.model, deps.ledger, subject, ctx, themes.themes, gap, deps.mintId)
  const outcome = await probeQueries(deps.engines, proposed, domains, deps.ledger, subject.never_say ?? [])
  const queries = scoreQueries(proposed, outcome, themes.themes, subject, domains)
  const digest = await writeDigest(deps.model, deps.ledger, { subject, ctx, weekStart: opts.weekStart, engines, queries, themes, gap, krishHitsDomains: domains })

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
  return packet
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
  const failures: Array<{ slug: string; error: string }> = []
  const bundle = opts.dry && !!opts.outPath && selected.length > 1
  for (const subject of selected) {
    try {
      const packet = await runSubject(subject, shared, deps, opts)
      const outPath = bundle ? null : opts.outPath ?? defaultOutPath(subject.slug, opts.weekStart)
      const shipped = await ship(deps.cc, packet, { dry: opts.dry, outPath })
      results.push({ slug: subject.slug, packet, shipped })
      log('subject_done', { subject: subject.slug, queries: packet.stats.queries, probes: packet.stats.probes, cost_usd: packet.stats.cost_usd, ledger_usd: deps.ledger.total })
    } catch (e) {
      failures.push({ slug: subject.slug, error: errText(e) })
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
