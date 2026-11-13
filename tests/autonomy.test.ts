/**
 * The autonomy loop for win kits (GET-GOING Step 1), against the protocol's
 * own schema and the local stand-in: a kit is a plan; Krish's yes puts it in
 * flight and AEO checks in on it after each research run and weekly; his No
 * on a check-in stops it for good; his change redirects it; a won question
 * closes it with kit_won. AEO never proposes a go-live for a kit. Synthetic
 * data only.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { canonicalJson, sha256Hex } from '../src/lib/canonical.js'
import { finishResearch, runDirective } from '../src/protocol/loop.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import { buildDirectiveReport, buildResearchReport, CHECKINS_MAX, gapClassIn, questionIn, weeklyCheckIn, type DecisionLite, type ResearchInput } from '../src/protocol/reports.js'
import { readRepoState } from '../src/protocol/state.js'
import { kitPlans, type KitCandidate } from '../src/schema/kit.js'
import { emptyStates, type SubjectPanel, type TrackedQuestion } from '../src/schema/panel.js'
import { validateReport, type EngineReport } from '../src/schema/report.js'
import { ROOT } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-12-06T10:30:00Z')
const RUN = 'aeo:2026-12-06:research'
const PAGE = 'https://github.com/synthetic/aeo/actions/runs/1'
const QUESTION = 'Which synthetic question would a buyer type?'

const q8 = (n: number) => String(n).padStart(8, 'a')
const qidOf = (n: number) => `${q8(n)}-0000-4000-8000-000000000000`
const plan = (product: string, n: number) => `aeo:kit:${product}:${q8(n)}`
const checkIn = (product: string, n: number) => `aeo:checkin:${product}:${q8(n)}`
const decision = (proposal_id: string, decision: string, decided_at: string, over: Partial<DecisionLite> = {}): DecisionLite => ({ proposal_id, decision, decided_at, payload_sha256: '1'.repeat(64), ...over })

const tracked = (n: number, over: Partial<TrackedQuestion> = {}): TrackedQuestion => ({
  query_id: qidOf(n), question: QUESTION, tiers: ['kit'], gap_class: 'retrieved_not_cited',
  panel: { state: 'contested', first_seen: '2026-11-16', last_asked: '2026-11-30', won_at: null, lost_at: null, streak: 2 },
  engines: [{ engine: 'chatgpt', n: 3, first: 1, cited: 3 }, { engine: 'claude', n: 3, first: 0, cited: 1 }],
  shipped_url: null, ...over,
})
const panelOf = (over: Partial<SubjectPanel> = {}): SubjectPanel => ({ states: { ...emptyStates(), absent: 20, contested: 1 }, sampled: 1, sample_answers: 4, won_now: [], lost_now: [], tracked: [], history: true, ...over })

const sub = (slug: string, kind: SubjectSummary['kind'], over: Partial<SubjectSummary> = {}): SubjectSummary => ({
  slug, kind, product_slug: kind === 'venture' ? slug : null, ok: true, questions: 25, probed_questions: 25, cited_first: 1, probes: 75, probes_failed: 0, probes_skipped_cap: 0, ...over,
})
const summary = (subjects: SubjectSummary[]): RunSummary => ({ v: 1, subject_arg: 'x', week_start: '2026-11-30', generated_at: NOW.toISOString(), engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 3, max_probe_usd: 0.07, error_code: null, subjects })
function input(subjects: SubjectSummary[], over: Partial<ResearchInput> = {}): ResearchInput {
  return { runId: RUN, mode: 'synthetic', observedAt: NOW, revision: 'abc', capturedAt: new Date('2026-12-06T04:00:00Z'), scope: 'all', expected: subjects.map(s => s.slug), summaries: subjects.map(s => summary([s])), totalCapUsd: 25, planError: null, decisions: [], runPage: PAGE, ...over }
}
const candidate = (product: string, n: number, gap: KitCandidate['gap_class'] = 'no_page'): KitCandidate => ({
  product_slug: product, query_id: qidOf(n), priority: 3, title: QUESTION, gap_class: gap, target_kind: 'new_page', reference: `${product}.example`,
  exact_payload: `Win kit kit:${product}:${q8(n)} (v1)\nProduct: ${product}\nQuestion: ${QUESTION}\nWhy it is not won: no page of ours answers it (${gap})\nPriority: 3`,
})

function assertValid(r: EngineReport): void {
  assert.deepEqual(schemaErrors(SCHEMA, r), [], 'the report schema')
  assert.deepEqual(validateReport(r), { ok: true })
}

/** A research report two weeks back that proposed kit n for a product: what a check-in reads the approval class from. */
function earlierWithKit(product: string, n: number): Record<string, unknown> {
  const r = buildResearchReport(input([sub(product, 'venture', { kits: 1, kit_candidate: candidate(product, n) })], { observedAt: new Date('2026-11-22T10:30:00Z'), runId: 'aeo:2026-11-22:research' }))
  return r as unknown as Record<string, unknown>
}

