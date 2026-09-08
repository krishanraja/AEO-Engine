import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normaliseQuery } from '../src/lib/text.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import type { ProbeOutcome } from '../src/pipeline/40-probe.js'
import { LABEL_PROXIES, LABEL_VOLUME, assignStatus, callEvidenceFor, scoreQueries } from '../src/pipeline/50-score.js'
import type { Engine, PacketQuery, Probe, Theme } from '../src/schema/packet.js'
import { subject } from './helpers.js'

const ctrl = subject('ctrl')
const OURS = ['ctrl.mindmake.co', 'mindmake.co']
let n = 0
const pq = (query: string, prior: number | null = null, source: ProposedQuery['source'] = 'seed'): ProposedQuery => ({
  query_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, query, source, touchpoint_id: null, norm: normaliseQuery(query),
  prior: prior === null ? null : { query_id: 'p', query, demand_score: prior, status: 'watch', trend: 'flat' },
})
const probe = (engine: Engine, we_cited: boolean, chars = 300, cites = 2): Probe => ({
  engine, model: 'm', question: 'q', answer_snapshot: 'x'.repeat(chars), we_cited,
  citations: Array.from({ length: cites }, (_, i) => `https://host${i}.example/p`), cost_usd: 0.01,
})
const outcome = (rows: Array<[ProposedQuery, Probe[]]>): ProbeOutcome => ({ probesByQuery: new Map(rows.map(([q, p]) => [q.query_id, p])), probes: 0, probes_failed: 0, probes_skipped_cap: 0 })
const themes: Theme[] = [{ theme: 'How do I get an AI assistant to write in my own voice', calls: 1, evidence: [{ call_ref: 'abcdef12', date: '2026-09-03', paraphrase: 'p1' }, { call_ref: 'abcdef12', date: '2026-09-03', paraphrase: 'p2' }] }]

test('llm_demand: ten per substantive, cited answer, capped at forty', () => {
  const q = pq('Anything at all here?')
  const rows = scoreQueries([q], outcome([[q, [probe('perplexity', false), probe('chatgpt', false, 100), probe('claude', false, 300, 1), probe('grok', false)]]]), [], ctrl, OURS)
  assert.equal(rows[0].demand_basis.llm_demand, 20)
  assert.deepEqual(rows[0].demand_basis.labels, [LABEL_PROXIES])
  assert.deepEqual(rows[0].gap.competitor_domains, ['host0.example', 'host1.example'])
})

test('transcript_evidence: ten per matching evidence item, by theme overlap', () => {
  assert.equal(callEvidenceFor('How do I get an AI assistant to write like me?', themes).length, 2)
  assert.equal(callEvidenceFor('What is the weather?', themes).length, 0)
  const q = pq('How do I get an AI assistant to write like me?')
  const rows = scoreQueries([q], outcome([]), themes, ctrl, OURS)
  assert.equal(rows[0].demand_basis.transcript_evidence, 20)
  assert.equal(rows[0].demand_score, 20)
  assert.equal(rows[0].probes.length, 0)
})

test('rising_volume: striking distance rows by normalised equality, else the absent-to-cited flip', () => {
  const a = pq('What is a personal AI writing style?')
  const b = pq('How do I train an AI on my writing?')
  const c = pq('Is a custom GPT for my voice worth it?')
  const rows = scoreQueries([a, b, c], outcome([]), [], ctrl, OURS)
  const by = (q: ProposedQuery) => rows.find(r => r.query_id === q.query_id)!
  assert.equal(by(a).demand_basis.rising_volume, 30, 'volume 320 and position 18 to 14')
  assert.deepEqual(by(a).demand_basis.labels, [LABEL_PROXIES, LABEL_VOLUME])
  assert.equal(by(b).demand_basis.rising_volume, 15, 'volume 880, position worse')
  assert.equal(by(c).demand_basis.rising_volume, 0, 'no row matches this phrasing')

  const flip = pq('How do I get an AI assistant to write like me?', 45)
  const noPrior = pq('How do I get an AI assistant to write like me?')
  const r2 = scoreQueries([flip, noPrior], outcome([[flip, [probe('chatgpt', true)]], [noPrior, [probe('chatgpt', true)]]]), [], ctrl, OURS)
  assert.equal(r2.find(r => r.query_id === flip.query_id)!.demand_basis.rising_volume, 15, 'absent on chatgpt four weeks back, cited now')
  assert.equal(r2.find(r => r.query_id === noPrior.query_id)!.demand_basis.rising_volume, 0, 'no prior row, no flip')
  assert.deepEqual(r2.find(r => r.query_id === flip.query_id)!.gap.we_cited_engines, ['chatgpt'])
})

test('trend against the prior score', () => {
  const up = pq('Up one two three?', 10), down = pq('Down one two three?', 50), flat = pq('Flat one two three?', 25), fresh = pq('New one two three?')
  const three = () => [probe('perplexity', false), probe('chatgpt', false), probe('claude', false)]
  const rows = scoreQueries([up, down, flat, fresh], outcome([[up, three()], [down, [probe('perplexity', false, 10)]], [flat, three()], [fresh, three()]]), [], ctrl, OURS)
  const t = (q: ProposedQuery) => rows.find(r => r.query_id === q.query_id)!.trend
  assert.equal(t(up), 'up')
  assert.equal(t(down), 'down')
  assert.equal(t(flat), 'flat')
  assert.equal(t(fresh), 'new')
})

test('status: recommend needs absence on two probed engines (or all when fewer), watch needs 30', () => {
  const mk = (score: number, probes: Probe[], id: number): PacketQuery => ({
    query_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, query: `q${id}`, source: 'seed', demand_score: score,
    demand_basis: { llm_demand: 0, transcript_evidence: 0, rising_volume: 0, labels: [] }, call_evidence: [],
    gap: { we_cited_engines: [], competitor_domains: [] }, trend: 'new', status: 'drop', touchpoint_id: null, probes,
  })
  const absent2 = () => [probe('perplexity', false), probe('chatgpt', false), probe('claude', true)]
  const cited2 = () => [probe('perplexity', true), probe('chatgpt', true), probe('claude', false)]
  const rows = [
    mk(90, cited2(), 1),             // watch: cited on two of three
    mk(80, absent2(), 2),            // recommend
    mk(70, [probe('grok', false)], 3), // recommend: the one probed engine is absent
    mk(60, [probe('grok', true)], 4),  // watch
    mk(20, absent2(), 5),            // recommend: third slot needs no score floor
    mk(20, absent2(), 6),            // drop: fourth slot needs 30
    mk(35, [], 7),                   // watch: not probed, cannot be recommended
    mk(10, [], 8),                   // drop
  ]
  assignStatus(rows)
  assert.deepEqual(rows.map(r => r.status), ['watch', 'recommend', 'recommend', 'watch', 'recommend', 'drop', 'watch', 'drop'])
})
