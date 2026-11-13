/**
 * The verify lane (src/protocol/verify.ts, src/protocol/verify-cli.ts,
 * src/pipeline/verify.ts; brief section I; GET-GOING Steps 1 and 9): the
 * standing plan, the off week's go-live behind spend, and the go-live step
 * that runs it once, only on Krish's approved decision whose digest matches,
 * in his words when he amended it. Synthetic data, stub engines and the
 * local stand-in only; no network.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { OfflineControlCenter } from '../src/clients/offline.js'
import { buildDeps, parseArgs } from '../src/index.js'
import { canonicalJson, sha256Hex } from '../src/lib/canonical.js'
import { runVerifyAll, verifyShare } from '../src/pipeline/verify.js'
import { finishVerify, runDirective } from '../src/protocol/loop.js'
import { main as protocolMain } from '../src/protocol/cli.js'
import { unseal } from '../src/lib/seal.js'
import { buildRunSummary, type RunSummary, type SubjectSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, buildResearchReport, buildVerifyReport, type DecisionLite, type ResearchInput } from '../src/protocol/reports.js'
import { main as verifyCli, outputLines, runDecide, verifySubjects } from '../src/protocol/verify-cli.js'
import { buildGoLive, decideVerify, goLiveSunday, isOffWeekSunday, VERIFY_LINE_HEAD, VERIFY_PLAN_ID, verifyEstimateUsd, verifyIdsIn, verifyPlanProposal, verifyPlanState, verifyPlanText } from '../src/protocol/verify.js'
import type { AeoContext } from '../src/schema/context.js'
import { emptyStates, type SubjectPanel, type TrackedQuestion } from '../src/schema/panel.js'
import { validatePacket } from '../src/schema/packet.js'
import { validateReport, type EngineReport, type Proposal } from '../src/schema/report.js'
import { parseVerifyPayload, verifyPayloadText, type VerifyPayload } from '../src/schema/verify.js'
import { FIXTURES, ROOT, StubEngine, StubModel } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const RESEARCH_AT = new Date('2026-11-22T10:30:00Z')
const RESEARCH_RUN = 'aeo:2026-11-22:research'
const SUNDAY = '2026-11-29'
const THURSDAY = new Date('2026-11-26T05:12:00Z')
const PAGE = 'https://github.com/synthetic/aeo/actions/runs/7'
// The fixture venture's last research packet holds these three questions (tests/fixtures/context.all.json).
const Q1 = 'b1000000-0000-4000-8000-000000000001'
const Q2 = 'b1000000-0000-4000-8000-000000000002'
const Q3 = 'b1000000-0000-4000-8000-000000000003'
const QUESTION_WORDS = 'How do I get an AI assistant to write like me?'

const sha = (text: string | null, amount: number | null) => sha256Hex(canonicalJson({ amount_usd: amount, exact_payload: text }))

function assertValid(r: EngineReport): void {
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'the report schema')
  assert.deepEqual(validateReport(r), { ok: true })
}

const tracked = (id: string, tiers: TrackedQuestion['tiers'], state: TrackedQuestion['panel']['state'] = 'absent'): TrackedQuestion => ({
  query_id: id, question: 'A tracked synthetic question?', tiers, gap_class: 'no_page',
  panel: { state, first_seen: null, last_asked: '2026-11-16', won_at: null, lost_at: null, streak: null }, engines: [], shipped_url: tiers.includes('shipped') ? 'https://ctrl.mindmake.co/answers/x' : null,
})
const panelOf = (t: TrackedQuestion[]): SubjectPanel => ({ states: { ...emptyStates(), absent: 20 }, sampled: 0, sample_answers: 0, won_now: [], lost_now: [], tracked: t, history: true })
const sub = (slug: string, over: Partial<SubjectSummary> = {}): SubjectSummary => ({ slug, kind: 'venture', product_slug: slug, ok: true, questions: 25, probed_questions: 25, cited_first: 0, probes: 75, probes_failed: 0, probes_skipped_cap: 0, ...over })
const runSummary = (subjects: SubjectSummary[], over: Partial<RunSummary> = {}): RunSummary => ({ v: 1, subject_arg: 'all', week_start: '2026-11-16', generated_at: RESEARCH_AT.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 2, max_probe_usd: 0.07, error_code: null, subjects, ...over })
const researchInput = (subjects: SubjectSummary[], over: Partial<ResearchInput> = {}): ResearchInput => ({ runId: RESEARCH_RUN, mode: 'synthetic', observedAt: RESEARCH_AT, revision: 'abc', capturedAt: RESEARCH_AT, scope: 'all', expected: subjects.map(s => s.slug), summaries: [runSummary(subjects)], totalCapUsd: 25, planError: null, decisions: [], ...over })

/** A full research report whose ventures tracked Q1 and Q3 as shipped and Q2 as a kit in flight (won already). */
function research(): EngineReport {
  return buildResearchReport(researchInput([
    sub('ctrl', { panel: panelOf([tracked(Q3, ['shipped']), tracked(Q1, ['shipped', 'kit']), tracked(Q2, ['kit'], 'won')]) }),
    sub('heartside', { panel: panelOf([]) }),
  ]))
}
const stored = (r: EngineReport) => ({ run_id: r.run_id, accepted_at: RESEARCH_AT.toISOString(), report: r as unknown as Record<string, unknown> })
const decision = (proposal_id: string, d: string, decided_at: string, payload_sha256: string, over: Partial<DecisionLite> = {}): DecisionLite => ({ proposal_id, decision: d, decided_at, payload_sha256, ...over })
const planYes = (at = '2026-11-23T09:00:00Z') => decision(VERIFY_PLAN_ID, 'approved', at, verifyPlanProposal(new Date(0)).payload_sha256)
const daily = (at: Date, decisions: DecisionLite[], last = stored(research())) => buildDirectiveReport({ runId: `aeo:${at.toISOString().slice(0, 10)}:directive`, mode: 'synthetic', observedAt: at, revision: 'abc', capturedAt: at, directive: { directive_id: 'd', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions })
const verifyAsksOf = (r: EngineReport) => r.proposals.filter(p => p.proposal_id.startsWith('aeo:verify'))

// ---------- the research report's line ----------

test('the research report names the questions a verify run would re-ask, in one line the daily report reads back', () => {
  const r = research()
  assertValid(r)
  const line = r.activity.map(a => a.line).find(l => l.startsWith(VERIFY_LINE_HEAD))
  assert.ok(line && line.length <= 500)
  // Not won first, shipped before kit, then by id; a question tracked twice once.
  assert.deepEqual(verifyIdsIn(r as unknown as Record<string, unknown>), [Q1, Q3, Q2])
  assert.deepEqual(verifyIdsIn(null), [])
  // No question tracked: no line.
  const none = buildResearchReport(researchInput([sub('ctrl', { panel: panelOf([]) })]))
  assert.ok(!none.activity.some(a => a.line.startsWith(VERIFY_LINE_HEAD)))
})

// ---------- step one: the plan ----------

test('the plan: proposed by the daily report once a question is shipped or a kit plan approved, the same each day, never again after his No', () => {
  const d1 = daily(new Date('2026-11-23T05:12:00Z'), [])
  assertValid(d1)
  const [plan] = verifyAsksOf(d1)
  assert.equal(plan.proposal_id, VERIFY_PLAN_ID)
  assert.equal(plan.exact_payload, 'In the off week, re-ask only the questions a venture has declared shipped (or a kit Krish approved), three samples on every engine, at most 10 questions and at most 3 dollars a run. Results never count in the North Star share.')
  assert.deepEqual([plan.stage, plan.wall, plan.kind, plan.amount_usd, plan.parent_proposal_id], ['plan', 'strategy', 'prepared', 3, undefined])
  assert.equal(plan.payload_sha256, sha(plan.exact_payload, 3))
  assert.equal(verifyPlanText(), plan.exact_payload)
  assert.deepEqual(verifyAsksOf(daily(new Date('2026-11-24T05:12:00Z'), [])), [{ ...plan, expires_at: plan.expires_at }], 'the same words the next day, so it waits as one ask')
  // Nothing shipped and no kit plan approved: no plan.
  const quiet = stored(buildResearchReport(researchInput([sub('ctrl', { panel: panelOf([]) })])))
  assert.deepEqual(verifyAsksOf(daily(new Date('2026-11-23T05:12:00Z'), [], quiet)), [])
  // An approved kit plan alone makes it due.
  const kitYes = decision('aeo:kit:ctrl:b1000000', 'approved', '2026-11-22T12:00:00Z', '1'.repeat(64))
  assert.deepEqual(verifyAsksOf(daily(new Date('2026-11-23T05:12:00Z'), [kitYes], quiet)).map(p => p.proposal_id), [VERIFY_PLAN_ID])
  // His No: never proposed again, not even beside a later yes.
  const no = decision(VERIFY_PLAN_ID, 'declined', '2026-11-23T09:00:00Z', plan.payload_sha256)
  for (const decisions of [[no], [no, planYes('2026-11-25T09:00:00Z')]]) {
    const r = daily(THURSDAY, decisions)
    assert.deepEqual(verifyAsksOf(r), [])
    assert.ok(r.activity.some(a => a.line === 'Krish declined the verify plan, so no off-week verify run is proposed, now or later.'))
  }
  assert.equal(verifyPlanState([no, planYes('2026-12-30T09:00:00Z')]).state, 'declined')
  // His decisions could not be read: nothing about the lane is proposed.
  const unread = buildDirectiveReport({ runId: 'aeo:2026-11-23:directive', mode: 'synthetic', observedAt: new Date('2026-11-23T05:12:00Z'), revision: 'abc', capturedAt: new Date('2026-11-23T05:12:00Z'), directive: null, directiveError: 'directive_unavailable', last: stored(research()), lastError: null, decisions: null })
  assert.deepEqual(verifyAsksOf(unread), [])
})

// ---------- step two: the go-live ----------

test('the go-live: on the Thursday to Saturday before an even-week Sunday, canonical and sorted, the estimate rounded up and capped', () => {
  assert.equal(goLiveSunday(new Date('2026-11-25T05:12:00Z')), null, 'Wednesday')
  for (const d of ['2026-11-26', '2026-11-27', '2026-11-28']) assert.equal(goLiveSunday(new Date(`${d}T05:12:00Z`)), SUNDAY)
  assert.equal(goLiveSunday(new Date('2026-12-03T05:12:00Z')), null, 'the Sunday after is a research Sunday')
  assert.equal(isOffWeekSunday(SUNDAY), true)
  assert.equal(isOffWeekSunday('2026-12-06'), false)
  assert.equal(isOffWeekSunday('2026-11-28'), false)

  assert.deepEqual(verifyAsksOf(daily(new Date('2026-11-25T05:12:00Z'), [planYes()])), [], 'not on a Wednesday')
  const r = daily(THURSDAY, [planYes()])
  assertValid(r)
  assert.ok(['1.1.0', '1.20.0', '1.22.0'].includes(r.schema_version))
  const [go] = verifyAsksOf(r)
  const text = `{"amount_usd":1,"date":"${SUNDAY}","query_ids":["${Q1}","${Q2}","${Q3}"],"samples":3}`
  assert.deepEqual(go, {
    stage: 'go_live', parent_proposal_id: VERIFY_PLAN_ID, proposal_id: `aeo:verify:${SUNDAY}`, title: `Verify run on ${SUNDAY}: re-ask 3 shipped questions, up to 1 USD`,
    why: go.why, kind: 'prepared', wall: 'spend', amount_usd: 1, channel: 'research_workflow', objective_key: null, exact_payload: text, payload_sha256: sha(text, 1),
    evidence: [{ label: `The questions the research run ${RESEARCH_RUN} tracked as shipped or a kit in flight`, url: null }],
    close_condition: { event: 'verify_ran', reference: `aeo:${SUNDAY}:verify` }, expires_at: '2026-11-30T00:00:00.000Z',
  })
  assert.ok(!/\u2014/.test(go.why))
  assert.deepEqual(verifyAsksOf(daily(new Date('2026-11-28T05:12:00Z'), [planYes()])), [go], 'the same words all three days')
  // Decided, it is not asked again.
  const yes = decision(go.proposal_id, 'approved', '2026-11-26T09:00:00Z', go.payload_sha256)
  const after = daily(new Date('2026-11-27T05:12:00Z'), [planYes(), yes])
  assert.deepEqual(verifyAsksOf(after), [])
  assert.ok(after.activity.some(a => a.line.startsWith(`Krish approved the verify run for ${SUNDAY}; it runs once, at that Sunday's scheduled slot`)))

  // The estimate and the caps.
  assert.equal(verifyEstimateUsd(10), 1.8, 'three samples on three engines, the Claude Code lane free')
  const ids = Array.from({ length: 12 }, (_, i) => `${String(12 - i).padStart(8, 'f')}-0000-4000-8000-000000000000`)
  const ten = buildGoLive(SUNDAY, ids, 3, null)!
  assert.equal(ten.payload.query_ids.length, 10)
  assert.deepEqual(ten.payload.query_ids, [...ten.payload.query_ids].sort(), 'sorted')
  assert.equal(ten.payload.amount_usd, 2, '1.80 rounded up')
  assert.equal(ten.text, canonicalJson({ amount_usd: 2, date: SUNDAY, query_ids: ten.payload.query_ids, samples: 3 }))
  const one = buildGoLive(SUNDAY, ids, 1, null)!
  assert.deepEqual([one.payload.query_ids.length, one.payload.amount_usd], [5, 1], 'fits his cap: five questions at 0.90')
  assert.equal(buildGoLive(SUNDAY, ids, 0.1, null), null)
  // His amended plan amount caps the go-live.
  const plan = verifyPlanProposal(new Date(0))
  const amendedPlan = decision(VERIFY_PLAN_ID, 'approved', '2026-11-23T09:00:00Z', plan.payload_sha256, { amended: true, exact_payload: plan.exact_payload, amount_usd: 0.5, amended_sha256: sha(plan.exact_payload, 0.5) })
  assert.deepEqual(verifyPlanState([amendedPlan]).cap, 0.5)
  const capped = verifyAsksOf(daily(THURSDAY, [amendedPlan]))[0]
  assert.deepEqual([capped.amount_usd, JSON.parse(capped.exact_payload ?? '{}').query_ids.length], [0.5, 2])
  // An amended plan whose digest does not check out holds the lane.
  const bad = { ...amendedPlan, amended_sha256: '0'.repeat(64) }
  const held = daily(THURSDAY, [bad])
  assert.deepEqual(verifyAsksOf(held), [])
  assert.ok(held.holds.some(h => h.reason === 'amendment_unverified'))
})

// ---------- step three: the go-live step's decision ----------

test('the plan job decides: no decision skips; approved and matching runs; amended runs his version; a mismatched digest skips; an approved plan alone never goes live', () => {
  const expected = buildGoLive(SUNDAY, [Q1, Q2, Q3], 3, { run_id: RESEARCH_RUN })!
  const goId = `aeo:verify:${SUNDAY}`
  const yes = decision(goId, 'approved', '2026-11-27T09:00:00Z', expected.sha)
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes()], expected, alreadyRan: false }), { run: false, reason: 'no_decision' }, 'an approved plan never goes live by itself')
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [], expected, alreadyRan: false }), { run: false, reason: 'plan_none' })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [yes], expected, alreadyRan: false }), { run: false, reason: 'plan_none' }, 'a go-live with no approved plan')
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), yes], expected, alreadyRan: false }), { run: true, payload: expected.payload, amended: false })
  assert.deepEqual(decideVerify({ date: '2026-12-06', decisions: [planYes(), yes], expected, alreadyRan: false }), { run: false, reason: 'not_an_off_week_sunday' })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), yes], expected, alreadyRan: true }), { run: false, reason: 'already_ran' }, 'once')
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), { ...yes, payload_sha256: '9'.repeat(64) }], expected, alreadyRan: false }), { run: false, reason: 'sha_mismatch' })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), yes], expected: null, alreadyRan: false }), { run: false, reason: 'no_payload_to_match' })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), yes, decision(goId, 'declined', '2026-11-28T09:00:00Z', expected.sha)], expected, alreadyRan: false }), { run: false, reason: 'go_live_declined' }, 'Purge on a go-live means stop')
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), yes, decision(VERIFY_PLAN_ID, 'declined', '2026-11-28T09:00:00Z', 'x')], expected, alreadyRan: false }), { run: false, reason: 'plan_declined' })
  // Amended: his version, when its digest checks out; never the engine's.
  const his = verifyPayloadText({ date: SUNDAY, query_ids: [Q3, Q1], samples: 2, amount_usd: 1 })
  const amended = { ...yes, amended: true, exact_payload: his, amount_usd: 1, amended_sha256: sha(his, 1) }
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), amended], expected, alreadyRan: false }), { run: true, payload: { date: SUNDAY, query_ids: [Q1, Q3], samples: 2, amount_usd: 1 }, amended: true })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), { ...amended, amended_sha256: '0'.repeat(64) }], expected, alreadyRan: false }), { run: false, reason: 'amendment_unverified' })
  const wrongDay = verifyPayloadText({ date: '2026-12-13', query_ids: [Q1], samples: 3, amount_usd: 1 })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), { ...amended, exact_payload: wrongDay, amended_sha256: sha(wrongDay, 1) }], expected, alreadyRan: false }), { run: false, reason: 'amendment_payload_date_mismatch' })
  const dear = verifyPayloadText({ date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 50 })
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [planYes(), { ...amended, exact_payload: dear, amount_usd: 50, amended_sha256: sha(dear, 50) }], expected, alreadyRan: false }), { run: false, reason: 'amendment_payload_amount' }, 'never past the hard ceiling')
  // The payload reader is strict.
  for (const bad of ['{}', 'not json', JSON.stringify({ date: SUNDAY, query_ids: [], samples: 3, amount_usd: 1 }), JSON.stringify({ date: SUNDAY, query_ids: ['x'], samples: 3, amount_usd: 1 }), JSON.stringify({ date: SUNDAY, query_ids: [Q1], samples: 4, amount_usd: 1 }), JSON.stringify({ date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 1, extra: 1 })]) assert.equal(parseVerifyPayload(bad).ok, false, bad)
})