// ---------- the research report: check-ins ----------

test('check-ins only for the plans Krish approved in the last six weeks, at most three, oldest plan first', () => {
  const decisions = [
    decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z'),
    decision(plan('heartside', 2), 'approved', '2026-11-23T09:00:00Z'),
    decision(plan('pulse', 3), 'approved', '2026-11-22T09:00:00Z'),
    decision(plan('circle', 4), 'approved', '2026-11-25T09:00:00Z'),
    decision(plan('mindmake', 5), 'approved', '2026-11-26T09:00:00Z'),
    decision(plan('publication', 6), 'declined', '2026-11-23T09:00:00Z'),
    decision(plan('ctrl', 9), 'approved', '2026-10-01T09:00:00Z'),
  ]
  const subjects = [sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) }), sub('heartside', 'venture', { panel: panelOf() })]
  const r = buildResearchReport(input(subjects, { decisions, lastReport: earlierWithKit('ctrl', 1) }))
  assertValid(r)
  assert.equal(r.schema_version, '1.1.0')
  const checks = r.proposals.filter(p => p.stage === 'check_in')
  assert.equal(CHECKINS_MAX, 3)
  assert.deepEqual(checks.map(p => p.proposal_id), [checkIn('pulse', 3), checkIn('heartside', 2), checkIn('ctrl', 1)], 'the three oldest approvals; a decline and a lapsed approval get none')
  for (const p of checks) {
    assert.equal(p.parent_proposal_id, p.proposal_id.replace('aeo:checkin:', 'aeo:kit:'))
    assert.equal(p.wall, 'strategy')
    assert.equal(p.kind, 'advice')
    assert.deepEqual(p.close_condition, { event: 'check_in_answered', reference: p.parent_proposal_id })
    assert.equal(p.expires_at, '2026-12-20T04:00:00.000Z', 'the next scheduled research run')
    assert.deepEqual(p.evidence, [{ label: 'The research run', url: PAGE }])
  }
  assert.ok(r.activity.some(a => a.line === '2 more open kit plans wait for a later check-in (at most 3 a report).'))
  assert.ok(!r.proposals.some(p => p.stage === 'go_live'), 'AEO never proposes a go-live for a kit')

  const ctrl = checks.find(p => p.proposal_id === checkIn('ctrl', 1))!
  const text = ctrl.exact_payload ?? ''
  assert.match(text, /^Check-in on the win kit plan aeo:kit:ctrl:aaaaaaa1\nProduct: ctrl\nQuestion: Which synthetic question would a buyer type\?\nApproved: Tuesday 24 November 2026\n/)
  assert.match(text, /- Gap class at approval: no_page\n- Gap class now: retrieved_not_cited \(retrieved, not cited\)\n- Panel state now: contested, 2 runs in this state\n/)
  assert.match(text, /- Assistants that answered: 2 \(chatgpt \(first on 1 of 3 samples, cited on 3\); claude \(first on 0 of 3 samples, cited on 1\)\)\n/)
  assert.match(text, /- Assistants citing us: 2; citing us first: 1; first on 2 of 3 samples: 0\n- A shipped URL declared: no\n\nAgainst the plan: closer to a first citation than at approval\.\nPlan: the kit as proposed \(aeo:kit:ctrl:aaaaaaa1\)\./)
  assert.equal(gapClassIn(text), 'no_page', 'carried forward for the next check-in')
  assert.equal(questionIn(text), QUESTION)
  const pulse = checks.find(p => p.proposal_id === checkIn('pulse', 3))!
  assert.match(pulse.exact_payload ?? '', /Not measured by the research run on Sunday 6 December 2026 \(aeo:2026-12-06:research\): no research job for pulse reported this run\./)
  assert.match(pulse.exact_payload ?? '', /Against the plan: not measured this run\./)
  const heart = checks.find(p => p.proposal_id === checkIn('heartside', 2))!
  assert.match(heart.exact_payload ?? '', /this run's research did not track its question/)
  // Only his list sees the question; the rest of the report never names it.
  const rest = JSON.stringify({ ...r, proposals: [] })
  assert.ok(!rest.includes(QUESTION))
})

