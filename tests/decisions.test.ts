/**
 * The decision fields a 1.1.0 proposal is answered with, the report version
 * that carries a proposal's stage, and a venture request's note. Synthetic,
 * against the protocol stand-in.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { parseAnswerRequests, parseDecision, parseDecisions, sealReport, validateReport, versionBefore, type EngineReport, type Proposal } from '../src/schema/report.js'
import { ROOT } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const SHA = 'a'.repeat(64)
const AMENDED = 'b'.repeat(64)

/** A decision as 1.1.0 and 1.6.0 serve it, with a field this engine does not know. */
const RAW = {
  proposal_id: 'aeo:go-live:1', decision: 'approved', decided_at: '2026-11-13T09:00:00Z', payload_sha256: SHA,
  stage: 'go_live', amended: true, exact_payload: 'His synthetic version of the words.', amount_usd: 12, amended_sha256: AMENDED,
  carried_out: 'draft', reason_code: 'not_now', reason_text: 'Synthetic words that are not kept', a_future_field: { x: 1 },
}

test('decisions: 1.1.0 fields are read loosely; an unknown field is ignored, a misshapen one left out, never fatal', () => {
  assert.deepEqual(parseDecision(RAW), {
    proposal_id: 'aeo:go-live:1', decision: 'approved', decided_at: '2026-11-13T09:00:00Z', payload_sha256: SHA,
    stage: 'go_live', amended: true, amended_sha256: AMENDED, exact_payload: 'His synthetic version of the words.', amount_usd: 12, carried_out: 'draft', reason_code: 'not_now',
  })
  // The 1.0.0 shape still reads exactly as it did.
  assert.deepEqual(parseDecision({ proposal_id: 'p', decision: 'declined', decided_at: 't', payload_sha256: null }), { proposal_id: 'p', decision: 'declined', decided_at: 't', payload_sha256: null })
  const odd = parseDecision({ ...RAW, stage: 'launch', amended: 'yes', amended_sha256: 'short', exact_payload: 4, amount_usd: -1, carried_out: 'sent', reason_code: 'Not Now' })
  assert.deepEqual(odd, { proposal_id: 'aeo:go-live:1', decision: 'approved', decided_at: '2026-11-13T09:00:00Z', payload_sha256: SHA })
  assert.equal(parseDecision({ ...RAW, stage: null })?.stage, null, 'a null stage is kept: not an autonomous step')
  assert.equal(parseDecision({ ...RAW, decision: 'maybe' }), null)
  assert.equal(parseDecision({ decision: 'approved' }), null)
  assert.deepEqual(parseDecisions([RAW, 'x', null, { proposal_id: 'q', decision: 'done' }]).map(d => d.proposal_id), ['aeo:go-live:1', 'q'])
  assert.deepEqual(parseDecisions(undefined), [])
})

test('decisions: GET decisions and the directive both carry them parsed, through the stand-in', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    s.decisions = [RAW as never, { proposal_id: 'aeo:plan:1', decision: 'approved', decided_at: '2026-11-12T09:00:00Z', payload_sha256: SHA, stage: 'plan', amended: false } as never, { bad: true } as never]
    ;(s.directive as Record<string, unknown>).decisions_since = [RAW, { proposal_id: 'x', decision: 'unknown' }]
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const decisions = await c.getDecisions('2026-11-01T00:00:00Z')
    assert.deepEqual(decisions.map(d => [d.proposal_id, d.stage, d.amended]), [['aeo:go-live:1', 'go_live', true], ['aeo:plan:1', 'plan', false]])
    assert.equal(decisions[0].exact_payload, 'His synthetic version of the words.')
    assert.ok(!('reason_text' in decisions[0]), 'his free words on a No are not kept')
    const { directive } = await c.getDirective()
    assert.deepEqual(directive.decisions_since.map(d => [d.proposal_id, d.stage, d.amount_usd]), [['aeo:go-live:1', 'go_live', 12]])
  } finally {
    await s.close()
  }
})

const proposal = (over: Partial<Proposal>): Proposal => ({
  proposal_id: 'aeo:plan:2026-11-13', title: 'A synthetic plan', why: 'Synthetic', kind: 'advice', wall: 'strategy', amount_usd: null, channel: null,
  objective_key: 'queries_cited_first', exact_payload: 'The synthetic plan, in words he can change.', payload_sha256: SHA, evidence: [], close_condition: { event: 'plan_decided', reference: null }, expires_at: null, ...over,
})

const report = (version: EngineReport['schema_version'], proposals: Proposal[], extra: Partial<EngineReport> = {}): EngineReport => sealReport({
  schema_version: version, engine_id: 'aeo-engine', product_slug: 'mindmake', run_id: `aeo:2026-11-13:stages:${version}:${proposals.length}`, mode: 'synthetic',
  observed_at: '2026-11-13T10:00:00Z', source: { revision: 'abc', captured_at: '2026-11-13T10:00:00Z' }, status: 'ready',
  objectives: [{ key: 'queries_cited_first', value: null, unit: 'questions', window_start: null, window_end: null, timezone: 'UTC', availability: 'missing', reason: 'Synthetic.' }],
  activity: [], proposals, events: [], holds: [], ...extra,
})

