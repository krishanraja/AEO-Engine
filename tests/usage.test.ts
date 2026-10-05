import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageMeter } from '../src/lib/usage.js'

// The engine reported spend from lib/cost.ts, which charges a flat estimate per
// call BEFORE the call is made. Its own comment says those are estimates to be
// tuned from real ledgers. So the only cost figure leaving this repo was a
// guess, and posting it to the usage meter would have dressed a guess as a
// measurement — in the one table built to be believed about money.
//
// These pin the other half: what the responses actually said.

// Anthropic's usage object, as a probe turn returns it.
const usage = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...extra,
})

test('calls to one stage and model add up into one row', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100))
  m.record('aeo-probe', 'claude-sonnet-5', usage(2500, 250))
  const rows = m.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].usage.input_tokens, 3500)
  assert.equal(rows[0].usage.output_tokens, 350)
  assert.equal(rows[0].calls, 2)
})

// The four writing stages have very different appetites — the digest is the
// expensive one — and a single aeo-engine row could never have said which.
test('stages and models stay separate rows', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100))
  m.record('aeo-digest', 'claude-sonnet-5', usage(8000, 2000))
  m.record('aeo-digest', 'claude-opus-5', usage(500, 50))
  assert.equal(m.rows().length, 3)
  assert.equal(m.calls, 3)
})

// The wire shape is Anthropic's own, field for field, so the receiving end
// parses it with the same readUsage() it uses for a live call. If these names
// drift, the meter reads zeros and reports a free run.
test('the summed shape carries Anthropic\'s field names, cache fields included', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(100, 10, {
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
  }))
  const u = m.rows()[0].usage
  assert.equal(u.cache_read_input_tokens, 900)
  assert.equal(u.cache_creation_input_tokens, 40)
  assert.equal(u.cache_creation.ephemeral_5m_input_tokens, 40)
  assert.equal(u.cache_creation.ephemeral_1h_input_tokens, 0)
})

// A run that burned its budget on refusals must not read as a cheap run: the
// tokens were read and billed before the refusal came back.
test('a failed call is counted, not dropped', () => {
  const m = new UsageMeter()
  m.record('aeo-digest', 'claude-sonnet-5', usage(5000, 0), true)
  const [row] = m.rows()
  assert.equal(row.failed, 1)
  assert.equal(row.calls, 1)
  assert.equal(row.usage.input_tokens, 5000)
})

// A response with no usage object at all is the offline twin, or a provider
// that reports in its own shape. Reporting it as a zero row would be
// indistinguishable from a cheap call.
test('a row with no tokens is not reported at all', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', undefined)
  m.record('aeo-probe', 'claude-sonnet-5', { some: 'other shape' })
  assert.equal(m.rows().length, 0)
  assert.equal(m.tokens, 0)
  // The calls still happened, so the count still knows about them: "two calls,
  // no tokens measured" is a diagnosis, "nothing happened" is not.
  assert.equal(m.calls, 2)
})

test('a non-numeric field never becomes NaN in the total', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', { input_tokens: '900', output_tokens: 100 })
  const [row] = m.rows()
  assert.equal(row.usage.input_tokens, 0)
  assert.equal(row.usage.output_tokens, 100)
})