test('a No on a check-in stops its plan for good: no more check-ins, in the research report or the daily one', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const subjects = [sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })]
  const first = buildResearchReport(input(subjects, { decisions: [approved] }))
  const asked = first.proposals.find(p => p.stage === 'check_in')!
  assert.ok(asked)
  // He says no on that version.
  const no = decision(checkIn('ctrl', 1), 'declined', '2026-12-07T09:00:00Z', { payload_sha256: asked.payload_sha256 })
  const plans = kitPlans([approved, no], new Date('2026-12-08T00:00:00Z'))
  assert.deepEqual(plans.open, [])
  assert.deepEqual(plans.stopped.map(p => p.plan_id), [plan('ctrl', 1)])
  // The daily report drops it at once.
  const last = { run_id: RUN, accepted_at: NOW.toISOString(), report: first as unknown as Record<string, unknown> }
  const daily = buildDirectiveReport({ runId: 'aeo:2026-12-08:directive', mode: 'synthetic', observedAt: new Date('2026-12-08T05:12:00Z'), revision: 'abc', capturedAt: new Date('2026-12-08T05:12:00Z'), directive: { directive_id: 'aeo:2026-12-08', chosen_by: 'rule', decisions_since: [no] }, directiveError: null, last, lastError: null, decisions: [approved, no] })
  assertValid(daily)
  assert.deepEqual(daily.proposals.filter(p => p.stage === 'check_in'), [])
  // His decisions could not be read: the check-in is carried, unless the directive's own seven days show his No.
  const unread = (since: DecisionLite[]) => buildDirectiveReport({ runId: 'aeo:2026-12-08:directive', mode: 'synthetic', observedAt: new Date('2026-12-08T05:12:00Z'), revision: 'abc', capturedAt: new Date('2026-12-08T05:12:00Z'), directive: { directive_id: 'aeo:2026-12-08', chosen_by: 'rule', decisions_since: since }, directiveError: null, last, lastError: null, decisions: null })
  assert.deepEqual(unread([]).proposals.filter(p => p.stage === 'check_in').map(p => p.proposal_id), [checkIn('ctrl', 1)], 'an unread decision list never drops a check-in')
  assert.deepEqual(unread([no]).proposals.filter(p => p.stage === 'check_in'), [])
  // A week later, no weekly one either.
  const week = buildDirectiveReport({ runId: 'aeo:2026-12-14:directive', mode: 'synthetic', observedAt: new Date('2026-12-14T05:12:00Z'), revision: 'abc', capturedAt: new Date('2026-12-14T05:12:00Z'), directive: { directive_id: 'aeo:2026-12-14', chosen_by: 'rule', decisions_since: [no] }, directiveError: null, last, lastError: null, decisions: [approved, no] })
  assert.deepEqual(week.proposals.filter(p => p.stage === 'check_in'), [])
  // The next research run, even with the question still contested: none, and a line says why.
  const next = buildResearchReport(input(subjects, { observedAt: new Date('2026-12-20T10:30:00Z'), runId: 'aeo:2026-12-20:research', decisions: [approved, no] }))
  assertValid(next)
  assert.deepEqual(next.proposals.filter(p => p.stage === 'check_in'), [])
  assert.ok(next.activity.some(a => a.line === '1 kit plan Krish stopped with a No on a check-in gets no more check-ins.'))
  // Even a later yes on an older version cannot restart it: his No stands for good.
  const later = kitPlans([approved, no, decision(checkIn('ctrl', 1), 'approved', '2026-12-09T09:00:00Z')], new Date('2026-12-10T00:00:00Z'))
  assert.deepEqual(later.open, [])
})

test('his change redirects the plan: his version, when its digest checks out, is the plan; one that does not is held and never used', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const words = 'Make the pricing page answer this first, then the guide.'
  const sha = sha256Hex(canonicalJson({ amount_usd: null, exact_payload: words }))
  const subjects = [sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })]
  const redirected = buildResearchReport(input(subjects, { decisions: [approved, decision(checkIn('ctrl', 1), 'approved', '2026-12-01T09:00:00Z', { amended: true, exact_payload: words, amount_usd: null, amended_sha256: sha })] }))
  assertValid(redirected)
  const text = redirected.proposals.find(p => p.stage === 'check_in')?.exact_payload ?? ''
  assert.match(text, /Approved: Tuesday 24 November 2026; redirected by Krish on Tuesday 1 December 2026/)
  assert.match(text, /Plan: Krish's redirect of Tuesday 1 December 2026, quoted below\./)
  assert.ok(text.endsWith(`His redirect, as he wrote it:\n${words}`))
  // His amendment of the plan itself counts the same way.
  const onPlan = kitPlans([decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z', { amended: true, exact_payload: words, amended_sha256: sha })], NOW)
  assert.equal(onPlan.open[0].redirect?.text, words)
  // A digest that does not check out: held, said so, and the plan stands as proposed.
  const forged = buildResearchReport(input(subjects, { decisions: [approved, decision(checkIn('ctrl', 1), 'approved', '2026-12-01T09:00:00Z', { amended: true, exact_payload: words, amended_sha256: '0'.repeat(64) })] }))
  assertValid(forged)
  const plain = forged.proposals.find(p => p.stage === 'check_in')?.exact_payload ?? ''
  assert.ok(!plain.includes(words))
  assert.match(plain, /Plan: the kit as proposed/)
  assert.ok(forged.holds.some(h => h.reason === 'amendment_unverified' && /aeo:kit:ctrl:aaaaaaa1/.test(h.detail ?? '')))
})

// ---------- events ----------

test('a won kit plan closes with kit_won, which its close condition names, and is not checked in on', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const won = tracked(1, { gap_class: 'won', panel: { state: 'won', first_seen: '2026-11-16', last_asked: '2026-11-30', won_at: '2026-11-30', lost_at: null, streak: 1 }, engines: [{ engine: 'chatgpt', n: 3, first: 2, cited: 3 }] })
  const r = buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: candidate('ctrl', 7), panel: panelOf({ tracked: [won] }) })], { decisions: [approved] }))
  assertValid(r)
  assert.deepEqual(r.events.filter(e => e.event === 'kit_won'), [{ event: 'kit_won', proposal_id: plan('ctrl', 1), at: NOW.toISOString(), evidence_url: PAGE }])
  assert.ok(!r.proposals.some(p => p.proposal_id === checkIn('ctrl', 1)))
  assert.ok(r.activity.some(a => a.line === `1 kit plan won this run and closed with kit_won (run ${RUN}): ctrl, cited first by chatgpt on 2 of 3 samples.`))
  assert.ok(r.activity.some(a => a.line === 'Kit plans closed by kit_won, checked in on no more: aeo:kit:ctrl:aaaaaaa1 (2026-12-06).'))
  // The plan's own close condition is that event, so it closes the plan he approved.
  assert.equal(r.proposals.find(p => p.stage === 'plan')?.close_condition.event, 'kit_won')
})

