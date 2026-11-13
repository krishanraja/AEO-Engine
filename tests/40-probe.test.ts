import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPS } from '../src/config/run.js'
import { Ledger } from '../src/lib/cost.js'
import { normaliseQuery } from '../src/lib/text.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import { orderForProbing, probeLimitFor, probeQueries } from '../src/pipeline/40-probe.js'
import { StubEngine } from './helpers.js'

const pq = (query: string, source: ProposedQuery['source'], priorDemand: number | null = null, requested = false): ProposedQuery => ({
  query_id: `00000000-0000-4000-8000-${String(Math.abs(hash(query))).padStart(12, '0').slice(0, 12)}`,
  query, source, touchpoint_id: null, norm: normaliseQuery(query), requested,
  prior: priorDemand === null ? null : { query_id: 'x', query, demand_score: priorDemand, status: 'watch', trend: 'flat' },
})
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

test('orderForProbing: requested first in request order, then prior demand, then gap, transcript, room, striking, carry, seed', () => {
  const list = [
    pq('seed one?', 'seed'), pq('gap one?', 'gap'), pq('asked second?', 'seed', null, true), pq('prior low?', 'seed', 20), pq('transcript one?', 'transcript'),
    pq('prior high?', 'seed', 70), pq('room one?', 'room_signal'), pq('striking one?', 'striking_distance'), pq('carry one?', 'watch_carry'), pq('asked third?', 'seed', 90, true),
  ]
  const first = pq('asked first?', 'seed', null, true)
  assert.deepEqual(orderForProbing([first, ...list]).map(q => q.query), ['asked first?', 'asked second?', 'asked third?', 'prior high?', 'prior low?', 'gap one?', 'transcript one?', 'room one?', 'striking one?', 'carry one?', 'seed one?'])
})

test('the probe limit: the usual 25, raised to hold every request and five more, never above 30', () => {
  assert.equal(probeLimitFor(0), CAPS.MAX_PROBED_QUERIES_PER_SUBJECT)
  assert.equal(probeLimitFor(0), 25)
  assert.equal(probeLimitFor(20), 25)
  assert.equal(probeLimitFor(21), 26)
  assert.equal(probeLimitFor(25), 30)
  assert.equal(probeLimitFor(40), CAPS.MAX_PROBED_QUERIES_HARD)
})

test('probeQueries records the answer honestly, caps citations, cleans text, counts failures', async () => {
  const long = 'A substantive answer. '.repeat(20)
  const engines = [
    new StubEngine('perplexity', () => ({ text: `${long} see ctrl.mindmake.co \u2014 it fits`, citations: Array.from({ length: 10 }, (_, i) => `https://a.example/${i}`) })),
    new StubEngine('chatgpt', () => ({ text: long, citations: ['https://mindmake.co/ctrl', 'https://x.example/@someone', 'mailto:someone@example.com'] })),
    new StubEngine('claude', () => { throw new Error('boom') }),
  ]
  const ledger = new Ledger(10)
  const out = await probeQueries(engines, [pq('How do I write?', 'seed'), pq('Second?', 'seed')], ['ctrl.mindmake.co', 'mindmake.co'], ledger)
  assert.equal(out.probes, 4)
  assert.equal(out.probes_failed, 2)
  assert.equal(out.probes_skipped_cap, 0)
  const rows = out.probesByQuery.get(pq('How do I write?', 'seed').query_id)!
  assert.equal(rows.length, 2)
  assert.equal(rows[0].we_cited, true, 'a domain in the text counts')
  assert.equal(rows[0].citations.length, 8)
  assert.ok(!rows[0].answer_snapshot.includes('\u2014'))
  assert.equal(rows[1].we_cited, true, 'a citation host counts')
  assert.deepEqual(rows[1].citations, ['https://mindmake.co/ctrl'], 'citations carrying a handle or an email are dropped')
  assert.equal(rows[0].cost_usd, ledger.priceOf('perplexity'))
  assert.equal(rows[0].model, 'perplexity-stub')
})

