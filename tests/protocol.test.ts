import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp, ProtocolError, protocolBase } from '../src/clients/growthEngine.js'
import { canonicalJson, reportDigest } from '../src/lib/canonical.js'
import { seal, unseal } from '../src/lib/seal.js'
import { deliver, finishResearch, runDirective, startResearch } from '../src/protocol/loop.js'
import { main as protocolMain } from '../src/protocol/cli.js'
import { buildRunSummary, countCitedFirst, firstCitationIsOurs, isoWeek, nextScheduledRun, type RunSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, buildResearchReport, SPEND_PROPOSAL_ID, spendPayloadSha, type ResearchInput } from '../src/protocol/reports.js'
import type { AeoPacket } from '../src/schema/packet.js'
import { validateReport, type EngineReport } from '../src/schema/report.js'
import { ROOT, readJson } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const EXAMPLE = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.example.json'), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-10-25T06:30:00Z')
const ctrlPacket = () => structuredClone(readJson('expected/packet.ctrl.json')) as AeoPacket
const CTRL_DOMAINS = ['ctrl.mindmake.co', 'mindmake.co']

// ---------- digest ----------

test('digest: reproduces the worked example from the protocol', () => {
  assert.equal(reportDigest(EXAMPLE), 'f4351324e84aa1baf6afd1bc4d2ffadb3039ab6399b2309c2717b89a26a0a517')
  assert.equal(EXAMPLE.payload_sha256, reportDigest(EXAMPLE))
})

test('digest: keys sorted at every depth, arrays in order, whole numbers stay whole', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 'x' }, 3.5, null] }), '{"a":[{"c":"x","d":2},3.5,null],"b":1}')
  assert.equal(canonicalJson({ v: 25 }), '{"v":25}')
  assert.equal(canonicalJson({ s: 'café "q"' }), '{"s":"café \\"q\\""}')
})

// ---------- the envelope ----------

test('report validator: accepts the worked example, refuses unknown fields at any depth', () => {
  assert.deepEqual(validateReport(EXAMPLE), { ok: true })
  const top = { ...structuredClone(EXAMPLE), extra: 1 }
  assert.equal(validateReport(top).ok, false)
  const nested = structuredClone(EXAMPLE) as { objectives: Array<Record<string, unknown>> }
  nested.objectives[0].note = 'x'
  const r = validateReport(nested)
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.errors.some(e => /objectives\[0\]\.note: unknown field/.test(e)))
})

test('report validator: unknown is null with a reason, never zero', () => {
  const bad = structuredClone(EXAMPLE) as { objectives: Array<Record<string, unknown>> }
  bad.objectives[1].value = 0
  assert.equal(validateReport(bad).ok, false)
  const noReason = structuredClone(EXAMPLE) as { objectives: Array<Record<string, unknown>> }
  noReason.objectives[1].reason = null
  assert.equal(validateReport(noReason).ok, false)
})

// ---------- measurement ----------

test('cited first: our domain must be the first citation, on at least one assistant', () => {
  assert.equal(firstCitationIsOurs(['https://www.mindmake.co/a', 'https://x.example'], CTRL_DOMAINS), true)
  assert.equal(firstCitationIsOurs(['https://x.example', 'https://mindmake.co/a'], CTRL_DOMAINS), false)
  assert.equal(firstCitationIsOurs(['https://notmindmake.co/a'], CTRL_DOMAINS), false)
  assert.equal(firstCitationIsOurs([], CTRL_DOMAINS), false)
  const c = countCitedFirst(ctrlPacket(), CTRL_DOMAINS)
  assert.equal(c.cited_first, 2)
  assert.equal(c.probed_questions, ctrlPacket().queries.filter(q => q.probes.length).length)
})

