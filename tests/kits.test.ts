import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { finishResearch, runDirective } from '../src/protocol/loop.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, buildResearchReport, KIT_PROPOSAL_PREFIX, kitProposal, wordsPayloadSha, type ResearchInput } from '../src/protocol/reports.js'
import { validateReport, type EngineReport } from '../src/schema/report.js'
import type { KitCandidate } from '../src/schema/kit.js'
import { ROOT } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-11-22T10:30:00Z')
const QUESTION = 'Which synthetic question would a buyer type?'

const candidate = (product: string, priority: number, n = 1): KitCandidate => ({
  product_slug: product,
  query_id: `${String(n).padStart(8, 'a')}-0000-4000-8000-000000000000`,
  priority,
  title: QUESTION,
  exact_payload: `Win kit kit:${product}:${String(n).padStart(8, 'a')} (v1)\nQuestion: ${QUESTION}\nTarget: Update the page https://${product}.example/answers/x on ${product}.example.`,
  gap_class: 'retrieved_not_cited',
  target_kind: 'update_page',
  reference: `https://${product}.example/answers/x`,
})

const sub = (slug: string, kind: SubjectSummary['kind'], over: Partial<SubjectSummary> = {}): SubjectSummary => ({
  slug, kind, product_slug: kind === 'venture' ? slug : null, ok: true, questions: 25, probed_questions: 25, cited_first: 1, probes: 75, probes_failed: 0, probes_skipped_cap: 0,
  gap_classes: { won: 1, cited_not_first: 2, retrieved_not_cited: 3, not_retrieved: 4, no_page: 15, unknown: 0 }, ...over,
})

const summary = (subjects: SubjectSummary[]): RunSummary => ({ v: 1, subject_arg: 'x', week_start: '2026-11-16', generated_at: NOW.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 3, max_probe_usd: 0.07, error_code: null, subjects })

function input(subjects: SubjectSummary[], over: Partial<ResearchInput> = {}): ResearchInput {
  return { runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: NOW, revision: 'abc', capturedAt: new Date('2026-11-22T04:00:00Z'), scope: 'all', expected: subjects.map(s => s.slug), summaries: subjects.map(s => summary([s])), totalCapUsd: 25, planError: null, ...over }
}

/** The asks beside the verify lane's (tests/verify.test.ts covers those): an approved kit plan makes the standing verify plan due. */
const kitAsks = (ps: EngineReport['proposals']) => ps.filter(p => !p.proposal_id.startsWith('aeo:verify'))

function assertValid(r: EngineReport): void {
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'schema')
  assert.deepEqual(validateReport(r), { ok: true })
}

test('kit proposal: a plan, prepared, behind strategy, on queries_cited_first, closed by kit_won, and accepted by both validators', () => {
  const p = kitProposal(candidate('heartside', 4.8), new Date('2026-12-06T04:00:00Z'))
  assert.equal(p.proposal_id, `${KIT_PROPOSAL_PREFIX}heartside:aaaaaaa1`)
  assert.equal(p.kind, 'prepared')
  assert.equal(p.wall, 'strategy')
  assert.equal(p.title, `Win '${QUESTION}' for heartside`)
  assert.equal(p.objective_key, 'queries_cited_first')
  assert.deepEqual(p.close_condition, { event: 'kit_won', reference: 'https://heartside.example/answers/x' })
  assert.equal(p.expires_at, '2026-12-06T04:00:00.000Z')
  assert.equal(p.payload_sha256, wordsPayloadSha(p.exact_payload))
  assert.equal(p.amount_usd, null)
  assert.equal(p.channel, null)
  // A kit is a plan for one question (GET-GOING Step 1): stage plan, no parent, and never a go-live from AEO.
  assert.equal(p.stage, 'plan')
  assert.ok(!('parent_proposal_id' in p))
  const r = buildResearchReport(input([sub('heartside', 'venture', { kits: 4, kit_candidate: candidate('heartside', 4.8) })]))
  assertValid(r)
  assert.equal(r.schema_version, '1.1.0', 'the lowest version that carries a stage')
  assert.ok(!r.proposals.some(x => x.stage === 'go_live'))
  // A host reference (no page of ours) carries no evidence link; an empty one closes on nothing named.
  const host = kitProposal({ ...candidate('ctrl', 1), target_kind: 'new_page', reference: 'ctrl.example' }, NOW)
  assert.deepEqual(host.evidence, [])
  assert.equal(host.close_condition.reference, 'ctrl.example')
  assert.equal(kitProposal({ ...candidate('ctrl', 1), reference: '' }, NOW).close_condition.reference, null)
})

