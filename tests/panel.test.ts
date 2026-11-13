import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPS } from '../src/config/run.js'
import { Ledger } from '../src/lib/cost.js'
import { brandNamesOf, nameMentioned } from '../src/lib/names.js'
import type { ProbeDetail } from '../src/lib/probeDetail.js'
import { normaliseQuery } from '../src/lib/text.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import { probeQueries } from '../src/pipeline/40-probe.js'
import { resample } from '../src/pipeline/41-samples.js'
import { advancePanel, citedLastRun, panelFor, panelQuestions, readPanel, sampleSet, selectPanel, shippedOf, stepPanel } from '../src/pipeline/55-panel.js'
import { countCitedFirst, countMajorityFirst } from '../src/protocol/measure.js'
import type { PriorQuery, PriorWeek } from '../src/schema/context.js'
import type { AeoPacket, Engine } from '../src/schema/packet.js'
import { engineWon, heldWin, stateOf, type Panel } from '../src/schema/panel.js'
import { featuredRun } from './golden.js'
import { StubEngine } from './helpers.js'

const W = '2026-11-16'
const P = '2026-11-02'
const qid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const pq = (n: number, query: string, over: Partial<ProposedQuery> = {}): ProposedQuery => ({ query_id: qid(n), query, source: 'seed', touchpoint_id: null, prior: null, norm: normaliseQuery(query), requested: false, ...over })
const prior = (n: number, query: string, panel?: Panel | null): PriorQuery => ({ query_id: qid(n), query, demand_score: 10, status: 'watch', trend: 'flat', ...(panel !== undefined ? { panel } : {}) })
const panel = (state: Panel['state'], over: Partial<Panel> = {}): Panel => ({ state, first_seen: '2026-10-05', last_asked: P, won_at: null, lost_at: null, streak: 1, ...over })
const detail = (n: number, engine: Engine, over: Partial<ProbeDetail> = {}): ProbeDetail => ({ query_id: qid(n), engine, first_host_ours: false, our_position: null, cited_any: false, searched: true, zero_citation: false, retrieved_ours: false, ...over })

// ---------- the win rule, against noise ----------

test('the state: one first citation in three samples is not a win, two are; one sample alone decides when not sampled', () => {
  const rows: Array<[string, Parameters<typeof stateOf>[0], string]> = [
    ['nobody answered', [], 'unknown'],
    ['one sample, first', [{ n: 1, first: 1, cited: 1 }], 'won'],
    ['three samples, first once: noise', [{ n: 3, first: 1, cited: 3 }], 'contested'],
    ['three samples, first twice', [{ n: 3, first: 2, cited: 3 }], 'won'],
    ['first once on each of two engines is still not a win', [{ n: 3, first: 1, cited: 1 }, { n: 3, first: 1, cited: 2 }], 'contested'],
    ['a re-ask failed: two answers, first once', [{ n: 2, first: 1, cited: 2 }], 'contested'],
    ['a re-ask failed: two answers, first twice', [{ n: 2, first: 2, cited: 2 }], 'won'],
    ['cited, never first', [{ n: 3, first: 0, cited: 3 }], 'cited'],
    ['retrieved, not cited', [{ n: 1, first: 0, cited: 0, retrieved: true }], 'retrieved'],
    ['answered, nothing of ours', [{ n: 1, first: 0, cited: 0 }, { n: 3, first: 0, cited: 0 }], 'absent'],
  ]
  for (const [why, engines, want] of rows) assert.equal(stateOf(engines), want, why)
  assert.equal(engineWon({ n: 3, first: 1, cited: 1 }), false)
  assert.equal(engineWon({ n: 3, first: 2, cited: 2 }), true)
  // A question picked for repeat samples: an engine left on one answer (its re-asks capped or failed) cannot win it alone.
  assert.equal(engineWon({ n: 1, first: 1, cited: 1 }, true), false)
  assert.equal(stateOf([{ n: 1, first: 1, cited: 1 }, { n: 3, first: 0, cited: 3 }], true), 'contested', 'first once, on the engine the cap stopped: not a win')
  assert.equal(stateOf([{ n: 1, first: 1, cited: 1 }, { n: 3, first: 2, cited: 3 }], true), 'won', 'two of three on the engine that was re-asked')
  assert.equal(stateOf([{ n: 1, first: 1, cited: 1 }]), 'won', 'not picked for samples: its one sample decides')
})

// ---------- the panel's history ----------