test('panel moves become question_won and question_lost events for the subjects that count, with the run\'s evidence in a line', () => {
  const change = (n: number, engines: string[], samples: number, first: number) => ({ query_id: qidOf(n), engines, samples, first })
  const r = buildResearchReport(input([
    sub('ctrl', 'venture', { cited_first_majority: 1, panel: panelOf({ won_now: [change(1, ['chatgpt'], 3, 3)], lost_now: [change(2, [], 6, 1)] }) }),
    sub('secret-prospect-co', 'prospect', { cited_first_majority: 0, panel: panelOf({ won_now: [change(3, ['claude'], 1, 1)] }) }),
    sub('secret-aspiration-co', 'aspiration', { panel: panelOf({ won_now: [change(4, ['claude'], 1, 1)] }) }),
  ]))
  assertValid(r)
  assert.deepEqual(r.events.map(e => [e.event, e.proposal_id, e.evidence_url]), [['question_won', null, PAGE], ['question_lost', null, PAGE], ['question_won', null, PAGE]], 'an aspiration never counts')
  const lines = r.activity.map(a => a.line)
  assert.ok(lines.includes(`Panel moves this run (${RUN}): 2 questions became won (first on 4 of 4 answers, by chatgpt, claude), 1 question lost. By subject: ctrl: 1 won, 1 lost; prospect 1 of 1: 1 won, 0 lost.`))
  assert.ok(lines.includes('Cited first by a majority of the assistants that answered: 1 question; by any assistant: 2 questions (first sample only, so readings stay comparable).'))
  assert.ok(lines.includes('Panel across the counted subjects: 0 won, 2 contested, 0 cited, 0 retrieved, 40 absent, 0 unknown. 2 contested questions were re-asked up to twice more on each assistant that answered (8 more answers); won means first on 2 of 3 samples on one assistant.'))
  assert.ok(!JSON.stringify(r).includes('secret-'))

  // More than the report can carry: forty go as events, the rest are counted in a line.
  const many = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ won_now: Array.from({ length: 45 }, (_, i) => change(i + 10, ['chatgpt'], 1, 1)) }) })]))
  assertValid(many)
  assert.equal(many.events.length, 40)
  assert.ok(many.activity.some(a => a.line === '5 panel events past the report\'s 40 are counted here only.'))
  // No panel history served: a line says the history stays unknown.
  const fresh = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ history: false }) })]))
  assert.ok(fresh.activity.some(a => /does not serve last run's panel back yet/.test(a.line)))
})

// ---------- what the directive serves ----------

test('aeo_kits_delivered: no kit plan from AEO, its check-ins on approved plans go on, and the daily report stops carrying an undecided kit', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const subjects = [sub('ctrl', 'venture', { kits: 3, kit_candidate: candidate('ctrl', 7), panel: panelOf({ tracked: [tracked(1)] }) })]
  const delivered = buildResearchReport(input(subjects, { decisions: [approved], kitsDelivered: true }))
  assertValid(delivered)
  assert.deepEqual(delivered.proposals.map(p => [p.stage, p.proposal_id]), [['check_in', checkIn('ctrl', 1)]])
  assert.ok(delivered.activity.some(a => /venture engines carry the win kits now/.test(a.line)))
  const before = buildResearchReport(input(subjects, { decisions: [approved] }))
  assert.deepEqual(before.proposals.map(p => p.stage), ['plan', 'check_in'])
  const last = { run_id: RUN, accepted_at: NOW.toISOString(), report: before as unknown as Record<string, unknown> }
  const day = new Date('2026-12-07T05:12:00Z')
  const base = { runId: 'aeo:2026-12-07:directive', mode: 'synthetic' as const, observedAt: day, revision: 'abc', capturedAt: day, directive: { directive_id: 'aeo:2026-12-07', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions: [approved] }
  assert.deepEqual(buildDirectiveReport(base).proposals.map(p => p.stage), ['plan', 'check_in'])
  const daily = buildDirectiveReport({ ...base, kitsDelivered: true })
  assertValid(daily)
  assert.deepEqual(daily.proposals.map(p => p.stage), ['check_in'])
})