test('next scheduled run: Sunday 04:00 UTC in an odd ISO week', () => {
  assert.equal(isoWeek(new Date('2026-10-25T00:00:00Z')), 43)
  assert.equal(isoWeek(new Date('2026-11-01T00:00:00Z')), 44)
  assert.equal(nextScheduledRun(new Date('2026-10-19T05:10:00Z')).toISOString(), '2026-10-25T04:00:00.000Z')
  assert.equal(nextScheduledRun(new Date('2026-10-25T03:59:00Z')).toISOString(), '2026-10-25T04:00:00.000Z')
  assert.equal(nextScheduledRun(new Date('2026-10-25T04:00:00Z')).toISOString(), '2026-11-08T04:00:00.000Z')
  assert.equal(nextScheduledRun(new Date('2026-12-30T12:00:00Z')).toISOString(), '2027-01-03T04:00:00.000Z')
})

test('seal: opens only with the same secret and the same workflow run, and refuses tampering', () => {
  const s = seal({ n: 1 }, 'secret-a', 'run-1')
  assert.deepEqual(unseal(s, 'secret-a', 'run-1'), { n: 1 })
  assert.throws(() => unseal(s, 'secret-b', 'run-1'))
  assert.throws(() => unseal(s, 'secret-a', 'run-2'))
  const j = JSON.parse(s)
  j.data = Buffer.from(Buffer.from(j.data, 'base64').map((b: number, i: number) => (i === 0 ? b ^ 1 : b))).toString('base64')
  assert.throws(() => unseal(JSON.stringify(j), 'secret-a', 'run-1'))
})

// ---------- report builders ----------

function summary(over: Partial<RunSummary> & { subjects: RunSummary['subjects'] }): RunSummary {
  return { v: 1, subject_arg: 'x', week_start: '2026-10-19', generated_at: NOW.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 4.2, max_probe_usd: 0.04, error_code: null, ...over }
}
const venture = (cf = 3, skipped = 0) => ({ slug: 'ctrl', kind: 'venture' as const, product_slug: 'ctrl', ok: true, questions: 34, probed_questions: 20, cited_first: cf, probes: 60 - skipped, probes_failed: 0, probes_skipped_cap: skipped })
const prospect = (slug: string, cf = 1) => ({ slug, kind: 'prospect' as const, product_slug: null, ok: true, questions: 30, probed_questions: 20, cited_first: cf, probes: 60, probes_failed: 0, probes_skipped_cap: 0 })
const aspiration = { slug: 'secret-aspiration-co', kind: 'aspiration' as const, product_slug: null, ok: true, questions: 25, probed_questions: 20, cited_first: 7, probes: 60, probes_failed: 0, probes_skipped_cap: 0 }

function researchInput(over: Partial<ResearchInput> = {}): ResearchInput {
  return {
    runId: 'aeo:2026-10-25:research', mode: 'synthetic', observedAt: NOW, revision: 'abc123', capturedAt: new Date('2026-10-25T04:00:00Z'),
    scope: 'all', expected: ['ctrl', 'secret-prospect-co', 'secret-aspiration-co'],
    summaries: [summary({ subjects: [venture()] }), summary({ subjects: [prospect('secret-prospect-co')] }), summary({ subjects: [aspiration] })],
    totalCapUsd: 15, planError: null, ...over,
  }
}

function assertValid(r: EngineReport): void {
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'schema')
  assert.deepEqual(validateReport(r), { ok: true })
}