test('advancePanel: transitions, streaks and the week each question was won, as a table', () => {
  const rows: Array<[string, Panel | null, { state: Panel['state']; isNew?: boolean }, Partial<Panel>]> = [
    ['no panel served, carried question: history unknown, never guessed', null, { state: 'won' }, { first_seen: null, won_at: null, lost_at: null, streak: null }],
    ['no panel served, query id new this run, won: no win week, since it may have been won before it was asked', null, { state: 'won', isNew: true }, { first_seen: W, won_at: null, lost_at: null, streak: null }],
    ['no panel served, new, absent', null, { state: 'absent', isNew: true }, { first_seen: W, won_at: null, streak: null }],
    ['absent again: the streak grows', panel('absent', { streak: 2 }), { state: 'absent' }, { first_seen: '2026-10-05', won_at: null, streak: 3 }],
    ['absent to won: won this week', panel('absent', { streak: 4 }), { state: 'won' }, { won_at: W, lost_at: null, streak: 1 }],
    ['won again: won_at keeps the first week', panel('won', { won_at: P, streak: 1 }), { state: 'won' }, { won_at: P, streak: 2 }],
    ['won to contested: lost this week', panel('won', { won_at: P }), { state: 'contested' }, { won_at: P, lost_at: W, streak: 1 }],
    ['won to unknown: not a loss', panel('won', { won_at: P }), { state: 'unknown' }, { won_at: P, lost_at: null, streak: 1 }],
    ['unknown after a win, then won: the same win, not a new one', panel('unknown', { won_at: P }), { state: 'won' }, { won_at: P, lost_at: null }],
    ['unknown after a win, then absent: lost this week', panel('unknown', { won_at: P }), { state: 'absent' }, { won_at: P, lost_at: W }],
    ['lost before, won again: a new win', panel('absent', { won_at: '2026-10-05', lost_at: P }), { state: 'won' }, { won_at: W, lost_at: P }],
    ['won with no win week on record, then contested: lost this week', panel('won', { won_at: null }), { state: 'contested' }, { won_at: null, lost_at: W }],
    ['unknown with no win or loss on record, then won: its win week is not guessed', panel('unknown'), { state: 'won' }, { won_at: null, lost_at: null, streak: 1 }],
    ['unknown with no win or loss on record, then absent: no loss is guessed', panel('unknown'), { state: 'absent' }, { won_at: null, lost_at: null }],
    ['unknown after a loss, then won: a new win', panel('unknown', { won_at: '2026-10-05', lost_at: P }), { state: 'won' }, { won_at: W, lost_at: P }],
    ['unknown twice after a win: still held', panel('unknown', { won_at: P }), { state: 'unknown' }, { won_at: P, lost_at: null, streak: 2 }],
    ['a served streak of null stays null in the same state', panel('cited', { streak: null }), { state: 'cited' }, { streak: null }],
    ['a second run in the same week is not counted twice', panel('absent', { last_asked: W, streak: 2 }), { state: 'absent' }, { streak: 2 }],
    ['a served first_seen of null stays null', panel('absent', { first_seen: null }), { state: 'cited' }, { first_seen: null, streak: 1 }],
  ]
  for (const [why, before, now, want] of rows) {
    const p = advancePanel(before, { state: now.state, week: W, isNew: now.isNew === true })
    assert.equal(p.state, now.state, why)
    assert.equal(p.last_asked, W, why)
    for (const [k, v] of Object.entries(want)) assert.equal(p[k as keyof Panel], v, `${why}: ${k}`)
  }
})

test('a move is a change in whether it holds a win; a same-week rerun repeats none, a flip within the week is one', () => {
  const rows: Array<[string, Panel, Panel['state'], { won: boolean; lost: boolean }, Partial<Panel>]> = [
    ['rerun in the same week, still won', panel('won', { last_asked: W, won_at: W }), 'won', { won: false, lost: false }, { won_at: W, streak: 1 }],
    ['rerun in the same week, still lost', panel('absent', { last_asked: W, won_at: P, lost_at: W }), 'absent', { won: false, lost: false }, { lost_at: W }],
    ['won earlier this week, absent now: a loss this week too', panel('won', { last_asked: W, won_at: W }), 'absent', { won: false, lost: true }, { won_at: W, lost_at: W, streak: 1 }],
    ['absent last week, won now', panel('absent'), 'won', { won: true, lost: false }, { won_at: W }],
    ['won last week, unknown now: no move', panel('won', { won_at: P }), 'unknown', { won: false, lost: false }, { lost_at: null }],
  ]
  for (const [why, before, state, move, want] of rows) {
    const s = stepPanel(before, { state, week: W, isNew: false })
    assert.deepEqual({ won: s.won, lost: s.lost }, move, why)
    for (const [k, v] of Object.entries(want)) assert.equal(s.panel[k as keyof Panel], v, `${why}: ${k}`)
  }
  assert.deepEqual(stepPanel(null, { state: 'won', week: W, isNew: true }), { panel: { state: 'won', first_seen: W, last_asked: W, won_at: null, lost_at: null, streak: null }, won: false, lost: false }, 'no served panel: never a move')
  // heldWin, the rule behind every move.
  assert.equal(heldWin(panel('won')), true)
  assert.equal(heldWin(panel('cited', { won_at: P })), false, 'a measured non-win holds none')
  assert.equal(heldWin(panel('unknown', { won_at: P })), true)
  assert.equal(heldWin(panel('unknown', { won_at: '2026-10-05', lost_at: P })), false)
  assert.equal(heldWin(panel('unknown')), null)
})

