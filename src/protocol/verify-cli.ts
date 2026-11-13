/**
 * The verify lane's steps in the research workflow's plan job
 * (.github/workflows/aeo-weekly.yml), as a command:
 *
 *   tsx src/protocol/verify-cli.ts decide --date YYYY-MM-DD --out <file> [--mode live|synthetic]
 *       On an even-week Sunday: reads Krish's decisions (free GETs), rebuilds
 *       the go-live payload it would run from the last full research report,
 *       and decides (src/protocol/verify.ts, decideVerify). Runs only on his
 *       approved decision whose payload_sha256 matches, once; in his words
 *       when he amended it. Writes the payload to <file> (on the runner, never
 *       uploaded) and, under GitHub Actions, its outputs: run, reason, and on
 *       a run payload, amount, run_id, attempt_id and started_at. Any read
 *       that fails is a skip with its reason: never a guess, never a run.
 *
 *   tsx src/protocol/verify-cli.ts subjects --payload <file> < context.json
 *       Prints the slugs of the subjects whose last research packet holds one
 *       of the payload's questions, as a JSON array: the verify run's matrix.
 *
 * Reads CONTROL_CENTER_URL and CONTROL_CENTER_ENGINE_TOKEN for `decide`
 * (the research job already holds both). Logs carry a reason code and
 * counts, never a query id, a question or a value of a secret.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { GrowthEngineHttp, ProtocolError } from '../clients/growthEngine.js'
import { errText, log } from '../lib/log.js'
import type { AeoContext } from '../schema/context.js'
import type { PlanDecision } from '../schema/kit.js'
import { parseVerifyPayload, verifyPayloadText, type VerifyPayload } from '../schema/verify.js'
import { lastResearch } from './loop.js'
import { buildGoLive, decideVerify, isOffWeekSunday, VERIFY_EPOCH, VERIFY_PLAN_ID, VERIFY_PREFIX, verifyIdsIn, verifyPlanState, verifyRunId, type VerifyDecision } from './verify.js'

type Reader = Pick<GrowthEngineHttp, 'getDirective' | 'getDecisions' | 'getReport'>

const codeOf = (e: unknown, fallback: string) => (e instanceof ProtocolError ? e.code : fallback)

/**
 * The plan job's decision for one Sunday, from Control Center's records.
 * Reads the directive's decisions and his decisions back to VERIFY_EPOCH,
 * whether a verify report for that Sunday is already stored (once), and the
 * last full research report, from which the payload is rebuilt exactly as
 * the daily report proposed it.
 */
export async function runDecide(c: Reader, date: string, mode: 'live' | 'synthetic' = 'live'): Promise<VerifyDecision> {
  if (!isOffWeekSunday(date)) return { run: false, reason: 'not_an_off_week_sunday' }
  let decisions: PlanDecision[] = []
  try {
    decisions = [...(await c.getDirective()).directive.decisions_since]
  } catch (e) {
    const code = codeOf(e, 'directive_unavailable')
    if (code === 'unauthorized' || code === 'forbidden') return { run: false, reason: code }
    log('verify_directive_unavailable', { code })
  }
  try {
    decisions = [...decisions, ...(await c.getDecisions(VERIFY_EPOCH))]
  } catch (e) {
    return { run: false, reason: codeOf(e, 'decisions_unavailable') }
  }
  let alreadyRan: boolean
  try {
    alreadyRan = !!(await c.getReport(verifyRunId(date)))
  } catch (e) {
    // Once must be proven: without the readback, nothing runs.
    return { run: false, reason: codeOf(e, 'readback_unavailable') }
  }
  let expected = null
  const plan = verifyPlanState(decisions)
  try {
    const { last } = await lastResearch(c, mode, new Date(`${date}T23:59:59Z`))
    expected = last ? buildGoLive(date, verifyIdsIn(last.report), plan.cap, { run_id: last.run_id }) : null
  } catch (e) {
    return { run: false, reason: codeOf(e, 'readback_unavailable') }
  }
  const mine = decisions.filter(d => d.proposal_id === VERIFY_PLAN_ID || d.proposal_id.startsWith(VERIFY_PREFIX)).length
  const out = decideVerify({ date, decisions, expected, alreadyRan })
  log(out.run ? 'verify_go' : 'verify_skipped', out.run
    ? { questions: out.payload.query_ids.length, samples: out.payload.samples, amount_usd: out.payload.amount_usd, amended: out.amended }
    : { reason: out.reason, verify_decisions: mine, mismatched: out.reason === 'sha_mismatch' ? 1 : 0, plan: plan.state })
  return out
}