test('research report: schema valid, counts ventures and prospects, never names a prospect or an aspiration', () => {
  const r = buildResearchReport(researchInput())
  assertValid(r)
  assert.equal(r.status, 'ready')
  assert.deepEqual(r.objectives[0], { key: 'queries_cited_first', value: 4, unit: 'questions', window_start: '2026-10-12T00:00:00.000Z', window_end: NOW.toISOString(), timezone: 'UTC', availability: 'measured', reason: null })
  const text = JSON.stringify(r)
  assert.ok(!text.includes('secret-prospect-co') && !text.includes('secret-aspiration-co'))
  assert.ok(r.activity.some(a => /for ctrl on 3 assistants; ours was the first citation on 3 questions/.test(a.line)))
  assert.ok(r.activity.some(a => /prospect 1 of 1.*Mindmake was the first citation on 1 question\./.test(a.line)))
  assert.ok(r.activity.some(a => /aspiration 1 of 1 on 3 assistants; aspirations are not counted/.test(a.line)))
  assert.ok(r.activity.some(a => /Next scheduled research run: 2026-11-08 04:00 UTC/.test(a.line)))
  assert.deepEqual(r.proposals, [])
  assert.ok(!/\$|usd/i.test(r.activity.map(a => a.line).join(' ')), 'no spend figure in a line')
})

test('research report: a single-subject run or a failed subject leaves the objective unknown, with a reason', () => {
  const one = buildResearchReport(researchInput({ scope: 'one', expected: ['ctrl'], summaries: [summary({ subjects: [venture()] })] }))
  assertValid(one)
  assert.equal(one.objectives[0].value, null)
  assert.equal(one.objectives[0].availability, 'missing')
  assert.match(one.objectives[0].reason ?? '', /one subject/)

  const failed = buildResearchReport(researchInput({ summaries: [summary({ subjects: [venture()] }), summary({ subjects: [aspiration] })] }))
  assertValid(failed)
  assert.equal(failed.status, 'degraded')
  assert.equal(failed.objectives[0].value, null)
  assert.match(failed.objectives[0].reason ?? '', /failed for 1 of 2 counted subjects/)
  assert.ok(failed.activity.some(a => /unnamed subject 1 of 1 left no readable summary/.test(a.line)))
  assert.ok(!JSON.stringify(failed).includes('secret-prospect-co'))

  const plan = buildResearchReport(researchInput({ expected: [], summaries: [], planError: 'context_unavailable' }))
  assertValid(plan)
  assert.equal(plan.status, 'degraded')
  assert.equal(plan.holds[0].reason, 'context_unavailable')
})

test('research report: a spend proposal only when the cap stopped probes, with a whole-dollar amount above the cap', () => {
  const r = buildResearchReport(researchInput({ summaries: [summary({ subjects: [venture(1, 30)], spent_usd: 4.98 }), summary({ subjects: [prospect('secret-prospect-co')] }), summary({ subjects: [aspiration] })] }))
  assertValid(r)
  assert.equal(r.proposals.length, 1)
  const p = r.proposals[0]
  assert.equal(p.proposal_id, SPEND_PROPOSAL_ID)
  assert.equal(p.wall, 'spend')
  assert.ok(Number.isInteger(p.amount_usd) && (p.amount_usd as number) > 15)
  assert.equal(p.amount_usd, Math.ceil((4.98 + 30 * 0.04) * 3))
  assert.equal(p.payload_sha256, spendPayloadSha(p.amount_usd as number))
  assert.equal(p.expires_at, '2026-11-08T04:00:00.000Z')
  assert.equal(r.holds[0].reason, 'spend_cap_reached')
})

