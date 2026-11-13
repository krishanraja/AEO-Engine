/**
 * Protocol 1.22.0: this engine is the one AI-answers specialist every
 * venture's growth engine calls (Ruling, Krish, 2026-11-12: "AEO-Engine
 * becomes the one specialist that every venture's growth engine calls for its
 * AI-answer work."). A venture engine's request rides this engine's directive
 * (answer_requests); the research run asks its product's questions verbatim,
 * first, under that product's subject, and its report says which requests it
 * asked (answers_served), at 1.22.0 and only where the directive serves them.
 * Every question and id here is invented.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ControlCenterClient } from '../src/clients/types.js'
import { uuidFromKey } from '../src/index.js'
import { Ledger } from '../src/lib/cost.js'
import { UsageMeter } from '../src/lib/usage.js'
import { buildResearchReport, type ResearchInput } from '../src/protocol/reports.js'
import { buildRunSummary, type RunSummary } from '../src/protocol/measure.js'
import { gapFor } from '../src/pipeline/20-gap.js'
import { proposeQueries } from '../src/pipeline/30-propose.js'
import { orderForProbing, probeLimitFor, probeQueries } from '../src/pipeline/40-probe.js'
import { scoreQueries } from '../src/pipeline/50-score.js'
import { requestsFor, runAll, servedBy, type RunDeps } from '../src/pipeline/run.js'
import type { AeoContext, ContextSubject } from '../src/schema/context.js'
import { PRODUCT_SLUGS, type AeoPacket } from '../src/schema/packet.js'
import { ANSWERS_VERSION, parseAnswerRequests, parseFeatures, validateReport, type AnswerRequest } from '../src/schema/report.js'
import { fixtureContext, ROOT, StubEngine, StubModel, subject } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr } from './standin.js'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const PACKET_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/packet.schema.json'), 'utf8')) as { $defs?: unknown; properties: { subject: { properties: { product_slug: { oneOf: Array<{ enum?: string[] }> } } } } }
const NOW = new Date('2026-11-22T10:30:00Z')
const R1 = '0b4f6a1e-7c2d-4e8a-9b1f-3d5c7e9a2b4c'
const R2 = '1c5a7b2f-8d3e-4f9b-8c2a-4e6d8f0b3c5d'

const request = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({
  request_id: R1, engine_id: 'growth-heartside', product_slug: 'heartside', subject_slug: 'heartside',
  questions: ['What is a good gift from my dog?', 'Which dog gift is the funniest?'], requested_at: '2026-11-12T08:00:00Z', ...over,
})

test('the directive: answer_requests is read loosely, a misshapen request dropped, never guessed at', () => {
  const read = parseAnswerRequests([
    request(),
    { request_id: 'nope', engine_id: 'growth-x', product_slug: 'x', questions: ['A fine question here?'] },
    { request_id: R2, engine_id: 'growth-makeyourmindup', product_slug: 'publication', questions: ['short', 7, 'Which newsletter explains AI without the hype?'] },
    'not a request',
  ])
  assert.deepEqual(read.map(r => r.request_id), [R1, R2])
  assert.deepEqual(read[1].questions, ['Which newsletter explains AI without the hype?'])
  assert.equal(read[1].subject_slug, 'publication')
  assert.deepEqual(parseAnswerRequests(undefined), [])
  assert.equal(parseFeatures({ engine_state: true, krish_instruction: true, answer_requests: true })?.answer_requests, true)
  assert.equal(parseFeatures({ engine_state: true, krish_instruction: true })?.answer_requests, undefined)
})

test("a venture subject answers its own product's requests only; a prospect or an aspiration answers none", () => {
  const all = [request(), request({ request_id: R2, product_slug: 'publication', engine_id: 'growth-makeyourmindup' })]
  assert.deepEqual(requestsFor({ kind: 'venture', product_slug: 'heartside' }, all).map(r => r.request_id), [R1])
  assert.deepEqual(requestsFor({ kind: 'prospect', product_slug: null }, all), [])
  assert.deepEqual(requestsFor({ kind: 'venture', product_slug: 'ctrl' }, all), [])
  assert.deepEqual(requestsFor({ kind: 'venture', product_slug: 'heartside' }, undefined), [])
})

test('a request is served only when every one of its questions was put to an assistant', () => {
  const q = (query: string, probed: boolean) => ({ query, probes: probed ? [{}] : [] }) as never
  const packet = { queries: [q('What is a good gift from my dog?', true), q('which dog gift is the FUNNIEST', true)] }
  assert.deepEqual(servedBy(packet, [request()]), [R1], 'matched as the run normalises a query')
  const capped = { queries: [q('What is a good gift from my dog?', true), q('Which dog gift is the funniest?', false)] }
  assert.deepEqual(servedBy(capped, [request()]), [], 'the cap stopped one: not served, so it is asked again next run')
})

test("the packet takes each venture's product: heartside, legibility and publication beside the five before", () => {
  for (const p of ['heartside', 'legibility', 'publication']) assert.ok((PRODUCT_SLUGS as readonly string[]).includes(p))
  const en = PACKET_SCHEMA.properties.subject.properties.product_slug.oneOf.find(o => o.enum)?.enum ?? []
  assert.deepEqual([...en].sort(), [...PRODUCT_SLUGS].sort(), 'docs/packet.schema.json says the same as the code')
})

function summary(subjects: RunSummary['subjects']): RunSummary {
  return { v: 1, subject_arg: 'x', week_start: '2026-11-16', generated_at: NOW.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 4, max_probe_usd: 0.04, error_code: null, subjects }
}
const heartside = (served?: string[]) => ({ slug: 'heartside', kind: 'venture' as const, product_slug: 'heartside', ok: true, questions: 22, probed_questions: 22, cited_first: 0, probes: 66, probes_failed: 0, probes_skipped_cap: 0, ...(served ? { served } : {}) })
const input = (over: Partial<ResearchInput> = {}): ResearchInput => ({
  runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: NOW, revision: 'abc123', capturedAt: NOW,
  scope: 'all', expected: ['heartside'], summaries: [summary([heartside([R1])])], totalCapUsd: 15, planError: null, ...over,
})

test('the research report says which requests it asked, at 1.22.0, only where the directive serves them, and never a question', () => {
  const r = buildResearchReport(input({ answers: true }))
  assert.equal(r.schema_version, ANSWERS_VERSION)
  assert.deepEqual(r.answers_served, [R1])
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'Control Center\'s report schema takes it')
  assert.deepEqual(validateReport(r), { ok: true })
  assert.ok(r.activity.some(a => /^Asked 1 venture request for AI answers, word for word \(heartside\)\.$/.test(a.line)))
  assert.ok(!JSON.stringify(r).includes('gift from my dog'), 'never a question in the report')
  // A directive that does not serve requests: no field, the version it spoke before.
  const before = buildResearchReport(input())
  assert.equal(before.answers_served, undefined)
  assert.equal(before.schema_version, '1.0.0')
  // Nothing asked: no field.
  assert.equal(buildResearchReport(input({ answers: true, summaries: [summary([heartside()])] })).answers_served, undefined)
  // A failed subject serves nothing.
  const failed = buildResearchReport(input({ answers: true, summaries: [summary([{ ...heartside([R1]), ok: false }])] }))
  assert.equal(failed.answers_served, undefined)
})

test('the validator refuses answers_served before 1.22.0 and anything that is not a request id', () => {
  const r = buildResearchReport(input({ answers: true }))
  assert.equal(validateReport({ ...r, schema_version: '1.20.0' }).ok, false)
  assert.equal(validateReport({ ...r, answers_served: ['nope'] }).ok, false)
})

test('the run summary carries the served ids by subject, sealed with the counts', () => {
  const s = buildRunSummary({
    subjectArg: 'heartside', weekStart: '2026-11-16', now: NOW, engines: ['perplexity'], capUsd: 5, spentUsd: 1, maxProbeUsd: 0.01,
    results: [{ packet: { subject: { slug: 'heartside', kind: 'venture', product_slug: 'heartside' }, queries: [], stats: { probes: 0, probes_failed: 0, probes_skipped_cap: 0 } } as never, domains: ['heartside.example'], served: [R1] }],
    failures: [], errorCode: null,
  })
  assert.deepEqual(s.subjects[0].served, [R1])
})

test('a full request of 25 questions is asked whole, first, beside 30 high-demand questions of the engine\'s own, and is served', async () => {
  const ctx = fixtureContext()
  const asked = Array.from({ length: 25 }, (_, i) => `Which personalised present suits owner kind${i}?`)
  const own = Array.from({ length: 30 }, (_, i) => `How do I choose a dog gift for occasion${i}?`)
  // Every one of the engine's own questions carries high prior demand, which
  // used to put each of them ahead of every requested (seed) question.
  const venture = {
    ...subject('ctrl'), slug: 'heartside', product_slug: 'heartside', domains: ['heartside.example'], competitor_domains: [],
    touchpoints: [], striking_distance: [], probes_4w: [],
    prior: { week_start: '2026-11-02', watch_list: [], recommendations: [], queries: own.map((query, i) => ({ query_id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, query, demand_score: 90, status: 'watch' as const, trend: 'flat' as const })) },
  } as ContextSubject
  const req = request({ questions: asked })
  const requested = requestsFor(venture, [req]).flatMap(r => r.questions)
  assert.equal(requested.length, 25)

  const model = new StubModel(JSON.stringify({ queries: own.map(query => ({ query, source: 'gap', touchpoint_id: null })) }))
  const ledger = new Ledger(25)
  const domains = ['heartside.example']
  const proposed = await proposeQueries(model, ledger, venture, ctx, [], gapFor(venture, domains), uuidFromKey, requested)
  assert.equal(proposed.filter(q => q.requested).length, 25, 'no requested question lost at the proposal cap')
  assert.ok(proposed.every(q => q.requested ? q.source === 'seed' : true), 'the packet source enum is unchanged')

  const ordered = orderForProbing(proposed)
  assert.deepEqual(ordered.slice(0, 25).map(q => q.query), asked, 'requested first, in request order')
  const limit = probeLimitFor(proposed.filter(q => q.requested).length)
  assert.equal(limit, 30)
  const engines = (['perplexity', 'chatgpt', 'claude'] as const).map(e => new StubEngine(e, () => ({ text: 'An answer.', citations: ['https://x.example/a'], searched: true })))
  const outcome = await probeQueries(engines, proposed, domains, ledger, [], limit)
  for (const e of engines) {
    assert.deepEqual(e.asked.slice(0, 25), asked, `${e.engine} asked every requested question first`)
    assert.equal(e.asked.length, 30, 'and five of its own beside them')
  }
  const queries = scoreQueries(proposed, outcome, [], venture, domains)
  assert.deepEqual(servedBy({ queries }, [req]), [R1])
})

test('a requested question of one meaningful word is still asked', async () => {
  const venture = { ...subject('ctrl'), slug: 'heartside', product_slug: 'heartside', domains: ['heartside.example'] } as ContextSubject
  const proposed = await proposeQueries(new StubModel('{"queries":[]}'), new Ledger(10), venture, fixtureContext(), [], gapFor(venture, []), uuidFromKey, ['What is Heartside?'])
  assert.equal(proposed[0].query, 'What is Heartside?')
  assert.equal(proposed[0].requested, true)
})

/**
 * The whole subject run, as the CLI composes it (runAll: propose, the probe
 * limit, the probes, the score, the digest, ship, servedBy), offline, with a
 * venture request of 25 questions beside 30 of the engine's own that all carry
 * high prior demand. Only the shared spend share differs between the cases.
 */