// ---------- the whole loop, through the stand-in ----------

/** The fixture context, with a served panel on the venture's last packet so a move can be reported, and the packet features given. */
class VerifyContext extends OfflineControlCenter {
  constructor(private readonly features?: string[]) { super(FIXTURES) }
  override async getContext(): Promise<AeoContext> {
    const ctx = structuredClone(await super.getContext())
    if (this.features) ctx.packet_features = this.features
    const ctrl = ctx.subjects.find(s => s.slug === 'ctrl')!
    for (const q of ctrl.prior?.queries ?? []) q.panel = { state: 'absent', first_seen: '2026-08-31', last_asked: '2026-11-16', won_at: null, lost_at: null, streak: 2 }
    return ctx
  }
}

/** Stub engines: perplexity cites ctrl's own page first for the first fixture question every time; the others cite elsewhere. */
function engines() {
  const answer = (engine: string) => (q: string) => ({ text: `A synthetic answer from ${engine}.`, citations: engine === 'perplexity' && q === QUESTION_WORDS ? ['https://ctrl.mindmake.co/answers/x', 'https://other.example/a'] : ['https://other.example/a'] })
  return [new StubEngine('perplexity', answer('perplexity')), new StubEngine('chatgpt', answer('chatgpt')), new StubEngine('claude', answer('claude'), 'claude-code/x', { costKind: 'claude_code' })]
}

