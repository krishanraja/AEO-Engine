/**
 * Protocol 1.20.0: Krish's instruction and the engine's state. Synthetic
 * fixtures only, against the local stand-in. The rule every test here holds:
 * his words never reach a report, a request body or a log line, because this
 * repository and its Actions logs are public.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { runPage, wakeRef } from '../src/protocol/cli.js'
import { finishResearch, runDirective } from '../src/protocol/loop.js'
import type { RunSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, NEEDS_RESEARCH, type ResearchInput } from '../src/protocol/reports.js'
import { buildEngineState, inWords, parseAutonomy, parseFirstUnticked, parseNorthStar, parseUrgency, parseWaitingOnKrish, plain, readRepoState } from '../src/protocol/state.js'
import { parseFeatures, parseInstruction, stateLineOk, validateReport, type EngineReport, type ObjectiveReading } from '../src/schema/report.js'
import { ROOT } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn, SYNTHETIC_INSTRUCTION, SYNTHETIC_WORDS } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const DIRECTIVE_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-directive.schema.json'), 'utf8')) as Record<string, unknown>
const DAY = () => new Date('2026-11-11T05:12:00Z')
const FEATURES = { engine_state: true, krish_instruction: true }
const HELD_RULE = 'Krish has held this engine until it is ready. Propose nothing and ask him nothing. Report one hold that names what stops you being ready and what would clear it.'

function assertValid(r: EngineReport | null | undefined): asserts r is EngineReport {
  assert.ok(r, 'a report was built')
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'schema')
  assert.deepEqual(validateReport(r), { ok: true })
}

/** Runs fn against a fresh stand-in, and fails if the words or the token show up anywhere they could leak. */
async function standIn<T>(setup: (s: StandIn) => void, fn: (c: GrowthEngineHttp, s: StandIn) => Promise<T>): Promise<{ result: T; s: StandIn; logs: string }> {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    setup(s)
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const { result, text } = await captureStderr(() => fn(c, s))
    assert.ok(!text.includes(SYNTHETIC_WORDS), 'his words never reach a log line')
    assert.ok(!text.includes(TOKEN), 'the token never reaches a log line')
    for (const x of s.seen) assert.ok(!JSON.stringify(x.body ?? null).includes(SYNTHETIC_WORDS), `his words never leave in a request (${x.method} ${x.path})`)
    for (const r of s.reports.values()) assert.ok(!JSON.stringify(r.report).includes(SYNTHETIC_WORDS), 'his words never reach a report')
    return { result, s, logs: text }
  } finally {
    await s.close()
  }
}

const withInstruction = (s: StandIn) => {
  s.directive = { ...s.directive, schema_version: '1.20.0', features: FEATURES, krish_instruction: structuredClone(SYNTHETIC_INSTRUCTION) } as typeof s.directive
}

// ---------- parsing ----------

test('instruction: the id is kept, the words are dropped, and anything misshapen reads as none', () => {
  const ref = parseInstruction(SYNTHETIC_INSTRUCTION)
  assert.deepEqual(ref, { id: SYNTHETIC_INSTRUCTION.id, given_at: SYNTHETIC_INSTRUCTION.given_at, supersedes: null })
  assert.ok(!JSON.stringify(ref).includes(SYNTHETIC_WORDS))
  assert.equal(parseInstruction(null), null)
  assert.equal(parseInstruction(undefined), null)
  assert.equal(parseInstruction({ ...SYNTHETIC_INSTRUCTION, id: 'not-an-id' }), null)
  assert.equal(parseInstruction({ ...SYNTHETIC_INSTRUCTION, words: '  ' }), null)
  assert.equal(parseInstruction({ ...SYNTHETIC_INSTRUCTION, given_at: 'soon' }), null)
  assert.equal(parseInstruction({ ...SYNTHETIC_INSTRUCTION, supersedes: 'ki_' + 'a'.repeat(24) })?.supersedes, 'ki_' + 'a'.repeat(24))
  assert.deepEqual(parseFeatures(FEATURES), FEATURES)
  assert.equal(parseFeatures({ engine_state: 'yes', krish_instruction: true }), null)
  assert.equal(parseFeatures(undefined), null)
  // The fixture is what Control Center's own directive schema says it sends.
  const props = (DIRECTIVE_SCHEMA.properties as Record<string, Record<string, unknown>>)
  const shape = (props.krish_instruction.oneOf as Array<Record<string, unknown>>)[1]
  assert.deepEqual(schemaErrors(shape, SYNTHETIC_INSTRUCTION), [])
  assert.deepEqual(schemaErrors(props.features, FEATURES), [])
})

