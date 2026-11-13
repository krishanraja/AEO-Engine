import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CAPS } from '../src/config/run.js'
import { AnthropicClient, parseTurns, webSearchRequests } from '../src/clients/anthropic.js'
import { ControlCenterHttp } from '../src/clients/controlCenter.js'
import { FirefliesHttp } from '../src/clients/fireflies.js'
import { OpenAIClient, parseResponse as parseOpenAI, PROBE_TIMEOUT_MS as OPENAI_PROBE_TIMEOUT_MS } from '../src/clients/openai.js'
import { markerOrder, parseCompletion, PerplexityClient } from '../src/clients/perplexity.js'
import { FirefliesUnavailable } from '../src/clients/types.js'
import { XaiClient } from '../src/clients/xai.js'
import { UsageMeter } from '../src/lib/usage.js'
import type { AeoPacket } from '../src/schema/packet.js'
import { readJson } from './helpers.js'

interface Canned { status: number; body: unknown; headers?: Record<string, string> }
interface Call { url: string; init: RequestInit }

/** Replace global fetch for one test; returns the calls made. */
async function withFetch<T>(responses: Canned[], fn: () => Promise<T>): Promise<{ result: T; calls: Call[] }> {
  const calls: Call[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = responses.shift()
    if (!r) throw new Error('no canned response left')
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } })
  }) as typeof fetch
  try {
    return { result: await fn(), calls }
  } finally {
    globalThis.fetch = real
  }
}

const body = (c: Call) => JSON.parse(String(c.init.body))
const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]

test('control center: bearer on every call, a 429 is retried once after Retry-After', async () => {
  const slept: number[] = []
  const cc = new ControlCenterHttp('https://cc.example/', 'the-secret-value', async ms => { slept.push(ms) })
  const packet = readJson('expected/packet.ctrl.json') as AeoPacket
  const { result, calls } = await withFetch([{ status: 429, body: {}, headers: { 'retry-after': '2' } }, { status: 200, body: { ok: true, deduped: false, replaced: true } }], () => cc.postIngest(packet))
  assert.equal(result.ok, true)
  assert.equal(result.replaced, true)
  assert.deepEqual(slept, [2000])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://cc.example/api/aeo/ingest')
  assert.equal(header(calls[0], 'authorization'), 'Bearer the-secret-value')
  const bad = await withFetch([{ status: 400, body: { ok: false, error: 'invalid_packet', errors: ['packet.x: no'] } }], () => cc.postIngest(packet))
  assert.deepEqual(bad.result, { ok: false, status: 400, error: 'invalid_packet', errors: ['packet.x: no'] })
  await assert.rejects(withFetch([{ status: 401, body: {} }], () => cc.postIngest(packet)), /unauthorized/)
  const ctx = await withFetch([{ status: 200, body: { ok: true, subjects: [] } }], () => cc.getContext('all'))
  assert.equal(ctx.calls[0].url, 'https://cc.example/api/aeo/context?subject=all')
  const patch = await withFetch([{ status: 200, body: { ok: true } }], () => cc.patchCommand({ command_id: 4, state: 'failed', error: 'x' }))
  assert.equal(patch.calls[0].init.method, 'PATCH')
  assert.deepEqual(body(patch.calls[0]), { command_id: 4, state: 'failed', error: 'x' })
})

test('fireflies: every failure is FirefliesUnavailable; dates are normalised', async () => {
  await assert.rejects(new FirefliesHttp(undefined).listTranscripts('a', 'b'), FirefliesUnavailable)
  const ff = new FirefliesHttp('key-value')
  await assert.rejects(withFetch([{ status: 500, body: {} }], () => ff.listTranscripts('a', 'b')), FirefliesUnavailable)
  await assert.rejects(withFetch([{ status: 200, body: { errors: [{ message: 'nope' }] } }], () => ff.listTranscripts('a', 'b')), /graphql: nope/)
  const { result, calls } = await withFetch([{ status: 200, body: { data: { transcripts: [{ id: 't1', title: 'Call', date: Date.UTC(2026, 8, 3, 12), participants: ['x@example.com'] }] } } }], () => ff.listTranscripts('2026-09-01T00:00:00Z', '2026-09-08T00:00:00Z'))
  assert.equal(result[0].date, '2026-09-03T12:00:00.000Z')
  assert.equal(header(calls[0], 'authorization'), 'Bearer key-value')
  assert.deepEqual(body(calls[0]).variables, { fromDate: '2026-09-01T00:00:00Z', toDate: '2026-09-08T00:00:00Z', limit: 50 })
  const t = await withFetch([{ status: 200, body: { data: { transcript: { id: 't1', title: 'Call', date: '2026-09-03T12:00:00.000Z', sentences: [{ text: 'hi', speaker_name: 'A' }], summary: { overview: 'o', keywords: ['k'], action_items: 'one' } } } } }], () => ff.getTranscript('t1'))
  assert.deepEqual(t.result.summary, { overview: 'o', keywords: ['k'], action_items: ['one'] })
  assert.equal(t.result.sentences.length, 1)
})