test('schema_version is the lowest that carries the fields a report uses', () => {
  assert.equal(buildResearchReport(input([sub('ctrl', 'venture')])).schema_version, '1.0.0', 'nothing staged')
  assert.equal(buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: candidate('ctrl', 1) })])).schema_version, '1.1.0', 'a plan')
  const state = { repo: readRepoState(ROOT), instruction: null, seen: false, evidenceUrl: null }
  assert.equal(buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: candidate('ctrl', 1) })], { state })).schema_version, '1.20.0', 'the engine\'s state')
  const served = buildResearchReport(input([sub('ctrl', 'venture', { served: ['0f8fad5b-d9cb-469f-a165-70867728950e'], kits: 1, kit_candidate: candidate('ctrl', 1) })], { answers: true }))
  assert.equal(served.schema_version, '1.22.0')
  for (const r of [served]) assertValid(r)
  const research = buildResearchReport(input([sub('ctrl', 'venture', { kits: 1, kit_candidate: candidate('ctrl', 1) })]))
  const last = { run_id: RUN, accepted_at: NOW.toISOString(), report: research as unknown as Record<string, unknown> }
  const day = new Date('2026-12-07T05:12:00Z')
  const daily = buildDirectiveReport({ runId: 'aeo:2026-12-07:directive', mode: 'synthetic', observedAt: day, revision: 'abc', capturedAt: day, directive: { directive_id: 'aeo:2026-12-07', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null })
  assert.equal(daily.schema_version, '1.1.0', 'carrying the plan')
  const quiet = buildDirectiveReport({ runId: 'aeo:2026-12-07:directive', mode: 'synthetic', observedAt: day, revision: 'abc', capturedAt: day, directive: null, directiveError: 'directive_unavailable', last: null, lastError: null })
  assert.equal(quiet.schema_version, '1.0.0')
})

// ---------- the weekly check-in ----------

test('the daily report renews the check-in a week after the research run, keeps it the same all week, and never asks again what he answered', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const late = decision(plan('heartside', 2), 'approved', '2026-12-08T09:00:00Z')
  const research = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })], { decisions: [approved], lastReport: earlierWithKit('ctrl', 1) }))
  const asked = research.proposals.find(p => p.stage === 'check_in')!
  const last = { run_id: RUN, accepted_at: NOW.toISOString(), report: research as unknown as Record<string, unknown> }
  const day = (iso: string, decisions: DecisionLite[] = [approved]) => buildDirectiveReport({ runId: `aeo:${iso.slice(0, 10)}:directive`, mode: 'synthetic', observedAt: new Date(iso), revision: 'abc', capturedAt: new Date(iso), directive: { directive_id: `aeo:${iso.slice(0, 10)}`, chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions })

  const d3 = day('2026-12-09T05:12:00Z')
  assertValid(d3)
  assert.deepEqual(d3.proposals, [asked], 'within the week: the research run\'s check-in, unchanged')

  const d7 = day('2026-12-13T05:12:00Z')
  assertValid(d7)
  const weekly = d7.proposals.find(p => p.proposal_id === checkIn('ctrl', 1))!
  assert.notEqual(weekly.payload_sha256, asked.payload_sha256, 'renewed, so it comes back to him')
  assert.match(weekly.exact_payload ?? '', /^Weekly check-in for the week from Sunday 13 December 2026: nothing is measured between research runs, so the figures are those of the research run on Sunday 6 December 2026 \(aeo:2026-12-06:research\); the next research run is Sunday 20 December 2026\.\n\nCheck-in on the win kit plan aeo:kit:ctrl:aaaaaaa1\n/)
  assert.equal(d7.proposals.filter(p => p.stage === 'check_in').length, 1, 'one check-in per plan, never two')
  assert.ok(d7.activity.some(a => /1 weekly check-in on the kit plans Krish approved is on his list/.test(a.line)))
  assert.deepEqual(day('2026-12-14T05:12:00Z').proposals, d7.proposals, 'the same week, the same words')

  // He answers the weekly one: it is not asked again that week.
  const yes = decision(checkIn('ctrl', 1), 'approved', '2026-12-14T09:00:00Z', { payload_sha256: weekly.payload_sha256 })
  const d9 = day('2026-12-15T05:12:00Z', [approved, yes])
  assertValid(d9)
  assert.deepEqual(d9.proposals.filter(p => p.stage === 'check_in'), [])

  // A plan he approved after the research run gets a weekly check-in with what is known, and no invented figures.
  const both = day('2026-12-13T05:12:00Z', [approved, late])
  assertValid(both)
  const fresh = both.proposals.find(p => p.proposal_id === checkIn('heartside', 2))!
  assert.match(fresh.exact_payload ?? '', /No research run has measured it since he approved it\./)
  assert.match(fresh.exact_payload ?? '', /- Gap class at approval: not known/)
})