test('research report: exactly one kit, the highest priority across ventures that are not held', () => {
  const subjects = [
    sub('ctrl', 'venture', { kits: 6, kit_candidate: candidate('ctrl', 3.2, 2) }),
    sub('heartside', 'venture', { kits: 9, kit_candidate: candidate('heartside', 5.1, 3) }),
    sub('legibility', 'venture', { held: true, kits: 0 }),
    sub('secret-prospect-co', 'prospect'),
    sub('secret-aspiration-co', 'aspiration', { gap_classes: undefined }),
  ]
  const r = buildResearchReport(input(subjects))
  assertValid(r)
  const kits = r.proposals.filter(p => p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX))
  assert.equal(kits.length, 1)
  assert.equal(kits[0].proposal_id, 'aeo:kit:heartside:aaaaaaa3')
  const lines = r.activity.map(a => a.line)
  assert.ok(lines.includes('One win kit is on Krish\'s list, for heartside; the next research run checks it.'))
  // Each venture's line goes on with its AI referrals (src/protocol/reports.ts, ventureMeasures).
  assert.ok(lines.includes('Why heartside\'s questions are not won: 1 won, 2 cited not first, 3 retrieved not cited, 4 with a page not retrieved, 15 with no page; 9 win kits prepared. AI referrals: unknown (no search signals served).'))
  assert.ok(lines.includes('Why legibility\'s questions are not won: 1 won, 2 cited not first, 3 retrieved not cited, 4 with a page not retrieved, 15 with no page; held, so no kit. AI referrals: unknown (no search signals served).'))
  assert.ok(lines.includes('Why the questions of 1 prospect are not won by Mindmake\'s pages: 1 won, 2 cited not first, 3 retrieved not cited, 4 with a page not retrieved, 15 with no page.'))
  const text = JSON.stringify({ ...r, proposals: r.proposals.filter(p => !kits.includes(p)) })
  assert.ok(!text.includes(QUESTION), 'the question only inside the kit')
  assert.ok(!text.includes('secret-prospect-co') && !text.includes('secret-aspiration-co'))
  // The detail lines come last, so the 40-line cap can only cut them.
  assert.ok(lines.indexOf('One win kit is on Krish\'s list, for heartside; the next research run checks it.') < lines.findIndex(l => l.startsWith('Why ')))
})

test('research report: no kit when only held products have candidates, and none from a prospect or an aspiration', () => {
  const held = buildResearchReport(input([
    sub('legibility', 'venture', { held: true, kit_candidate: candidate('legibility', 9) }),
    sub('full-time', 'venture', { held: true, kit_candidate: candidate('full-time', 8) }),
    sub('secret-prospect-co', 'prospect', { kit_candidate: candidate('mindmake', 7) }),
    sub('secret-aspiration-co', 'aspiration', { kit_candidate: candidate('mindmake', 7) }),
  ]))
  assertValid(held)
  assert.deepEqual(held.proposals, [])
  assert.ok(!held.activity.some(a => /win kit is on/.test(a.line)))
  // A failed venture carries none either.
  const failed = buildResearchReport(input([sub('ctrl', 'venture', { ok: false, kit_candidate: candidate('ctrl', 4) })]))
  assert.deepEqual(failed.proposals.filter(p => p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX)), [])
})

test('research report: a kit whose words a report may not carry is held back, and the report still lands', () => {
  const bad = { ...candidate('ctrl', 4), exact_payload: 'Win kit\nWrite to someone@example.com about it' }
  const r = buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: bad })]))
  assertValid(r)
  assert.deepEqual(r.proposals, [])
  assert.ok(r.holds.some(h => h.reason === 'kit_not_proposed' && /for ctrl/.test(h.detail ?? '')))
  assert.ok(!r.activity.some(a => /win kit is on/.test(a.line)))
  assert.equal(r.objectives[0].availability, 'measured', 'the reading still lands')
})

test('research report: a kit beside a spend ask, both valid, the spend first', () => {
  const r = buildResearchReport(input([sub('ctrl', 'venture', { probes_skipped_cap: 12, kits: 2, kit_candidate: candidate('ctrl', 2.4) })]))
  assertValid(r)
  assert.deepEqual(r.proposals.map(p => p.wall), ['spend', 'strategy'])
})

