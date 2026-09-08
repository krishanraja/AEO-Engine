import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ledger } from '../src/lib/cost.js'
import { gapFor } from '../src/pipeline/20-gap.js'
import { computeCompetitorGap, digestSystem, playbookGroups, writeDigest, type DigestInput } from '../src/pipeline/60-digest.js'
import type { ThemesResult } from '../src/pipeline/10-transcripts.js'
import type { Engine, PacketQuery, Probe } from '../src/schema/packet.js'
import { StubModel, fixtureContext, subject } from './helpers.js'

const ctx = fixtureContext()
const ENGINES: Engine[] = ['perplexity', 'chatgpt', 'claude']
const probe = (engine: Engine, we_cited: boolean, citations: string[]): Probe => ({ engine, model: 'm', question: 'q', answer_snapshot: 'a'.repeat(250), we_cited, citations, cost_usd: 0.01 })
const row = (id: number, query: string, status: PacketQuery['status'], score: number, probes: Probe[], competitors: string[] = ['rival.example']): PacketQuery => ({
  query_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, query, source: 'seed', demand_score: score,
  demand_basis: { llm_demand: 30, transcript_evidence: 0, rising_volume: 0, labels: [] }, call_evidence: [],
  gap: { we_cited_engines: probes.filter(p => p.we_cited).map(p => p.engine), competitor_domains: competitors }, trend: 'new', status, touchpoint_id: null, probes,
})
const themes: ThemesResult = { themes_status: 'no_calls', themes: [], calls: { considered: 0, attributed: 0 } }
const three = (cited: Engine[] = []) => ENGINES.map(e => probe(e, cited.includes(e), e === 'perplexity' ? ['https://rival.example/a', 'https://other.example/b'] : ['https://rival.example/a']))

function input(slug: string, queries: PacketQuery[]): DigestInput {
  const s = subject(slug)
  const ours = slug === 'sample-media' ? ctx.krish.domains : s.domains
  return { subject: s, ctx, weekStart: '2026-09-07', engines: ENGINES, queries, themes, gap: gapFor(s, ours), krishHitsDomains: ours }
}

test('the model writes the prose; numbers, ids and engines come from the score table', async () => {
  const q = [row(1, 'How do I write in my own voice with AI?', 'recommend', 60, three()), row(2, 'Second question here?', 'watch', 35, three(['claude'])), row(3, 'Dropped one here?', 'drop', 5, three())]
  const model = new StubModel(JSON.stringify({
    strongest_signal: 'Nobody \u2014 not one engine \u2014 cites us on voice',
    recommendations: [
      { query_id: q[0].query_id, title: 'The voice piece', angle: 'Show the method', evidence: ['absent on all three'] },
      { query_id: '00000000-0000-4000-8000-000000000099', title: 'Invented', angle: 'x', evidence: [] },
      { query_id: q[1].query_id, title: 'A watch row is not a recommendation', angle: 'x', evidence: [] },
    ],
    watch_list: [{ query_id: q[1].query_id, why: 'Cited on claude only' }],
    approach_hook: 'A hook a venture must not carry',
    playbook: [{ url: 'https://x', why: 'no' }],
  }))
  const ledger = new Ledger(10)
  const d = await writeDigest(model, ledger, input('ctrl', q))
  assert.equal(d.digest_writer, 'claude')
  assert.equal(d.strongest_signal, 'Nobody, not one engine, cites us on voice')
  assert.equal(d.recommendations.length, 1)
  assert.equal(d.recommendations[0].title, 'The voice piece')
  assert.equal(d.recommendations[0].n, 1)
  assert.equal(d.recommendations[0].demand, 60)
  assert.deepEqual(d.recommendations[0].engines, ENGINES)
  assert.equal(d.recommendations[0].target_query, q[0].query)
  assert.deepEqual(d.watch_list, [{ query_id: q[1].query_id, query: q[1].query, why: 'Cited on claude only' }])
  assert.equal(d.approach_hook, null)
  assert.equal(d.playbook, null)
  assert.equal(d.competitor_gap.domain, 'rival.example')
  assert.equal(ledger.summary().by_kind.digest.calls, 1)
  assert.match(model.requests[0].system, /ABSOLUTE RULE: every number you write must appear in the evidence/)
  assert.match(model.requests[0].system, /unknowns/)
  assert.ok(model.requests[0].user.includes('"call themes: no_calls"'))
})