// ---------- end to end, through the stand-in ----------

test('stand-in: a research run checks in on his approved plan, the daily run renews it weekly, and his No stops it', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const approved = { proposal_id: plan('ctrl', 1), decision: 'approved', decided_at: '2026-11-24T09:00:00Z', payload_sha256: '1'.repeat(64) }
    s.decisions = [approved]
    const ids = { attemptId: 'aeo:2026-12-06:research:1.1', runId: RUN, startedAt: '2026-12-06T04:00:00Z' }
    const { runId: _r, ...rest } = input([sub('ctrl', 'venture', { kits: 2, kit_candidate: candidate('ctrl', 7), panel: panelOf({ tracked: [tracked(1)] }) })])
    const research = await captureStderr(() => finishResearch(c, ids, rest, () => NOW, { evidenceUrl: PAGE }))
    assert.equal(research.result.status, 'succeeded')
    const stored = s.reports.get(RUN)?.report as unknown as EngineReport
    assertValid(stored)
    assert.deepEqual(stored.proposals.map(p => [p.stage, p.proposal_id]), [['plan', 'aeo:kit:ctrl:aaaaaaa7'], ['check_in', checkIn('ctrl', 1)]])
    assert.ok(!research.text.includes(QUESTION), 'the question never reaches a log line')

    const day8 = new Date('2026-12-14T05:12:00Z')
    const weekly = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-12-14:directive:1.1', now: () => day8, wake: 'w1' }))
    assert.equal(weekly.result.status, 'succeeded')
    const renewed = weekly.result.report?.proposals.find(p => p.proposal_id === checkIn('ctrl', 1))
    assert.match(renewed?.exact_payload ?? '', /^Weekly check-in for the week from Sunday 13 December 2026/)
    assert.ok(s.seen.some(x => x.path.startsWith('/api/growth/engines/aeo/decisions?since=2026-10-15')), 'the daily run reads his decisions back as far as the research run')

    s.decisions = [approved, { proposal_id: checkIn('ctrl', 1), decision: 'declined', decided_at: '2026-12-14T09:00:00Z', payload_sha256: renewed?.payload_sha256 ?? null }]
    const after = await captureStderr(() => runDirective(c, { mode: 'synthetic', revision: 'abc', attemptId: 'aeo:2026-12-15:directive:1.1', now: () => new Date('2026-12-15T05:12:00Z'), wake: 'w2' }))
    assert.equal(after.result.status, 'succeeded')
    assert.deepEqual(after.result.report?.proposals.filter(p => p.stage === 'check_in'), [])
    assert.match(after.text, /"check_ins_declined":1,"acted_on":0/)
  } finally {
    await s.close()
  }
})

// ---------- review, 2026-11-13: closing, redirects, causes, Sundays, the line cap, held plans ----------