test('a served panel is read loosely: anything misshapen is unknown, never repaired', () => {
  assert.deepEqual(readPanel(panel('won', { won_at: P })), panel('won', { won_at: P }))
  for (const bad of [null, 'won', { ...panel('won'), state: 'winning' }, { ...panel('won'), last_asked: null }, { ...panel('won'), won_at: '2 Nov' }, { ...panel('won'), streak: 0 }, { ...panel('won'), streak: 1.5 }]) assert.equal(readPanel(bad), null, JSON.stringify(bad))
  // The packet's own date rule: a real day, not only its shape, or the whole served panel is unknown.
  for (const bad of [{ ...panel('won'), won_at: '2026-13-45' }, { ...panel('won'), first_seen: '2026-00-10' }, { ...panel('won'), last_asked: '2026-11-32' }]) assert.equal(readPanel(bad), null, JSON.stringify(bad))
})

// ---------- what is probed, in what order ----------

test('selectPanel: requested, shipped, kit in flight, won last run, contested, then the rest in today\'s order', () => {
  const proposed = [
    pq(1, 'An exploratory question about something?', { prior: prior(1, 'x') }),
    pq(2, 'A question that was won last run?', { prior: prior(2, 'x') }),
    pq(3, 'A question cited anywhere last run?'),
    pq(4, 'A question a venture asked for?', { requested: true }),
    pq(5, 'A question a venture shipped a page for?'),
    pq(6, 'A question with a kit plan approved?'),
    pq(7, 'A question contested last run by its panel?'),
    pq(8, 'A shipped question named only by its words?'),
  ]
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(2, 'x', panel('won', { won_at: P })), prior(7, 'x', panel('contested')), prior(1, 'x', panel('absent'))] }
  const sel = selectPanel(proposed, {
    prior: priorWeek,
    probes4w: [{ id: 'p', question: 'A question cited anywhere last run?', engine: 'claude', we_cited: true, competitors_cited: [], run_at: '2026-11-02T09:00:00Z', run_id: null, query_id: null }],
    shipped: [{ query_id: qid(5), url: 'https://ours.example/a', shipped_at: null }, { question: 'A shipped question named only by its words?', url: 'https://ours.example/b', shipped_at: null }],
    kitPrefixes: [qid(6).slice(0, 8)],
  })
  assert.deepEqual(sel.ordered.map(q => sel.tiers.get(q.query_id)), ['requested', 'shipped', 'shipped', 'kit', 'won', 'contested', 'contested', 'exploratory'])
  assert.deepEqual(sel.ordered.map(q => q.query_id), [qid(4), qid(5), qid(8), qid(6), qid(2), qid(3), qid(7), qid(1)])
  assert.equal(sel.limit, CAPS.MAX_PROBED_QUERIES_PER_SUBJECT)
})

test('selectPanel: the protected tiers stretch the limit past the usual one, never past the hard ceiling', () => {
  const many = (n: number, kit: number) => Array.from({ length: n }, (_, i) => pq(100 + i, `Question number ${i} about a thing?`, i < kit ? {} : {}))
  const prefixes = (list: ProposedQuery[], k: number) => list.slice(0, k).map(q => q.query_id.slice(0, 8))
  const a = many(40, 27)
  assert.equal(selectPanel(a, { kitPrefixes: prefixes(a, 27) }).limit, 27, 'every kit in flight, above the usual 25')
  const b = many(40, 35)
  assert.equal(selectPanel(b, { kitPrefixes: prefixes(b, 35) }).limit, CAPS.MAX_PROBED_QUERIES_HARD, 'never past the hard ceiling')
  assert.equal(selectPanel(many(40, 0)).limit, CAPS.MAX_PROBED_QUERIES_PER_SUBJECT)
})

test('cited last run: the newest run in the four-week history, by id or by words; an older run does not count', () => {
  const c = citedLastRun([
    { id: 'a', question: 'Old cited question?', engine: 'claude', we_cited: true, competitors_cited: [], run_at: '2026-10-19T09:00:00Z', run_id: 'r1', query_id: qid(1) },
    { id: 'b', question: 'New cited question?', engine: 'claude', we_cited: true, competitors_cited: [], run_at: '2026-11-02T09:00:00Z', run_id: 'r2', query_id: qid(2) },
    { id: 'c', question: 'New absent question?', engine: 'chatgpt', we_cited: false, competitors_cited: [], run_at: '2026-11-02T09:01:00Z', run_id: 'r2', query_id: qid(3) },
  ])
  assert.deepEqual([...c.ids], [qid(2)])
  assert.deepEqual([...c.norms], [normaliseQuery('New cited question?')])
})