async function runRequested(capUsd: number) {
  const asked = Array.from({ length: 25 }, (_, i) => `Which personalised present suits owner kind${i}?`)
  const own = Array.from({ length: 30 }, (_, i) => `How do I choose a dog gift for occasion${i}?`)
  const venture = {
    ...subject('ctrl'), slug: 'heartside', product_slug: 'heartside', domains: ['heartside.example'], competitor_domains: [],
    touchpoints: [], striking_distance: [], probes_4w: [],
    prior: { week_start: '2026-11-02', watch_list: [], recommendations: [], queries: own.map((query, i) => ({ query_id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, query, demand_score: 90, status: 'watch' as const, trend: 'flat' as const })) },
  } as ContextSubject
  const ctx = { ...fixtureContext(), subjects: [venture] } as AeoContext
  const ingested: AeoPacket[] = []
  const cc: ControlCenterClient = {
    getContext: async () => ctx,
    postIngest: async p => { ingested.push(p); return { ok: true, status: 200 } },
    patchCommand: async () => {},
    postUsage: async () => ({ ok: true, error: null }),
  }
  // The proposal returns the engine's own 30; the digest fails and falls back, after its charge.
  const model = new StubModel(req => req.stage === 'propose' ? JSON.stringify({ queries: own.map(query => ({ query, source: 'gap', touchpoint_id: null })) }) : 'THROW')
  const engines = (['perplexity', 'chatgpt', 'claude'] as const).map(e => new StubEngine(e, () => ({ text: 'An answer.', citations: ['https://x.example/a'], searched: true })))
  const ledger = new Ledger(capUsd)
  const deps: RunDeps = { cc, fireflies: null, engines, model, ledger, usage: new UsageMeter(), mintId: uuidFromKey, now: new Date('2026-11-22T10:00:00Z'), requests: [request({ questions: asked })] }
  const { result } = await captureStderr(() => runAll(deps, { subject: 'all', weekStart: '2026-11-16', dry: false, outPath: null, commandId: null }))
  return { asked, engines, ledger, result, packet: ingested[0] }
}