async function verifyRun(payloadText: string, features?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-verify-'))
  try {
    const file = join(dir, 'verify-payload.json')
    writeFileSync(file, payloadText)
    const args = parseArgs(['--offline', '--mode', 'verify', '--verify-payload', file, '--subject', 'all', '--week', '2026-11-23', '--fixtures', FIXTURES, '--cap-usd', String(JSON.parse(payloadText).amount_usd)], new Date('2026-11-29T10:00:00Z'))
    const deps = buildDeps(args, { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '' }, new Date('2026-11-29T10:00:00Z'))
    const cc = new VerifyContext(features)
    deps.cc = cc
    const stubs = engines()
    deps.engines = stubs
    const model = new StubModel('THROW')
    deps.model = model
    const payload = parseVerifyPayload(payloadText)
    assert.ok(payload.ok)
    const out = await runVerifyAll(deps, { subject: 'all', weekStart: args.week, dry: false, outPath: null, commandId: null }, payload.payload)
    return { out, deps, cc, stubs, model }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('--mode verify: only the payload\'s questions, three samples on every packet engine, no model call, and a packet only with run_kind listed', async () => {
  assert.throws(() => parseArgs(['--mode', 'verify']), /needs --verify-payload/)
  assert.throws(() => parseArgs(['--verify-payload', 'x']), /--mode verify only/)
  const text = verifyPayloadText({ date: SUNDAY, query_ids: [Q1, Q3, 'cccccccc-0000-4000-8000-000000000000'], samples: 3, amount_usd: 1 })
  const { out, deps, cc, stubs, model } = await verifyRun(text)
  assert.deepEqual(out.failures, [])
  assert.equal(out.missing, 1, 'a question no packet holds is skipped and counted')
  assert.equal(model.requests.length, 0, 'no propose, digest or voice call')
  const words = new Set(['How do I get an AI assistant to write like me?', 'How do I stop AI output sounding generic?'])
  for (const e of stubs) {
    assert.equal(e.asked.length, 6, `${e.engine}: two questions, three samples each`)
    assert.ok(e.asked.every(q => words.has(q)), 'only the payload\'s questions')
  }
  assert.equal(deps.ledger.capUsd, verifyShare(1, 2, 2))
  assert.ok(deps.ledger.total <= 1 && deps.ledger.total > 0, 'charged inside the amount; Claude Code free')
  assert.equal(cc.ingested.length, 0, 'no packet without run_kind: Control Center would count it as a research week')
  const r = out.results[0]
  assert.equal(r.shipped.mode, 'held')
  assert.deepEqual(r.more?.verify, { found: [Q1, Q3], asked: 2, samples: 3 })
  assert.equal(r.panel?.won_now.length, 1, 'won against the last research panel: first on three of three samples')
  // With run_kind listed, the packet goes as a verify run.
  const listed = await verifyRun(text, ['run_kind', 'samples', 'panel'])
  assert.equal(listed.cc.ingested.length, 1)
  const packet = listed.cc.ingested[0]
  assert.equal(packet.run_kind, 'verify')
  assert.deepEqual(packet.queries.map(q => q.query_id).sort(), [Q1, Q3])
  assert.ok(packet.queries.every(q => q.probes.every(p => p.samples?.n === 3)))
  assert.equal(validatePacket(packet, { features: ['run_kind', 'samples', 'panel'] }).ok, true)
  // The share: the amount over the questions found, to the cent and down.
  assert.equal(verifyShare(2, 1, 3), 0.66)
  assert.equal(verifyShare(1, 0, 3), 0)
})

test('the verify report: closes the go-live with the run as its evidence, moves against the last research panel, one count line, no objective', async () => {
  const text = verifyPayloadText({ date: SUNDAY, query_ids: [Q1, Q3, 'cccccccc-0000-4000-8000-000000000000'], samples: 3, amount_usd: 1 })
  const { out, deps } = await verifyRun(text)
  const summary = buildRunSummary({ subjectArg: 'ctrl', weekStart: '2026-11-23', now: new Date('2026-11-29T10:00:00Z'), engines: ['perplexity', 'chatgpt', 'claude'], capUsd: deps.ledger.capUsd, spentUsd: deps.ledger.total, maxProbeUsd: 0.05, results: out.results, failures: [], errorCode: null, kind: 'verify' })
  assert.equal(summary.kind, 'verify')
  const parsed = parseVerifyPayload(text)
  assert.ok(parsed.ok)
  const payload: VerifyPayload = parsed.payload
  const r = buildVerifyReport({ runId: `aeo:${SUNDAY}:verify`, mode: 'synthetic', observedAt: new Date('2026-11-29T11:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-29T09:00:00Z'), expected: ['ctrl'], summaries: [summary], payload, planError: null, runPage: PAGE })
  assertValid(r)
  assert.deepEqual(r.objectives, [], 'queries_cited_first stays the research run\'s')
  assert.deepEqual(r.proposals, [])
  assert.deepEqual(r.events.map(e => [e.event, e.proposal_id, e.evidence_url]), [['verify_ran', `aeo:verify:${SUNDAY}`, PAGE], ['question_won', null, PAGE]])
  assert.deepEqual(r.activity.map(a => a.line), [`Verify run aeo:${SUNDAY}:verify, Krish's go-live aeo:verify:${SUNDAY}: asked 2 of 3 questions (1 not found in the last research packets), 3 samples on each of 3 assistants (perplexity, chatgpt, claude); against the last research panel 1 question became won and 0 lost. A verify run never counts toward questions cited first.`])
  const json = JSON.stringify(r)
  assert.ok(!json.includes('write like me') && !json.includes(Q1) && !json.includes('synthetic answer'), 'no question, id or answer in the report')
  // Nothing asked: no closing event, a hold. A plan error: a hold. No payload: a hold.
  const empty = buildVerifyReport({ runId: `aeo:${SUNDAY}:verify`, mode: 'synthetic', observedAt: new Date('2026-11-29T11:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-29T09:00:00Z'), expected: [], summaries: [], payload, planError: null })
  assert.ok(!empty.events.some(e => e.event === 'verify_ran'))
  assert.ok(empty.holds.some(h => h.reason === 'verify_nothing_asked'))
  const planned = buildVerifyReport({ runId: `aeo:${SUNDAY}:verify`, mode: 'synthetic', observedAt: new Date('2026-11-29T11:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-29T09:00:00Z'), expected: [], summaries: [], payload, planError: 'context_unavailable' })
  assert.equal(planned.status, 'degraded')
  assert.ok(planned.holds.some(h => h.reason === 'context_unavailable'))
  const unread = buildVerifyReport({ runId: `aeo:${SUNDAY}:verify`, mode: 'synthetic', observedAt: new Date('2026-11-29T11:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-29T09:00:00Z'), expected: [], summaries: [], payload: null, planError: null })
  assert.ok(unread.holds.some(h => h.reason === 'verify_payload_unread'))
})

test('stand-in, end to end: an approved go-live goes live once with exactly its payload, in his words when amended; an approved plan alone never goes live', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  const dir = mkdtempSync(join(tmpdir(), 'aeo-verify-cli-'))
  try {
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const r = research()
    s.reports.set(RESEARCH_RUN, { payload_sha256: r.payload_sha256, mode: 'synthetic', accepted_at: RESEARCH_AT.toISOString(), report: r as unknown as Record<string, unknown> })
    s.decisions = [planYes() as never]
    // Thursday's daily run proposes the go-live.
    const thu = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-11-26:directive:1.1', now: () => THURSDAY, wake: '1.1' }))
    assert.equal(thu.result.status, 'succeeded')
    const go = thu.result.report!.proposals.find(p => p.proposal_id === `aeo:verify:${SUNDAY}`) as Proposal
    assert.ok(go)
    assert.ok(!thu.text.includes(Q1), 'no query id in a log line')

    // Sunday, before his yes on the go-live: the approved plan alone never goes live.
    assert.deepEqual(await captureStderr(() => runDecide(c, SUNDAY, 'synthetic')).then(x => x.result), { run: false, reason: 'no_decision' })

    // His yes on exactly that payload: it runs, with exactly that payload.
    s.decisions = [planYes() as never, decision(go.proposal_id, 'approved', '2026-11-27T09:00:00Z', go.payload_sha256) as never]
    const decided = await captureStderr(() => runDecide(c, SUNDAY, 'synthetic'))
    assert.ok(decided.result.run)
    const approvedPayload = decided.result.payload
    assert.equal(verifyPayloadText(approvedPayload), go.exact_payload, 'exactly what he approved')
    assert.match(decided.text, /"event":"verify_go","questions":3,"samples":3,"amount_usd":1,"amended":false/)
    assert.ok(!decided.text.includes(Q1))

    // The CLI writes the payload on the runner and the step's outputs.
    const outFile = join(dir, 'out', 'verify-payload.json')
    const ghOut = join(dir, 'github-output')
    writeFileSync(ghOut, '')
    const code = await captureStderr(() => verifyCli(['decide', '--date', SUNDAY, '--out', outFile, '--mode', 'synthetic'], { CONTROL_CENTER_URL: s.base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN, GITHUB_OUTPUT: ghOut, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }))
    assert.equal(code.result, 0)
    assert.equal(readFileSync(outFile, 'utf8').trim(), go.exact_payload)
    const outputs = readFileSync(ghOut, 'utf8')
    assert.match(outputs, /^run=true$/m)
    assert.match(outputs, new RegExp(`^payload=${go.exact_payload!.replace(/[[\]{}.]/g, '\\$&')}$`, 'm'))
    assert.match(outputs, new RegExp(`^run_id=aeo:${SUNDAY}:verify$`, 'm'))
    assert.match(outputs, new RegExp(`^attempt_id=aeo:${SUNDAY}:verify:42\\.1$`, 'm'))
    assert.ok(!code.text.includes(TOKEN))

    // The verify run's report lands; a second decision for that Sunday finds it and does not run again.
    const summary = runSummary([sub('ctrl', { verify: { found: [Q1, Q2, Q3], asked: 3, samples: 3 }, panel: panelOf([]) })], { kind: 'verify', subject_arg: 'ctrl' })
    const done = await captureStderr(() => finishVerify(c, { attemptId: `aeo:${SUNDAY}:verify:42.1`, runId: `aeo:${SUNDAY}:verify`, startedAt: '2026-11-29T09:00:00Z' }, { mode: 'synthetic', observedAt: new Date('2026-11-29T11:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-29T09:00:00Z'), expected: ['ctrl'], summaries: [summary], payload: approvedPayload, planError: null, runPage: PAGE }, () => new Date('2026-11-29T11:00:00Z')))
    assert.equal(done.result.status, 'succeeded')
    const report = s.reports.get(`aeo:${SUNDAY}:verify`)?.report as unknown as EngineReport
    assert.deepEqual(report.events[0], { event: 'verify_ran', proposal_id: go.proposal_id, at: '2026-11-29T11:00:00.000Z', evidence_url: PAGE })
    assert.deepEqual([...s.attempts.get(`aeo:${SUNDAY}:verify:42.1`)!.map(a => [a.command, a.status])], [['verify', 'succeeded']])
    assert.deepEqual(await captureStderr(() => runDecide(c, SUNDAY, 'synthetic')).then(x => x.result), { run: false, reason: 'already_ran' }, 'once')
    s.reports.delete(`aeo:${SUNDAY}:verify`)

    // Amended: his version runs, never the engine's.
    const his = verifyPayloadText({ date: SUNDAY, query_ids: [Q3], samples: 3, amount_usd: 1 })
    s.decisions = [planYes() as never, decision(go.proposal_id, 'approved', '2026-11-27T09:00:00Z', go.payload_sha256, { amended: true, exact_payload: his, amount_usd: 1, amended_sha256: sha(his, 1) }) as never]
    const amended = await captureStderr(() => runDecide(c, SUNDAY, 'synthetic'))
    assert.deepEqual(amended.result, { run: true, payload: { date: SUNDAY, query_ids: [Q3], samples: 3, amount_usd: 1 }, amended: true })

    // A decision made on other words: skipped, with a count.
    s.decisions = [planYes() as never, decision(go.proposal_id, 'approved', '2026-11-27T09:00:00Z', '7'.repeat(64)) as never]
    const mismatch = await captureStderr(() => runDecide(c, SUNDAY, 'synthetic'))
    assert.deepEqual(mismatch.result, { run: false, reason: 'sha_mismatch' })
    assert.match(mismatch.text, /"event":"verify_skipped","reason":"sha_mismatch","verify_decisions":2,"mismatched":1/)

    // The decisions cannot be read: nothing runs.
    s.overrides.set('decisions', { status: 500, body: { error: 'down' } })
    assert.deepEqual((await captureStderr(() => runDecide(c, SUNDAY, 'synthetic'))).result, { run: false, reason: 'decisions_server_error' })
    s.overrides.delete('decisions')

    // Not configured: no decision is read and nothing runs; the outputs say so.
    const quiet = join(dir, 'quiet-output')
    writeFileSync(quiet, '')
    await captureStderr(() => verifyCli(['decide', '--date', SUNDAY, '--out', join(dir, 'none.json')], { GITHUB_OUTPUT: quiet }))
    assert.equal(readFileSync(quiet, 'utf8'), 'run=false\nreason=not_configured\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await s.close()
  }
})

test('the verify matrix: only the subjects whose last packet holds a payload question; the outputs of a skip carry no payload', () => {
  const ctx = { subjects: [{ slug: 'ctrl', prior: { queries: [{ query_id: Q1.toUpperCase() }] } }, { slug: 'heartside', prior: { queries: [{ query_id: 'dddddddd-0000-4000-8000-000000000000' }] } }, { slug: 'pulse', prior: null }] } as unknown as AeoContext
  assert.deepEqual(verifySubjects(ctx, { date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 1 }), ['ctrl'])
  assert.deepEqual(outputLines({ run: false, reason: 'no_decision' }, SUNDAY, {}), ['run=false', 'reason=no_decision'])
})

test('end to end, offline: the verify CLI leaves a sealed verify summary the report job turns into the verify report', async () => {
  const dir = join(ROOT, 'out', 'verify-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'summaries'), { recursive: true })
  const payloadFile = join(dir, 'verify-payload.json')
  writeFileSync(payloadFile, `${verifyPayloadText({ date: SUNDAY, query_ids: [Q1, Q3], samples: 3, amount_usd: 1 })}\n`)
  const env = { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '901' }
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx')
  const r = spawnSync(tsx, ['src/index.ts', '--offline', '--mode', 'verify', '--verify-payload', payloadFile, '--subject', 'ctrl', '--week', '2026-11-23', '--cap-usd', '1', '--summary-out', join(dir, 'summaries', 'aeo-summary-0.json')], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stderr.includes(Q1) && !r.stderr.includes('write like me'), 'no query id or question in a log line')
  assert.match(r.stderr, /"event":"verify_start","date":"2026-11-29","questions":2,"found":2,"missing":0,"selected":1,"cap_usd":1,"samples":3/)
  const opened = unseal(readFileSync(join(dir, 'summaries', 'aeo-summary-0.json'), 'utf8'), 'synthetic-engine-secret', '901') as RunSummary
  assert.equal(opened.kind, 'verify')
  assert.deepEqual(opened.subjects[0].verify, { found: [Q1, Q3], asked: 2, samples: 3 })
  // A bad payload asks nothing.
  writeFileSync(join(dir, 'bad.json'), '{"date":"2026-11-29"}')
  const bad = spawnSync(tsx, ['src/index.ts', '--offline', '--mode', 'verify', '--verify-payload', join(dir, 'bad.json'), '--subject', 'ctrl'], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /"event":"verify_payload_unread","reason":"payload_keys"/)

  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const { result, text } = await captureStderr(() => protocolMain([
      'research-report', '--mode', 'synthetic', '--kind', 'verify', '--verify-payload', payloadFile, '--attempt-id', `aeo:${SUNDAY}:verify:901.1`, '--run-id', `aeo:${SUNDAY}:verify`, '--started-at', '2026-11-29T09:00:00Z',
      '--summaries', join(dir, 'summaries'), '--subjects', '["ctrl"]', '--scope', 'all', '--total-cap-usd', '1',
    ], { CONTROL_CENTER_URL: s.base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN, AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '901', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'synthetic/aeo' }))
    assert.equal(result, 0, text)
    const report = s.reports.get(`aeo:${SUNDAY}:verify`)?.report as unknown as EngineReport
    assertValid(report)
    assert.deepEqual(report.objectives, [])
    assert.deepEqual(report.events[0], { event: 'verify_ran', proposal_id: `aeo:verify:${SUNDAY}`, at: report.observed_at, evidence_url: 'https://github.com/synthetic/aeo/actions/runs/901' })
    assert.match(report.activity[0].line, new RegExp(`^Verify run aeo:${SUNDAY}:verify, Krish's go-live aeo:verify:${SUNDAY}: asked 2 of 2 questions, 3 samples on each of 3 assistants`))
    assert.ok(!s.reports.has(`aeo:${SUNDAY}:research`), 'a verify run never stands in for the research run')
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