test('a question the model says is owned is not also recommended, and every wall names a real query', async () => {
  const q = [
    row(1, 'How do I write in my own voice with AI?', 'recommend', 60, three()),
    row(2, 'What is AI?', 'recommend', 55, three(), ['linkedin.com', 'youtube.com']),
    row(3, 'Second question here?', 'watch', 35, three(['claude'])),
  ]
  const model = new StubModel(JSON.stringify({
    strongest_signal: 's',
    recommendations: [
      { query_id: q[0].query_id, title: 'The voice piece', angle: 'Show the method', why_you_can_win: 'He has the graded before and after; the tool blogs have a feature page.', evidence: ['absent on all three'] },
      { query_id: q[1].query_id, title: 'A category term he cannot win', angle: 'x', why_you_can_win: 'He knows a lot about this', evidence: [] },
    ],
    not_worth_chasing: [
      { query_id: q[1].query_id, owned_by: ['linkedin.com', 'youtube.com'], why_not: 'A social network and a video platform own this on reach. One piece does not move it.' },
      { query_id: q[2].query_id, owned_by: [], why_not: 'Asked by people who cannot buy.' },
      { query_id: '00000000-0000-4000-8000-000000000099', owned_by: ['nowhere.example'], why_not: 'A query that is not in this packet.' },
      { query_id: q[1].query_id, owned_by: ['linkedin.com'], why_not: 'The same one twice.' },
    ],
    watch_list: [],
    approach_hook: null,
    playbook: [],
  }))
  const d = await writeDigest(model, new Ledger(10), input('ctrl', q))
  const ids = new Set(q.map(x => x.query_id))
  // Only questions this packet actually carries, and each of them once.
  assert.deepEqual(d.not_worth_chasing.map(w => w.query_id), [q[1].query_id, q[2].query_id])
  for (const w of d.not_worth_chasing) assert.ok(ids.has(w.query_id), `${w.query_id} is not a query in this packet`)
  // A walled question is dropped from the recommendations even though the model wrote one for it.
  assert.deepEqual(d.recommendations.map(r => r.query_id), [q[0].query_id])
  assert.equal(d.recommendations[0].why_you_can_win, 'He has the graded before and after; the tool blogs have a feature page.')
  // owned_by falls back to the hosts actually cited when the model names none.
  assert.deepEqual(d.not_worth_chasing[1].owned_by, ['rival.example'])
  assert.equal(d.not_worth_chasing[0].query, 'What is AI?')
})

test('a recommendation the model wrote no reason for is carried with why_you_can_win null, not dropped', async () => {
  const q = [row(1, 'How do I write in my own voice with AI?', 'recommend', 60, three()), row(2, 'Another one to answer?', 'recommend', 50, three())]
  const model = new StubModel(JSON.stringify({
    strongest_signal: 's',
    recommendations: [
      { query_id: q[0].query_id, title: 'No reason given', angle: 'a', evidence: ['e'] },
      { query_id: q[1].query_id, title: 'An empty reason', angle: 'a', why_you_can_win: '   ', evidence: ['e'] },
    ],
    not_worth_chasing: [],
    watch_list: [],
    approach_hook: null,
    playbook: [],
  }))
  const d = await writeDigest(model, new Ledger(10), input('ctrl', q))
  // The choice: carry it with null so the reader sees the judgement was not
  // made, rather than drop the row and hide the digest's own failure.
  assert.equal(d.recommendations.length, 2)
  assert.equal(d.recommendations[0].title, 'No reason given')
  assert.equal(d.recommendations[0].why_you_can_win, null)
  assert.equal(d.recommendations[1].why_you_can_win, null)
})

test('the fallback walls off what the platforms own and never invents a reason to win', async () => {
  const q = [
    row(1, 'How do I write in my own voice with AI?', 'recommend', 60, three()),
    row(2, 'What is the future of work?', 'recommend', 55, three(), ['linkedin.com', 'forbes.com', 'www.youtube.com', 'niche.example']),
    row(3, 'A specialist question here?', 'recommend', 50, three(), ['niche.example', 'linkedin.com']),
  ]
  const d = await writeDigest(new StubModel('THROW'), new Ledger(10), input('ctrl', q))
  assert.equal(d.digest_writer, 'fallback')
  // Three of four cited hosts are general platforms, so that answer is a wall.
  assert.deepEqual(d.not_worth_chasing.map(w => w.query_id), [q[1].query_id])
  assert.deepEqual(d.not_worth_chasing[0].owned_by, ['linkedin.com', 'forbes.com', 'www.youtube.com'])
  assert.match(d.not_worth_chasing[0].why_not, /^The answer is owned by linkedin.com, forbes.com, www.youtube.com, won on reach/)
  assert.match(d.not_worth_chasing[0].why_not, /the writing pass was unavailable/i)
  // One general platform beside a specialist is still a specialist's answer.
  assert.deepEqual(d.recommendations.map(r => r.query_id), [q[0].query_id, q[2].query_id])
  // The fallback can see who is cited; it cannot see what Krish has that they do not.
  for (const r of d.recommendations) assert.equal(r.why_you_can_win, null, `${r.title} invented a reason`)
})