test('panelQuestions: last week\'s kit, shipped and won questions are asked even when the proposal left them out', () => {
  const proposed = [pq(1, 'A question the model proposed?')]
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(2, 'A won question from last week?', panel('won')), prior(3, 'A kit question from last week?'), prior(4, 'A plain question from last week?')] }
  const shipped = shippedOf({ shipped: [{ question: 'A brand new shipped question?', url: 'https://ours.example/new', shipped_at: '2026-11-10T00:00:00Z' }, { url: 'not a url', question: 'Dropped?', shipped_at: null }] as never })
  assert.equal(shipped.length, 1, 'a declaration without a URL is dropped')
  const out = panelQuestions(proposed, { id: 's', prior: priorWeek }, { prior: priorWeek, shipped, kitPrefixes: [qid(3).slice(0, 8)] }, k => `minted:${k}`)
  assert.deepEqual(out.map(q => q.query), ['A question the model proposed?', 'A won question from last week?', 'A kit question from last week?', 'A brand new shipped question?'])
  assert.equal(out[1].query_id, qid(2), 'a carried question keeps its id')
  assert.equal(out[3].query_id, `minted:s|${normaliseQuery('A brand new shipped question?')}`)
})

// ---------- repeat samples ----------

test('resample: contested questions are asked twice more on each engine that answered; counts land on the first answer\'s detail', async () => {
  // chatgpt cites us first on its first and third answers; claude only on its first.
  let gpt = 0
  let cl = 0
  const engines = [
    new StubEngine('chatgpt', () => ({ text: 'x', citations: [++gpt === 2 ? 'https://other.example' : 'https://ours.example/a', 'https://other.example'] })),
    new StubEngine('claude', () => ({ text: 'x', citations: [++cl === 1 ? 'https://ours.example/a' : 'https://other.example'] })),
    new StubEngine('perplexity', () => { throw new Error('down') }),
  ]
  const q = pq(1, 'A contested question?')
  const ledger = new Ledger(10)
  const outcome = await probeQueries(engines, [q], ['ours.example'], ledger)
  const before = ledger.entries.length
  const s = await resample(engines, outcome, [q], ['ours.example'], ledger)
  assert.deepEqual(s, { questions: 1, asks: 4, answers: 4, failed: 0, skipped_cap: 0 }, 'perplexity failed the first pass, so it is not re-asked')
  assert.equal(ledger.entries.length - before, 4, 'each re-ask is charged like a probe')
  const d = outcome.detailsByQuery!.get(q.query_id)!
  assert.deepEqual(d.map(x => [x.engine, x.samples]), [['chatgpt', { n: 3, first: 2, cited: 2 }], ['claude', { n: 3, first: 1, cited: 1 }]])
  assert.deepEqual(d.map(x => x.first_host_ours), [true, true], 'the first sample\'s own fields never change')
  assert.equal(stateOf(d.map(x => ({ ...x.samples! }))), 'won', 'chatgpt is first on 2 of 3')
})

test('resample: the cap stops re-asks and counts them; the Claude Code lane is free', async () => {
  const prices = { perplexity: 0.02, chatgpt: 0.02, claude: 0.02, grok: 0.02, gemini: 0.02, claude_code: 0, classify: 0, themes: 0, propose: 0, digest: 0, voice: 0 }
  const engines = [
    new StubEngine('chatgpt', () => ({ text: 'x', citations: ['https://ours.example/a'] })),
    new StubEngine('claude', () => ({ text: 'x', citations: ['https://ours.example/a'] }), 'claude-code', { costKind: 'claude_code' }),
  ]
  const q = pq(1, 'A question cited first?')
  const ledger = new Ledger(0.05, prices)
  const outcome = await probeQueries(engines, [q], ['ours.example'], ledger)
  assert.equal(ledger.total, 0.02)
  const s = await resample(engines, outcome, [q], ['ours.example'], ledger, 0.01)
  // 0.02 spent and 0.01 held back for the digest: one more chatgpt ask fits, the second does not.
  assert.equal(s.skipped_cap, 1)
  assert.equal(ledger.total, 0.04)
  const d = outcome.detailsByQuery!.get(q.query_id)!
  assert.deepEqual(d.map(x => x.samples?.n), [2, 3], 'the free lane took both re-asks')
})