test('runAll: a request of 25 questions is asked whole and first beside 30 high-demand questions of the engine\'s own, shipped and served', async () => {
  const { asked, engines, ledger, result, packet } = await runRequested(25)
  assert.deepEqual(result.failures, [])
  for (const e of engines) {
    assert.deepEqual(e.asked.slice(0, 25), asked, `${e.engine} asked every requested question first, in request order`)
    assert.equal(e.asked.length, 30, 'the limit rose to the 25 requested and five of its own')
  }
  for (const q of asked) assert.ok(packet.queries.find(x => x.query === q)?.probes.length === 3, `every requested question carries its probes in the shipped packet`)
  assert.deepEqual(result.results[0].served, [R1])
  assert.equal(result.results[0].unserved, 0)
  assert.ok(ledger.entries.some(e => e.kind === 'digest'), 'the digest was charged')
})

test('runAll: a share too small for the request leaves it unserved, says so by count, and still keeps the digest its money', async () => {
  // propose 0.04, then 0.13 a question for three assistants, with the digest's 0.06 held back.
  const { asked, engines, ledger, result } = await runRequested(2)
  const r = result.results[0]
  assert.ok(r.packet.stats.probes_skipped_cap > 0, 'the cap stopped pairs')
  assert.deepEqual(engines[0].asked, asked.slice(0, 15), 'requested questions still went first')
  assert.deepEqual(r.served, [], 'not every requested question was asked, so the request is not served')
  assert.equal(r.unserved, 1)
  assert.ok(ledger.entries.some(e => e.kind === 'digest'), 'the probes left the digest its share')
  assert.ok(ledger.total <= 2 + 1e-9)

  const sum = buildRunSummary({ subjectArg: 'heartside', weekStart: '2026-11-16', now: NOW, engines: ['perplexity', 'chatgpt', 'claude'], capUsd: 2, spentUsd: ledger.total, maxProbeUsd: 0.07, results: result.results, failures: [], errorCode: null })
  assert.equal(sum.subjects[0].requests_unserved, 1)
  const report = buildResearchReport(input({ answers: true, summaries: [sum] }))
  assert.deepEqual(schemaErrors(SCHEMA, report), [])
  assert.deepEqual(validateReport(report), { ok: true })
  const said = '1 venture request for heartside was not asked in full: the spend cap stopped some of its questions. It stays open for a later run.'
  assert.ok(report.activity.some(a => a.line === said))
  assert.ok(report.holds.some(h => h.reason === 'answer_request_not_served' && h.detail === said))
  assert.equal(report.answers_served, undefined, 'an unserved request is not claimed')
  assert.ok(!JSON.stringify(report).includes('owner kind'), 'never a question in the report')
})

test('proposeQueries: two requests of 25 questions reach the proposal whole, past the usual cap of 40 and inside the packet\'s 60', async () => {
  const venture = { ...subject('ctrl'), slug: 'heartside', product_slug: 'heartside', domains: ['heartside.example'] } as ContextSubject
  const first = Array.from({ length: 25 }, (_, i) => `Which personalised present suits owner kind${i}?`)
  const second = Array.from({ length: 25 }, (_, i) => `Which framed portrait suits a breed${i} lover?`)
  const own = Array.from({ length: 30 }, (_, i) => `How do I choose a dog gift for occasion${i}?`)
  const model = new StubModel(JSON.stringify({ queries: own.map(query => ({ query, source: 'gap', touchpoint_id: null })) }))
  const proposed = await proposeQueries(model, new Ledger(10), venture, fixtureContext(), [], gapFor(venture, []), uuidFromKey, [...first, ...second])
  assert.deepEqual(proposed.filter(q => q.requested).map(q => q.query), [...first, ...second])
  assert.ok(proposed.length <= 60)
})
