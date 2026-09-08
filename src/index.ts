/**
 * aeo-engine: the weekly answer-engine research run.
 *
 *   tsx src/index.ts [--subject <slug|uuid|all>] [--week YYYY-MM-DD] [--dry] [--offline]
 *                    [--out <path>] [--command-id <n>] [--cap-usd <n>]
 *
 *   --dry      validate and write the packet instead of POSTing it
 *   --offline  fixtures under tests/fixtures instead of any network call
 *   --out      where a dry run writes; with several subjects one file holds an array
 */
import { createHash, randomUUID } from 'node:crypto'
import { CAPS, ENGINES, MODELS } from './config/run.js'
import { AnthropicClient } from './clients/anthropic.js'
import { ControlCenterHttp } from './clients/controlCenter.js'
import { FirefliesHttp } from './clients/fireflies.js'
import { OfflineControlCenter, OfflineEngine, OfflineFireflies, OfflineModel } from './clients/offline.js'
import { OpenAIClient } from './clients/openai.js'
import { PerplexityClient } from './clients/perplexity.js'
import type { EngineClient, ModelClient } from './clients/types.js'
import { XaiClient } from './clients/xai.js'
import { Ledger } from './lib/cost.js'
import { errText, log } from './lib/log.js'
import { mondayOf, YMD } from './lib/week.js'
import { runAll, type RunDeps, type RunOpts } from './pipeline/run.js'

export interface CliArgs {
  subject: string
  week: string
  dry: boolean
  offline: boolean
  out: string | null
  commandId: number | null
  capUsd: number
  fixtures: string
}

export function parseArgs(argv: readonly string[], now = new Date()): CliArgs {
  const args: CliArgs = { subject: 'all', week: mondayOf(now), dry: false, offline: false, out: null, commandId: null, capUsd: CAPS.MAX_USD_PER_RUN, fixtures: 'tests/fixtures' }
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
      case '--offline': args.offline = true; break
      case '--out': args.out = next(); break
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
      default: throw new Error(`unknown argument ${a}`)
    }
  }
  return args
}

/** A uuid derived from a key: version and variant nibbles set so it passes the contract's pattern. */
export function uuidFromKey(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

function liveEngines(env: NodeJS.ProcessEnv): EngineClient[] {
  const out: EngineClient[] = []
  for (const e of ENGINES) {
    if (e === 'perplexity') out.push(new PerplexityClient(env.PERPLEXITY_API_KEY ?? ''))
    else if (e === 'chatgpt') out.push(new OpenAIClient(env.OPENAI_API_KEY ?? ''))
    else if (e === 'claude') out.push(new AnthropicClient(env.ANTHROPIC_API_KEY ?? ''))
    else if (e === 'grok') out.push(new XaiClient(env.XAI_API_KEY ?? ''))
  }
  return out
}

export function buildDeps(args: CliArgs, env: NodeJS.ProcessEnv = process.env, now = new Date()): RunDeps {
  const ledger = new Ledger(args.capUsd)
  if (args.offline) {
    const dir = args.fixtures
    return {
      cc: new OfflineControlCenter(dir),
      fireflies: new OfflineFireflies(dir),
      engines: ENGINES.map(e => new OfflineEngine(e, MODELS[e === 'chatgpt' ? 'openai' : e === 'claude' ? 'anthropic' : e === 'grok' ? 'xai' : 'perplexity'], dir)),
      model: new OfflineModel(dir),
      ledger,
      mintId: uuidFromKey,
      now,
    }
  }
  const anthropic = new AnthropicClient(env.ANTHROPIC_API_KEY ?? '')
  const model: ModelClient = anthropic.asModelClient()
  return {
    cc: new ControlCenterHttp(env.CONTROL_CENTER_URL ?? '', env.AEO_ENGINE_SECRET ?? ''),
    fireflies: env.FIREFLIES_API_KEY ? new FirefliesHttp(env.FIREFLIES_API_KEY) : null,
    engines: liveEngines(env),
    model,
    ledger,
    mintId: () => randomUUID(),
    now,
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  const deps = buildDeps(args)
  const opts: RunOpts = { subject: args.subject, weekStart: args.week, dry: args.dry, outPath: args.out, commandId: args.commandId }
  log('run_start', { subject: args.subject, week_start: args.week, dry: args.dry, offline: args.offline, engines: ENGINES, cap_usd: args.capUsd, command_id: args.commandId })

  if (args.commandId !== null && !args.dry) {
    await deps.cc.patchCommand({ command_id: args.commandId, state: 'running' })
  }
  let failed: string | null = null
  try {
    const { results, failures } = await runAll(deps, opts)
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
  if (failed && args.commandId !== null && !args.dry) {
    try { await deps.cc.patchCommand({ command_id: args.commandId, state: 'failed', error: failed.slice(0, 600) }) } catch (e) { log('patch_failed', { error: errText(e) }) }
  }
  return failed ? 1 : 0
}

const invokedDirectly = process.argv[1] && /src[\\/]index\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }, e => { log('run_crashed', { error: errText(e) }); process.exitCode = 1 })
}