test('sampleSet: shipped, kit and won tiers first, then cited anywhere this run, only answered questions, at most eight', () => {
  const proposed = Array.from({ length: 12 }, (_, i) => pq(i + 1, `Question ${i + 1} about something?`))
  const sel = selectPanel(proposed, { kitPrefixes: [qid(12).slice(0, 8), qid(11).slice(0, 8)] })
  const details = new Map<string, ProbeDetail[]>(proposed.map((q, i) => [q.query_id, i === 10 ? [] : [detail(i + 1, 'chatgpt', { cited_any: i < 9 })]]))
  const picked = sampleSet(sel, details)
  assert.equal(picked.length, CAPS.MAX_SAMPLED_QUESTIONS_PER_SUBJECT)
  assert.equal(CAPS.MAX_SAMPLED_QUESTIONS_PER_SUBJECT, 8)
  assert.equal(picked[0].query_id, qid(12), 'the kit in flight first')
  assert.ok(!picked.some(q => q.query_id === qid(11)), 'a kit question nobody answered is not re-asked')
  assert.ok(!picked.some(q => q.query_id === qid(10)), 'not cited and not tiered: not contested')
})

test('the North Star count stays on the first sample, whatever the re-asks found; the majority count beside it', () => {
  const packet = { engines: ['perplexity', 'chatgpt', 'claude'], subject: { kind: 'venture' }, queries: [1, 2, 3].map(n => ({ query_id: qid(n), probes: [{ engine: 'chatgpt', citations: [] }] })) } as unknown as AeoPacket
  const details = [
    // First on the first sample, then not: counted, and contested on the panel.
    detail(1, 'chatgpt', { first_host_ours: true, cited_any: true, samples: { n: 3, first: 1, cited: 3 } }),
    detail(1, 'claude'),
    // Not first on the first sample, first on both re-asks: not counted, though the panel says won.
    detail(2, 'chatgpt', { cited_any: true, samples: { n: 3, first: 2, cited: 3 } }),
    // First on two of three engines: counted, and a majority.
    detail(3, 'chatgpt', { first_host_ours: true }), detail(3, 'claude', { first_host_ours: true }), detail(3, 'perplexity'),
  ]
  assert.deepEqual(countCitedFirst(packet, ['ours.example'], details), { probed_questions: 3, cited_first: 2 })
  assert.equal(countMajorityFirst(packet, details), 1, 'question 3 only: question 1 is first on one of two')
  assert.equal(countMajorityFirst(packet, []), null)
})

test('panelFor: a change is reported only when the panel moved this week; kits in flight and shipped questions are tracked', () => {
  const proposed = [pq(1, 'Won this week?', { prior: prior(1, 'x') }), pq(2, 'Lost this week?', { prior: prior(2, 'x') }), pq(3, 'Kit question?', { prior: prior(3, 'x') }), pq(4, 'New and won?'), pq(5, 'Not answered?')]
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(1, 'x', panel('cited')), prior(2, 'x', panel('won', { won_at: P })), prior(3, 'x', panel('absent'))] }
  const ctx = { prior: priorWeek, kitPrefixes: [qid(3).slice(0, 8)], shipped: [{ query_id: qid(3), url: 'https://ours.example/k', shipped_at: null }] }
  const sel = selectPanel(proposed, ctx)
  const details = new Map<string, ProbeDetail[]>([
    [qid(1), [detail(1, 'chatgpt', { first_host_ours: true, cited_any: true, samples: { n: 3, first: 3, cited: 3 } })]],
    [qid(2), [detail(2, 'chatgpt', { cited_any: true })]],
    [qid(3), [detail(3, 'claude', { first_host_ours: true, cited_any: true, samples: { n: 3, first: 1, cited: 2 } })]],
    [qid(4), [detail(4, 'claude', { first_host_ours: true, cited_any: true })]],
  ])
  const r = panelFor({ selection: sel, asked: new Set([1, 2, 3, 4, 5].map(qid)), details, prior: priorWeek, week: W, gapClasses: new Map([[qid(3), 'won']]), shipped: ctx.shipped, kitPrefixes: ctx.kitPrefixes, sampled: 2, sampleAnswers: 4 })
  assert.equal(r.panels.get(qid(5))?.state, 'unknown')
  assert.deepEqual(r.summary.states, { won: 2, contested: 1, cited: 1, retrieved: 0, absent: 0, unknown: 1 })
  // A question first asked this run and won at once has no win week: it may have been won before it was asked.
  assert.deepEqual(r.summary.won_now.map(c => [c.query_id, c.engines, c.samples, c.first]), [[qid(1), ['chatgpt'], 3, 3]])
  assert.deepEqual(r.panels.get(qid(4)), { state: 'won', first_seen: W, last_asked: W, won_at: null, lost_at: null, streak: null })
  assert.deepEqual(r.summary.lost_now.map(c => c.query_id), [qid(2)])
  assert.equal(r.summary.history, true)
  assert.equal(r.summary.tracked.length, 1)
  const t = r.summary.tracked[0]
  assert.deepEqual(t.tiers, ['shipped', 'kit'])
  assert.equal(t.panel.state, 'contested', 'first once in three samples is not a win')
  assert.equal(t.gap_class, 'won', 'the diagnosis reads the first sample')
  assert.equal(t.shipped_url, 'https://ours.example/k')
  assert.deepEqual(t.engines, [{ engine: 'claude', n: 3, first: 1, cited: 2 }])
})