const dailyAt = (iso: string, last: { run_id: string; accepted_at: string; report: Record<string, unknown> } | null, decisions: DecisionLite[]) => buildDirectiveReport({
  runId: `aeo:${iso.slice(0, 10)}:directive`, mode: 'synthetic', observedAt: new Date(iso), revision: 'abc', capturedAt: new Date(iso),
  directive: { directive_id: `aeo:${iso.slice(0, 10)}`, chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions,
})
const stored = (r: EngineReport) => ({ run_id: r.run_id, accepted_at: r.observed_at, report: r as unknown as Record<string, unknown> })
const wonTracked = () => tracked(1, { gap_class: 'won', panel: { state: 'won', first_seen: '2026-11-16', last_asked: '2026-11-30', won_at: '2026-11-30', lost_at: null, streak: 1 }, engines: [{ engine: 'chatgpt', n: 3, first: 2, cited: 3 }], sampled: true })

test('a plan kit_won closed gets no more check-ins and no second kit_won: not daily, not in later research runs; approved again, it opens', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const won = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [wonTracked()] }) })], { decisions: [approved] }))
  assertValid(won)
  assert.equal(won.events.filter(e => e.event === 'kit_won').length, 1)
  // The daily report a week later: no weekly check-in on a closed plan.
  const d7 = dailyAt('2026-12-13T05:12:00Z', stored(won), [approved])
  assertValid(d7)
  assert.deepEqual(d7.proposals.filter(p => p.stage === 'check_in'), [])
  // The next research run, the question still won or slipped back: no check-in, no second kit_won, and the closure carried.
  for (const t of [wonTracked(), tracked(1)]) {
    const next = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [t] }) })], { observedAt: new Date('2026-12-20T10:30:00Z'), runId: 'aeo:2026-12-20:research', decisions: [approved], lastReport: won as unknown as Record<string, unknown> }))
    assertValid(next)
    assert.deepEqual(next.events.filter(e => e.event === 'kit_won'), [])
    assert.deepEqual(next.proposals.filter(p => p.stage === 'check_in'), [])
    assert.ok(next.activity.some(a => a.line === 'Kit plans closed by kit_won, checked in on no more: aeo:kit:ctrl:aaaaaaa1 (2026-12-06).'))
    // Two reports on, it still reads as closed: the daily report after it renews nothing.
    assert.deepEqual(dailyAt('2026-12-27T05:12:00Z', stored(next), [approved]).proposals.filter(p => p.stage === 'check_in'), [])
  }
  // Approved again after it closed: open, and checked in on.
  const again = decision(plan('ctrl', 1), 'approved', '2026-12-08T09:00:00Z')
  const reopened = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })], { observedAt: new Date('2026-12-20T10:30:00Z'), runId: 'aeo:2026-12-20:research', decisions: [approved, again], lastReport: won as unknown as Record<string, unknown> }))
  assert.deepEqual(reopened.proposals.filter(p => p.stage === 'check_in').map(p => p.proposal_id), [checkIn('ctrl', 1)])
})

test('his redirect stays the plan after a later plain yes on the next check-in; only a newer amendment that checks out replaces it', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const sha = (w: string) => sha256Hex(canonicalJson({ amount_usd: null, exact_payload: w }))
  const first = 'Make the pricing page answer this first, then the guide.'
  const amended = decision(checkIn('ctrl', 1), 'approved', '2026-12-07T09:00:00Z', { amended: true, exact_payload: first, amount_usd: null, amended_sha256: sha(first) })
  const plainYes = decision(checkIn('ctrl', 1), 'approved', '2026-12-21T09:00:00Z', { payload_sha256: '2'.repeat(64) })
  const at = new Date('2026-12-22T00:00:00Z')
  assert.equal(kitPlans([approved, amended, plainYes], at).open[0].redirect?.text, first)
  const subjects = [sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })]
  const r = buildResearchReport(input(subjects, { observedAt: new Date('2026-12-20T10:30:00Z'), decisions: [approved, amended, plainYes] }))
  assert.match(r.proposals.find(p => p.stage === 'check_in')?.exact_payload ?? '', /His redirect, as he wrote it:\nMake the pricing page answer this first, then the guide\.$/)
  // A newer amendment replaces it; a newer one that does not check out is held and the earlier one stands.
  const second = 'Answer it on the guide instead.'
  assert.equal(kitPlans([approved, amended, plainYes, decision(checkIn('ctrl', 1), 'approved', '2026-12-22T09:00:00Z', { amended: true, exact_payload: second, amount_usd: null, amended_sha256: sha(second) })], at).open[0].redirect?.text, second)
  const forged = kitPlans([approved, amended, plainYes, decision(checkIn('ctrl', 1), 'approved', '2026-12-22T09:00:00Z', { amended: true, exact_payload: second, amount_usd: null, amended_sha256: '0'.repeat(64) })], at).open[0]
  assert.equal(forged.redirect?.text, first)
  assert.equal(forged.unverified, true)
})

test('a plan approved only in an amended version that does not check out is held: no check-in, no kit in flight, and a hold says so', () => {
  const forged = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z', { amended: true, exact_payload: 'His words.', amended_sha256: '0'.repeat(64) })
  const plans = kitPlans([forged], NOW)
  assert.deepEqual(plans.open, [])
  assert.deepEqual(plans.held.map(p => p.plan_id), [plan('ctrl', 1)])
  const r = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })], { decisions: [forged] }))
  assertValid(r)
  assert.deepEqual(r.proposals.filter(p => p.stage === 'check_in'), [])
  assert.ok(r.holds.some(h => h.reason === 'amendment_unverified' && h.detail === 'His approval of aeo:kit:ctrl:aaaaaaa1 came in an amended version whose digest does not check out, so the plan is held: no check-ins and no kit in flight until a decision on it that checks out.'))
  assert.deepEqual(dailyAt('2026-12-13T05:12:00Z', stored(r), [forged]).proposals.filter(p => p.stage === 'check_in'), [])
})