test('a model failure falls back to the score table and says so', async () => {
  const q = [row(1, 'How do I write in my own voice with AI?', 'recommend', 60, three()), row(2, 'Second question here?', 'watch', 35, three(['claude']))]
  const d = await writeDigest(new StubModel('THROW'), new Ledger(10), input('ctrl', q))
  assert.equal(d.digest_writer, 'fallback')
  assert.equal(d.recommendations.length, 1)
  assert.equal(d.recommendations[0].why_you_can_win, null)
  assert.deepEqual(d.not_worth_chasing, [])
  assert.match(d.recommendations[0].angle, /not cited on perplexity, chatgpt, claude/)
  assert.match(d.recommendations[0].evidence[0], /^demand 60: llm 30/)
  assert.match(d.strongest_signal ?? '', /scored 60 and we are absent on perplexity, chatgpt, claude/)
  assert.equal(d.watch_list[0].why, 'demand 35, new; cited on 1 of 3 probed engines')
})

test('a prospect gets a hook without its never-say name; a missing recommendation is filled from the table', async () => {
  const q = [row(1, 'How should a media group sequence AI?', 'recommend', 60, three()), row(2, 'How do we measure AI return?', 'recommend', 50, three())]
  const model = new StubModel(JSON.stringify({ strongest_signal: null, recommendations: [{ query_id: q[1].query_id, title: 'Only the second', angle: 'a', evidence: ['e'] }], watch_list: [], approach_hook: 'When Sample Media Group leaders ask, the answer cites rival.example, not Mindmake', playbook: [] }))
  const d = await writeDigest(model, new Ledger(10), input('sample-media', q))
  assert.equal(d.recommendations.length, 2)
  assert.equal(d.recommendations[0].title, 'Answer "How should a media group sequence AI?"', 'most demand first, fallback prose when the model skipped it')
  assert.equal(d.recommendations[1].title, 'Only the second')
  assert.equal(d.approach_hook, 'When leaders ask, the answer cites rival.example, not Mindmake')
  const fb = await writeDigest(new StubModel('THROW'), new Ledger(10), input('sample-media', q))
  assert.match(fb.approach_hook ?? '', /^When your team asks an AI assistant "How should a media group sequence AI\?", the answer cites rival.example/)
})

test('an aspiration gets a playbook grouped by host and path shape', async () => {
  const own = (p: string) => `https://sample-studio.example${p}`
  const q = [
    row(1, 'How should I price an AI product?', 'watch', 40, [probe('perplexity', true, [own('/essays/2026/pricing-ai-products'), 'https://example-vc.com/x']), probe('chatgpt', true, [own('/essays/2026/pricing-ai-products')]), probe('claude', false, ['https://example-vc.com/y'])]),
    row(2, 'How do I build in public?', 'recommend', 40, [probe('perplexity', true, [own('/notes/2026/09/build')]), probe('chatgpt', false, ['https://example-vc.com/z']), probe('claude', false, ['https://example-vc.com/z'])]),
  ]
  const model = new StubModel(JSON.stringify({ strongest_signal: 's', recommendations: [], watch_list: [], approach_hook: null, playbook: [{ url: own('/essays/2026/pricing-ai-products'), why: 'A dated essay with a number in it' }] }))
  const d = await writeDigest(model, new Ledger(10), input('sample-studio', q))
  assert.ok(Array.isArray(d.playbook))
  assert.equal(d.playbook![0].path_pattern, '/essays/n')
  assert.equal(d.playbook![0].times_cited, 4, 'two four-week rows plus two this week')
  assert.equal(d.playbook![0].url, own('/essays/2026/pricing-ai-products'), 'the most cited URL stands for the group')
  assert.equal(d.playbook![0].why, 'A dated essay with a number in it')
  assert.equal(d.playbook![1].path_pattern, '/notes/n')
  assert.match(d.playbook![1].why, /^Cited 1 time, for example on/)
  assert.equal(d.approach_hook, null)
  const groups = playbookGroups([{ url: 'https://h.example/a/1', host: 'h.example', path_pattern: '/a/n', times: 1, questions: ['q'] }, { url: 'https://h.example/a/2', host: 'h.example', path_pattern: '/a/n', times: 3, questions: ['r'] }])
  assert.deepEqual(groups, [{ url: 'https://h.example/a/2', host: 'h.example', path_pattern: '/a/n', times_cited: 4, questions: ['q', 'r'] }])
})

