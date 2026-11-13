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
import { buildResearchReport, type ResearchInput } from '../src/protocol/reports.js'
import { buildRunSummary, type RunSummary } from '../src/protocol/measure.js'
import { requestsFor, servedBy } from '../src/pipeline/run.js'
import { PRODUCT_SLUGS } from '../src/schema/packet.js'
import { ANSWERS_VERSION, parseAnswerRequests, parseFeatures, validateReport, type AnswerRequest } from '../src/schema/report.js'
import { ROOT } from './helpers.js'
import { schemaErrors } from './schema-check.js'

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
