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
import { GrowthEngineHttp, ProtocolError } from '../src/clients/growthEngine.js'
import { OfflineControlCenter } from '../src/clients/offline.js'
import { buildDeps, parseArgs, verifyGuard, verifyMain } from '../src/index.js'
import { canonicalJson, sha256Hex } from '../src/lib/canonical.js'
import { runVerifyAll, verifyShare } from '../src/pipeline/verify.js'
import { finishVerify, runDirective } from '../src/protocol/loop.js'
import { main as protocolMain } from '../src/protocol/cli.js'
import { unseal } from '../src/lib/seal.js'
import { buildRunSummary, type RunSummary, type SubjectSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, buildResearchReport, buildVerifyReport, type DecisionLite, type ResearchInput } from '../src/protocol/reports.js'
import { main as verifyCli, outputLines, runDecide, verifySubjects } from '../src/protocol/verify-cli.js'
import { buildGoLive, decideVerify, goLiveSunday, isOffWeekSunday, skipReason, VERIFY_CHECKIN_ID, VERIFY_LINE_HEAD, VERIFY_PLAN_ID, verifyEstimateUsd, verifyIdsIn, verifyPlanProposal, verifyPlanState, verifyPlanText, verifySundaysToRead } from '../src/protocol/verify.js'
import type { AeoContext } from '../src/schema/context.js'
import { emptyStates, type SubjectPanel, type TrackedQuestion } from '../src/schema/panel.js'
import { validatePacket } from '../src/schema/packet.js'
import { validateReport, type EngineReport, type Proposal } from '../src/schema/report.js'
import { parseVerifyPayload, verifyOwners, verifyPayloadText, type VerifyPayload } from '../src/schema/verify.js'
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
  // Three questions at 0.39 each (three samples on three engines, Claude at its paid price): 1.17, rounded up.
  const text = `{"amount_usd":2,"date":"${SUNDAY}","query_ids":["${Q1}","${Q2}","${Q3}"],"samples":3}`
  assert.deepEqual(go, {
    stage: 'go_live', parent_proposal_id: VERIFY_PLAN_ID, proposal_id: `aeo:verify:${SUNDAY}`, title: `Verify run on ${SUNDAY}: re-ask 3 shipped questions, up to 2 USD`,
    why: go.why, kind: 'prepared', wall: 'spend', amount_usd: 2, channel: 'research_workflow', objective_key: null, exact_payload: text, payload_sha256: sha(text, 2),
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

  // The estimate and the caps. Claude is priced at its paid API rate: without
  // the Claude Code token in the verify job it falls back to the paid API.
  assert.equal(verifyEstimateUsd(10), 3.9, 'three samples on perplexity, chatgpt and claude at 0.01 + 0.05 + 0.07')
  assert.equal(verifyEstimateUsd(1), 0.39)
  const ids = Array.from({ length: 12 }, (_, i) => `${String(12 - i).padStart(8, 'f')}-0000-4000-8000-000000000000`)
  const atCap = buildGoLive(SUNDAY, ids, 3, null)!
  assert.deepEqual([atCap.payload.query_ids.length, atCap.payload.amount_usd], [7, 3], 'the most that fit 3 USD: seven at 2.73, rounded up')
  const ten = buildGoLive(SUNDAY, ids, 5, null)!
  assert.equal(ten.payload.query_ids.length, 10, 'never more than ten')
  assert.deepEqual(ten.payload.query_ids, [...ten.payload.query_ids].sort(), 'sorted')
  assert.equal(ten.payload.amount_usd, 4, '3.90 rounded up')
  assert.equal(ten.text, canonicalJson({ amount_usd: 4, date: SUNDAY, query_ids: ten.payload.query_ids, samples: 3 }))
  const one = buildGoLive(SUNDAY, ids, 1, null)!
  assert.deepEqual([one.payload.query_ids.length, one.payload.amount_usd], [2, 1], 'fits his cap: two questions at 0.78')
  assert.equal(buildGoLive(SUNDAY, ids, 0.1, null), null)
  // His amended plan amount caps the go-live.
  const plan = verifyPlanProposal(new Date(0))
  const amendedPlan = decision(VERIFY_PLAN_ID, 'approved', '2026-11-23T09:00:00Z', plan.payload_sha256, { amended: true, exact_payload: plan.exact_payload, amount_usd: 0.5, amended_sha256: sha(plan.exact_payload, 0.5) })
  assert.deepEqual(verifyPlanState([amendedPlan]).cap, 0.5)
  const capped = verifyAsksOf(daily(THURSDAY, [amendedPlan]))[0]
  assert.deepEqual([capped.amount_usd, JSON.parse(capped.exact_payload ?? '{}').query_ids.length], [0.5, 1])
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
    assert.match(decided.text, /"event":"verify_go","questions":3,"samples":3,"amount_usd":2,"amended":false/)
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
  const ctx = { subjects: [{ slug: 'ctrl', kind: 'venture', prior: { queries: [{ query_id: Q1.toUpperCase(), query: QUESTION_WORDS }] } }, { slug: 'heartside', kind: 'venture', prior: { queries: [{ query_id: 'dddddddd-0000-4000-8000-000000000000', query: 'Another synthetic question?' }] } }, { slug: 'pulse', kind: 'venture', prior: null }] } as unknown as AeoContext
  assert.deepEqual(verifySubjects(ctx, { date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 1 }), ['ctrl'])
  // A question two subjects hold goes to one of them only: the venture first, then by slug.
  const both = { subjects: [{ slug: 'sample-media', kind: 'prospect', prior: { queries: [{ query_id: Q1, query: QUESTION_WORDS }, { query_id: Q2, query: 'Q2?' }] } }, { slug: 'zeta', kind: 'venture', prior: { queries: [{ query_id: Q1, query: QUESTION_WORDS }] } }, { slug: 'alpha', kind: 'venture', prior: { queries: [{ query_id: Q1, query: QUESTION_WORDS }] } }] } as unknown as AeoContext
  assert.deepEqual([...verifyOwners(both.subjects, [Q1, Q2]).entries()], [[Q1, 'alpha'], [Q2, 'sample-media']])
  assert.deepEqual(verifySubjects(both, { date: SUNDAY, query_ids: [Q1, Q2], samples: 3, amount_usd: 1 }), ['sample-media', 'alpha'], 'in the context\'s order; zeta owns nothing, so it gets no job')
  assert.deepEqual(verifySubjects({ subjects: [{ slug: 'ctrl', prior: { queries: [{ query_id: Q1 }] } }] } as unknown as AeoContext, { date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 1 }), [], 'a question with no words cannot be asked, so it gives no job')
  assert.deepEqual(outputLines({ run: false, reason: 'no_decision' }, SUNDAY, {}), ['run=false', 'reason=no_decision'])
})

