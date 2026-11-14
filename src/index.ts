/**
 * aeo-engine: the fortnightly answer-engine research run.
 *
 *   tsx src/index.ts [--subject <slug|uuid|all>] [--week YYYY-MM-DD] [--dry] [--offline]
 *                    [--out <path>] [--command-id <n>] [--cap-usd <n>]
 *
 *   --dry      validate and write the packet instead of POSTing it
 *   --rehearse a dry run that also sends each packet to production's ingest
 *              under a subject id that is never a subject's: the ingest
 *              validates every field and writes nothing, and 404
 *              unknown_subject means accepted (src/lib/rehearse.ts)
 *   --offline  fixtures under tests/fixtures instead of any network call
 *   --out      where a dry run writes; with several subjects one file holds an array
 *   --summary-out  where to leave this run's counts, sealed, for the protocol
 *                  report job (src/protocol/). Needs AEO_ENGINE_SECRET; the
 *                  file holds counts and a venture's top win kits, and opens
 *                  only inside the same workflow run (GITHUB_RUN_ID).
 *   --site-in  the run's site audit, sealed by its site job (src/site.ts). With
 *              it, our own pages come from the file and none is requested
 *              here; a missing or unreadable file means no audit this run.
 *   --mode     research (the default) or verify. A verify run
 *              (src/pipeline/verify.ts) re-asks only the questions of the
 *              payload in --verify-payload, written by the research
 *              workflow's plan job from Krish's approved go-live
 *              (src/protocol/verify.ts): no model call, no site read, and a
 *              packet only when Control Center lists run_kind. It asks
 *              nothing on a workflow re-run (GITHUB_RUN_ATTEMPT past 1), on a
 *              payload for another day than today (UTC), or when Control
 *              Center already stores a verify report for that day
 *              (verifyGuard).
 */
import { createHash, randomUUID } from 'node:crypto'
import { attemptOf, CAPS, MODELS, PRICE_USD_PER_CALL, resolveClaudeLane, resolveEngines, type ClaudeLane } from './config/run.js'
import { AnthropicClient } from './clients/anthropic.js'
import { ClaudeCodeEngine, type SpawnFn } from './clients/claudeCode.js'
import { ControlCenterHttp } from './clients/controlCenter.js'
import { FirefliesHttp } from './clients/fireflies.js'
import { GeminiClient } from './clients/gemini.js'
import { OfflineControlCenter, OfflineEngine, OfflineFireflies, OfflineModel } from './clients/offline.js'
import { LiveSite, OfflineSite } from './clients/site.js'
import { readSharedAudit } from './site.js'
import { OpenAIClient } from './clients/openai.js'
import { MeteredEngine } from './clients/metered.js'
import { PerplexityClient } from './clients/perplexity.js'
import type { EngineClient, ModelClient } from './clients/types.js'
import { XaiClient } from './clients/xai.js'
import { costKindOf } from './pipeline/40-probe.js'
import { inPacket, isGatedEngine, type Engine } from './schema/packet.js'
import { Ledger } from './lib/cost.js'
import { errText, log } from './lib/log.js'
import { UsageMeter } from './lib/usage.js'
import { seal } from './lib/seal.js'
import { mondayOf, YMD } from './lib/week.js'
import { runAll, type RunDeps, type RunOpts, type RunResult } from './pipeline/run.js'
import { writePacket } from './pipeline/70-ship.js'
import { buildRunSummary } from './protocol/measure.js'
import { GrowthEngineHttp, ProtocolError } from './clients/growthEngine.js'
import type { AnswerRequest, Taste } from './schema/report.js'
import { kitPlans, PLAN_OPEN_DAYS, type KitPlan, type PlanDecision } from './schema/kit.js'
import { parseVerifyPayload, type VerifyPayload } from './schema/verify.js'
import { runVerifyAll } from './pipeline/verify.js'
import { verifyRunId } from './protocol/verify.js'
import { readFileSync } from 'node:fs'

export interface CliArgs {
  subject: string
  week: string
  dry: boolean
  rehearse: boolean
  offline: boolean
  out: string | null
  summaryOut: string | null
  siteIn: string | null
  commandId: number | null
  capUsd: number
  fixtures: string
  mode: 'research' | 'verify'
  verifyPayload: string | null
}