const dayBase = (observedAt: Date) => ({ runId: `aeo:${observedAt.toISOString().slice(0, 10)}:directive`, mode: 'synthetic' as const, observedAt, revision: 'abc', capturedAt: observedAt, directiveError: null, lastError: null })

test('daily report: carries the kit until he decides, drops it on a decline or at expiry, and says a kit ships elsewhere', () => {
  const research = buildResearchReport(input([sub('ctrl', 'venture', { kits: 2, kit_candidate: candidate('ctrl', 3) })]))
  const kit = research.proposals[0]
  const last = { run_id: research.run_id, accepted_at: '2026-11-22T10:31:00Z', report: research as unknown as Record<string, unknown> }
  const directive = (decisions: Array<{ proposal_id: string; decision: string; decided_at: string; payload_sha256: string | null }> = []) => ({ directive_id: 'aeo:2026-11-23', chosen_by: 'rule', decisions_since: decisions })

  const open = buildDirectiveReport({ ...dayBase(new Date('2026-11-23T05:12:00Z')), directive: directive(), last })
  assertValid(open)
  assert.deepEqual(open.proposals, [kit], 'the same id and the same payload, so nothing changes until he decides')

  const declined = buildDirectiveReport({ ...dayBase(new Date('2026-11-24T05:12:00Z')), directive: directive([{ proposal_id: kit.proposal_id, decision: 'declined', decided_at: '2026-11-23T09:00:00Z', payload_sha256: kit.payload_sha256 }]), last })
  assertValid(declined)
  assert.deepEqual(declined.proposals, [])

  const approved = buildDirectiveReport({ ...dayBase(new Date('2026-11-24T05:12:00Z')), directive: directive([{ proposal_id: kit.proposal_id, decision: 'approved', decided_at: '2026-11-23T09:00:00Z', payload_sha256: kit.payload_sha256 }]), last })
  assertValid(approved)
  assert.deepEqual(kitAsks(approved.proposals), [])
  assert.deepEqual(approved.proposals.map(p => p.proposal_id), ['aeo:verify-plan:v1'], 'an approved kit plan makes the standing verify plan due')
  assert.ok(approved.activity.some(a => /Krish approved "Win '.*' for ctrl" on 2026-11-23\. This engine still changes nothing behind a wall; a kit ships through the product's build session or its growth engine, never from here\./.test(a.line)))

  const older = buildDirectiveReport({ ...dayBase(new Date('2026-11-24T05:12:00Z')), directive: directive([{ proposal_id: kit.proposal_id, decision: 'declined', decided_at: '2026-11-23T09:00:00Z', payload_sha256: '0'.repeat(64) }]), last })
  assert.deepEqual(older.proposals, [kit], 'a decision on an earlier version leaves the current one his to decide')

  const expired = buildDirectiveReport({ ...dayBase(new Date('2026-12-06T05:12:00Z')), directive: directive(), last })
  assertValid(expired)
  assert.deepEqual(expired.proposals, [], 'it expires at the next research run')
})

test('stand-in: the research report lands with one kit, the next day\'s report carries it, and an approval is counted and never acted on', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const ids = { attemptId: 'aeo:2026-11-22:research:1.1', runId: 'aeo:2026-11-22:research', startedAt: '2026-11-22T04:00:00Z' }
    const { runId: _r, ...rest } = input([sub('ctrl', 'venture', { kits: 3, kit_candidate: candidate('ctrl', 3.6) }), sub('legibility', 'venture', { held: true })])
    const research = await captureStderr(() => finishResearch(c, ids, rest, () => NOW))
    assert.equal(research.result.status, 'succeeded')
    const stored = s.reports.get(ids.runId)?.report as unknown as EngineReport
    const kits = stored.proposals.filter(p => p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX))
    assert.equal(kits.length, 1)
    assert.ok(!research.text.includes(QUESTION) && !research.text.includes('answers/x'), 'the kit never reaches a log line')

    const day = new Date('2026-11-23T05:12:00Z')
    const open = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-11-23:directive:1.1', now: () => day, wake: 'w1' }))
    assert.equal(open.result.status, 'succeeded')
    assert.deepEqual(open.result.report?.proposals, kits, 'carried while he has not decided')

    s.decisions = [{ proposal_id: kits[0].proposal_id, decision: 'approved', decided_at: '2026-11-23T05:00:00Z', payload_sha256: kits[0].payload_sha256 }]
    const daily = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-11-23:directive:2.1', now: () => day, wake: 'w2' }))
    assert.equal(daily.result.status, 'succeeded')
    assert.deepEqual(kitAsks(daily.result.report?.proposals ?? []), [], 'dropped: his decision is read before the report, even before the directive serves it')
    assert.match(daily.text, /"event":"protocol_decisions".*"kits_approved":1,"check_ins_declined":0,"acted_on":0/)
    assert.ok(!daily.text.includes(QUESTION))
  } finally {
    await s.close()
  }
})