test('directive report: unknown until a research run reports, then carried, then stale', () => {
  const base = { runId: 'aeo:2026-10-19:directive', mode: 'synthetic' as const, observedAt: new Date('2026-10-19T05:12:00Z'), revision: 'abc', capturedAt: new Date('2026-10-19T05:11:00Z'), directive: { directive_id: 'aeo:2026-10-19', chosen_by: 'rule', decisions_since: [] }, directiveError: null }
  const none = buildDirectiveReport({ ...base, last: null, lastError: null })
  assertValid(none)
  assert.equal(none.objectives[0].value, null)
  assert.match(none.objectives[0].reason ?? '', /only a research run measures this; the next is 2026-10-25 04:00 UTC/)
  assert.ok(none.activity.some(a => /Next scheduled research run: 2026-10-25 04:00 UTC/.test(a.line)))
  assert.equal(none.status, 'degraded')

  const research = buildResearchReport(researchInput({ observedAt: new Date('2026-10-11T06:00:00Z'), runId: 'aeo:2026-10-11:research', summaries: [summary({ subjects: [venture(1, 30)], spent_usd: 4.98 }), summary({ subjects: [prospect('secret-prospect-co')] }), summary({ subjects: [aspiration] })] }))
  const last = { run_id: research.run_id, accepted_at: '2026-10-11T06:00:05Z', report: research as unknown as Record<string, unknown> }
  const carried = buildDirectiveReport({ ...base, last, lastError: null })
  assertValid(carried)
  assert.equal(carried.objectives[0].availability, 'measured')
  assert.equal(carried.objectives[0].value, 2)
  assert.equal(carried.status, 'ready')
  assert.ok(carried.activity.some(a => /Last full research run reported at 2026-10-11 06:00 UTC/.test(a.line)))
  assert.equal(carried.proposals.length, 1, 'the spend ask stays until the next scheduled run')

  const stale = buildDirectiveReport({ ...base, observedAt: new Date('2026-10-27T05:12:00Z'), last, lastError: null })
  assertValid(stale)
  assert.equal(stale.objectives[0].availability, 'stale')
  assert.equal(stale.objectives[0].value, 2)
  assert.equal(stale.proposals.length, 0, 'the spend ask expired at the next scheduled run')

  const fresh = buildResearchReport(researchInput({ observedAt: new Date('2026-10-18T06:00:00Z'), summaries: [summary({ subjects: [venture(1, 30)] })], expected: ['ctrl'] }))
  const withAsk = { run_id: 'aeo:2026-10-18:research', accepted_at: '2026-10-18T06:00:05Z', report: fresh as unknown as Record<string, unknown> }
  const open = buildDirectiveReport({ ...base, last: withAsk, lastError: null })
  assertValid(open)
  assert.equal(open.proposals.length, 1, 'an unanswered walled ask stays in front of him')
  const sha = fresh.proposals[0].payload_sha256
  const answered = buildDirectiveReport({ ...base, last: withAsk, lastError: null, directive: { ...base.directive, decisions_since: [{ proposal_id: SPEND_PROPOSAL_ID, decision: 'approved', decided_at: '2026-10-18T09:00:00Z', payload_sha256: sha }] } })
  assertValid(answered)
  assert.equal(answered.proposals.length, 0)
  assert.ok(answered.activity.some(a => /Krish approved .* the cap moves only when he sets AEO_MAX_USD_PER_RUN/.test(a.line)))
})

// ---------- the client against a local stand-in ----------

async function withStandIn<T>(fn: (s: StandIn, c: GrowthEngineHttp) => Promise<T>, token = TOKEN): Promise<{ result: T; logs: string; s: StandIn }> {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const c = new GrowthEngineHttp(s.base, token)
    const { result, text } = await captureStderr(() => fn(s, c))
    assert.ok(!text.includes(TOKEN), 'the token never reaches a log line')
    return { result, logs: text, s }
  } finally {
    await s.close()
  }
}