export function parseArgs(argv: readonly string[], now = new Date()): CliArgs {
  const args: CliArgs = { subject: 'all', week: mondayOf(now), dry: false, rehearse: false, offline: false, out: null, summaryOut: null, siteIn: null, commandId: null, capUsd: CAPS.MAX_USD_PER_RUN, fixtures: 'tests/fixtures', mode: 'research', verifyPayload: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    switch (a) {
      case '--subject': args.subject = next().trim() || 'all'; break
      case '--week': {
        const w = next()
        if (!YMD.test(w) || Number.isNaN(Date.parse(w))) throw new Error('--week must be YYYY-MM-DD')
        args.week = mondayOf(new Date(`${w}T00:00:00Z`))
        break
      }
      case '--dry': args.dry = true; break
      case '--rehearse': args.rehearse = true; args.dry = true; break
      case '--offline': args.offline = true; break
      case '--out': args.out = next(); break
      case '--summary-out': args.summaryOut = next(); break
      case '--site-in': args.siteIn = next(); break
      case '--command-id': {
        const n = Number(next())
        if (!Number.isInteger(n) || n < 1) throw new Error('--command-id must be a positive integer')
        args.commandId = n
        break
      }
      case '--cap-usd': {
        const n = Number(next())
        if (!(n > 0)) throw new Error('--cap-usd must be a positive number')
        args.capUsd = n
        break
      }
      case '--fixtures': args.fixtures = next(); break
      case '--mode': {
        const m = next()
        if (m !== 'research' && m !== 'verify') throw new Error('--mode is research or verify')
        args.mode = m
        break
      }
      case '--verify-payload': args.verifyPayload = next(); break
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  if (args.rehearse && args.mode === 'verify') throw new Error('--rehearse is for a research run; a verify run spends only on an approved go-live')
  if (args.mode === 'verify' && !args.verifyPayload) throw new Error('--mode verify needs --verify-payload')
  if (args.mode !== 'verify' && args.verifyPayload) throw new Error('--verify-payload is for --mode verify only')
  return args
}

/**
 * The verify payload the plan job wrote (src/protocol/verify.ts), read
 * strictly. A payload that does not read is refused, and nothing is asked.
 * The log carries a reason code and counts, never a query id.
 */
export function readVerifyPayload(path: string): VerifyPayload | null {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { log('verify_payload_unread', { reason: 'missing' }); return null }
  const parsed = parseVerifyPayload(text.trim())
  if (!parsed.ok) { log('verify_payload_unread', { reason: parsed.reason }); return null }
  return parsed.payload
}

/** A uuid derived from a key: version and variant nibbles set so it passes the contract's pattern. */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** What a test may put in place of a real process or a real network client. */
export interface DepsOverrides { spawn?: SpawnFn }

/**
 * The Claude probe for a lane (src/config/run.ts, CLAUDE_LANES), and in
 * compare mode the API lane that answers beside it. The parent process may
 * hold the API key and the subscription token together; the Claude Code
 * child is given only its allowlisted environment (claudeCode.ts, childEnv),
 * and its first event is checked to have no API key source.
 */
export function claudeProbe(lane: ClaudeLane, env: NodeJS.ProcessEnv, usage: UsageMeter, o: DepsOverrides = {}): { main: EngineClient; shadow?: EngineClient } {
  const api = () => new AnthropicClient(env.ANTHROPIC_API_KEY ?? '', usage)
  const code = (fallback?: EngineClient) => new ClaudeCodeEngine({ env, meter: usage, ...(o.spawn ? { spawn: o.spawn } : {}), ...(fallback ? { fallback } : {}) })
  if (lane === 'api') return { main: api() }
  if (lane === 'compare') return { main: code(), shadow: api() }
  if (lane === 'code_then_api') return { main: code(api()) }
  return { main: code() }
}

/** The one meter is shared with the probe client too: probes are the bulk of
 *  the spend, and metering only the writing stages would report the small half. */
function liveEngines(env: NodeJS.ProcessEnv, usage: UsageMeter, lane: ClaudeLane, o: DepsOverrides): { engines: EngineClient[]; shadow?: EngineClient } {
  const engines: EngineClient[] = []
  let shadow: EngineClient | undefined
  for (const e of resolveEngines(env)) {
    if (e === 'perplexity') engines.push(new MeteredEngine(new PerplexityClient(env.PERPLEXITY_API_KEY ?? ''), 'perplexity', usage))
    else if (e === 'chatgpt') engines.push(new MeteredEngine(new OpenAIClient(env.OPENAI_API_KEY ?? ''), 'openai', usage))
    else if (e === 'claude') {
      const c = claudeProbe(lane, env, usage, o)
      engines.push(c.main)
      shadow = c.shadow
    } else if (e === 'grok') engines.push(new MeteredEngine(new XaiClient(env.XAI_API_KEY ?? ''), 'xai', usage))
    else if (e === 'gemini') engines.push(new MeteredEngine(new GeminiClient(env.GEMINI_API_KEY ?? ''), 'google', usage))
  }
  return { engines, ...(shadow ? { shadow } : {}) }
}

export function buildDeps(args: CliArgs, env: NodeJS.ProcessEnv = process.env, now = new Date(), overrides: DepsOverrides = {}): RunDeps {
  const ledger = new Ledger(args.capUsd)
  // The Anthropic clients feed it their usage objects. Perplexity, OpenAI, xAI
  // and Gemini report usage in their own shapes, so each probe engine is
  // wrapped (src/clients/metered.ts) and its input and output tokens are kept
  // on rows of their own provider, never summed into an Anthropic-shaped
  // object priced at Anthropic's rates. They are posted only once the context
  // lists meter_billing (src/lib/usage.ts, postRows).
  const usage = new UsageMeter()
  if (args.offline) {
    const dir = args.fixtures
    return {
      cc: new OfflineControlCenter(dir),
      fireflies: new OfflineFireflies(dir),
      // The packet's engines only: a gated engine (gemini) has no fixtures,
      // and the offline twin's packets must not change with a key in the shell.
      engines: resolveEngines(env).filter((e): e is Engine => !isGatedEngine(e)).map(e => new OfflineEngine(e, MODELS[e === 'chatgpt' ? 'openai' : e === 'claude' ? 'anthropic' : e === 'grok' ? 'xai' : 'perplexity'], dir)),
      model: new OfflineModel(dir),
      // Synthetic pages under tests/fixtures/site; a URL with no fixture reads as unavailable.
      site: new OfflineSite(dir),
      ledger,
      usage,
      mintId: uuidFromKey,
      now,
    }
  }
  const anthropic = new AnthropicClient(env.ANTHROPIC_API_KEY ?? '', usage)
  const model: ModelClient = anthropic.asModelClient()
  // The lane is read here, per run, never at module load.
  const choice = resolveClaudeLane(env, args.week)
  if (choice.reason === 'no_token') log('claude_lane_fallback', { lane: 'api', reason: 'CLAUDE_CODE_OAUTH_TOKEN is not set' })
  else log('claude_lane', { lane: choice.lane, reason: choice.reason, ...(choice.unknown ? { unknown_value: true } : {}) })
  // A retry is a fresh process with a fresh free-tier count, so it asks no Gemini (resolveEngines).
  if (env.GEMINI_API_KEY && attemptOf(env) > 1) log('gemini_skipped', { reason: 'retry_attempt', attempt: attemptOf(env) })
  // Nor does it read a page: a fresh process has a fresh per-host count, and
  // the first attempt may already have read its pages cited first. Its own
  // hosts come from the run's site audit (--site-in) either way.
  const retry = attemptOf(env) > 1
  if (retry) log('site_reader_skipped', { reason: 'retry_attempt', attempt: attemptOf(env) })
  const live = liveEngines(env, usage, choice.lane, overrides)
  return {
    cc: new ControlCenterHttp(env.CONTROL_CENTER_URL ?? '', env.AEO_ENGINE_SECRET ?? ''),
    fireflies: env.FIREFLIES_API_KEY ? new FirefliesHttp(env.FIREFLIES_API_KEY) : null,
    engines: live.engines,
    ...(live.shadow ? { shadow: live.shadow } : {}),
    claudeLane: choice.lane,
    model,
    // Fetch only: GET, no script run, an honest User-Agent, a budget per host (src/clients/site.ts).
    site: retry ? null : new LiveSite(),
    ledger,
    usage,
    mintId: () => randomUUID(),
    now,
  }
}

/**
 * Krish's approved voice rules, read from today's directive through the
 * growth engine door (protocol 1.5.0 `taste`). Null means unknown: the
 * protocol bearer is not set here, the directive could not be read, or it
 * carried no taste. Never fatal, never retried, never invented. The log line
 * carries counts only, never a rule's text.
 */
export async function readTaste(env: NodeJS.ProcessEnv, client?: Pick<GrowthEngineHttp, 'getDirective'>): Promise<Taste | null> {
  try {
    const c = client ?? (env.CONTROL_CENTER_ENGINE_TOKEN ? new GrowthEngineHttp(env.CONTROL_CENTER_PROTOCOL_URL || env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN) : null)
    if (!c) { log('directive_taste', { state: 'unknown', reason: 'not_configured' }); return null }
    const { directive } = await c.getDirective()
    const taste = directive.taste ?? null
    log('directive_taste', taste ? { state: taste.approved_voice_rules.length ? 'approved' : 'none_approved', rules: taste.approved_voice_rules.length } : { state: 'unknown', reason: 'absent' })
    return taste
  } catch (e) {
    log('directive_taste', { state: 'unknown', reason: e instanceof ProtocolError ? e.code : 'directive_unavailable' })
    return null
  }
}

/**
 * 1.22.0: the venture engines' open requests to this specialist, read from
 * today's directive through the growth engine door (answer_requests). Empty
 * when the bearer is not set, the directive could not be read, or none is
 * open: the run then asks only Control Center's subject list, as before.
 * Never fatal; the log line carries counts only, never a question.
 */
export async function readAnswerRequests(env: NodeJS.ProcessEnv, client?: Pick<GrowthEngineHttp, 'getDirective'>): Promise<AnswerRequest[]> {
  try {
    const c = client ?? (env.CONTROL_CENTER_ENGINE_TOKEN ? new GrowthEngineHttp(env.CONTROL_CENTER_PROTOCOL_URL || env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN) : null)
    if (!c) { log('answer_requests', { state: 'unknown', reason: 'not_configured' }); return [] }
    const { directive } = await c.getDirective()
    const requests = directive.answer_requests ?? []
    log('answer_requests', { state: 'read', requests: requests.length, questions: requests.reduce((n, r) => n + r.questions.length, 0) })
    return requests
  } catch (e) {
    log('answer_requests', { state: 'unknown', reason: e instanceof ProtocolError ? e.code : 'directive_unavailable' })
    return []
  }
}

/** What a research job reads from today's directive: Krish's voice rules, the venture requests, and the kit plans he approved. */
export interface DirectiveInputs { taste: Taste | null; requests: AnswerRequest[]; kitPlans: KitPlan[] }

/**
 * One read of today's directive through the growth engine door, and one of
 * his decisions back over the six weeks a kit plan stays open (both free
 * GETs): his approved voice rules (1.5.0), the venture engines' open
 * requests (1.22.0), and the kit plans he approved and has not stopped or
 * closed (src/schema/kit.ts), whose questions this run probes and re-samples
 * as kits in flight. Never fatal: anything unread is unknown or none. Logs
 * carry counts only, never a rule, a question or a plan's words.
 */
export async function readDirectiveInputs(env: NodeJS.ProcessEnv, client?: Pick<GrowthEngineHttp, 'getDirective' | 'getDecisions'>, now: Date = new Date()): Promise<DirectiveInputs> {
  const none: DirectiveInputs = { taste: null, requests: [], kitPlans: [] }
  const c = client ?? (env.CONTROL_CENTER_ENGINE_TOKEN ? new GrowthEngineHttp(env.CONTROL_CENTER_PROTOCOL_URL || env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN) : null)
  if (!c) {
    log('directive_taste', { state: 'unknown', reason: 'not_configured' })
    log('answer_requests', { state: 'unknown', reason: 'not_configured' })
    log('kit_plans', { state: 'unknown', reason: 'not_configured' })
    return none
  }
  let directive
  try {
    directive = (await c.getDirective()).directive
  } catch (e) {
    const reason = e instanceof ProtocolError ? e.code : 'directive_unavailable'
    log('directive_taste', { state: 'unknown', reason })
    log('answer_requests', { state: 'unknown', reason })
    log('kit_plans', { state: 'unknown', reason })
    return none
  }
  const taste = directive.taste ?? null
  log('directive_taste', taste ? { state: taste.approved_voice_rules.length ? 'approved' : 'none_approved', rules: taste.approved_voice_rules.length } : { state: 'unknown', reason: 'absent' })
  const requests = directive.answer_requests ?? []
  log('answer_requests', { state: 'read', requests: requests.length, questions: requests.reduce((n, r) => n + r.questions.length, 0) })
  let decisions: PlanDecision[] = [...(directive.decisions_since ?? [])]
  try {
    decisions = [...decisions, ...(await c.getDecisions(new Date(now.getTime() - (PLAN_OPEN_DAYS + 1) * 86_400_000).toISOString()))]
  } catch (e) {
    log('kit_plans_decisions_unavailable', { code: e instanceof ProtocolError ? e.code : 'decisions_unavailable' })
  }
  const plans = kitPlans(decisions, now)
  log('kit_plans', { state: 'read', open: plans.open.length, stopped: plans.stopped.length, done: plans.done.length, held: plans.held.length })
  return { taste, requests, kitPlans: plans.open }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.mode === 'verify') return verifyMain(args)
  const deps = buildDeps(args)
  // Offline runs stay offline: fixtures carry no directive, so taste is
  // unknown, no request is open and no kit plan is in flight.
  if (!args.offline) {
    const read = await readDirectiveInputs(process.env)
    deps.taste = read.taste
    deps.requests = read.requests
    deps.kitPlans = read.kitPlans
  }
  if (args.siteIn) deps.sharedAudit = readSharedAudit(args.siteIn, process.env)
  const opts: RunOpts = { subject: args.subject, weekStart: args.week, dry: args.dry, outPath: args.out, commandId: args.commandId, rehearse: args.rehearse }
  log('run_start', { subject: args.subject, week_start: args.week, dry: args.dry, rehearse: args.rehearse, offline: args.offline, engines: deps.engines.map(e => e.engine), claude_lane: deps.claudeLane ?? null, cap_usd: args.capUsd, command_id: args.commandId })

  if (args.commandId !== null && !args.dry) {
    await deps.cc.patchCommand({ command_id: args.commandId, state: 'running' })
  }
  let failed: string | null = null
  let outcome: RunResult | null = null
  try {
    const { results, failures } = outcome = await runAll(deps, opts)
    if (args.dry) {
      const report = {
        week_start: args.week,
        subjects: results.map(r => ({ slug: r.slug, kind: r.packet.subject.kind, written_to: r.shipped.path ?? args.out ?? null, stats: r.packet.stats, themes_status: r.packet.themes_status, recommendations: r.packet.recommendations.length, watch_list: r.packet.watch_list.length })),
        failures,
        ledger: deps.ledger.summary(),
      }
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    }
    if (failures.length) failed = failures.map(f => `${f.slug}: ${f.error}`).join(' | ')
    if (!results.length) failed = failed ?? 'no subject produced a packet'
  } catch (e) {
    failed = errText(e)
    log('run_failed', { error: failed })
  }
  // Report the spend LAST and unconditionally, including after a failure.
  //
  // A run that died on its third subject still paid for the first two, and a
  // failed run that reports nothing is the same lie as a green node on a 404:
  // the money left the account either way. A dry run is metered too, because --dry
  // only stops the packet shipping, every probe still ran and still billed.
  // The meter's first shape until the context lists meter_billing; then every
  // row with its provider and billing, subscription and other providers too.
  const rows = deps.usage.postRows()
  if (rows.length) {
    const posted = await deps.cc.postUsage(rows, args.week)
    log('usage_reported', {
      rows: rows.length, calls: deps.usage.calls, tokens: deps.usage.tokens,
      web_search_requests: deps.usage.searches,
      billing_rows: deps.usage.billingAccepted, provider_calls: deps.usage.providerCalls,
      ok: posted.ok, error: posted.error,
    })
  } else {
    // Said out loud, because "no rows" and "the meter is broken" look identical
    // in silence, and that is the exact confusion this reporting exists to end.
    log('usage_not_reported', { reason: deps.usage.billingAccepted ? 'no tokens or failures measured this run' : 'no anthropic tokens measured this run' })
  }
  // The Claude Code lane's tokens: billed to the subscription, counted here
  // and in the sealed summary, and posted as tokens with no dollar amount once
  // the context lists meter_billing (src/lib/usage.ts), never as a priced row.
  if (deps.usage.subscriptionCalls) log('usage_subscription', { calls: deps.usage.subscriptionCalls, tokens: deps.usage.subscriptionTokens, posted: deps.usage.billingAccepted })

  if (args.summaryOut) writeSummary(args, deps, outcome)

  if (failed && args.commandId !== null && !args.dry) {
    try { await deps.cc.patchCommand({ command_id: args.commandId, state: 'failed', error: failed.slice(0, 600) }) } catch (e) { log('patch_failed', { error: errText(e) }) }
  }
  return failed ? 1 : 0
}

/** What verifyMain may be given in place of the clock and the protocol door (tests). */
export interface VerifyOverrides extends DepsOverrides {
  now?: Date
  /** The protocol door for the stored-report read; null means none. Unset: built from the environment (never offline). */
  protocol?: Pick<GrowthEngineHttp, 'getReport'> | null
}

export type VerifyGuard = { ok: true } | { ok: false; reason: string }

/**
 * "Once", checked in the job that spends, before anything is asked. The plan
 * job checks it too, but GitHub's "Re-run failed jobs" reuses the plan job's
 * outputs and runs only the failed jobs, so the research job cannot take the
 * plan job's word for it:
 *
 * - GITHUB_RUN_ATTEMPT must be "1" or unset: a re-run of the workflow is
 *   never a verify run's first try;
 * - the payload's date must be today (UTC): a payload is that Sunday's only;
 * - where the protocol door is available (the bearer is set, and the run is
 *   not offline), Control Center must hold no verify report for that date,
 *   read back first; a read that fails refuses too, since once must be proven.
 *
 * Refused with a reason code; the log line carries the code and counts, never
 * a query id.
 */
export async function verifyGuard(payload: VerifyPayload, env: NodeJS.ProcessEnv, now: Date, protocol: Pick<GrowthEngineHttp, 'getReport'> | null): Promise<VerifyGuard> {
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim()
  if (attempt !== '' && attempt !== '1') return { ok: false, reason: 'rerun_attempt' }
  if (payload.date !== now.toISOString().slice(0, 10)) return { ok: false, reason: 'not_today' }
  if (!protocol) return { ok: true }
  try {
    if (await protocol.getReport(verifyRunId(payload.date))) return { ok: false, reason: 'already_ran' }
  } catch (e) {
    return { ok: false, reason: e instanceof ProtocolError ? e.code : 'readback_unavailable' }
  }
  return { ok: true }
}

/** The protocol door for the guard's read: the bearer and its URL from the environment, or null (never offline). */
function protocolDoor(args: CliArgs, env: NodeJS.ProcessEnv): Pick<GrowthEngineHttp, 'getReport'> | null {
  if (args.offline || !String(env.CONTROL_CENTER_ENGINE_TOKEN ?? '').trim()) return null
  try { return new GrowthEngineHttp(env.CONTROL_CENTER_PROTOCOL_URL || env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN) } catch (e) {
    // A bearer with no usable URL: the read cannot be made, so once cannot be proven.
    return { getReport: async () => { throw e } }
  }
}

/**
 * The verify run (`--mode verify`): only the payload's questions, no model
 * call, no directive read, no site read, and only past verifyGuard. Its
 * summary says it is a verify run, for the report job's verify report.
 */
export async function verifyMain(args: CliArgs, env: NodeJS.ProcessEnv = process.env, overrides: VerifyOverrides = {}): Promise<number> {
  const payload = args.verifyPayload ? readVerifyPayload(args.verifyPayload) : null
  if (!payload) return 1
  const now = overrides.now ?? new Date()
  const guard = await verifyGuard(payload, env, now, overrides.protocol !== undefined ? overrides.protocol : protocolDoor(args, env))
  if (!guard.ok) {
    log('verify_refused', { reason: guard.reason, questions: payload.query_ids.length })
    return 1
  }
  const deps = buildDeps(args, env, now, overrides)
  // A verify run reads no page: no site audit, no page cited first.
  deps.site = null
  const opts: RunOpts = { subject: args.subject, weekStart: args.week, dry: args.dry, outPath: args.out, commandId: null }
  log('run_start', { mode: 'verify', subject: args.subject, week_start: args.week, dry: args.dry, offline: args.offline, engines: deps.engines.map(e => e.engine), claude_lane: deps.claudeLane ?? null, cap_usd: args.capUsd })
  let failed: string | null = null
  let outcome: RunResult | null = null
  try {
    const r = outcome = await runVerifyAll(deps, opts, payload)
    if (r.failures.length) failed = r.failures.map(f => `${f.slug}: ${f.error}`).join(' | ')
  } catch (e) {
    failed = errText(e)
    log('run_failed', { error: failed })
  }
  const rows = deps.usage.postRows()
  if (rows.length) {
    const posted = await deps.cc.postUsage(rows, args.week)
    log('usage_reported', { rows: rows.length, calls: deps.usage.calls, tokens: deps.usage.tokens, web_search_requests: deps.usage.searches, billing_rows: deps.usage.billingAccepted, provider_calls: deps.usage.providerCalls, ok: posted.ok, error: posted.error })
  }
  if (deps.usage.subscriptionCalls) log('usage_subscription', { calls: deps.usage.subscriptionCalls, tokens: deps.usage.subscriptionTokens, posted: deps.usage.billingAccepted })
  if (args.summaryOut) writeSummary(args, deps, outcome, env, 'verify')
  return failed ? 1 : 0
}

/**
 * Counts, and each venture's top win kit (the one field that is not a count,
 * bound for Control Center only), sealed (src/lib/seal.ts), because the file
 * crosses jobs as an artifact of a public repository. Never fails the run: the packets have
 * shipped by now, and the report job reads a missing summary as a failed
 * subject rather than as a quiet one.
 */
function writeSummary(args: CliArgs, deps: RunDeps, outcome: RunResult | null, env: NodeJS.ProcessEnv = process.env, kind: 'research' | 'verify' = 'research'): void {
  if (!args.summaryOut) return
  const secret = env.AEO_ENGINE_SECRET ?? ''
  if (!secret) { log('summary_not_written', { reason: 'AEO_ENGINE_SECRET is not set' }); return }
  // `engines` are the packet's: the ones that count. A gated engine is in
  // each subject's gated_engines and per-engine counts instead.
  const fromPackets = [...new Set((outcome?.results ?? []).flatMap(r => r.packet.engines))]
  const engines = fromPackets.length ? fromPackets : deps.engines.map(e => e.engine).filter(e => inPacket(e))
  const summary = buildRunSummary({
    subjectArg: args.subject,
    weekStart: args.week,
    now: new Date(),
    engines,
    capUsd: kind === 'verify' ? deps.ledger.capUsd : args.capUsd,
    spentUsd: deps.ledger.total,
    maxProbeUsd: Math.max(0, ...[...deps.engines, ...(deps.shadow ? [deps.shadow] : [])].map(e => PRICE_USD_PER_CALL[costKindOf(e)] ?? 0)),
    results: outcome?.results ?? [],
    failures: outcome?.failures ?? [],
    errorCode: outcome ? null : 'run_failed',
    searchRequests: deps.usage.searchesBy('aeo-probe'),
    ...(deps.claudeLane ? { claudeLane: deps.claudeLane } : {}),
    subscription: { calls: deps.usage.subscriptionCalls, tokens: deps.usage.subscriptionTokens },
    kind,
  })
  try {
    writePacket(args.summaryOut, JSON.parse(seal(summary, secret, env.GITHUB_RUN_ID ?? 'local')))
    log('summary_written', { path: args.summaryOut, subjects: summary.subjects.length })
  } catch (e) {
    log('summary_not_written', { reason: errText(e) })
  }
}

const invokedDirectly = process.argv[1] && /src[\\/]index\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }, e => { log('run_crashed', { error: errText(e) }); process.exitCode = 1 })
}