test('the weekly check-in says why the research run carried none on its plan: approved since, or held back under the limit of three', () => {
  const approvals = [1, 2, 3, 4].map(n => decision(plan('ctrl', n), 'approved', `2026-11-2${n}T09:00:00Z`))
  const later = decision(plan('ctrl', 5), 'approved', '2026-12-08T09:00:00Z')
  const subjects = [sub('ctrl', 'venture', { panel: panelOf({ tracked: [1, 2, 3, 4].map(n => tracked(n)) }) })]
  const research = buildResearchReport(input(subjects, { decisions: approvals }))
  assert.deepEqual(research.proposals.filter(p => p.stage === 'check_in').map(p => p.proposal_id), [1, 2, 3].map(n => checkIn('ctrl', n)))
  const at = new Date('2026-12-14T05:12:00Z')
  const next = new Date('2026-12-20T04:00:00Z')
  const plans = kitPlans([...approvals, later], at).open
  const run = { run_id: RUN, observed_at: NOW, report: research as unknown as Record<string, unknown> }
  const capped = weeklyCheckIn(plans.find(p => p.plan_id === plan('ctrl', 4))!, run, at, next).payload
  assert.match(capped, /The research run on Sunday 6 December 2026 held its check-in back: a report carries at most 3, oldest plan first\. The next research run reports it\./)
  assert.ok(!capped.includes('No research run has measured it'))
  assert.match(weeklyCheckIn(plans.find(p => p.plan_id === plan('ctrl', 5))!, run, at, next).payload, /No research run has measured it since he approved it\./)
  // A run that carried fewer than three, and none on this plan: said plainly, with no cause guessed.
  const few = buildResearchReport(input(subjects, { decisions: [approvals[0]] }))
  const other = weeklyCheckIn(plans.find(p => p.plan_id === plan('ctrl', 2))!, { ...run, report: few as unknown as Record<string, unknown> }, at, next).payload
  assert.match(other, /The research run on Sunday 6 December 2026 carried no check-in on it, so its figures are not in the report this run reads; the next research run reports them\./)
  // The daily report renews three, oldest plan first.
  assert.deepEqual(dailyAt('2026-12-14T05:12:00Z', stored(research), [...approvals, later]).proposals.filter(p => p.stage === 'check_in').map(p => p.proposal_id), [1, 2, 3].map(n => checkIn('ctrl', n)))
})

test('on a research Sunday before that run reports, the daily report renews no check-in: the research run checks in itself', () => {
  const approved = decision(plan('ctrl', 1), 'approved', '2026-11-24T09:00:00Z')
  const research = buildResearchReport(input([sub('ctrl', 'venture', { panel: panelOf({ tracked: [tracked(1)] }) })], { decisions: [approved] }))
  const saturday = dailyAt('2026-12-19T05:12:00Z', stored(research), [approved])
  assert.equal(saturday.proposals.filter(p => p.stage === 'check_in').length, 1, 'the day before: renewed')
  const sunday = dailyAt('2026-12-20T05:12:00Z', stored(research), [approved])
  assertValid(sunday)
  assert.ok(sunday.activity.some(a => /has not reported yet/.test(a.line)))
  assert.deepEqual(sunday.proposals.filter(p => p.stage === 'check_in'), [])
})

test('a full fleet with panel moves: one line for them all, and the 40-line cap never cuts the events count or the gap classes', () => {
  const change = (n: number) => ({ query_id: qidOf(n), engines: ['chatgpt'], samples: 3, first: 2 })
  const moves = (k: number) => panelOf({ won_now: Array.from({ length: 3 }, (_, i) => change(k * 10 + i)), lost_now: [change(k * 10 + 5)] })
  const gaps = { won: 1, cited_not_first: 2, retrieved_not_cited: 3, not_retrieved: 4, no_page: 15, unknown: 0 }
  const subjects = [
    ...['circle', 'ctrl', 'full-time', 'heartside', 'legibility', 'mindmake', 'publication', 'pulse'].map((v, k) => sub(v, 'venture', { panel: moves(k), gap_classes: gaps, kits: 0 })),
    ...Array.from({ length: 6 }, (_, k) => sub(`p${k}`, 'prospect', { panel: moves(10 + k) })),
    ...Array.from({ length: 3 }, (_, k) => sub(`a${k}`, 'aspiration')),
  ]
  const r = buildResearchReport(input(subjects))
  assertValid(r)
  const lines = r.activity.map(a => a.line)
  assert.ok(lines.length <= 40)
  assert.equal(r.events.length, 40)
  assert.ok(lines.includes('16 panel events past the report\'s 40 are counted here only.'))
  const moved = lines.find(l => l.startsWith(`Panel moves this run (${RUN}): 42 questions became won (first on 84 of 126 answers, by chatgpt), 14 questions lost. By subject: circle: 3 won, 1 lost;`))
  assert.ok(moved && moved.length <= 500)
  assert.equal(lines.filter(l => l.startsWith('Panel for ')).length, 0, 'no line per subject')
  assert.ok(lines.some(l => l.startsWith('Why pulse\'s questions are not won:')), 'the last venture\'s gap classes survive the cap')
})
