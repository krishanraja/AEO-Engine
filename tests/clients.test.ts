import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AnthropicClient } from '../src/clients/anthropic.js'
import { ControlCenterHttp } from '../src/clients/controlCenter.js'
import { FirefliesHttp } from '../src/clients/fireflies.js'
import { OpenAIClient } from '../src/clients/openai.js'
import { PerplexityClient } from '../src/clients/perplexity.js'
import { FirefliesUnavailable } from '../src/clients/types.js'
import { XaiClient } from '../src/clients/xai.js'
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

test('perplexity: text and citations, from citations or search_results', async () => {
  const p = new PerplexityClient('k')
  const a = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'answer' } }], citations: ['https://a.example', 7] } }], () => p.ask('q'))
  assert.deepEqual(a.result, { text: 'answer', citations: ['https://a.example'] })
  assert.equal(body(a.calls[0]).model, 'sonar')
  const b = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'answer' } }], search_results: [{ url: 'https://b.example' }] } }], () => p.ask('q'))
  assert.deepEqual(b.result.citations, ['https://b.example'])
  await assert.rejects(withFetch([{ status: 500, body: {} }], () => p.ask('q')), /perplexity_500/)
})

test('openai responses: message text and url_citation annotations', async () => {
  const o = new OpenAIClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: 'part one', annotations: [{ type: 'url_citation', url: 'https://a.example' }, { type: 'file_citation' }] }, { type: 'output_text', text: 'part two', annotations: [{ type: 'url_citation', url: 'https://a.example' }] }] },
  ] } }], () => o.ask('q'))
  assert.deepEqual(result, { text: 'part one\npart two', citations: ['https://a.example'] })
  assert.deepEqual(body(calls[0]).tools, [{ type: 'web_search' }])
  assert.equal(header(calls[0], 'authorization'), 'Bearer k')
})

test('anthropic: web search citations from text blocks and tool results; json calls run with thinking off', async () => {
  const a = new AnthropicClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { stop_reason: 'end_turn', content: [
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://r.example/1' }, { type: 'web_search_result', url: 'https://r.example/2' }] },
    { type: 'text', text: 'the answer', citations: [{ type: 'web_search_result_location', url: 'https://r.example/1' }, { type: 'char_location' }] },
  ] } }], () => a.ask('q'))
  assert.deepEqual(result, { text: 'the answer', citations: ['https://r.example/1', 'https://r.example/2'] })
  assert.equal(header(calls[0], 'anthropic-version'), '2023-06-01')
  assert.equal(header(calls[0], 'x-api-key'), 'k')
  assert.equal(body(calls[0]).tools[0].name, 'web_search')
  assert.equal(body(calls[0]).tools[0].max_uses, 5)
  const j = await withFetch([{ status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] } }], () => a.classify('sys', 'user', 300))
  assert.equal(j.result, '{"a":1}')
  assert.deepEqual(body(j.calls[0]).thinking, { type: 'disabled' })
  assert.equal(body(j.calls[0]).system, 'sys')
  assert.equal(body(j.calls[0]).max_tokens, 300)
  const paused = await withFetch([
    { status: 200, body: { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'first' }] } },
    { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'second' }] } },
  ], () => a.ask('q'))
  assert.equal(paused.result.text, 'first\nsecond')
  assert.equal(paused.calls.length, 2)
})

test('xai: live search parameters and citations', async () => {
  const x = new XaiClient('k')
  const { result, calls } = await withFetch([{ status: 200, body: { choices: [{ message: { content: 'grok says' } }], citations: ['https://g.example'] } }], () => x.ask('q'))
  assert.deepEqual(result, { text: 'grok says', citations: ['https://g.example'] })
  assert.deepEqual(body(calls[0]).search_parameters, { mode: 'auto', return_citations: true })
  assert.equal(body(calls[0]).model, 'grok-4')
})