const decline = (proposal_id: string, decided_at = '2026-11-10T09:00:00Z', decision = 'declined') => ({ proposal_id, decision, decided_at, payload_sha256: '1'.repeat(64) })

test('research report: a kit Krish already decided never comes back as a fresh ask; the next one is proposed', () => {
  const top = candidate('heartside', 5.1, 3)
  const backup = candidate('heartside', 4.0, 4)
  const subjects = [sub('heartside', 'venture', { kits: 5, kit_candidate: top, kit_backups: [backup] }), sub('ctrl', 'venture', { kits: 2, kit_candidate: candidate('ctrl', 3.2, 2) })]
  const fresh = buildResearchReport(input(subjects, { decisions: [] }))
  assert.deepEqual(fresh.proposals.map(p => p.proposal_id), ['aeo:kit:heartside:aaaaaaa3'])
  for (const decision of ['declined', 'approved']) {
    const r = buildResearchReport(input(subjects, { decisions: [decline('aeo:kit:heartside:aaaaaaa3', '2026-11-10T09:00:00Z', decision)] }))
    assertValid(r)
    // An approved plan is in flight, so it gets its check-in beside the next kit; a declined one gets nothing.
    assert.deepEqual(r.proposals.map(p => p.proposal_id), decision === 'approved' ? ['aeo:kit:heartside:aaaaaaa4', 'aeo:checkin:heartside:aaaaaaa3'] : ['aeo:kit:heartside:aaaaaaa4'], `${decision}: the venture's next kit`)
    assert.ok(r.activity.some(a => a.line === '1 win kit Krish already decided was left off his list.'))
  }
  const all = buildResearchReport(input(subjects, { decisions: ['aeo:kit:heartside:aaaaaaa3', 'aeo:kit:heartside:aaaaaaa4', 'aeo:kit:ctrl:aaaaaaa2'].map(id => decline(id)) }))
  assertValid(all)
  assert.deepEqual(all.proposals, [], 'every candidate declined: none, and no check-in')
})

test('research report: no kit when his decisions could not be read, and none from a run of one subject', () => {
  const subjects = [sub('ctrl', 'venture', { kits: 2, kit_candidate: candidate('ctrl', 3.2, 2) })]
  const unread = buildResearchReport(input(subjects, { decisions: null }))
  assertValid(unread)
  assert.deepEqual(unread.proposals, [])
  assert.ok(unread.holds.some(h => h.reason === 'kit_not_proposed' && /decisions could not be read/.test(h.detail ?? '')))
  const one = buildResearchReport(input(subjects, { scope: 'one', decisions: [] }))
  assertValid(one)
  assert.deepEqual(one.proposals, [])
  assert.ok(one.activity.some(a => a.line === 'A run of one subject puts no win kit on Krish\'s list; the full research run does.'))
})

test('research report: a full run started by hand keeps the one kit already waiting, renewed when it is still a candidate, and never adds a second', () => {
  const earlier = buildResearchReport(input([sub('heartside', 'venture', { kits: 4, kit_candidate: candidate('heartside', 4.8, 1) })], { decisions: [] }))
  const waiting = earlier.proposals[0]
  const later = new Date('2026-11-25T12:00:00Z')
  // The waiting kit is still a candidate, below another: it is renewed under its own id, and the other waits.
  const renewed = buildResearchReport(input([sub('heartside', 'venture', { kits: 4, kit_candidate: candidate('ctrl', 9, 7), kit_backups: [{ ...candidate('heartside', 3, 1), exact_payload: `${candidate('heartside', 3, 1).exact_payload}\nPriority: 3` }] })], { observedAt: later, decisions: [], pendingKit: waiting }))
  assertValid(renewed)
  const kits = renewed.proposals.filter(p => p.proposal_id.startsWith(KIT_PROPOSAL_PREFIX))
  assert.deepEqual(kits.map(p => p.proposal_id), [waiting.proposal_id])
  assert.notEqual(kits[0].payload_sha256, waiting.payload_sha256, 'kept current')
  assert.equal(kits[0].expires_at, waiting.expires_at, 'it still expires at the next scheduled run')
  // No longer a candidate: carried exactly as it was.
  const carried = buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: candidate('ctrl', 9, 7) })], { observedAt: later, decisions: [], pendingKit: waiting }))
  assertValid(carried)
  assert.deepEqual(carried.proposals, [waiting])
  assert.ok(carried.activity.some(a => /stays as it is until he decides; no second kit is added/.test(a.line)))
})