// ---------- name mentions ----------

test('name mentions: a distinctive name, whole word, any case, outside every URL; null with no names', () => {
  assert.equal(nameMentioned('Heartside makes gifts from your dog.', ['Heartside']), true)
  assert.equal(nameMentioned('try HEARTSIDE for this', ['heartside']), true)
  assert.equal(nameMentioned('See https://heartside.io/gifts or heartside.io for more.', ['Heartside']), false, 'a link is a citation, not a mention')
  assert.equal(nameMentioned('The heartsides of the matter.', ['Heartside']), false, 'whole word only')
  assert.equal(nameMentioned('Make  Your Mind Up says so.', ['Make Your Mind Up']), true)
  assert.equal(nameMentioned('Anything at all.', []), null)
  assert.deepEqual(brandNamesOf(['Mindmake', 'mindmake', ' ', 7, 'M']), ['Mindmake'])
})

test('an offline run with a kit in flight: its question is tracked, re-sampled and reported, with no answer text', async () => {
  const kitQuery = 'b352032b-3bee-4b1e-8b22-d838679921b0'
  const r = await featuredRun('ctrl', [], undefined, deps => {
    deps.kitPlans = [{ plan_id: `aeo:kit:ctrl:${kitQuery.slice(0, 8)}`, product_slug: 'ctrl', q8: kitQuery.slice(0, 8), approved_at: '2026-09-09T09:00:00Z', decision: { proposal_id: `aeo:kit:ctrl:${kitQuery.slice(0, 8)}`, decision: 'approved', decided_at: '2026-09-09T09:00:00Z', payload_sha256: null }, check_in: null, redirect: null, unverified: false }]
  })
  assert.deepEqual(r.failures, [])
  const panel = r.results[0].panel!
  assert.equal(panel.tracked.length, 1)
  assert.equal(panel.tracked[0].query_id, kitQuery)
  assert.deepEqual(panel.tracked[0].tiers, ['kit'])
  assert.ok(panel.tracked[0].engines.every(e => e.n === 3), 'a kit in flight is always re-sampled')
  assert.ok(panel.sampled >= 1)
  assert.equal(panel.tracked[0].gap_class, 'retrieved_not_cited')
  assert.ok(!JSON.stringify(panel).includes('answer_snapshot'))
})

// ---------- noise and the spend cap (review, 2026-11-13) ----------

/** chatgpt (paid) is first on its first answer only; the free Claude Code lane cites us, never first. */
function capEngines() {
  let calls = 0
  const gpt = new StubEngine('chatgpt', () => (++calls === 1
    ? { text: 'x', citations: ['https://ours.example/a', 'https://other.example/b'] }
    : { text: 'x', citations: ['https://other.example/b', 'https://ours.example/a'] }))
  const claude = new StubEngine('claude', () => ({ text: 'x', citations: ['https://other.example/b', 'https://ours.example/a'] }), 'claude-code', { costKind: 'claude_code' })
  return [gpt, claude]
}
const PRICES = { perplexity: 0.05, chatgpt: 0.05, claude: 0.05, grok: 0.05, gemini: 0.05, claude_code: 0, classify: 0, themes: 0, propose: 0, digest: 0, voice: 0 }