test('perplexity: inline citations by first [n] marker, the source list as retrieved, always searched', async () => {
  const p = new PerplexityClient('k')
  const a = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'answer' } }], citations: ['https://a.example', 7] } }], () => p.ask('q'))
  assert.deepEqual(a.result, { text: 'answer', citations: ['https://a.example'], retrieved: ['https://a.example'], searched: true })
  assert.equal(body(a.calls[0]).model, 'sonar')
  const b = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'answer' } }], search_results: [{ url: 'https://b.example' }] } }], () => p.ask('q'))
  assert.deepEqual(b.result.citations, ['https://b.example'])
  assert.deepEqual(b.result.retrieved, ['https://b.example'])
  await assert.rejects(withFetch([{ status: 500, body: {} }], () => p.ask('q')), /perplexity_500/)
})

test('perplexity: markers order the citations, each once, and a marker past the list is skipped', () => {
  const sources = ['https://one.example', 'https://two.example', 'https://three.example', 'https://four.example']
  const r = parseCompletion({
    choices: [{ message: { content: 'Start with this [3]. Then this [1][3]. Both agree [2, 3]. Not real [9].' } }],
    citations: sources,
    search_results: sources.map(url => ({ url, title: 't' })),
    usage: { prompt_tokens: 10 },
  })
  assert.deepEqual(r.citations, ['https://three.example', 'https://one.example', 'https://two.example'], 'four was never cited in the text')
  assert.deepEqual(r.retrieved, sources)
  assert.equal(r.searched, true)
  assert.deepEqual(r.usage, { prompt_tokens: 10 })
  assert.deepEqual(markerOrder('a [2] b [1][2] c'), [2, 1])
  assert.deepEqual(parseCompletion({ choices: [{ message: { content: 'no markers' } }], citations: ['https://x.example', 'https://y.example', 'https://x.example'] }).citations, ['https://x.example', 'https://y.example'], 'no marker: the list order, each once')
})

test('openai responses: the search is forced, sources are asked for, and annotations order the citations', async () => {
  const o = new OpenAIClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { output: [
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'first query', sources: [{ type: 'url', url: 'https://s1.example' }, { type: 'url', url: 'https://a.example' }] } },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'second query', queries: ['second query', 'third query'] } },
    { type: 'message', content: [
      { type: 'output_text', text: 'part one', annotations: [{ type: 'url_citation', url: 'https://late.example', start_index: 40, end_index: 50 }, { type: 'url_citation', url: 'https://a.example', start_index: 3, end_index: 9 }, { type: 'file_citation' }] },
      { type: 'output_text', text: 'part two', annotations: [{ type: 'url_citation', url: 'https://a.example', start_index: 0, end_index: 4 }, { type: 'url_citation', url: 'https://b.example', start_index: 5, end_index: 8 }] },
    ] },
  ], usage: { input_tokens: 12, output_tokens: 34 } } }], () => o.ask('q'))
  assert.equal(result.text, 'part one\npart two')
  assert.deepEqual(result.citations, ['https://a.example', 'https://late.example', 'https://b.example'], 'by start_index within a part, parts in order, each URL once')
  assert.deepEqual(result.retrieved, ['https://s1.example', 'https://a.example'])
  assert.deepEqual(result.fan_out, ['first query', 'second query', 'third query'])
  assert.equal(result.searched, true)
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 34 })
  const sent = body(calls[0])
  assert.deepEqual(sent.tools, [{ type: 'web_search' }])
  assert.equal(sent.tool_choice, 'required')
  assert.deepEqual(sent.include, ['web_search_call.action.sources'])
  assert.equal(header(calls[0], 'authorization'), 'Bearer k')
  // Every probe now searches, so it gets the search turn's four minutes, not the 120s default.
  assert.equal(OPENAI_PROBE_TIMEOUT_MS, 240_000)
})

test('openai responses: an answer with no search call says so, and odd shapes are skipped, never guessed', () => {
  const r = parseOpenAI({ output: [
    { type: 'web_search_call', action: { type: 'open_page', url: 'https://opened.example' } },
    { type: 'web_search_call', action: 'not an object' },
    { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'x', annotations: 'nope' }] },
    'junk',
  ] })
  assert.equal(r.searched, true)
  assert.deepEqual(r.retrieved, ['https://opened.example'])
  assert.deepEqual(r.citations, [])
  assert.equal(r.text, 'x')
  assert.equal(r.usage, undefined)
  const memory = parseOpenAI({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'from memory', annotations: [] }] }] })
  assert.equal(memory.searched, false)
  assert.deepEqual(memory.fan_out, [])
})

