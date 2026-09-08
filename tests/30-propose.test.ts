import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OfflineModel } from '../src/clients/offline.js'
import { uuidFromKey } from '../src/index.js'
import { Ledger } from '../src/lib/cost.js'
import { gapFor } from '../src/pipeline/20-gap.js'
import { deterministicCandidates, proposeQueries } from '../src/pipeline/30-propose.js'
import { FIXTURES, StubModel, fixtureContext, subject } from './helpers.js'

const ctx = fixtureContext()
const ctrl = subject('ctrl')
const gap = gapFor(ctrl, ['ctrl.mindmake.co', 'mindmake.co'])

test('the fixture proposal: dedupe, carried ids, touchpoint ids', async () => {
  const ledger = new Ledger(10)
  const out = await proposeQueries(new OfflineModel(FIXTURES), ledger, ctrl, ctx, [], gap, uuidFromKey)
  assert.equal(out.length, 24, 'one seed copy of a transcript query was dropped')
  assert.equal(new Set(out.map(q => q.norm)).size, out.length)
  assert.equal(new Set(out.map(q => q.query_id)).size, out.length)
  const carried = out.filter(q => q.prior)
  assert.equal(carried.length, 3)
  const writeLikeMe = out.find(q => q.query === 'How do I get an AI assistant to write like me?')!
  assert.equal(writeLikeMe.query_id, 'b1000000-0000-4000-8000-000000000001')
  assert.equal(writeLikeMe.touchpoint_id, 'a1000000-0000-4000-8000-000000000001', 'attached by normalised match to the map question')
  assert.equal(writeLikeMe.source, 'transcript')
  assert.equal(out.find(q => q.query === 'Should I build my own AI skill?')?.source, 'watch_carry')
  assert.equal(ledger.summary().by_kind.propose.calls, 1)
  const fresh = out.find(q => !q.prior)!
  assert.equal(fresh.query_id, uuidFromKey(`${ctrl.id}|${fresh.norm}`))
})

test('the model prompt carries every input and the prospect instruction', async () => {
  const model = new StubModel('{"queries":[]}')
  await proposeQueries(model, new Ledger(10), subject('sample-media'), ctx, [], gapFor(subject('sample-media'), ['mindmake.co']), uuidFromKey)
  const req = model.requests[0]
  assert.match(req.system, /never a question about Mindmake/)
  assert.ok(req.user.includes('"room_target"'))
  assert.ok(req.user.includes('Announced a newsroom AI working group'))
  assert.ok(req.user.includes('room_face_icp'))
})

test('a failed or empty model falls back to the deterministic inputs', async () => {
  const out = await proposeQueries(new StubModel('THROW'), new Ledger(10), ctrl, ctx, [], gap, uuidFromKey)
  const cands = deterministicCandidates(ctrl, gap)
  assert.equal(cands.length, 9)
  assert.equal(out.length, 6, 'duplicates across gap, watch list and touchpoints collapse')
  assert.deepEqual(out.map(q => q.source), ['gap', 'gap', 'striking_distance', 'striking_distance', 'striking_distance', 'seed'])
  assert.equal(out[0].query_id, 'b1000000-0000-4000-8000-000000000001')
})

test('bad sources become seed, short queries are dropped, the list is capped at 40', async () => {
  const many = { queries: Array.from({ length: 60 }, (_, i) => ({ query: `How do I do thing word${i} well?`, source: i === 0 ? 'bogus' : 'seed', touchpoint_id: i === 1 ? 'a1000000-0000-4000-8000-000000000002' : 'not-a-known-id' })) }
  many.queries.push({ query: 'x', source: 'seed', touchpoint_id: null as unknown as string })
  const out = await proposeQueries(new StubModel(JSON.stringify(many)), new Ledger(10), ctrl, ctx, [], gap, uuidFromKey)
  assert.equal(out.length, 40)
  assert.equal(out[0].source, 'seed')
  assert.equal(out[1].touchpoint_id, 'a1000000-0000-4000-8000-000000000002')
  assert.equal(out[2].touchpoint_id, null)
})