test('directive loop: attempt started, directive, report, readback, decisions, attempt succeeded, and nothing else', async () => {
  const fixed = () => new Date('2026-10-19T05:12:00Z')
  const { result, s } = await withStandIn((_s, c) => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-10-19:directive:1.1', now: fixed }))
  assert.equal(result.status, 'succeeded')
  assert.equal(result.replayed, false)
  const attempts = s.attempts.get('aeo:2026-10-19:directive:1.1') ?? []
  assert.deepEqual(attempts.map(a => a.status), ['started', 'succeeded'])
  assert.equal(attempts[0].finished_at, undefined)
  assert.ok(attempts[1].finished_at)
  const stored = s.reports.get('aeo:2026-10-19:directive')
  assert.ok(stored)
  assert.equal(stored.payload_sha256, result.report?.payload_sha256)
  assert.equal(s.seen.find(x => x.method === 'POST' && x.path.endsWith('/reports'))?.headers['idempotency-key'], 'aeo:2026-10-19:directive')
  const order = s.seen.map(x => `${x.method} ${x.path.replace(/\?.*$/, '').replace(/reports\/aeo%3A2026-10-\d\d%3Aresearch/, 'reports/<research>')}`)
  assert.equal(order[0], 'POST /api/growth/engines/aeo/attempts')
  assert.equal(order[1], 'GET /api/growth/engines/aeo/directive')
  assert.equal(order.filter(o => o === 'GET /api/growth/engines/aeo/reports/<research>').length, 16, 'one free read per day back to the stale line')
  assert.deepEqual(order.slice(-4), ['POST /api/growth/engines/aeo/reports', 'GET /api/growth/engines/aeo/reports/aeo%3A2026-10-19%3Adirective', 'GET /api/growth/engines/aeo/decisions', 'POST /api/growth/engines/aeo/attempts'])
  for (const x of s.seen) assert.ok(x.path.startsWith('/api/growth/engines/aeo/'), 'only the protocol routes')
})

test('directive loop: finds the last research report and carries its reading', async () => {
  const fixed = () => new Date('2026-10-19T05:12:00Z')
  const research = buildResearchReport(researchInput({ observedAt: new Date('2026-10-11T06:00:00Z'), runId: 'aeo:2026-10-11:research' }))
  const { result, s } = await withStandIn(async (s, c) => {
    s.reports.set('aeo:2026-10-11:research', { payload_sha256: research.payload_sha256, mode: 'synthetic', accepted_at: '2026-10-11T06:00:05Z', report: research as unknown as Record<string, unknown> })
    return runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'a:1', now: fixed })
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.report?.objectives[0].value, 4)
  assert.equal(result.report?.objectives[0].availability, 'measured')
  assert.equal(s.count('GET', '/api/growth/engines/aeo/reports/aeo%3A2026-10-1'), 9 + 1, 'stops at the first hit, then reads its own report back')
})

test('report: an identical second POST is answered replayed, and the readback digest matches', async () => {
  const report = buildResearchReport(researchInput())
  const { result } = await withStandIn(async (_s, c) => {
    const first = await deliver(c, report)
    const second = await deliver(c, report)
    const back = await c.getReport(report.run_id)
    return { first, second, back }
  })
  assert.equal(result.first.replayed, false)
  assert.equal(result.second.replayed, true)
  assert.equal(result.back?.payload_sha256, report.payload_sha256)
})

test('report: a 409 is read back, never retried blindly, and fails the attempt with report_conflict', async () => {
  const fixed = () => new Date('2026-10-19T05:12:00Z')
  const { result, s } = await withStandIn(async (s, c) => {
    s.reports.set('aeo:2026-10-19:directive', { payload_sha256: 'f'.repeat(64), mode: 'synthetic', accepted_at: 'x', report: {} })
    return runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'a:2', now: fixed })
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'report_conflict')
  assert.equal(s.count('POST', '/api/growth/engines/aeo/reports'), 1, 'one POST, no retry')
  const posted = s.seen.findIndex(x => x.method === 'POST' && x.path.endsWith('/reports'))
  assert.ok(s.seen.slice(posted + 1).some(x => x.method === 'GET' && x.path.endsWith('/reports/aeo%3A2026-10-19%3Adirective')), 'read back after the conflict')
  assert.deepEqual((s.attempts.get('a:2') ?? []).map(a => [a.status, a.error_code]), [['started', null], ['failed', 'report_conflict']])
})

