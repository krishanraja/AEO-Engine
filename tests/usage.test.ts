import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageMeter, providerSearchCalls, tokensOf, type BillingRow } from '../src/lib/usage.js'
import { MeteredEngine } from '../src/clients/metered.js'
import type { EngineClient } from '../src/clients/types.js'

// The engine reported spend from lib/cost.ts, which charges a flat estimate per
// call BEFORE the call is made. Its own comment says those are estimates to be
// tuned from real ledgers. So the only cost figure leaving this repo was a
// guess, and posting it to the usage meter would have dressed a guess as a
// measurement, in the one table built to be believed about money.
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

// The four writing stages have very different appetites (the digest is the
// expensive one), and a single aeo-engine row could never have said which.
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

// Hosted web searches are billed per request beside the tokens. The meter
// counts them from usage.server_tool_use, and leaves the posted row as it was:
// that shape is Control Center's, and the count travels in the sealed run
// summary until Control Center says its reader takes it.
test('web search requests are counted by unit and kept out of the posted row', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100, { server_tool_use: { web_search_requests: 2 } }))
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100, { server_tool_use: { web_search_requests: 1 } }))
  m.record('aeo-digest', 'claude-sonnet-5', usage(1000, 100))
  assert.equal(m.searches, 3)
  assert.equal(m.searchesBy('aeo-probe'), 3)
  assert.equal(m.searchesBy('aeo-digest'), 0)
  for (const row of m.rows()) assert.ok(!('server_tool_use' in row.usage) && !('searches' in row))
})

// The Claude Code lane runs on the subscription: its tokens are recorded and
// counted, and never posted as a row Control Center would price at API rates.
test('subscription billing: recorded and counted, never in the posted rows, never a billed search', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100, { server_tool_use: { web_search_requests: 2 } }))
  m.record('aeo-probe', 'claude-code/claude-sonnet-5', usage(5000, 400, { server_tool_use: { web_search_requests: 3 } }), false, 'subscription')
  m.record('aeo-probe', 'claude-code/claude-sonnet-5', usage(100, 0), true, 'subscription')
  assert.deepEqual(m.rows().map(r => r.model), ['claude-sonnet-5'])
  assert.equal(m.calls, 1)
  assert.equal(m.tokens, 1100)
  assert.equal(m.subscriptionCalls, 2)
  assert.equal(m.subscriptionTokens, 5500)
  assert.equal(m.subscriptionRows()[0].failed, 1)
  assert.equal(m.searchesBy('aeo-probe'), 2, 'only the API lane\'s searches are billed per request')
})

// ---------- billing rows (AEO brief, section F) ----------

test('tokens out of every provider\'s own usage shape', () => {
  assert.deepEqual(tokensOf({ input_tokens: 10, output_tokens: 4, total_tokens: 14 }), { input: 10, output: 4 }, 'OpenAI Responses')
  assert.deepEqual(tokensOf({ prompt_tokens: 7, completion_tokens: 3 }), { input: 7, output: 3 }, 'Perplexity and xAI')
  assert.deepEqual(tokensOf({ promptTokenCount: 9, candidatesTokenCount: 5, thoughtsTokenCount: 2 }), { input: 9, output: 7 }, 'Gemini, its thinking billed as output')
  assert.deepEqual(tokensOf(undefined), { input: 0, output: 0 })
  assert.deepEqual(tokensOf({ prompt_tokens: 'many' }), { input: 0, output: 0 })
})

test('until the context lists meter_billing, the posted rows are exactly the first shape', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100, { server_tool_use: { web_search_requests: 3 } }))
  m.record('aeo-probe', 'claude-sonnet-5', usage(500, 50), false, 'subscription')
  m.recordProvider('openai', 'aeo-probe', 'gpt-5', { input_tokens: 10, output_tokens: 4 })
  assert.equal(m.billingAccepted, false)
  assert.deepEqual(m.postRows(), m.rows())
  m.acceptBilling(['kits', 'site'])
  assert.deepEqual(m.postRows(), m.rows(), 'another feature opens nothing')
  m.acceptBilling('meter_billing')
  assert.equal(m.billingAccepted, false, 'a misshapen list opens nothing')
})