test('competitor_gap merges the four-week history with this week', () => {
  const q = [row(1, 'x y z?', 'watch', 30, three())]
  const g = computeCompetitorGap(input('ctrl', q))
  assert.equal(g.domain, 'rival.example')
  assert.equal(g.times_cited, 3)
  const g2 = computeCompetitorGap(input('ctrl', []))
  assert.equal(g2.domain, 'example-writer-tools.com')
  assert.equal(g2.times_cited, 2)
})

test('the digest writes in the voice Krish already gave the OS, and plainly when it has none', () => {
  const plain = digestSystem()
  assert.doesNotMatch(plain, /HOW KRISH WRITES/)
  assert.doesNotMatch(plain, /THE MOVES HE RATES/)
  assert.match(plain, /ABSOLUTE RULE/)

  const dressed = digestSystem({
    name: 'Krish Raja',
    domains: ['mindmake.co'],
    voice_block: 'Write short. No em dashes. Never say "unlock" or "leverage".',
    voices_he_rates: [
      { name: 'A Writer', why: 'named concept plus one-line economics plus proof plus CTA.' },
      { name: 'Another', why: 'story-led essays that build the audience before the product.' },
      { name: 'No reason', why: '' },
    ],
  })
  assert.match(dressed, /HOW KRISH WRITES/)
  assert.match(dressed, /Never say "unlock"/)
  assert.match(dressed, /THE MOVES HE RATES/)
  assert.match(dressed, /named concept plus one-line economics/)
  assert.match(dressed, /story-led essays/)
  // The people are never named to the model: it borrows the move, not the byline.
  assert.doesNotMatch(dressed, /A Writer|Another/)
  // A creator with no recorded move contributes nothing.
  assert.equal(dressed.split('\n').filter(l => l.startsWith('- ')).length, 2)
  // The voice governs register; it can never loosen the evidence rules.
  assert.ok(dressed.indexOf('ABSOLUTE RULE') < dressed.indexOf('HOW KRISH WRITES'))
  assert.match(dressed, /never overrides the two ABSOLUTE RULES/)

  // A voice block far longer than the budget is cut, not sent whole.
  const long = digestSystem({ name: 'K', domains: [], voice_block: 'x'.repeat(20_000) })
  assert.ok(long.length < 12_000, `system prompt stayed bounded, was ${long.length}`)
})

test('the winnability rules ride on the canon, and there are none without it', () => {
  const plain = digestSystem({ name: 'K', domains: [], voice_block: 'Write short.' })
  assert.doesNotMatch(plain, /WINNABILITY/)
  assert.doesNotMatch(plain, /THE CANON/)
  assert.doesNotMatch(plain, /why_you_can_win is\b/)
  // The output contract is the same either way; only the judgement needs the canon.
  assert.match(plain, /"why_you_can_win"/)
  assert.match(plain, /"not_worth_chasing"/)

  const judged = digestSystem({ name: 'K', domains: [], canon: 'Mindmake sells one thing to one buyer: a senior operator who can start a project without asking.' })
  assert.match(judged, /WINNABILITY/)
  assert.match(judged, /Absence is not opportunity/)
  assert.match(judged, /a wall, not a gap/)
  assert.match(judged, /THE CANON/)
  assert.match(judged, /senior operator who can start a project without asking/)
  // The five rules, each recognisable.
  assert.match(judged, /1\. Decide who owns the answer now/)
  assert.match(judged, /2\. A recommendation must name what Krish has/)
  assert.match(judged, /"He knows a lot about this" is not a reason/)
  assert.match(judged, /3\. The person asking must be the buyer the canon describes/)
  assert.match(judged, /4\. A question that fails any of these goes in not_worth_chasing/)
  assert.match(judged, /5\. Prefer the specific over the category/)
  // The canon answers who and why; it never supplies a measurement.
  assert.match(judged, /never take a number from it/)
  assert.ok(judged.indexOf('ABSOLUTE RULE') < judged.indexOf('WINNABILITY'))

  // A canon far longer than the budget is cut to its opening, where the
  // positioning and the buyer are, not sent whole.
  const long = digestSystem({ name: 'K', domains: [], canon: 'THE OPENING. ' + 'y'.repeat(30_000) })
  assert.match(long, /THE OPENING\./)
  assert.ok(long.length < 12_000, `system prompt stayed bounded, was ${long.length}`)

  // Voice and canon together still fit.
  const both = digestSystem({ name: 'K', domains: [], voice_block: 'x'.repeat(20_000), canon: 'y'.repeat(30_000) })
  assert.ok(both.length < 19_000, `system prompt stayed bounded, was ${both.length}`)
})