test('anthropic: citations are the inline ones only, search results are retrieved, and max_uses is the cap', async () => {
  const a = new AnthropicClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 6, server_tool_use: { web_search_requests: 1 } }, content: [
    { type: 'server_tool_use', name: 'web_search', input: { query: 'what to search' } },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://r.example/1' }, { type: 'web_search_result', url: 'https://r.example/2' }] },
    { type: 'text', text: 'the answer', citations: [{ type: 'web_search_result_location', url: 'https://r.example/2' }, { type: 'char_location' }] },
    { type: 'text', text: 'more', citations: [{ type: 'web_search_result_location', url: 'https://r.example/1' }, { type: 'web_search_result_location', url: 'https://r.example/2' }] },
  ] } }], () => a.ask('q'))
  assert.deepEqual(result.citations, ['https://r.example/2', 'https://r.example/1'], 'the text cites 2 first, though the search returned 1 first')
  assert.deepEqual(result.retrieved, ['https://r.example/1', 'https://r.example/2'])
  assert.deepEqual(result.fan_out, ['what to search'])
  assert.equal(result.searched, true)
  assert.equal(result.text, 'the answer\nmore')
  assert.equal(header(calls[0], 'anthropic-version'), '2023-06-01')
  assert.equal(header(calls[0], 'x-api-key'), 'k')
  assert.equal(body(calls[0]).tools[0].name, 'web_search')
  assert.equal(body(calls[0]).tools[0].max_uses, CAPS.CLAUDE_API_SEARCH_MAX_USES)
  assert.equal(body(calls[0]).tools[0].max_uses, 2)
  const j = await withFetch([{ status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] } }], () => a.classify('sys', 'user', 300))
  assert.equal(j.result, '{"a":1}')
  assert.deepEqual(body(j.calls[0]).thinking, { type: 'disabled' })
  assert.equal(body(j.calls[0]).system, 'sys')
  assert.equal(body(j.calls[0]).max_tokens, 300)
})

test('anthropic: a paused search is read across its turns, and the meter counts each turn and its searches', async () => {
  const meter = new UsageMeter()
  const a = new AnthropicClient('k', meter)
  const paused = await withFetch([
    { status: 200, body: { stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 1, server_tool_use: { web_search_requests: 1 } }, content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'one' } },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://p.example/a' }] },
      { type: 'text', text: 'first', citations: [{ type: 'web_search_result_location', url: 'https://p.example/a' }] },
    ] } },
    { status: 200, body: { stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 2, server_tool_use: { web_search_requests: 1 } }, content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'two' } },
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: 'second', citations: [{ type: 'web_search_result_location', url: 'https://p.example/b' }, { type: 'web_search_result_location', url: 'https://p.example/a' }] },
    ] } },
  ], () => a.ask('q'))
  assert.equal(paused.result.text, 'first\nsecond')
  assert.equal(paused.calls.length, 2)
  assert.deepEqual(paused.result.citations, ['https://p.example/a', 'https://p.example/b'])
  assert.deepEqual(paused.result.retrieved, ['https://p.example/a'], 'an error result carries no list')
  assert.deepEqual(paused.result.fan_out, ['one', 'two'])
  assert.equal(body(paused.calls[1]).messages[1].role, 'assistant', 'the paused turn is sent back to resume')
  assert.equal(meter.calls, 2)
  assert.equal(meter.searchesBy('aeo-probe'), 2)
  assert.deepEqual(Object.keys(meter.rows()[0].usage).sort(), ['cache_creation', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'input_tokens', 'output_tokens'], 'the posted row keeps its shape')
})

test('anthropic: an answer with no search and no citation reads as not searched; a billed search alone reads as searched', () => {
  const none = parseTurns([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'from memory' }] }])
  assert.equal(none.searched, false)
  assert.deepEqual(none.citations, [])
  assert.equal(webSearchRequests({ server_tool_use: { web_search_requests: 3 } }), 3)
  assert.equal(webSearchRequests({ server_tool_use: { web_search_requests: 'x' } }), 0)
  const fromCode = parseTurns([{ usage: { server_tool_use: { web_search_requests: 1 } }, content: [{ type: 'text', text: 'filtered' }] }])
  assert.equal(fromCode.searched, true, 'dynamic filtering can search from code without a web_search block')
})

test('xai: live search parameters and citations', async () => {
  const x = new XaiClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'grok says' } }], citations: ['https://g.example'] } }], () => x.ask('q'))
  assert.deepEqual(result, { text: 'grok says', citations: ['https://g.example'], retrieved: ['https://g.example'], searched: true })
  const quiet = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'memory' } }], usage: { num_sources_used: 0 } } }], () => x.ask('q'))
  assert.equal(quiet.result.searched, false)
  assert.deepEqual(body(calls[0]).search_parameters, { mode: 'auto', return_citations: true })
  assert.equal(body(calls[0]).model, 'grok-4')
})