test('client: the directive it hands on carries the instruction by id, never its words', async () => {
  const { result } = await standIn(withInstruction, c => c.getDirective())
  assert.deepEqual(result.directive.krish_instruction, { id: SYNTHETIC_INSTRUCTION.id, given_at: SYNTHETIC_INSTRUCTION.given_at, supersedes: null })
  assert.deepEqual(result.directive.features, FEATURES)
  assert.ok(!JSON.stringify(result).includes(SYNTHETIC_WORDS))
})

// ---------- the daily run ----------

test('directive run, instruction present: it comes first, acked received then blocked on a paid research run, by id only', async () => {
  const { result, s } = await standIn(withInstruction, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i1', now: DAY, wake: '101.1', evidenceUrl: 'https://github.com/example/aeo-engine/actions/runs/101' }))
  assert.equal(result.status, 'succeeded')
  const r = result.report
  assertValid(r)
  assert.equal(r.schema_version, '1.20.0')
  assert.equal(r.run_id, 'aeo:2026-11-11:directive:101.1')
  assert.match(r.activity[0].line, new RegExp(`^Received Krish's instruction ${SYNTHETIC_INSTRUCTION.id}\\.`))
  assert.deepEqual(r.instruction_acks?.map(a => [a.instruction_id, a.state]), [[SYNTHETIC_INSTRUCTION.id, 'received'], [SYNTHETIC_INSTRUCTION.id, 'blocked']])
  assert.equal(r.instruction_acks?.[1].line, NEEDS_RESEARCH)
  assert.equal(r.instruction_acks?.[0].evidence_url, 'https://github.com/example/aeo-engine/actions/runs/101')
  assert.deepEqual(r.holds, [], 'an ack never goes in holds')
  assert.deepEqual(r.events, [])
  assert.ok(r.priorities?.length && r.obsessions?.length && r.next_steps?.length, 'the state rides with it')
  assert.equal(s.count('GET', '/api/growth/engines/aeo/reports?recent='), 1, 'one free read to see whether it was acked before')
})

test('directive run, instruction already acked in a recent live report: one still-open line, no ack repeated', async () => {
  const { result } = await standIn(s => {
    withInstruction(s)
    s.reports.set('aeo:2026-11-10:directive:100.1', { payload_sha256: 'e'.repeat(64), mode: 'live', accepted_at: '2026-11-10T05:12:05Z', report: { status: 'degraded', activity: [{ line: `Received Krish's instruction ${SYNTHETIC_INSTRUCTION.id}. This daily run reads and reports only.`, evidence_url: null }] } })
  }, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i2', now: DAY, wake: '102.1' }))
  const r = result.report
  assertValid(r)
  assert.equal(r.schema_version, '1.20.0')
  assert.match(r.activity[0].line, /is still open; this engine acked it in an earlier report\.$/)
  assert.equal(r.instruction_acks, undefined)
})

test('directive run, a recent read that fails: it acks again, which Control Center ignores as stale', async () => {
  const { result } = await standIn(s => { withInstruction(s); s.overrides.set('recent', { status: 500, body: { error: 'store_failed' } }) }, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i3', now: DAY, wake: '103.1' }))
  assertValid(result.report)
  assert.deepEqual(result.report.instruction_acks?.map(a => a.state), ['received', 'blocked'])
})

test('directive run, no instruction: 1.20.0 with the state, no ack and no instruction line', async () => {
  const { result, s } = await standIn(s => { s.directive = { ...s.directive, features: FEATURES, krish_instruction: null } as typeof s.directive }, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i4', now: DAY, wake: '104.1' }))
  const r = result.report
  assertValid(r)
  assert.equal(r.schema_version, '1.20.0')
  assert.equal(r.instruction_acks, undefined)
  assert.ok(!r.activity.some(a => /instruction ki_/.test(a.line)))
  assert.ok(r.priorities?.length)
  assert.equal(s.count('GET', '/api/growth/engines/aeo/reports?recent='), 0, 'nothing to look up')
})

test('directive run, held: a held engine is told only its hold and no instruction, so nothing is acked or claimed', async () => {
  const { result } = await standIn(s => {
    s.directive = { ...s.directive, features: FEATURES, krish_instruction: null, next_action: { proposal_id: null, instruction: HELD_RULE, why: 'Krish held it: it is not ready yet.', close_condition: null } } as typeof s.directive
  }, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i5', now: DAY, wake: '105.1' }))
  const r = result.report
  assertValid(r)
  assert.equal(r.instruction_acks, undefined)
  assert.ok(!JSON.stringify(r).includes('ki_'))
})

test('directive run, before 1.20.0: no features, so nothing new is sent, even with an instruction in the directive', async () => {
  const { result, s } = await standIn(s => { s.directive = { ...s.directive, krish_instruction: structuredClone(SYNTHETIC_INSTRUCTION) } as typeof s.directive }, c => runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'a:i6', now: DAY, wake: '106.1' }))
  const r = result.report
  assertValid(r)
  assert.equal(r.schema_version, '1.0.0')
  for (const k of ['priorities', 'obsessions', 'next_steps', 'instruction_acks']) assert.ok(!(k in r), `${k} is not sent before 1.20.0`)
  assert.equal(s.count('GET', '/api/growth/engines/aeo/reports?recent='), 0)
})

test('a second wake the same day: each wake has its own run_id, so the second report lands instead of a conflict', async () => {
  const { result, s } = await standIn(withInstruction, async c => {
    const first = await runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'aeo:2026-11-11:directive:201.1', now: DAY, wake: '201.1' })
    const second = await runDirective(c, { mode: 'live', revision: 'abc', attemptId: 'aeo:2026-11-11:directive:202.1', now: () => new Date('2026-11-11T09:40:00Z'), wake: '202.1' })
    return { first, second }
  })
  assert.equal(result.first.status, 'succeeded')
  assert.equal(result.second.status, 'succeeded', 'no report_conflict on the second wake')
  assert.ok(s.reports.has('aeo:2026-11-11:directive:201.1') && s.reports.has('aeo:2026-11-11:directive:202.1'))
  assert.deepEqual(result.first.report?.instruction_acks?.map(a => a.state), ['received', 'blocked'])
  assert.equal(result.second.report?.instruction_acks, undefined, 'the second wake read its own first report and does not ack again')

  assert.equal(wakeRef({ GITHUB_RUN_ID: '19234567890', GITHUB_RUN_ATTEMPT: '2' }), '19234567890.2')
  assert.notEqual(wakeRef({ GITHUB_RUN_ID: '19234567890', GITHUB_RUN_ATTEMPT: '1' }), wakeRef({ GITHUB_RUN_ID: '19234567891', GITHUB_RUN_ATTEMPT: '1' }))
  assert.equal(wakeRef({ GITHUB_RUN_ID: '1; rm -rf' }, () => new Date(5)), 'local.5', 'only digits make it into an id')
  assert.equal(runPage({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/aeo-engine', GITHUB_RUN_ID: '19234567890' }), 'https://github.com/example/aeo-engine/actions/runs/19234567890')
  assert.equal(runPage({ GITHUB_SERVER_URL: 'http://github.com', GITHUB_REPOSITORY: 'example/aeo-engine', GITHUB_RUN_ID: '1' }), null)
})

// ---------- the research run ----------

const NOW = new Date('2026-11-22T06:30:00Z')
function summary(subjects: RunSummary['subjects']): RunSummary {
  return { v: 1, subject_arg: 'x', week_start: '2026-11-16', generated_at: NOW.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 1, max_probe_usd: 0.04, error_code: null, subjects }
}
const venture = { slug: 'ctrl', kind: 'venture' as const, product_slug: 'ctrl', ok: true, questions: 30, probed_questions: 20, cited_first: 2, probes: 60, probes_failed: 0, probes_skipped_cap: 0 }
function input(over: Partial<ResearchInput> = {}): Omit<ResearchInput, 'runId'> {
  return { mode: 'live', observedAt: NOW, revision: 'abc', capturedAt: new Date('2026-11-22T04:00:00Z'), scope: 'all', expected: ['ctrl', 'missing-subject'], summaries: [summary([venture])], totalCapUsd: 15, planError: null, ...over }
}
const ids = { attemptId: 'aeo:2026-11-22:research:9.1', runId: 'aeo:2026-11-22:research', startedAt: '2026-11-22T04:00:10Z' }

test('research run, instruction open: received and started when it ran, blocked when it failed, and never done', async () => {
  const ok = await standIn(withInstruction, c => finishResearch(c, ids, input({ expected: ['ctrl'] }), () => NOW))
  assertValid(ok.result.report)
  assert.equal(ok.result.report.schema_version, '1.20.0')
  assert.match(ok.result.report.activity[0].line, /^Received Krish's instruction ki_[0-9a-f]{24} in this research run\.$/)
  assert.deepEqual(ok.result.report.instruction_acks?.map(a => a.state), ['received', 'started'])
  assert.match(ok.result.report.instruction_acks?.[1].line ?? '', /^A paid research run finished on Sunday 22 November 2026 with this instruction open: 1 of 1 subjects researched\./)

  const failed = await standIn(withInstruction, c => finishResearch(c, ids, input(), () => NOW))
  assertValid(failed.result.report)
  assert.deepEqual(failed.result.report.instruction_acks?.map(a => a.state), ['received', 'blocked'])
  assert.match(failed.result.report.instruction_acks?.[1].line ?? '', /failed for 1 of 2 subjects/)

  for (const r of [ok.result.report, failed.result.report]) assert.ok(!r.instruction_acks?.some(a => a.state === 'done'), 'done is his to say')
})

test('research run, no features: a 1.0.0 report exactly as before', async () => {
  const { result } = await standIn(() => {}, c => finishResearch(c, ids, input({ expected: ['ctrl'] }), () => NOW))
  assertValid(result.report)
  assert.equal(result.report.schema_version, '1.0.0')
  assert.ok(!('priorities' in result.report))
})

// ---------- the state, from this repository's own docs ----------

const MEASURED: ObjectiveReading = { key: 'queries_cited_first', value: 4, unit: 'questions', window_start: null, window_end: null, timezone: 'UTC', availability: 'measured', reason: null }
const MISSING: ObjectiveReading = { ...MEASURED, value: null, availability: 'missing', reason: 'not measured' }

test('state: read from this repository, every obsession is Krish\'s own words found verbatim in its doc', () => {
  const repo = readRepoState(ROOT)
  assert.ok(repo.northStar, 'the North Star number is read')
  assert.ok(repo.aim && repo.autonomy, 'both quoted aims are found')
  const st = buildEngineState({ repo, objective: MISSING, nextRun: new Date('2026-11-22T04:00:00Z') })
  const docs = { aim: readFileSync(join(ROOT, 'docs/NORTH_STAR.md'), 'utf8'), autonomy: readFileSync(join(ROOT, 'AGENTS.md'), 'utf8') }
  assert.equal(st.obsessions?.length, 2)
  assert.ok(docs.aim.includes(st.obsessions?.[0].line.slice(1, -1) ?? '<none>'))
  assert.ok(docs.autonomy.includes(st.obsessions?.[1].line.slice(1, -1) ?? '<none>'))
  assert.equal(st.obsessions?.[0].since, '2026-10-18')
  assert.equal(st.obsessions?.[1].since, '2026-10-19')
  assert.deepEqual(st.priorities?.map(p => p.rank), st.priorities?.map((_, n) => n + 1))
  assert.equal(st.priorities?.[0].objective_key, 'queries_cited_first')
  assert.match(st.priorities?.[1].line ?? '', /next is Sunday 22 November 2026 at 04:00 UTC/)
  assert.ok(st.next_steps?.some(n => n.waits_on === 'engine' && /^GET-GOING step \d+: /.test(n.line)))
  assert.ok(st.next_steps?.some(n => n.waits_on === 'engine' && n.when === '2026-11-22'))
  for (const x of [...(st.priorities ?? []), ...(st.obsessions ?? []), ...(st.next_steps ?? [])]) assert.ok(stateLineOk(x.line, 200), x.line)
  const report = buildDirectiveReport({ runId: 'aeo:2026-11-11:directive:1.1', mode: 'synthetic', observedAt: DAY(), revision: 'abc', capturedAt: DAY(), directive: null, directiveError: 'directive_unavailable', last: null, lastError: null, state: { repo, instruction: null, seen: false, evidenceUrl: null } })
  assertValid(report)
})

test('state: parsed from synthetic docs, a missing source leaves its lines out and nothing is invented', () => {
  const ns = parseNorthStar('# North Star\n\n> A synthetic aim in his words.\n\nSet by Krish on 3 March 2026.\n\n```yaml north-star-metric\nmetric: "Synthetic share"\nunit: %\ntarget: 40\ndeadline: 2027-02-01\n```\n')
  assert.deepEqual(ns, { northStar: { metric: 'Synthetic share', target: '40', unit: '%', deadline: '2027-02-01' }, aim: { quote: 'A synthetic aim in his words.', since: '2026-03-03' } })
  assert.deepEqual(parseUrgency('<!-- north-star-state {"urgency": 3, "urgency_reason": "behind"} -->'), { level: 3, reason: 'behind' })
  assert.equal(parseUrgency('<!-- north-star-state {"urgency": 9} -->'), null)
  assert.deepEqual(parseAutonomy('## Autonomy (Ruling, Krish, 2026-01-02)\n\nKrish: "synthetic ruling words." More.'), { quote: 'synthetic ruling words.', since: '2026-01-02' })
  assert.deepEqual(parseFirstUnticked('- [x] **Step 0.** Done.\n- [ ] **Step 4.** Build the `thing` with [a link](https://x.example).\n'), { step: 4, text: 'Build the thing with a link.' })
  assert.deepEqual(parseWaitingOnKrish('## What is next and what is waiting on Krish\n\n- Next: x.\n- Waiting on Krish: a target (`docs/X.md`, Step 3); a name (`a.ts`; not yet checked); and which keys are set.\n\n## Read next\n'), ['A target (docs/X.md, Step 3).', 'A name (a.ts; not yet checked).', 'Which keys are set.'])
  assert.equal(plain('**bold** `code` [text](https://x.example)'), 'bold code text')

  const empty = buildEngineState({ repo: { northStar: null, urgency: null, aim: null, autonomy: null, firstUnticked: null, waitingOnKrish: [] }, objective: MEASURED, nextRun: new Date('2026-11-22T04:00:00Z') })
  assert.equal(empty.obsessions, undefined, 'no quoted aim, no obsession')
  assert.deepEqual(empty.priorities?.map(p => p.rank), [1, 2])
  assert.match(empty.priorities?.[0].line ?? '', /from 4, as measured/)
  assert.deepEqual(empty.next_steps?.map(n => n.waits_on), ['engine'])

  const long = buildEngineState({ repo: { northStar: null, urgency: null, aim: { quote: 'x'.repeat(240), since: null }, autonomy: null, firstUnticked: null, waitingOnKrish: ['y'.repeat(260)] }, objective: MEASURED, nextRun: new Date('2026-11-22T04:00:00Z') })
  assert.equal(long.obsessions, undefined, 'a quote too long is left out, never cut')
  assert.ok(!long.next_steps?.some(n => n.waits_on === 'krish'))
})

test('line guard: what Control Center refuses is refused here first', () => {
  assert.equal(stateLineOk('The next run is Sunday 22 November 2026 at 04:00 UTC.', 200), true)
  assert.equal(stateLineOk('The next run is 2026-11-22 04:00 UTC.', 200), false, 'ten digits in one run read as a phone number')
  assert.equal(stateLineOk('Call +44 20 7946 0000', 200), false)
  assert.equal(stateLineOk('Write to someone@example.com', 200), false)
  assert.equal(stateLineOk('An em \u2014 dash', 200), false)
  assert.equal(stateLineOk('two\nlines', 200), false)
  assert.equal(stateLineOk(' padded', 200), false)
  assert.equal(stateLineOk('x'.repeat(201), 200), false)
  assert.equal(stateLineOk('Measured on 2026-10-25.', 200), true, 'a date alone is eight digits')
  assert.match(inWords(new Date('2027-01-03T04:00:00Z')), /^Sunday 3 January 2027 at 04:00 UTC$/)
})

test('validator: state fields need 1.20.0, and an ack must be by id, forward-shaped, and on one plain line', () => {
  const base = buildDirectiveReport({ runId: 'aeo:2026-11-11:directive:1.1', mode: 'synthetic', observedAt: DAY(), revision: 'abc', capturedAt: DAY(), directive: null, directiveError: 'x', last: null, lastError: null, state: { repo: readRepoState(ROOT), instruction: parseInstruction(SYNTHETIC_INSTRUCTION), seen: false, evidenceUrl: null } })
  assertValid(base)
  const reseal = (r: Record<string, unknown>) => { const { payload_sha256: _p, ...rest } = r; return { ...rest, payload_sha256: '0'.repeat(64) } }
  const old = validateReport(reseal({ ...base, schema_version: '1.0.0' })) as { ok: boolean; errors: string[] }
  assert.equal(old.ok, false)
  assert.ok(old.errors.some(e => /report\.priorities: needs schema_version 1\.20\.0/.test(e)))
  assert.ok(old.errors.some(e => /report\.instruction_acks: needs schema_version 1\.20\.0/.test(e)))
  const badAck = structuredClone(base) as unknown as { instruction_acks: Array<Record<string, unknown>> }
  badAck.instruction_acks[0].state = 'approved'
  badAck.instruction_acks[1].instruction_id = 'proposal-1'
  const errs = (validateReport(badAck) as { errors: string[] }).errors
  assert.ok(errs.some(e => /instruction_acks\[0\]\.state/.test(e)))
  assert.ok(errs.some(e => /instruction_acks\[1\]\.instruction_id/.test(e)))
  const quoted = structuredClone(base) as unknown as { priorities: Array<Record<string, unknown>> }
  quoted.priorities[0].rank = 6
  assert.ok((validateReport(quoted) as { errors: string[] }).errors.some(e => /priorities\[0\]\.rank/.test(e)))
})
