/**
 * The growth engine protocol from the command line.
 *
 *   tsx src/protocol/cli.ts directive [--mode live|synthetic]
 *       The daily cc-growth-directive wake-up: attempt, directive, a report of
 *       when research last ran and next runs, readback, decisions, attempt.
 *       Never a paid call.
 *
 *   tsx src/protocol/cli.ts research-start --attempt-id <id> --run-id <id> --started-at <iso>
 *       The research run's plan job: the started attempt and the directive,
 *       before the subject list is read.
 *
 *   tsx src/protocol/cli.ts research-report --attempt-id <id> --run-id <id> --started-at <iso>
 *       --summaries <dir> --subjects '<json slugs>' --scope all|one --total-cap-usd <n>
 *       [--plan-error <code>]
 *       The research run's report job: opens the sealed job summaries, then
 *       report, readback, decisions and the terminal attempt.
 *
 * Reads CONTROL_CENTER_URL and CONTROL_CENTER_ENGINE_TOKEN (and, for
 * research-report, AEO_ENGINE_SECRET and GITHUB_RUN_ID to open the
 * summaries). A missing one is named and the exit code is 2; no value is
 * ever printed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GrowthEngineHttp, ProtocolError } from '../clients/growthEngine.js'
import { errText, log } from '../lib/log.js'
import { unseal } from '../lib/seal.js'
import { ID_RE } from '../schema/report.js'
import { finishResearch, runDirective, startResearch } from './loop.js'
import type { RunSummary } from './measure.js'

type Flags = Record<string, string>

export function parseFlags(argv: readonly string[]): { command: string; flags: Flags } {
  const [command = '', ...rest] = argv
  const flags: Flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const v = rest[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
    flags[a.slice(2)] = v
    i++
  }
  return { command, flags }
}

function need(flags: Flags, name: string, re?: RegExp): string {
  const v = flags[name]
  if (!v) throw new Error(`--${name} is required`)
  if (re && !re.test(v)) throw new Error(`--${name} is malformed`)
  return v
}

function mode(flags: Flags): 'live' | 'synthetic' {
  const m = flags.mode ?? 'live'
  if (m !== 'live' && m !== 'synthetic') throw new Error('--mode is live or synthetic')
  return m
}

/** Every *.json under dir, opened with this run's key. A file that will not open is skipped and named by count only. */
export function readSummaries(dir: string, secret: string, context: string): { summaries: RunSummary[]; unreadable: number } {
  if (!existsSync(dir)) return { summaries: [], unreadable: 0 }
  const files = readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.json')).map(f => join(dir, f)).filter(p => statSync(p).isFile())
  const summaries: RunSummary[] = []
  let unreadable = 0
  for (const f of files) {
    try {
      const s = unseal(readFileSync(f, 'utf8'), secret, context) as RunSummary
      if (s && s.v === 1 && Array.isArray(s.subjects)) summaries.push(s)
      else unreadable++
    } catch {
      unreadable++
    }
  }
  return { summaries, unreadable }
}

function missingEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  return names.filter(n => !String(env[n] ?? '').trim())
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let parsed: ReturnType<typeof parseFlags>
  try { parsed = parseFlags(argv) } catch (e) { log('protocol_usage', { error: errText(e) }); return 2 }
  const { command, flags } = parsed
  if (!['directive', 'research-start', 'research-report'].includes(command)) {
    log('protocol_usage', { error: `unknown command "${command}"; use directive, research-start or research-report` })
    return 2
  }
  const required = ['CONTROL_CENTER_URL', 'CONTROL_CENTER_ENGINE_TOKEN', ...(command === 'research-report' ? ['AEO_ENGINE_SECRET'] : [])]
  const absent = missingEnv(env, required)
  if (absent.length) {
    // Names only. The job fails so a missing secret is never a green run.
    log('protocol_not_configured', { missing: absent })
    process.stderr.write(`Control Center protocol is not configured: ${absent.join(', ')} not set.\n`)
    return 2
  }

  let client: GrowthEngineHttp
  try {
    client = new GrowthEngineHttp(env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN)
  } catch (e) {
    log('protocol_not_configured', { code: e instanceof ProtocolError ? e.code : 'client_invalid' })
    return 2
  }
  const revision = env.GITHUB_SHA || 'unknown'
  const runRef = `${env.GITHUB_RUN_ID || 'local'}.${env.GITHUB_RUN_ATTEMPT || '1'}`

  try {
    if (command === 'directive') {
      const date = new Date().toISOString().slice(0, 10)
      const out = await runDirective(client, { mode: mode(flags), revision, attemptId: `aeo:${date}:directive:${runRef}` })
      return out.status === 'succeeded' ? 0 : 1
    }

    const ids = { attemptId: need(flags, 'attempt-id', ID_RE), runId: need(flags, 'run-id', ID_RE), startedAt: need(flags, 'started-at') }
    if (Number.isNaN(Date.parse(ids.startedAt))) throw new Error('--started-at is not a date-time')

    if (command === 'research-start') return (await startResearch(client, ids)).ok ? 0 : 1

    const subjects = JSON.parse(need(flags, 'subjects')) as unknown
    if (!Array.isArray(subjects) || !subjects.every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s))) throw new Error('--subjects must be a JSON array of slugs')
    const scope = need(flags, 'scope')
    if (scope !== 'all' && scope !== 'one') throw new Error('--scope is all or one')
    const totalCapUsd = Number(need(flags, 'total-cap-usd'))
    if (!(totalCapUsd > 0)) throw new Error('--total-cap-usd must be positive')
    const planError = flags['plan-error'] ? need(flags, 'plan-error', /^[a-z][a-z0-9_]{0,63}$/) : null
    const { summaries, unreadable } = readSummaries(flags.summaries ?? 'summaries', env.AEO_ENGINE_SECRET ?? '', env.GITHUB_RUN_ID || 'local')
    log('protocol_summaries', { read: summaries.length, unreadable, expected: subjects.length })
    const now = new Date()
    const out = await finishResearch(client, ids, {
      mode: mode(flags), observedAt: now, revision, capturedAt: new Date(ids.startedAt),
      scope, expected: subjects as string[], summaries, totalCapUsd, planError,
    })
    return out.status === 'succeeded' ? 0 : 1
  } catch (e) {
    log('protocol_usage', { error: errText(e) })
    return 2
  }
}

const invokedDirectly = process.argv[1] && /src[\\/]protocol[\\/]cli\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }, e => { log('protocol_crashed', { error: errText(e) }); process.exitCode = 1 })
}