test('end to end, offline: the verify CLI leaves a sealed verify summary the report job turns into the verify report', async () => {
  const dir = join(ROOT, 'out', 'verify-test')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'summaries'), { recursive: true })
  // The verify job runs only its own day's payload, so this one is for today (UTC).
  const DAY = new Date().toISOString().slice(0, 10)
  const payloadFile = join(dir, 'verify-payload.json')
  writeFileSync(payloadFile, `${verifyPayloadText({ date: DAY, query_ids: [Q1, Q3], samples: 3, amount_usd: 1 })}\n`)
  // A first attempt, offline, with no protocol bearer: whatever the shell running the tests holds.
  const env = { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '901', GITHUB_RUN_ATTEMPT: '1', CONTROL_CENTER_ENGINE_TOKEN: '' }
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx')
  const args = ['src/index.ts', '--offline', '--mode', 'verify', '--verify-payload', payloadFile, '--subject', 'ctrl', '--week', '2026-11-23', '--cap-usd', '1', '--summary-out', join(dir, 'summaries', 'aeo-summary-0.json')]
  // GitHub's "Re-run failed jobs" reuses the plan job's outputs: the second attempt asks nothing and leaves no summary.
  const rerun = spawnSync(tsx, args, { cwd: ROOT, encoding: 'utf8', env: { ...env, GITHUB_RUN_ATTEMPT: '2' } })
  assert.equal(rerun.status, 1)
  assert.match(rerun.stderr, /"event":"verify_refused","reason":"rerun_attempt","questions":2/)
  assert.ok(!rerun.stderr.includes('verify_start'), 'nothing asked')
  const r = spawnSync(tsx, args, { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stderr.includes(Q1) && !r.stderr.includes('write like me'), 'no query id or question in a log line')
  assert.match(r.stderr, new RegExp(`"event":"verify_start","date":"${DAY}","questions":2,"found":2,"missing":0,"selected":1,"cap_usd":1,"samples":3`))
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
      'research-report', '--mode', 'synthetic', '--kind', 'verify', '--verify-payload', payloadFile, '--attempt-id', `aeo:${DAY}:verify:901.1`, '--run-id', `aeo:${DAY}:verify`, '--started-at', `${DAY}T09:00:00Z`,
      '--summaries', join(dir, 'summaries'), '--subjects', '["ctrl"]', '--scope', 'all', '--total-cap-usd', '1',
    ], { CONTROL_CENTER_URL: s.base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN, AEO_ENGINE_SECRET: 'synthetic-engine-secret', GITHUB_RUN_ID: '901', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'synthetic/aeo' }))
    assert.equal(result, 0, text)
    const report = s.reports.get(`aeo:${DAY}:verify`)?.report as unknown as EngineReport
    assertValid(report)
    assert.deepEqual(report.objectives, [])
    assert.deepEqual(report.events[0], { event: 'verify_ran', proposal_id: `aeo:verify:${DAY}`, at: report.observed_at, evidence_url: 'https://github.com/synthetic/aeo/actions/runs/901' })
    assert.match(report.activity[0].line, new RegExp(`^Verify run aeo:${DAY}:verify, Krish's go-live aeo:verify:${DAY}: asked 2 of 2 questions, 3 samples on each of 3 assistants`))
    assert.ok(!s.reports.has(`aeo:${DAY}:research`), 'a verify run never stands in for the research run')
    // Its report is stored now: a verify job started again for that day, with
    // the bearer in its environment, reads it back first and asks nothing
    // (in process, so the stand-in can answer it).
    const again = await captureStderr(() => verifyMain(parseArgs(args.slice(1).filter(a => a !== '--offline')), { GITHUB_RUN_ATTEMPT: '1', CONTROL_CENTER_ENGINE_TOKEN: TOKEN, CONTROL_CENTER_PROTOCOL_URL: s.base, AEO_ENGINE_SECRET: 'synthetic-engine-secret' }))
    assert.equal(again.result, 1)
    assert.match(again.text, /"event":"verify_refused","reason":"already_ran","questions":2/)
    assert.ok(!again.text.includes(TOKEN) && !again.text.includes('verify_start'))
  } finally {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- once, in the job that spends ----------

test('the verify job refuses a re-run attempt, a payload for another day, and a day whose verify report is stored; a read that fails refuses too', async () => {
  const payload: VerifyPayload = { date: SUNDAY, query_ids: [Q1], samples: 3, amount_usd: 1 }
  const sunday = new Date(`${SUNDAY}T06:00:00Z`)
  const none = { getReport: async () => null }
  assert.deepEqual(await verifyGuard(payload, {}, sunday, null), { ok: true }, 'unset attempt, the right day, no protocol door')
  assert.deepEqual(await verifyGuard(payload, { GITHUB_RUN_ATTEMPT: '1' }, sunday, none), { ok: true })
  assert.deepEqual(await verifyGuard(payload, { GITHUB_RUN_ATTEMPT: '2' }, sunday, none), { ok: false, reason: 'rerun_attempt' }, '"Re-run failed jobs" reuses the plan job\'s outputs')
  assert.deepEqual(await verifyGuard(payload, { GITHUB_RUN_ATTEMPT: '1' }, new Date('2026-11-30T00:30:00Z'), none), { ok: false, reason: 'not_today' })
  const asked: string[] = []
  const stored = { getReport: async (id: string) => { asked.push(id); return { run_id: id, payload_sha256: 'x', mode: 'live', accepted_at: '', report: {} } } }
  assert.deepEqual(await verifyGuard(payload, {}, sunday, stored), { ok: false, reason: 'already_ran' })
  assert.deepEqual(asked, [`aeo:${SUNDAY}:verify`])
  const down = { getReport: async () => { throw new ProtocolError('readback_server_error', 500) } }
  assert.deepEqual(await verifyGuard(payload, {}, sunday, down), { ok: false, reason: 'readback_server_error' }, 'once must be proven')
  // verifyMain refuses before anything is built or asked; a bearer with no URL cannot prove once.
  const dir = mkdtempSync(join(tmpdir(), 'aeo-verify-guard-'))
  try {
    const file = join(dir, 'p.json')
    writeFileSync(file, verifyPayloadText(payload))
    const args = parseArgs(['--mode', 'verify', '--verify-payload', file, '--subject', 'ctrl'])
    const nourl = await captureStderr(() => verifyMain(args, { GITHUB_RUN_ATTEMPT: '1', CONTROL_CENTER_ENGINE_TOKEN: TOKEN }, { now: sunday }))
    assert.equal(nourl.result, 1)
    assert.match(nourl.text, /"event":"verify_refused","reason":"url_missing","questions":1/)
    const rerun = await captureStderr(() => verifyMain(args, { GITHUB_RUN_ATTEMPT: '3' }, { now: sunday, protocol: none }))
    assert.equal(rerun.result, 1)
    assert.match(rerun.text, /"reason":"rerun_attempt"/)
    assert.ok(!rerun.text.includes(Q1) && !rerun.text.includes('run_start'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--mode verify asks only packet engines (a gated Gemini is not asked), and a question two subjects hold is asked once, inside the amount', async () => {
  const text = verifyPayloadText({ date: SUNDAY, query_ids: [Q1, Q3], samples: 3, amount_usd: 1 })
  const dir = mkdtempSync(join(tmpdir(), 'aeo-verify-own-'))
  try {
    const file = join(dir, 'p.json')
    writeFileSync(file, text)
    const args = parseArgs(['--offline', '--mode', 'verify', '--verify-payload', file, '--subject', 'all', '--week', '2026-11-23', '--fixtures', FIXTURES, '--cap-usd', '1'], new Date('2026-11-29T10:00:00Z'))
    const deps = buildDeps(args, { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '' }, new Date('2026-11-29T10:00:00Z'))
    // The prospect's last packet holds Q1 too.
    deps.cc = new (class extends VerifyContext {
      override async getContext(): Promise<AeoContext> {
        const ctx = await super.getContext()
        const prospect = ctx.subjects.find(s => s.kind === 'prospect')!
        prospect.prior = { ...(prospect.prior ?? { week_start: '2026-11-16', watch_list: [], recommendations: [] }), queries: [{ query_id: Q1, query: QUESTION_WORDS, demand_score: 50, status: 'watch', trend: 'flat' }] } as NonNullable<typeof prospect.prior>
        return ctx
      }
    })()
    const stubs = engines()
    const gemini = new StubEngine('gemini', () => ({ text: 'A synthetic Gemini answer.', citations: ['https://other.example/a'] }))
    deps.engines = [...stubs, gemini]
    deps.model = new StubModel('THROW')
    const payload = parseVerifyPayload(text)
    assert.ok(payload.ok)
    const out = await runVerifyAll(deps, { subject: 'all', weekStart: args.week, dry: false, outPath: null, commandId: null }, payload.payload)
    assert.equal(gemini.asked.length, 0, 'a gated engine is never asked: its answers would not count')
    for (const e of stubs) assert.equal(e.asked.length, 6, `${e.engine}: each question once, three samples`)
    assert.deepEqual(out.results.map(r => r.slug), ['ctrl'], 'the venture owns Q1; the prospect has nothing to ask')
    assert.equal(deps.ledger.capUsd, 1, 'the whole amount, never more')
    assert.ok(out.results[0].packet.engines.every(e => e !== ('gemini' as never)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // Shares for one question each never add up past the amount.
  assert.ok(verifyShare(1, 1, 3) * 3 <= 1)
})

// ---------- the verify plan's check-in, his words, and a go-live that did not run ----------

const MONDAY = new Date('2026-11-30T05:12:00Z')
const goFor = () => buildGoLive(SUNDAY, [Q1, Q2, Q3], 3, { run_id: RESEARCH_RUN })!
const goYes = (sha = goFor().sha) => decision(`aeo:verify:${SUNDAY}`, 'approved', '2026-11-27T09:00:00Z', sha)
const dailyWith = (at: Date, decisions: DecisionLite[], runs: Array<{ date: string; report: Record<string, unknown> | null; error: string | null }> | undefined, last = stored(research())) => buildDirectiveReport({ runId: `aeo:${at.toISOString().slice(0, 10)}:directive`, mode: 'synthetic', observedAt: at, revision: 'abc', capturedAt: at, directive: { directive_id: 'd', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions, verifyDecisions: decisions, verifyRuns: runs })
const checkInOf = (r: EngineReport) => r.proposals.find(p => p.proposal_id === VERIFY_CHECKIN_ID)

/** The verify report the run of SUNDAY stored: three questions asked, one won. */
function verifyStored(): Record<string, unknown> {
  const won = { query_id: Q1, engines: ['perplexity'], samples: 3, first: 3 }
  const summary = runSummary([sub('ctrl', { verify: { found: [Q1, Q2, Q3], asked: 3, samples: 3 }, panel: { ...panelOf([]), won_now: [won] } })], { kind: 'verify', subject_arg: 'ctrl' })
  const payload: VerifyPayload = { ...goFor().payload }
  return buildVerifyReport({ runId: `aeo:${SUNDAY}:verify`, mode: 'synthetic', observedAt: new Date(`${SUNDAY}T11:00:00Z`), revision: 'abc', capturedAt: new Date(`${SUNDAY}T09:00:00Z`), expected: ['ctrl'], summaries: [summary], payload, planError: null, runPage: PAGE }) as unknown as Record<string, unknown>
}

test('check-in: while the plan is open, after an off-week Sunday that ran, in counts; behind strategy, naming the plan; not asked again once answered', () => {
  const r = dailyWith(MONDAY, [planYes(), goYes()], [{ date: SUNDAY, report: verifyStored(), error: null }])
  assertValid(r)
  const c = checkInOf(r)!
  assert.ok(c)
  assert.deepEqual([c.stage, c.parent_proposal_id, c.wall, c.kind, c.amount_usd, c.close_condition], ['check_in', VERIFY_PLAN_ID, 'strategy', 'advice', null, { event: 'check_in_answered', reference: VERIFY_PLAN_ID }])
  const text = c.exact_payload ?? ''
  assert.match(text, /^Check-in on the verify plan aeo:verify-plan:v1$/m)
  assert.match(text, /^Week 2 of the plan, from Monday 30 November 2026\.$/m)
  assert.match(text, /^- Sunday 29 November 2026: ran \(aeo:2026-11-29:verify\), asked 3 of 3 questions, 3 samples on each assistant; against the last research panel 1 question became won and 0 lost\.$/m)
  assert.match(text, /^Totals: 1 run done, 0 skipped; 3 questions re-asked; panel moves: 1 won, 0 lost\./m)
  assert.ok(!text.includes(Q1) && !text.includes('write like me') && !text.includes('synthetic answer') && !/https?:/.test(text), 'counts only: no id, question, answer or URL')
  assert.ok(!/\u2014/.test(text))
  assert.ok(!r.holds.length, 'it ran: no hold')
  // The same day's words again: one ask. Answered on those words: not asked again.
  assert.equal(checkInOf(dailyWith(new Date('2026-12-01T05:12:00Z'), [planYes(), goYes()], [{ date: SUNDAY, report: verifyStored(), error: null }]))?.payload_sha256, c.payload_sha256)
  const answered = decision(VERIFY_CHECKIN_ID, 'approved', '2026-11-30T09:00:00Z', c.payload_sha256)
  assert.equal(checkInOf(dailyWith(new Date('2026-12-01T05:12:00Z'), [planYes(), goYes(), answered], [{ date: SUNDAY, report: verifyStored(), error: null }])), undefined)
  // His No on the check-in stops the plan for good: no check-in, no go-live, ever.
  const no = decision(VERIFY_CHECKIN_ID, 'declined', '2026-11-30T09:00:00Z', c.payload_sha256)
  assert.equal(verifyPlanState([planYes(), no]).state, 'declined')
  const stopped = dailyWith(new Date('2026-12-10T05:12:00Z'), [planYes(), goYes(), no], [])
  assert.deepEqual(verifyAsksOf(stopped), [])
  assert.deepEqual(decideVerify({ date: '2026-12-13', decisions: [planYes(), no], expected: buildGoLive('2026-12-13', [Q1], 3, null), alreadyRan: false }), { run: false, reason: 'plan_declined' })
})

test('check-in: at least weekly with no Sunday in between, never in the plan\'s first week, and its words change with the week', () => {
  // Approved on a Monday: the first week has no Sunday since, so nothing; the week after carries one.
  assert.equal(checkInOf(dailyWith(new Date('2026-11-25T05:12:00Z'), [planYes()], [])), undefined)
  const week2 = checkInOf(dailyWith(MONDAY, [planYes()], []))!
  assert.ok(week2)
  assert.match(week2.exact_payload ?? '', /^- Sunday 29 November 2026: no go-live was approved, so it did not run\.$/m)
  const week3 = checkInOf(dailyWith(new Date('2026-12-07T05:12:00Z'), [planYes()], []))!
  assert.notEqual(week3.payload_sha256, week2.payload_sha256, 'a new week, a new check-in')
  assert.match(week3.exact_payload ?? '', /^Week 3 of the plan/m)
  // The Sundays a check-in covers are the ones read back.
  assert.deepEqual(verifySundaysToRead([planYes(), goYes()], MONDAY), [SUNDAY])
  assert.deepEqual(verifySundaysToRead([planYes()], new Date('2026-11-26T05:12:00Z')), [])
})

test('a go-live he approved that did not run: the daily report after that Sunday says so in a line and a hold, with the reason when the records give it, else unknown', () => {
  const skipped = dailyWith(MONDAY, [planYes(), goYes()], [{ date: SUNDAY, report: null, error: null }])
  assertValid(skipped)
  assert.ok(skipped.activity.some(a => a.line === `Krish approved the verify run for ${SUNDAY}, and no verify report for it is stored, so it did not run (why is not known to this engine (the workflow did not start, failed, or its research job refused)).`))
  const hold = skipped.holds.find(h => h.detail?.includes(`aeo:verify:${SUNDAY}`))!
  assert.equal(hold.reason, 'unknown', 'the records say it should have run')
  assert.match(checkInOf(skipped)?.exact_payload ?? '', /^- Sunday 29 November 2026: Krish approved its go-live and it did not run \(why is not known to this engine\)\.$/m)
  // Approved on other words than the plan job rebuilt: the records say why.
  const other = dailyWith(MONDAY, [planYes(), goYes('9'.repeat(64))], [{ date: SUNDAY, report: null, error: null }])
  assert.equal(other.holds.find(h => h.detail?.includes(`aeo:verify:${SUNDAY}`))?.reason, 'sha_mismatch')
  // A research run reported since that Sunday: the plan job's inputs cannot be rebuilt, so unknown.
  const newer = stored(buildResearchReport(researchInput([sub('ctrl', { panel: panelOf([tracked(Q1, ['shipped'])]) })], { runId: 'aeo:2026-11-30:research', observedAt: new Date('2026-11-30T04:30:00Z') })))
  assert.equal(skipReason(SUNDAY, [planYes(), goYes('9'.repeat(64))], { run_id: newer.run_id, report: newer.report }), 'unknown')
  // It ran: no hold. Its report could not be read: a line, no hold. Declined: nothing said. Past the week: nothing said.
  assert.ok(!dailyWith(MONDAY, [planYes(), goYes()], [{ date: SUNDAY, report: verifyStored(), error: null }]).holds.length)
  const unread = dailyWith(MONDAY, [planYes(), goYes()], [{ date: SUNDAY, report: null, error: 'readback_server_error' }])
  assert.ok(unread.activity.some(a => a.line.includes('could not be read back (readback_server_error)')))
  assert.ok(!unread.holds.length)
  const declined = decision(`aeo:verify:${SUNDAY}`, 'declined', '2026-11-28T09:00:00Z', goFor().sha)
  assert.ok(!dailyWith(MONDAY, [planYes(), goYes(), declined], [{ date: SUNDAY, report: null, error: null }]).holds.length)
  assert.ok(!dailyWith(new Date('2026-12-07T05:12:00Z'), [planYes(), goYes()], [{ date: SUNDAY, report: null, error: null }]).holds.some(h => h.detail?.includes(`aeo:verify:${SUNDAY}`)), 'said in the week after it only')
})

test('his amended plan: an amount change is taken; any other change to its words holds the plan, with no go-live and no run', () => {
  const plan = verifyPlanProposal(new Date(0))
  const amend = (text: string, amount: number) => decision(VERIFY_PLAN_ID, 'approved', '2026-11-23T09:00:00Z', plan.payload_sha256, { amended: true, exact_payload: text, amount_usd: amount, amended_sha256: sha(text, amount) })
  // The amount alone, with or without the words naming it.
  assert.deepEqual([verifyPlanState([amend(plan.exact_payload!, 2)]).state, verifyPlanState([amend(plan.exact_payload!, 2)]).cap], ['open', 2])
  assert.deepEqual([verifyPlanState([amend(verifyPlanText(2), 2)]).state, verifyPlanState([amend(verifyPlanText(2), 2)]).cap], ['open', 2])
  // Other words: held, never guessed at.
  const words = amend(plan.exact_payload!.replace('at most 10 questions', 'at most 4 questions'), 3)
  assert.equal(verifyPlanState([words]).state, 'held_words')
  const r = dailyWith(THURSDAY, [words], [])
  assertValid(r)
  assert.deepEqual(verifyAsksOf(r), [], 'no go-live and no check-in from it')
  const hold = r.holds.find(h => h.reason === 'verify_plan_amended_words')!
  assert.match(hold.detail ?? '', /can take only an amount change/)
  assert.deepEqual(decideVerify({ date: SUNDAY, decisions: [words, goYes()], expected: goFor(), alreadyRan: false }), { run: false, reason: 'plan_held_words' })
  // An amended answer to the check-in is words too: held, until a newer decision on the plan.
  const ci = decision(VERIFY_CHECKIN_ID, 'approved', '2026-11-30T09:00:00Z', 'a'.repeat(64), { amended: true, exact_payload: 'Re-ask the Mindmake questions too.', amount_usd: null, amended_sha256: sha('Re-ask the Mindmake questions too.', null) })
  assert.equal(verifyPlanState([planYes(), ci]).state, 'held_words')
  assert.equal(verifyPlanState([planYes(), ci, planYes('2026-12-01T09:00:00Z')]).state, 'open')
})

test('stand-in: the daily run reads the verify report of the off-week Sunday back, and says when an approved go-live did not run', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const r = research()
    s.reports.set(RESEARCH_RUN, { payload_sha256: r.payload_sha256, mode: 'synthetic', accepted_at: RESEARCH_AT.toISOString(), report: r as unknown as Record<string, unknown> })
    s.decisions = [planYes() as never, goYes() as never]
    const mon = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-11-30:directive:1.1', now: () => MONDAY, wake: '1.1' }))
    assert.equal(mon.result.status, 'succeeded')
    assert.match(mon.text, /"event":"protocol_verify_runs","sundays":1,"stored":0,"unread":0/)
    assert.ok(mon.result.report!.holds.some(h => h.reason === 'unknown' && h.detail?.includes(`aeo:verify:${SUNDAY}`)))
    assert.ok(checkInOf(mon.result.report!))
    // With its report stored, the same day reads it, and the check-in counts the run.
    const v = verifyStored()
    s.reports.set(`aeo:${SUNDAY}:verify`, { payload_sha256: String(v.payload_sha256), mode: 'synthetic', accepted_at: `${SUNDAY}T11:00:00Z`, report: v })
    const again = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-11-30:directive:2.1', now: () => MONDAY, wake: '2.1' }))
    assert.equal(again.result.status, 'succeeded')
    assert.ok(!again.result.report!.holds.length)
    assert.match(checkInOf(again.result.report!)?.exact_payload ?? '', /ran \(aeo:2026-11-29:verify\), asked 3 of 3 questions/)
    assert.ok(!again.text.includes(Q1))
  } finally {
    await s.close()
  }
})