test('report 1.1.0: a proposal carries its stage, by the Autonomy rules, and Control Center\'s stand-in accepts it', async () => {
  assert.equal(versionBefore('1.0.0', '1.1.0'), true)
  assert.equal(versionBefore('1.1.0', '1.20.0'), true)
  assert.equal(versionBefore('1.22.0', '1.20.0'), false)
  const plan = proposal({ stage: 'plan' })
  const goLive = proposal({ proposal_id: 'aeo:go-live:2026-11-13', stage: 'go_live', parent_proposal_id: plan.proposal_id, wall: 'spend', amount_usd: 30, close_condition: { event: 'spend_cap_raised', reference: null } })
  const checkIn = proposal({ proposal_id: 'aeo:check-in:2026-11-13', stage: 'check_in', parent_proposal_id: plan.proposal_id })
  const ok = report('1.1.0', [plan, goLive, checkIn])
  assert.deepEqual(validateReport(ok), { ok: true })
  assert.deepEqual(schemaErrors(SCHEMA, ok), [])

  const errorsOf = (r: EngineReport) => { const v = validateReport(r); return v.ok ? [] : v.errors }
  assert.ok(errorsOf(report('1.0.0', [plan])).some(e => /stage: needs schema_version 1\.1\.0/.test(e)), 'refused before 1.1.0, as Control Center refuses it')
  assert.ok(errorsOf(report('1.1.0', [proposal({ stage: 'plan', wall: 'none' })])).some(e => /a plan sits behind a wall/.test(e)))
  assert.ok(errorsOf(report('1.1.0', [proposal({ stage: 'go_live', wall: 'spend', amount_usd: 1 })])).some(e => /parent_proposal_id: required on a go-live/.test(e)))
  assert.ok(errorsOf(report('1.1.0', [proposal({ stage: 'go_live', wall: 'strategy', parent_proposal_id: 'p' })])).some(e => /a go-live is a send, post or spend/.test(e)))
  assert.ok(errorsOf(report('1.1.0', [proposal({ stage: 'check_in', wall: 'send', channel: 'email', parent_proposal_id: 'p' })])).some(e => /a check-in sits behind strategy/.test(e)))
  assert.ok(errorsOf(report('1.1.0', [proposal({ stage: 'launch' as never })])).some(e => /stage: plan, go_live, check_in or null/.test(e)))
  assert.ok(errorsOf(report('1.1.0', [], { priorities: [{ rank: 1, line: 'Synthetic priority', objective_key: null }] })).some(e => /priorities: needs schema_version 1\.20\.0/.test(e)), 'engine state still needs 1.20.0')
  assert.deepEqual(validateReport(report('1.0.0', [proposal({})])), { ok: true }, 'a 1.0.0 proposal with no stage is as before')

  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const r = await new GrowthEngineHttp(s.base, TOKEN).postReport(ok)
    assert.equal(r.replayed, false)
    assert.equal(s.reports.get(ok.run_id)?.payload_sha256, ok.payload_sha256)
  } finally {
    await s.close()
  }
})

test('answer requests: a venture\'s note is kept up to 400 characters; mode and targets only when present', () => {
  const R = '5b2d6c1e-1f3a-4c5d-9e8f-0a1b2c3d4e5f'
  const base = { request_id: R, engine_id: 'growth-heartside', product_slug: 'heartside', subject_slug: 'heartside', questions: ['What is a good gift from my dog?'], requested_at: '2026-11-12T08:00:00Z' }
  const [plain] = parseAnswerRequests([base])
  assert.ok(!('note' in plain) && !('mode' in plain) && !('targets' in plain))
  const [full] = parseAnswerRequests([{ ...base, note: `  ${'n'.repeat(450)}  `, mode: 'replace', targets: ['heartside.io', 7, '  ', 'x'.repeat(250)] }])
  assert.equal(full.note?.length, 400)
  assert.equal(full.mode, 'replace')
  assert.deepEqual(full.targets, ['heartside.io', 'x'.repeat(200)])
  const [odd] = parseAnswerRequests([{ ...base, note: 5, mode: '', targets: 'heartside.io' }])
  assert.ok(!('note' in odd) && !('mode' in odd) && !('targets' in odd))
})

test('answer requests through the stand-in: getDirective keeps a served note, mode and targets as the parser does', async () => {
  const R = '5b2d6c1e-1f3a-4c5d-9e8f-0a1b2c3d4e5f'
  const s = new StandIn(TOKEN)
  ;(s.directive as Record<string, unknown>).answer_requests = [{
    request_id: R, engine_id: 'growth-heartside', product_slug: 'heartside', subject_slug: 'heartside',
    questions: ['What is a good gift from my dog?'], requested_at: '2026-11-12T08:00:00Z',
    note: 'n'.repeat(450), mode: 'replace', targets: ['heartside.io', 7, '  '],
  }]
  await s.start()
  try {
    const { directive } = await new GrowthEngineHttp(s.base, TOKEN).getDirective()
    const [req] = directive.answer_requests ?? []
    assert.equal(req?.request_id, R)
    assert.equal(req?.note?.length, 400)
    assert.equal(req?.mode, 'replace')
    assert.deepEqual(req?.targets, ['heartside.io'])
    assert.deepEqual(req?.questions, ['What is a good gift from my dog?'])
  } finally {
    await s.close()
  }
})