test('a 401 surfaces as a failed attempt with a lower_snake code, and the token is never logged', async () => {
  const fixed = () => new Date('2026-10-19T05:12:00Z')
  const { result, s, logs } = await withStandIn(async (s, c) => {
    s.overrides.set('reports', { status: 401, body: { error: 'unauthorized' } })
    return runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'a:3', now: fixed })
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'unauthorized')
  assert.deepEqual((s.attempts.get('a:3') ?? []).map(a => [a.status, a.error_code, a.phase]), [['started', null, 'start'], ['failed', 'unauthorized', 'report']])
  assert.match(logs, /"code":"unauthorized"|"error_code":"unauthorized"/)

  const wrong = await withStandIn((_s, c) => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'a:4', now: fixed }), 'gen1_the-wrong-token')
  assert.equal(wrong.result.status, 'failed')
  assert.equal(wrong.result.error_code, 'unauthorized')
  assert.ok(!wrong.logs.includes('gen1_the-wrong-token'))
})

test('client: no redirect is followed, and plain http is refused except on loopback', async () => {
  const { result, s } = await withStandIn(async (s, c) => {
    s.overrides.set('directive', { status: 302, body: {}, headers: { location: `${s.base}/elsewhere` } })
    return c.getDirective().then(() => 'followed', (e: ProtocolError) => e.code)
  })
  assert.equal(result, 'redirect_refused')
  assert.equal(s.count('GET', '/elsewhere'), 0)
  assert.throws(() => protocolBase('http://controlcenter.example'), (e: ProtocolError) => e.code === 'url_insecure')
  assert.throws(() => protocolBase(''), (e: ProtocolError) => e.code === 'url_missing')
  assert.equal(protocolBase('https://cc.example/'), 'https://cc.example')
  assert.throws(() => new GrowthEngineHttp('https://cc.example', ''), (e: ProtocolError) => e.code === 'token_missing')
})

test('research: started in the plan job, finished in the report job, one attempt id', async () => {
  const ids = { attemptId: 'aeo:2026-10-25:research:9.1', runId: 'aeo:2026-10-25:research', startedAt: '2026-10-25T04:00:10Z' }
  const { result, s } = await withStandIn(async (_s, c) => {
    const start = await startResearch(c, ids)
    const input = researchInput()
    const { runId: _r, ...rest } = input
    const done = await finishResearch(c, ids, rest, () => NOW)
    return { start, done }
  })
  assert.equal(result.start.ok, true)
  assert.equal(result.done.status, 'succeeded')
  assert.deepEqual((s.attempts.get(ids.attemptId) ?? []).map(a => a.status), ['started', 'succeeded'])
  assert.equal(s.reports.get(ids.runId)?.payload_sha256, result.done.report?.payload_sha256)
})

// ---------- the command line ----------

test('cli: missing secrets are named, the exit is non-zero, and no value is printed', async () => {
  const { result, text } = await captureStderr(() => protocolMain(['directive'], { CONTROL_CENTER_URL: 'https://cc.example', AEO_ENGINE_SECRET: 'packet-secret-value' }))
  assert.equal(result, 2)
  assert.match(text, /CONTROL_CENTER_ENGINE_TOKEN/)
  assert.ok(!text.includes('packet-secret-value') && !text.includes('cc.example'))
  const insecure = await captureStderr(() => protocolMain(['directive'], { CONTROL_CENTER_URL: 'http://cc.example', CONTROL_CENTER_ENGINE_TOKEN: TOKEN }))
  assert.equal(insecure.result, 2)
  assert.match(insecure.text, /url_insecure/)
  assert.ok(!insecure.text.includes(TOKEN))
})