test('once it does: Anthropic API rows with their searches, subscription tokens, and every other provider\'s probes', () => {
  const m = new UsageMeter()
  m.record('aeo-probe', 'claude-sonnet-5', usage(1000, 100, { server_tool_use: { web_search_requests: 3 } }))
  m.record('aeo-probe', 'claude-sonnet-5', usage(2000, 200, { server_tool_use: { web_search_requests: 2 } }))
  m.record('aeo-digest', 'claude-sonnet-5', usage(800, 300))
  m.record('aeo-probe', 'claude-sonnet-5', usage(500, 50, { server_tool_use: { web_search_requests: 9 } }), false, 'subscription')
  m.recordProvider('openai', 'aeo-probe', 'gpt-5', { input_tokens: 10, output_tokens: 4 })
  m.recordProvider('openai', 'aeo-probe', 'gpt-5', undefined, true)
  m.recordProvider('google', 'aeo-probe', 'gemini-3.6-flash', { promptTokenCount: 9, candidatesTokenCount: 5 })
  m.recordProvider('xai', 'aeo-probe', 'grok-4', undefined)
  m.acceptBilling(['probe_detail', 'meter_billing'])
  const rows = m.postRows() as Array<Record<string, unknown>>
  assert.deepEqual(rows.map(r => [r.provider, r.billing, r.agent, r.model, r.calls, r.failed, r.search_calls ?? null, r.input_tokens ?? null, r.output_tokens ?? null]), [
    ['anthropic', 'api', 'aeo-probe', 'claude-sonnet-5', 2, 0, 5, null, null],
    ['anthropic', 'api', 'aeo-digest', 'claude-sonnet-5', 1, 0, 0, null, null],
    ['anthropic', 'subscription', 'aeo-probe', 'claude-sonnet-5', 1, 0, null, 500, 50],
    ['openai', 'api', 'aeo-probe', 'gpt-5', 2, 1, null, 10, 4],
    ['google', 'api', 'aeo-probe', 'gemini-3.6-flash', 1, 0, null, 9, 5],
  ], 'a subscription search is never a billed one; a call with neither a token nor a failure is not posted')
  assert.equal((rows[0].usage as { input_tokens: number }).input_tokens, 3000, "the API row keeps Anthropic's own usage object")
  assert.equal(m.searchesBy('aeo-probe'), 5)
  assert.equal(m.providerCalls, 4)
})

test('a metered engine records its provider\'s tokens, counts a throw as a failed call, and is otherwise the engine it wraps', async () => {
  const m = new UsageMeter()
  let fail = false
  const inner: EngineClient = {
    engine: 'chatgpt', model: 'gpt-5', exhausted: false,
    async ask() {
      if (fail) throw new Error('openai_429')
      return { text: 'x', citations: [], usage: { input_tokens: 12, output_tokens: 6 } }
    },
  }
  const e = new MeteredEngine(inner, 'openai', m)
  assert.deepEqual([e.engine, e.model, e.exhausted, e.client], ['chatgpt', 'gpt-5', false, inner])
  const a = await e.ask('q')
  assert.equal(a.text, 'x')
  fail = true
  await assert.rejects(e.ask('q'), /openai_429/)
  m.acceptBilling(['meter_billing'])
  assert.deepEqual(m.postRows(), [{ provider: 'openai', billing: 'api', agent: 'aeo-probe', model: 'gpt-5', input_tokens: 12, output_tokens: 6, calls: 2, failed: 1 }])
})

// ---------- search calls billed per call by the other providers (audit ai-cost-6) ----------

test('providerSearchCalls: OpenAI tool calls, xAI sources used, Gemini queries; Perplexity never', () => {
  assert.equal(providerSearchCalls('openai', { search_calls: 3 }), 3)
  assert.equal(providerSearchCalls('openai', {}), 0)
  assert.equal(providerSearchCalls('xai', { usage: { num_sources_used: 7 } }), 7)
  assert.equal(providerSearchCalls('google', { fan_out: ['a', 'b'] }), 2)
  assert.equal(providerSearchCalls('perplexity', { search_calls: 4, usage: { num_search_queries: 2 } }), 0, 'its request fee is priced per call already')
})

test('a billing row carries the provider search calls, and none when zero', () => {
  const m = new UsageMeter()
  m.acceptBilling(['meter_billing'])
  m.recordProvider('openai', 'aeo-probe', 'gpt-5', { input_tokens: 10, output_tokens: 4 }, false, 2)
  m.recordProvider('openai', 'aeo-probe', 'gpt-5', { input_tokens: 10, output_tokens: 4 }, false, 1)
  m.recordProvider('perplexity', 'aeo-probe', 'sonar', { prompt_tokens: 5, completion_tokens: 5 })
  const rows = m.postRows() as BillingRow[]
  const openai = rows.find(r => r.provider === 'openai')!
  assert.equal((openai as { search_calls?: number }).search_calls, 3)
  assert.ok(!('search_calls' in rows.find(r => r.provider === 'perplexity')!))
  assert.equal(m.providerSearches, 3)
})

test('the metered engine counts the OpenAI answer search calls onto its row', async () => {
  const m = new UsageMeter()
  m.acceptBilling(['meter_billing'])
  const inner = { engine: 'chatgpt', model: 'gpt-5', costKind: 'chatgpt', async ask() { return { text: 't', citations: [], usage: { input_tokens: 1, output_tokens: 1 }, search_calls: 4 } } }
  await new MeteredEngine(inner as never, 'openai', m).ask('q')
  assert.equal(m.providerSearches, 4)
})