test('a tight cap: a paid engine whose re-asks were stopped cannot win a re-sampled question on its one first citation', async () => {
  const engines = capEngines()
  const q = pq(1, 'A question cited first once?')
  const sel = selectPanel([q], {})
  const ledger = new Ledger(0.05, PRICES)
  const outcome = await probeQueries(engines, sel.ordered, ['ours.example'], ledger, [], sel.limit, 0, { preordered: true })
  const toSample = sampleSet(sel, outcome.detailsByQuery, 8, new Set(['chatgpt', 'claude']))
  assert.deepEqual(toSample.map(x => x.query_id), [qid(1)], 'cited anywhere this run')
  const s = await resample(engines, outcome, toSample, ['ours.example'], ledger, 0)
  assert.deepEqual(s, { questions: 1, asks: 2, answers: 2, failed: 0, skipped_cap: 2 }, 'only the free lane was re-asked')
  const r = panelFor({
    selection: sel, asked: outcome.asked!, details: outcome.detailsByQuery!, prior: null, week: W,
    sampledIds: new Set(toSample.map(x => x.query_id)), partial: outcome.partial, sampled: s.questions, sampleAnswers: s.answers, sampleSkippedCap: s.skipped_cap,
  })
  assert.equal(r.panels.get(qid(1))?.state, 'contested', 'chatgpt first on 1 of 1 and claude on 0 of 3: not won')
  assert.deepEqual(r.summary.won_now, [])
  assert.equal(r.summary.sample_skipped_cap, 2)

  // Every re-ask stopped: the question is not counted as re-sampled.
  const none = await resample(engines, await probeQueries(engines, [pq(2, 'Another?')], ['ours.example'], new Ledger(10, PRICES)), [pq(2, 'Another?')], ['ours.example'], new Ledger(0, PRICES), 0, { rounds: 2 })
  assert.equal(none.questions, 1, 'the free lane still re-asked')
  const paidOnly = [engines[0]]
  const o2 = await probeQueries(paidOnly, [pq(3, 'Paid only?')], ['ours.example'], new Ledger(10, PRICES))
  const stopped = await resample(paidOnly, o2, [pq(3, 'Paid only?')], ['ours.example'], new Ledger(0, PRICES), 0)
  assert.deepEqual(stopped, { questions: 0, asks: 0, answers: 0, failed: 0, skipped_cap: 2 }, 'no re-ask made: not counted as re-sampled')
})

test('the cap stops the engine that held a win: the question is unknown this run, never lost', async () => {
  const gpt = new StubEngine('chatgpt', () => ({ text: 'x', citations: ['https://ours.example/a'] }))
  const claude = new StubEngine('claude', () => ({ text: 'x', citations: ['https://other.example/b'] }), 'claude-code', { costKind: 'claude_code' })
  const q = pq(1, 'A question won last run?', { prior: prior(1, 'A question won last run?') })
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(1, 'A question won last run?', panel('won', { won_at: '2026-10-19' }))] }
  const sel = selectPanel([q], { prior: priorWeek })
  const outcome = await probeQueries([gpt, claude], sel.ordered, ['ours.example'], new Ledger(0, PRICES), [], sel.limit, 0, { preordered: true })
  assert.equal(outcome.probes_skipped_cap, 1)
  assert.ok(outcome.partial!.has(qid(1)))
  const r = panelFor({ selection: sel, asked: outcome.asked!, details: outcome.detailsByQuery!, prior: priorWeek, week: W, partial: outcome.partial, sampled: 0, sampleAnswers: 0 })
  assert.deepEqual(r.panels.get(qid(1)), { state: 'unknown', first_seen: '2026-10-05', last_asked: W, won_at: '2026-10-19', lost_at: null, streak: 1 })
  assert.deepEqual(r.summary.lost_now, [])

  // A failed call does the same; with every engine answering, absent is a loss.
  const down = new StubEngine('chatgpt', () => { throw new Error('down') })
  const failed = await probeQueries([down, claude], sel.ordered, ['ours.example'], new Ledger(10, PRICES), [], sel.limit, 0, { preordered: true })
  assert.ok(failed.partial!.has(qid(1)))
  assert.equal(panelFor({ selection: sel, asked: failed.asked!, details: failed.detailsByQuery!, prior: priorWeek, week: W, partial: failed.partial, sampled: 0, sampleAnswers: 0 }).panels.get(qid(1))?.state, 'unknown')
  const both = new StubEngine('chatgpt', () => ({ text: 'x', citations: ['https://other.example/b'] }))
  const full = await probeQueries([both, claude], sel.ordered, ['ours.example'], new Ledger(10, PRICES), [], sel.limit, 0, { preordered: true })
  assert.equal(full.partial!.size, 0)
  const lost = panelFor({ selection: sel, asked: full.asked!, details: full.detailsByQuery!, prior: priorWeek, week: W, partial: full.partial, sampled: 0, sampleAnswers: 0 })
  assert.equal(lost.panels.get(qid(1))?.lost_at, W)
  assert.deepEqual(lost.summary.lost_now.map(c => c.query_id), [qid(1)])

  // Sampled, with a re-ask the cap stopped: also too short to call a loss.
  const sampled = panelFor({
    selection: sel, asked: new Set([qid(1)]), prior: priorWeek, week: W, sampledIds: new Set([qid(1)]), sampled: 1, sampleAnswers: 2,
    details: new Map([[qid(1), [detail(1, 'chatgpt', { first_host_ours: true, cited_any: true, samples: { n: 1, first: 1, cited: 1 } }), detail(1, 'claude', { samples: { n: 3, first: 0, cited: 0 } })]]]),
  })
  assert.equal(sampled.panels.get(qid(1))?.state, 'unknown')
  assert.deepEqual(sampled.summary.lost_now, [])
})