test('daily report: a decline more than seven days back, past the directive\'s decisions_since, still drops the kit', () => {
  const research = buildResearchReport(input([sub('ctrl', 'venture', { kits: 2, kit_candidate: candidate('ctrl', 3) })]))
  const kit = research.proposals[0]
  const last = { run_id: research.run_id, accepted_at: '2026-11-22T10:31:00Z', report: research as unknown as Record<string, unknown> }
  const directive = { directive_id: 'aeo:2026-12-01', chosen_by: 'rule', decisions_since: [] }
  const declined = { proposal_id: kit.proposal_id, decision: 'declined', decided_at: '2026-11-23T09:00:00Z', payload_sha256: kit.payload_sha256 }
  const r = buildDirectiveReport({ ...dayBase(new Date('2026-12-01T05:12:00Z')), directive, last, decisions: [declined] })
  assertValid(r)
  assert.deepEqual(r.proposals, [])
  const without = buildDirectiveReport({ ...dayBase(new Date('2026-12-01T05:12:00Z')), directive, last })
  assert.deepEqual(without.proposals, [kit], 'without the longer read it would have come back')
})

test('stand-in: a full research run reads his decisions and the kit still waiting before it proposes', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const c = new GrowthEngineHttp(s.base, TOKEN)
    // The scheduled full run's kit, still waiting (it expires at the next scheduled run, 6 December).
    const earlier = buildResearchReport(input([sub('heartside', 'venture', { kits: 4, kit_candidate: candidate('heartside', 4.8, 1) })], { decisions: [] }))
    s.reports.set('aeo:2026-11-22:research', { payload_sha256: earlier.payload_sha256, mode: 'synthetic', accepted_at: '2026-11-22T10:31:00Z', report: earlier as unknown as Record<string, unknown> })
    // A full run Krish starts by hand three days later.
    const at = new Date('2026-11-25T12:00:00Z')
    const ids = { attemptId: 'aeo:2026-11-25:research:9.1', runId: 'aeo:2026-11-25:research', startedAt: '2026-11-25T11:00:00Z' }
    const { runId: _r, ...rest } = input([sub('ctrl', 'venture', { kits: 3, kit_candidate: candidate('ctrl', 9, 7) })], { observedAt: at })
    const first = await captureStderr(() => finishResearch(c, ids, rest, () => at))
    assert.equal(first.result.status, 'succeeded')
    assert.deepEqual(first.result.report?.proposals.map(p => p.proposal_id), ['aeo:kit:heartside:aaaaaaa1'], 'the waiting kit keeps its slot')
    assert.match(first.text, /"event":"protocol_kit_inputs","decisions":0,"kit_decisions":0,"kit_waiting":true/)

    // He declines it: the next full run proposes the next kit.
    s.decisions = [{ proposal_id: 'aeo:kit:heartside:aaaaaaa1', decision: 'declined', decided_at: '2026-11-26T09:00:00Z', payload_sha256: earlier.proposals[0].payload_sha256 }]
    const at2 = new Date('2026-11-27T12:00:00Z')
    const ids2 = { attemptId: 'aeo:2026-11-27:research:10.1', runId: 'aeo:2026-11-27:research', startedAt: '2026-11-27T11:00:00Z' }
    const next = await captureStderr(() => finishResearch(c, ids2, { ...rest, observedAt: at2 }, () => at2))
    assert.equal(next.result.status, 'succeeded')
    assert.deepEqual(next.result.report?.proposals.map(p => p.proposal_id), ['aeo:kit:ctrl:aaaaaaa7'])
    assert.ok(!next.text.includes(QUESTION))
  } finally {
    await s.close()
  }
})
