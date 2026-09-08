import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { readJson } from './helpers.js'

const load = () => structuredClone(readJson('expected/packet.ctrl.json')) as AeoPacket

function errorsOf(p: unknown): string[] {
  const v = validatePacket(p)
  return v.ok ? [] : v.errors
}

test('the expected ctrl packet validates', () => {
  const v = validatePacket(load())
  assert.equal(v.ok, true, JSON.stringify(v))
})

test('rejects an em dash anywhere', () => {
  const p = load()
  p.strongest_signal = 'One thing \u2014 another'
  assert.ok(errorsOf(p).some(e => e.includes('strongest_signal') && e.includes('em dash')))
})

test('rejects an email address anywhere', () => {
  const p = load()
  p.themes[0].evidence[0].paraphrase = 'They said write to someone@example.com for the deck'
  assert.ok(errorsOf(p).some(e => e.includes('paraphrase') && e.includes('email')))
})

test('rejects an @handle anywhere', () => {
  const p = load()
  p.queries[0].query = 'What does @someone think of AI writing?'
  assert.ok(errorsOf(p).some(e => e.includes('queries[0].query') && e.includes('@handle')))
})

test('rejects bad uuids and dates', () => {
  const p = load()
  p.run_id = 'not-a-uuid'
  p.week_start = '2026-9-7'
  p.themes[0].evidence[0].call_ref = 'ff-7c1e2a'
  const errs = errorsOf(p)
  assert.ok(errs.some(e => e.startsWith('run_id')))
  assert.ok(errs.some(e => e.startsWith('week_start')))
  assert.ok(errs.some(e => e.includes('call_ref')))
})

test('week_start must be a Monday', () => {
  const p = load()
  p.week_start = '2026-09-08'
  assert.ok(errorsOf(p).some(e => e.includes('Monday')))
})

test('enums, ranges and caps', () => {
  const p = load()
  ;(p.queries[0] as unknown as Record<string, unknown>).status = 'maybe'
  p.queries[1].demand_score = 101
  p.queries[2].demand_basis.llm_demand = 41
  p.queries[3].probes[0].citations = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`)
  p.queries[4].probes[0].answer_snapshot = 'x'.repeat(1801)
  ;(p as unknown as Record<string, unknown>).extra = 1
  const errs = errorsOf(p)
  assert.ok(errs.some(e => e.includes('queries[0].status')))
  assert.ok(errs.some(e => e.includes('queries[1].demand_score')))
  assert.ok(errs.some(e => e.includes('queries[2].demand_basis.llm_demand')))
  assert.ok(errs.some(e => e.includes('queries[3].probes[0].citations')))
  assert.ok(errs.some(e => e.includes('queries[4].probes[0].answer_snapshot')))
  assert.ok(errs.some(e => e.includes('unexpected key "extra"')))
})

test('the rules Control Center adds beyond the schema', () => {
  const p = load()
  p.subject.product_slug = null
  p.themes_status = 'no_calls'
  p.recommendations[0].query_id = '00000000-0000-4000-8000-000000000000'
  p.queries[1].query_id = p.queries[0].query_id
  p.playbook = []
  p.approach_hook = 'hello'
  const errs = errorsOf(p)
  assert.ok(errs.some(e => e.includes('a venture must name its product slug')))
  assert.ok(errs.some(e => e.includes('must be empty unless themes_status is ok')))
  assert.ok(errs.some(e => e.includes("not one of the packet's queries")))
  assert.ok(errs.some(e => e.includes('repeated')))
  assert.ok(errs.some(e => e.startsWith('playbook')))
  assert.ok(errs.some(e => e.startsWith('approach_hook')))
})

test('a non-object is refused with one error', () => {
  const v = validatePacket('nope')
  assert.equal(v.ok, false)
})