/** The step's outputs, one key=value a line, for $GITHUB_OUTPUT. */
export function outputLines(d: VerifyDecision, date: string, env: NodeJS.ProcessEnv, now: Date = new Date()): string[] {
  if (!d.run) return ['run=false', `reason=${d.reason}`]
  const id = String(env.GITHUB_RUN_ID ?? '').trim() || 'local'
  const attempt = String(env.GITHUB_RUN_ATTEMPT ?? '').trim() || '1'
  return [
    'run=true',
    'reason=approved',
    `payload=${verifyPayloadText(d.payload)}`,
    `amount=${d.payload.amount_usd}`,
    `run_id=${verifyRunId(date)}`,
    `attempt_id=${verifyRunId(date)}:${id}.${attempt}`,
    `started_at=${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
  ]
}

/** The subjects whose last research packet (subject.prior.queries) holds one of the payload's questions, by slug. */
export function verifySubjects(ctx: Pick<AeoContext, 'subjects'>, payload: VerifyPayload): string[] {
  const ids = new Set(payload.query_ids.map(q => q.toLowerCase()))
  return (Array.isArray(ctx.subjects) ? ctx.subjects : [])
    .filter(s => (s.prior?.queries ?? []).some(q => typeof q?.query_id === 'string' && ids.has(q.query_id.toLowerCase())))
    .map(s => s.slug)
}

function flagsOf(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
    out[a.slice(2)] = v
    i++
  }
  return out
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, stdin: () => string = () => readFileSync(0, 'utf8')): Promise<number> {
  const [command = '', ...rest] = argv
  let flags: Record<string, string>
  try { flags = flagsOf(rest) } catch (e) { log('verify_usage', { error: errText(e) }); return 2 }
  if (command === 'subjects') {
    const parsed = flags.payload ? parseVerifyPayload(readFileSync(flags.payload, 'utf8').trim()) : null
    if (!parsed || !parsed.ok) { log('verify_usage', { error: 'a readable --payload is required' }); return 2 }
    let ctx: AeoContext
    try { ctx = JSON.parse(stdin()) as AeoContext } catch { log('verify_usage', { error: 'the context on stdin is not JSON' }); return 2 }
    const slugs = verifySubjects(ctx, parsed.payload)
    log('verify_subjects', { subjects: slugs.length })
    process.stdout.write(JSON.stringify(slugs))
    return 0
  }
  if (command !== 'decide') { log('verify_usage', { error: `unknown command "${command}"; use decide or subjects` }); return 2 }
  const date = flags.date ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { log('verify_usage', { error: '--date YYYY-MM-DD is required' }); return 2 }
  const mode = flags.mode === 'synthetic' ? 'synthetic' : 'live'
  const absent = ['CONTROL_CENTER_URL', 'CONTROL_CENTER_ENGINE_TOKEN'].filter(n => !String(env[n] ?? '').trim())
  let decision: VerifyDecision
  if (absent.length) {
    // Names only. Without the protocol there is no decision to read, so nothing runs.
    log('verify_not_configured', { missing: absent })
    decision = { run: false, reason: 'not_configured' }
  } else {
    try {
      decision = await runDecide(new GrowthEngineHttp(env.CONTROL_CENTER_URL, env.CONTROL_CENTER_ENGINE_TOKEN), date, mode)
    } catch (e) {
      decision = { run: false, reason: codeOf(e, 'decide_failed') }
    }
  }
  if (decision.run && flags.out) {
    mkdirSync(dirname(flags.out), { recursive: true })
    writeFileSync(flags.out, `${verifyPayloadText(decision.payload)}\n`)
  }
  const lines = outputLines(decision, date, env)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  return 0
}

const invokedDirectly = process.argv[1] && /src[\\/]protocol[\\/]verify-cli\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }, e => { log('verify_crashed', { error: errText(e) }); process.exitCode = 1 })
}