test('a packet question this run did not ask keeps its served panel unchanged, so a win cut by the limit keeps its week', () => {
  const proposed = [pq(1, 'Asked this run?', { prior: prior(1, 'x') }), pq(2, 'Won, past the limit?', { prior: prior(2, 'x') })]
  const served = panel('won', { won_at: '2026-10-19', streak: 3 })
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(1, 'x', panel('absent')), prior(2, 'x', served)] }
  const sel = selectPanel(proposed, { prior: priorWeek })
  const r = panelFor({ selection: sel, asked: new Set([qid(1)]), details: new Map([[qid(1), [detail(1, 'chatgpt')]]]), prior: priorWeek, week: W, sampled: 0, sampleAnswers: 0 })
  assert.deepEqual(r.panels.get(qid(2)), served, 'as served: its last_asked stays the week it was asked')
  assert.equal(r.summary.states.won, 0, 'not counted in this run\'s states')
  // The next run reads it back as won, and the panel asks it again.
  const next: PriorWeek = { week_start: W, watch_list: [], recommendations: [], queries: [prior(2, 'Won, past the limit?', r.panels.get(qid(2)))] }
  assert.deepEqual(panelQuestions([pq(9, 'Something new?')], { id: 's', prior: next }, { prior: next }, k => k).map(q => q.query_id), [qid(9), qid(2)])
})

test('sampleSet: a requested question that is also won last run, a kit or shipped is re-sampled; gated engines take no slot', () => {
  const proposed = [pq(1, 'Requested and won last run?', { requested: true, prior: prior(1, 'x') }), pq(2, 'Requested and a kit?', { requested: true }), pq(3, 'Requested and shipped?', { requested: true }), pq(4, 'Requested only?', { requested: true })]
  const priorWeek: PriorWeek = { week_start: P, watch_list: [], recommendations: [], queries: [prior(1, 'x', panel('won', { won_at: P }))] }
  const sel = selectPanel(proposed, { prior: priorWeek, kitPrefixes: [qid(2).slice(0, 8)], shipped: [{ query_id: qid(3), url: 'https://ours.example/s', shipped_at: null }] })
  assert.ok(proposed.every(q => sel.tiers.get(q.query_id) === 'requested'))
  const details = new Map<string, ProbeDetail[]>(proposed.map((q, i) => [q.query_id, [detail(i + 1, 'chatgpt')]]))
  assert.deepEqual(sampleSet(sel, details).map(q => q.query_id), [qid(1), qid(2), qid(3)], 'not cited this run, and still re-sampled')

  // Twelve questions: eight cited only by gated Gemini, four by chatgpt. Only the packet's engines count.
  const many = Array.from({ length: 12 }, (_, i) => pq(20 + i, `Question ${i} about a thing?`))
  const sel2 = selectPanel(many)
  const d2 = new Map<string, ProbeDetail[]>(many.map((q, i) => [q.query_id, i < 8
    ? [detail(20 + i, 'chatgpt'), { ...detail(20 + i, 'chatgpt'), engine: 'gemini' as Engine, cited_any: true }]
    : [detail(20 + i, 'chatgpt', { cited_any: true })]]))
  assert.deepEqual(sampleSet(sel2, d2, 8, new Set(['chatgpt'])).map(q => q.query_id), many.slice(8).map(q => q.query_id))
  const geminiOnly = new Map<string, ProbeDetail[]>([[many[0].query_id, [{ ...detail(20, 'chatgpt'), engine: 'gemini' as Engine, cited_any: true }]]])
  assert.deepEqual(sampleSet(sel2, geminiOnly, 8, new Set(['chatgpt'])), [], 'answered only by a gated engine: no slot')
})

test('a new query_id whose words the four weeks of probes hold is not new: its first week is unknown', () => {
  const proposed = [pq(1, 'Asked before under another id?'), pq(2, 'Truly new?')]
  const sel = selectPanel(proposed)
  const probes4w = [{ id: 'p', question: 'Asked before under another id?', engine: 'claude' as const, we_cited: false, competitors_cited: [], run_at: '2026-10-19T09:00:00Z', run_id: 'r', query_id: 'ffffffff-0000-4000-8000-000000000000' }]
  const r = panelFor({ selection: sel, asked: new Set([qid(1), qid(2)]), details: new Map([[qid(1), [detail(1, 'chatgpt')]], [qid(2), [detail(2, 'chatgpt')]]]), prior: null, week: W, probes4w, sampled: 0, sampleAnswers: 0 })
  assert.equal(r.panels.get(qid(1))?.first_seen, null)
  assert.equal(r.panels.get(qid(2))?.first_seen, W)
  assert.equal(r.summary.history, false)
})
