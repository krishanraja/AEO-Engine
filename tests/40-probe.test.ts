import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Ledger } from '../src/lib/cost.js'
import { normaliseQuery } from '../src/lib/text.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import { orderForProbing, probeQueries } from '../src/pipeline/40-probe.js'
import { StubEngine } from './helpers.js'

const pq = (query: string, source: ProposedQuery['source'], priorDemand: number | null = null): ProposedQuery => ({
  query_id: `00000000-0000-4000-8000-${String(Math.abs(hash(query))).padStart(12, '0').slice(0, 12)}`,
  query, source, touchpoint_id: null, norm: normaliseQuery(query),
  prior: priorDemand === null ? null : { query_id: 'x', query, demand_score: priorDemand, status: 'watch', trend: 'flat' },
})
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

test('orderForProbing: prior demand, then gap, transcript, room signal, then the rest', () => {
  const list = [pq('seed one?', 'seed'), pq('gap one?', 'gap'), pq('prior low?', 'seed', 20), pq('transcript one?', 'transcript'), pq('prior high?', 'seed', 70), pq('room one?', 'room_signal'), pq('striking one?', 'striking_distance'), pq('carry one?', 'watch_carry')]
  assert.deepEqual(orderForProbing(list).map(q => q.query), ['prior high?', 'prior low?', 'gap one?', 'transcript one?', 'room one?', 'striking one?', 'carry one?', 'seed one?'])
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
  const ledger = new Ledger(0.05, { perplexity: 0.02, chatgpt: 0.02, claude: 0.02, grok: 0.02, classify: 0, themes: 0, propose: 0, digest: 0 })
  const list = [pq('one?', 'seed'), pq('two?', 'seed'), pq('three?', 'seed')]
  const out = await probeQueries(engines, list, ['mindmake.co'], ledger, [], 2)
  assert.equal(out.probes, 2)
  assert.equal(out.probes_skipped_cap, 2, 'the two pairs of the second query')
  assert.equal(out.probesByQuery.has(list[2].query_id), false, 'over the per-subject cap, not counted against the usd cap')
  assert.equal(engines[0].asked.length + engines[1].asked.length, 2)
})