test('the usd cap stops calls and counts every unprobed pair; the per-subject cap leaves probes empty', async () => {
  const engines = [
    new StubEngine('perplexity', () => ({ text: 'x', citations: [] })),
    new StubEngine('chatgpt', () => ({ text: 'x', citations: [] })),
  ]
  const ledger = new Ledger(0.05, { perplexity: 0.02, chatgpt: 0.02, claude: 0.02, grok: 0.02, gemini: 0.02, claude_code: 0, classify: 0, themes: 0, propose: 0, digest: 0, voice: 0 })
  const list = [pq('one?', 'seed'), pq('two?', 'seed'), pq('three?', 'seed')]
  const out = await probeQueries(engines, list, ['mindmake.co'], ledger, [], 2)
  assert.equal(out.probes, 2)
  assert.equal(out.probes_skipped_cap, 2, 'the two pairs of the second query')
  assert.equal(out.probesByQuery.has(list[2].query_id), false, 'over the per-subject cap, not counted against the usd cap')
  assert.equal(engines[0].asked.length + engines[1].asked.length, 2)
})

test('the first citation is measured before cleaning: a dropped handle URL never promotes the second source to first', async () => {
  const engines = [
    // The first source carries a handle, so the packet's cleaned list drops it.
    new StubEngine('chatgpt', () => ({ text: 'An answer.', citations: ['https://medium.example/@someone/post', 'https://mindmake.co/guide'], searched: true })),
    new StubEngine('claude', () => ({ text: 'Another.', citations: ['https://mindmake.co/a', 'https://x.example'], searched: true })),
    new StubEngine('perplexity', () => ({ text: 'No sources.', citations: [], searched: false })),
  ]
  const q = pq('Which guide should I read?', 'seed')
  const out = await probeQueries(engines, [q], ['mindmake.co'], new Ledger(10))
  const rows = out.probesByQuery.get(q.query_id)!
  assert.deepEqual(rows[0].citations, ['https://mindmake.co/guide'], 'the packet keeps the cleaned list')
  const d = out.detailsByQuery!.get(q.query_id)!
  assert.deepEqual(d.map(x => x.engine), ['chatgpt', 'claude', 'perplexity'])
  assert.deepEqual(d.map(x => x.first_host_ours), [false, true, false], 'chatgpt cited a stranger first')
  assert.deepEqual(d.map(x => x.our_position), [2, 1, null])
  assert.deepEqual(d.map(x => x.cited_any), [true, true, false])
  assert.deepEqual(d.map(x => x.searched), [true, true, false])
  assert.deepEqual(d.map(x => x.zero_citation), [false, false, true])
  assert.deepEqual(rows.map(r => r.we_cited), [true, true, false])
})

test('we_cited reads the inline citations and the text, never a path it does not cover', async () => {
  const engines = [
    new StubEngine('chatgpt', () => ({ text: 'See linkedin.com/in/krishrajapal for more.', citations: ['https://linkedin.com/pulse/other-person'] })),
    new StubEngine('claude', () => ({ text: 'Nothing named.', citations: ['https://uk.linkedin.com/in/krishraja/'] })),
  ]
  const q = pq('Who writes about board AI plans?', 'seed')
  const out = await probeQueries(engines, [q], ['mindmake.co', 'linkedin.com/in/krishraja'], new Ledger(10))
  assert.deepEqual(out.probesByQuery.get(q.query_id)!.map(r => r.we_cited), [false, true])
  assert.deepEqual(out.detailsByQuery!.get(q.query_id)!.map(x => x.first_host_ours), [false, true])
})

test('the usd cap counts a question\'s engines together: none is charged past the cap', async () => {
  const engines = ['perplexity', 'chatgpt', 'claude'].map(e => new StubEngine(e as 'perplexity', () => ({ text: 'x', citations: [] })))
  const ledger = new Ledger(0.05, { perplexity: 0.02, chatgpt: 0.02, claude: 0.02, grok: 0.02, gemini: 0.02, claude_code: 0, classify: 0, themes: 0, propose: 0, digest: 0, voice: 0 })
  const out = await probeQueries(engines, [pq('one question here?', 'seed')], ['mindmake.co'], ledger)
  assert.equal(out.probes, 2, 'each alone fits; all three together would cross')
  assert.equal(out.probes_skipped_cap, 1)
  assert.ok(ledger.total <= 0.05)
})