test('end to end: an offline research run leaves a sealed summary the report job turns into one report', async () => {
  const dir = join(ROOT, 'out', 'protocol-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const env = { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '777' }
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx')
  const r = spawnSync(tsx, ['src/index.ts', '--offline', '--dry', '--subject', 'all', '--week', '2026-09-07', '--out', 'out/protocol-test/packets.json', '--summary-out', 'out/protocol-test/summaries/aeo-summary-all.json'], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  const sealedText = readFileSync(join(dir, 'summaries', 'aeo-summary-all.json'), 'utf8')
  assert.ok(!sealedText.includes('sample-media') && !sealedText.includes('ctrl'), 'nothing readable in the artifact')
  const opened = unseal(sealedText, 'synthetic-engine-secret', '777') as RunSummary
  const bySlug = Object.fromEntries(opened.subjects.map(x => [x.slug, x]))
  assert.equal(bySlug.ctrl.cited_first, 2)
  assert.equal(bySlug['sample-studio'].kind, 'aspiration')
  assert.equal(opened.subjects.length, 3)

  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const { result, text } = await captureStderr(() => protocolMain([
      'research-report', '--mode', 'synthetic', '--attempt-id', 'aeo:2026-09-13:research:777.1', '--run-id', 'aeo:2026-09-13:research', '--started-at', '2026-09-13T04:00:00Z',
      '--summaries', join(dir, 'summaries'), '--subjects', '["ctrl","sample-media","sample-studio"]', '--scope', 'all', '--total-cap-usd', '25',
    ], { CONTROL_CENTER_URL: s.base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN, AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '777', GITHUB_SHA: 'deadbeef' }))
    assert.equal(result, 0, text)
    assert.ok(!text.includes(TOKEN))
    const stored = s.reports.get('aeo:2026-09-13:research')
    assert.ok(stored)
    const report = stored.report as unknown as EngineReport
    assert.deepEqual(schemaErrors(SCHEMA, report), [])
    assert.equal(report.mode, 'synthetic')
    assert.equal(report.source.revision, 'deadbeef')
    assert.equal(report.objectives[0].availability, 'measured')
    assert.equal(report.objectives[0].value, 2 + (bySlug['sample-media'].cited_first ?? 0))
    assert.ok(!JSON.stringify(report).includes('sample-media') && !JSON.stringify(report).includes('sample-studio'))
    assert.deepEqual((s.attempts.get('aeo:2026-09-13:research:777.1') ?? []).map(a => a.status), ['succeeded'])

    // The wrong run cannot open the summaries: every subject reads as failed.
    const other = await captureStderr(() => protocolMain([
      'research-report', '--mode', 'synthetic', '--attempt-id', 'x:1', '--run-id', 'aeo:2026-09-14:research', '--started-at', '2026-09-14T04:00:00Z',
      '--summaries', join(dir, 'summaries'), '--subjects', '["ctrl"]', '--scope', 'all', '--total-cap-usd', '25',
    ], { CONTROL_CENTER_URL: s.base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN, AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '778' }))
    assert.equal(other.result, 1)
    assert.match(other.text, /"unreadable":1/)
    assert.equal(s.reports.get('aeo:2026-09-14:research')?.report.status, 'degraded')
  } finally {
    await s.close()
  }
})

test('buildRunSummary: a run that failed before any subject says so', () => {
  const s = buildRunSummary({ subjectArg: 'all', weekStart: '2026-10-19', now: NOW, engines: [], capUsd: 25, spentUsd: 0, maxProbeUsd: 0.04, results: [], failures: [], errorCode: 'run_failed' })
  assert.equal(s.error_code, 'run_failed')
  assert.deepEqual(s.subjects, [])
})

// ---------- the cost wall, statically ----------

test('cost wall: the protocol code never imports the pipeline or a paid client', () => {
  const files = ['src/protocol/cli.ts', 'src/protocol/loop.ts', 'src/protocol/reports.ts', 'src/protocol/measure.ts', 'src/clients/growthEngine.ts']
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    for (const banned of ['pipeline/', 'anthropic', 'openai', 'perplexity', 'xai', 'fireflies', 'controlCenter.js']) {
      assert.ok(!new RegExp(`from '[^']*${banned}`).test(src), `${f} imports ${banned}`)
    }
  }
  assert.ok(existsSync(join(ROOT, '.github/workflows/cc-growth-directive.yml')))
  assert.ok(readdirSync(join(ROOT, 'src/protocol')).length >= 4)
})
