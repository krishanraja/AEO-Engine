/**
 * The Claude Code lane, offline. A fake spawn plays synthetic stream-json
 * lines in the shape recorded from Claude Code 2.1.323 on 2026-11-13; no
 * line here is a real answer, and no test starts the CLI or touches a network.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { AnthropicClient } from '../src/clients/anthropic.js'
import {
  CHILD_ENV_KEYS, ClaudeCodeEngine, EMPTY_MCP_CONFIG, PROBE_SYSTEM_V1, ProbeRefused, SubscriptionLimit,
  childEnv, citeFromText, claudeCodeArgs, linksFrom, readProbeStream, urlsInText, type SpawnFn, type SpawnOptions,
} from '../src/clients/claudeCode.js'
import { GeminiClient } from '../src/clients/gemini.js'
import { CAPS, COMPARE_FIRST_RUN_UNTIL, MODELS, resolveClaudeLane } from '../src/config/run.js'
import { buildDeps, parseArgs } from '../src/index.js'
import { Ledger } from '../src/lib/cost.js'
import { normaliseQuery } from '../src/lib/text.js'
import { UsageMeter } from '../src/lib/usage.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import { probeQueries } from '../src/pipeline/40-probe.js'
import { StubEngine } from './helpers.js'
import { captureStderr } from './standin.js'

const TOKEN_ENV = { PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth-token' }

// ---------- synthetic events, in the recorded shape ----------

const INIT = (over: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'init', cwd: '/tmp/x', session_id: 's', tools: ['WebSearch'], mcp_servers: [], model: 'claude-sonnet-5', apiKeySource: 'none', ...over })
const SEARCH = (id: string, query: string) => ({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id, name: 'WebSearch', input: { query, allowed_domains: [] } }] } })
const RESULTS = (id: string, query: string, urls: string[]) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(urls.map(u => ({ title: 'Synthetic', url: u })))}` }] },
  tool_use_result: { query, results: [{ tool_use_id: 'srvtoolu_1', content: urls.map((url, i) => ({ title: `Synthetic ${i}`, url })) }, 'A synthetic summary the tool also returns.'], durationSeconds: 1 },
})
/** The older form: no tool_use_result, only the tool_result text. */
const RESULTS_TEXT_ONLY = (id: string, urls: string[]) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Web search results for query: "q"\n\nLinks: ${JSON.stringify(urls.map(u => ({ title: 'A [bracketed] title', url: u })))}\n\nREMINDER: cite sources.` }] },
})
const RATE = (status: string, over: Record<string, unknown> = {}) => ({ type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1_800_000_000, ...over } })
const RESULT = (text: string, over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 3, total_cost_usd: 0.11, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...over })

const GUIDE = 'https://www.example-guide.com/voice'
const TOOLS = 'https://example-tools.com/blog/rules'
const OTHER = 'https://example-other.org/unread'
const TEXT = `Start with [the voice guide](${GUIDE}). Then write rules, as https://example-tools.com/blog/rules/. explains. One page I recall is https://invented.example.net/made-up, and the guide again: ${GUIDE}/`
const HAPPY = [RATE('allowed'), INIT(), SEARCH('t1', 'ai writing in my own voice'), RESULTS('t1', 'ai writing in my own voice', [TOOLS, GUIDE, OTHER]), SEARCH('t2', 'style rules for ai'), RESULTS('t2', 'style rules for ai', [GUIDE]), RESULT(TEXT)]

// ---------- a fake child process ----------

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killed: string[] = []
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? 'SIGTERM')
    setImmediate(() => this.emit('close', null, signal ?? 'SIGTERM'))
    return true
  }
}

interface Spawned { command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }

/** Plays the events as stdout lines (the first split across two writes), then closes, unless it is told to hang. */
function fakeSpawn(events: unknown[], o: { hang?: boolean; exitCode?: number } = {}): { spawn: SpawnFn; calls: Spawned[] } {
  const calls: Spawned[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild()
    calls.push({ command, args, options, child })
    setImmediate(() => {
      const text = events.map(e => JSON.stringify(e) + '\n').join('')
      const cut = Math.min(17, text.length)
      child.stdout.write(text.slice(0, cut))
      child.stdout.write(text.slice(cut))
      child.stderr.write('synthetic stderr that is never logged\n')
      if (o.hang) return
      child.stdout.on('end', () => child.emit('close', o.exitCode ?? 0, null))
      child.stdout.end()
    })
    return child
  }
  return { spawn, calls }
}

const engine = (spawn: SpawnFn, extra: { meter?: UsageMeter; timeoutMs?: number } = {}) => new ClaudeCodeEngine({ env: TOKEN_ENV, spawn, ...extra })

// ---------- arguments and environment ----------

test('claude code: the arguments are one fresh headless session, WebSearch only, no MCP, never a minimal or permission-skipping mode', () => {
  const args = claudeCodeArgs('How do I write in my own voice with AI?', MODELS.anthropic)
  assert.deepEqual(args, [
    '-p', 'How do I write in my own voice with AI?',
    '--system-prompt', PROBE_SYSTEM_V1,
    '--tools', 'WebSearch',
    '--allowedTools', 'WebSearch',
    '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(CAPS.CLAUDE_CODE_MAX_TURNS),
    '--model', MODELS.anthropic,
    '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
  ])
  assert.equal(CAPS.CLAUDE_CODE_MAX_TURNS, 8)
  assert.equal(EMPTY_MCP_CONFIG, '{"mcpServers":{}}')
  for (const banned of ['--bare', '--dangerously-skip-permissions', '--permission-mode', '--add-dir']) assert.ok(!args.includes(banned), banned)
  assert.equal(args.filter(a => a === 'WebSearch').length, 2, 'WebSearch is the only tool and the only allowed tool')
  // The system prompt is neutral: no venture, no product, no em dash.
  assert.equal(PROBE_SYSTEM_V1, 'You are a helpful assistant answering a question from a member of the public. Search the web before you answer and cite the sources you rely on with links.')
  assert.ok(!/mindmake|ctrl|heartside|krish/i.test(PROBE_SYSTEM_V1))
  // A question that starts with a dash is still the prompt, never a flag.
  assert.equal(claudeCodeArgs('-x is it a flag?', 'm')[1], ' -x is it a flag?')
})

test('claude code: the child environment is an allowlist, built fresh, and never carries an API key', () => {
  const parent = {
    PATH: '/usr/bin', HOME: '/home/runner', CLAUDE_CODE_OAUTH_TOKEN: 'tok',
    ANTHROPIC_API_KEY: 'sk-synthetic', ANTHROPIC_BASE_URL: 'https://proxy.example', OPENAI_API_KEY: 'x', PERPLEXITY_API_KEY: 'x', XAI_API_KEY: 'x', GEMINI_API_KEY: 'x',
    AEO_ENGINE_SECRET: 'x', CONTROL_CENTER_ENGINE_TOKEN: 'x', GITHUB_TOKEN: 'x', NODE_OPTIONS: '--require x',
  }
  const env = childEnv(parent, '/tmp/probe-home')
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/tmp/probe-home', CLAUDE_CODE_OAUTH_TOKEN: 'tok', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  assert.ok(!('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_BASE_URL' in env))
  for (const k of Object.keys(env)) assert.ok((CHILD_ENV_KEYS as readonly string[]).includes(k), k)
  assert.notEqual(env, parent)
  assert.deepEqual(Object.keys(childEnv({}, '/h')).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'HOME'])
})

// ---------- the stream ----------

test('claude code: a probe reads fan-out, retrieved and the cited sources in the order the text cites them', async () => {
  const meter = new UsageMeter()
  const { spawn, calls } = fakeSpawn(HAPPY)
  const a = await engine(spawn, { meter }).ask('How do I write in my own voice with AI?')
  assert.equal(a.text, TEXT)
  assert.equal(a.searched, true)
  assert.deepEqual(a.fan_out, ['ai writing in my own voice', 'style rules for ai'])
  assert.deepEqual(a.retrieved, [TOOLS, GUIDE, OTHER], 'search order, each once')
  assert.deepEqual(a.citations, [GUIDE, TOOLS], 'text order, as the search returned each, each once')
  assert.equal(a.typed_urls_dropped, 1, 'the URL no search returned is dropped and counted')
  // One fresh session in its own empty directories, removed afterwards.
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.equal(c.command, 'claude')
  assert.deepEqual(c.options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.ok(c.options.cwd.startsWith(tmpdir()) && c.options.env.HOME.startsWith(tmpdir()))
  assert.notEqual(c.options.cwd, process.cwd())
  assert.notEqual(c.options.cwd, c.options.env.HOME)
  assert.ok(!existsSync(c.options.cwd) && !existsSync(c.options.env.HOME), 'both temporary directories are gone')
  assert.ok(!('ANTHROPIC_API_KEY' in c.options.env))
  // The tokens are the subscription's: recorded, never a posted (priced) row.
  assert.deepEqual(meter.rows(), [])
  assert.equal(meter.subscriptionCalls, 1)
  assert.equal(meter.subscriptionTokens, 1500)
  assert.equal(meter.subscriptionRows()[0].model, 'claude-code/claude-sonnet-5')
})

test('claude code: retrieved falls back to the "Links:" list when tool_use_result is absent', () => {
  const out = readProbeStream([INIT(), SEARCH('t1', 'q'), RESULTS_TEXT_ONLY('t1', [GUIDE, TOOLS]), RESULT(`See ${TOOLS} and ${GUIDE}.`)])
  assert.equal(out.error, null)
  assert.deepEqual(out.answer?.retrieved, [GUIDE, TOOLS])
  assert.deepEqual(out.answer?.citations, [TOOLS, GUIDE])
  assert.deepEqual(linksFrom('Links: [{"title":"a ] b","url":"https://a.example/x"}] and Links: not json'), ['https://a.example/x'])
  assert.deepEqual(linksFrom('no links here'), [])
})

test('claude code: URLs in text are read from markdown and bare links, trimmed of trailing punctuation', () => {
  assert.deepEqual(urlsInText('A [x](https://a.example/p). B (see https://b.example/q). C https://en.example.org/wiki/Foo_(bar), D <https://d.example/>.'), [
    'https://a.example/p', 'https://b.example/q', 'https://en.example.org/wiki/Foo_(bar)', 'https://d.example/',
  ])
  const c = citeFromText('First http://example-tools.com/blog/rules then https://www.example-guide.com/voice#part', [GUIDE, TOOLS])
  assert.deepEqual(c, { citations: [TOOLS, GUIDE], typed_urls_dropped: 0 }, 'scheme, www and fragment do not split a source')
  assert.deepEqual(citeFromText('Nothing cited.', [GUIDE]), { citations: [], typed_urls_dropped: 0 })
})

test('claude code: it fails closed on an extra tool, an API key source or a connected MCP server, before any answer', async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [INIT({ tools: ['WebSearch', 'Bash'] }), /tools_not_websearch_only/],
    [INIT({ tools: [] }), /tools_not_websearch_only/],
    [INIT({ tools: undefined }), /tools_not_websearch_only/],
    [INIT({ apiKeySource: 'ANTHROPIC_API_KEY' }), /api_key_source/],
    [INIT({ apiKeySource: 'apiKeyHelper' }), /api_key_source/],
    // An allowlist: 'none' only. A saved Console key bills the API and does not name "api key".
    [INIT({ apiKeySource: '/login managed key' }), /api_key_source/],
    [INIT({ apiKeySource: 'user' }), /api_key_source/],
    [INIT({ apiKeySource: 'oauth' }), /api_key_source/],
    [INIT({ apiKeySource: undefined }), /api_key_source/],
    [INIT({ apiKeySource: 0 }), /api_key_source/],
    [INIT({ mcp_servers: [{ name: 'x', status: 'connected' }] }), /mcp_connected/],
  ]
  for (const [init, re] of cases) {
    const { spawn, calls } = fakeSpawn([init, SEARCH('t1', 'q'), RESULTS('t1', 'q', [GUIDE]), RESULT(`See ${GUIDE}`)])
    await assert.rejects(engine(spawn).ask('A question?'), (e: Error) => e instanceof ProbeRefused && re.test(e.message))
    assert.ok(calls[0].child.killed.includes('SIGKILL'), 'the child is killed at once')
  }
  // A failed MCP server, or none, is fine.
  assert.equal(readProbeStream([INIT({ mcp_servers: [{ name: 'x', status: 'failed' }] }), RESULT('ok')]).error, null)
  // An answer with no init, or a tool other than WebSearch mid-stream, is refused too.
  assert.throws(() => readProbeStream([SEARCH('t1', 'q')]), /claude_code_no_init/)
  assert.throws(() => readProbeStream([INIT(), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: {} }] } }]), /tool_not_websearch/)
})

test('claude code: the subscription limit raises SubscriptionLimit, and the rest of the job stops without starting a session', async () => {
  const { spawn, calls } = fakeSpawn([INIT(), RATE('rejected'), RESULT('never read')])
  const e = engine(spawn)
  await assert.rejects(e.ask('A question?'), (err: Error) => err instanceof SubscriptionLimit && /rejected/.test(err.message) && /five_hour/.test(err.message))
  await assert.rejects(e.ask('Another question?'), SubscriptionLimit)
  assert.equal(calls.length, 1, 'no second session once the limit is known')
  // Paid overage carrying on, or a status this CLI does not declare, stops it too.
  assert.throws(() => readProbeStream([INIT(), RATE('rejected', { isUsingOverage: true })]), (err: Error) => err instanceof SubscriptionLimit && /rejected_overage/.test(err.message))
  assert.throws(() => readProbeStream([INIT(), RATE('allowed', { isUsingOverage: true })]), SubscriptionLimit, 'overage in use stops it whatever the status says')
  assert.throws(() => readProbeStream([INIT(), RATE('throttled')]), SubscriptionLimit)
  assert.throws(() => readProbeStream([INIT(), { type: 'rate_limit_event', rate_limit_info: {} }]), SubscriptionLimit)
})

test('claude code: allowed_warning is a warning, not the limit: the probe finishes, is marked, and the next ask still runs', async () => {
  const warned = readProbeStream([INIT(), RATE('allowed_warning', { isUsingOverage: false }), SEARCH('t1', 'q'), RESULTS('t1', 'q', [GUIDE]), RESULT(`See ${GUIDE}`)])
  assert.equal(warned.error, null)
  assert.equal(warned.answer?.limit_warning, true)
  assert.deepEqual(warned.answer?.citations, [GUIDE])
  assert.equal(readProbeStream(HAPPY).answer?.limit_warning, undefined, 'allowed alone marks nothing')

  const { spawn, calls } = fakeSpawn([INIT(), RATE('allowed_warning'), SEARCH('t1', 'q'), RESULTS('t1', 'q', [GUIDE]), RESULT(`See ${GUIDE}`)])
  const e = engine(spawn)
  assert.equal((await e.ask('A question?')).limit_warning, true)
  assert.equal((await e.ask('Another question?')).limit_warning, true)
  assert.equal(calls.length, 2, 'a warning never latches the lane shut')

  // In the probe stage the answer is kept and counted as a warning, not a failure.
  const stub = new StubEngine('claude', () => ({ text: `See ${GUIDE}`, citations: [GUIDE], searched: true, limit_warning: true }), 'claude-code/claude-sonnet-5', { costKind: 'claude_code' })
  const q: ProposedQuery = { query_id: '00000000-0000-4000-8000-000000000777', query: 'How do I keep my own voice?', source: 'seed', touchpoint_id: null, prior: null, norm: normaliseQuery('How do I keep my own voice?'), requested: false }
  const out = await probeQueries([stub], [q], ['mindmake.co'], new Ledger(10))
  assert.equal(out.probes, 1)
  assert.equal(out.probes_failed, 0)
  assert.equal(out.probes_skipped_limit, 0)
  assert.equal(out.probes_limit_warning, 1)
})

test('claude code: a multi-byte character split across two reads of the pipe is decoded whole', async () => {
  const text = 'Caf\u00e9 owners say \u201cyes\u201d, see https://www.example-guide.com/voice.'
  const lines = [INIT(), SEARCH('t1', 'q'), RESULTS('t1', 'q', [GUIDE]), RESULT(text)].map(e => JSON.stringify(e) + '\n').join('')
  const bytes = Buffer.from(lines, 'utf8')
  const accent = bytes.indexOf(Buffer.from('\u00e9', 'utf8'))
  const quote = bytes.indexOf(Buffer.from('\u201c', 'utf8'))
  assert.ok(accent > 0 && quote > accent)
  const spawn: SpawnFn = () => {
    const child = new FakeChild()
    setImmediate(() => {
      // Cut inside the two-byte e-acute and inside the three-byte quote mark.
      child.stdout.write(bytes.subarray(0, accent + 1))
      child.stdout.write(bytes.subarray(accent + 1, quote + 2))
      child.stdout.write(bytes.subarray(quote + 2))
      child.stdout.on('end', () => child.emit('close', 0, null))
      child.stdout.end()
    })
    return child
  }
  const a = await engine(spawn).ask('A question?')
  assert.equal(a.text, text)
  assert.ok(!a.text.includes('\ufffd'))
  assert.deepEqual(a.citations, [GUIDE])
})

test('claude code: a timeout kills the process and fails the probe; an error result or a failed exit fails it too', async () => {
  const hang = fakeSpawn([INIT(), SEARCH('t1', 'q')], { hang: true })
  await assert.rejects(engine(hang.spawn, { timeoutMs: 30 }).ask('Slow question?'), /claude_code_timeout after 30ms/)
  assert.deepEqual(hang.calls[0].child.killed, ['SIGKILL'])

  const meter = new UsageMeter()
  const err = fakeSpawn([INIT(), RESULT('', { is_error: true, subtype: 'error_max_turns' })], { exitCode: 1 })
  await assert.rejects(engine(err.spawn, { meter }).ask('A question?'), /claude_code_result_error_max_turns \(exit 1\)/)
  assert.equal(meter.subscriptionRows()[0].failed, 1, 'a failed answer still used the subscription, and is recorded as failed')

  const isError = fakeSpawn([INIT(), RESULT('text', { is_error: true })])
  await assert.rejects(engine(isError.spawn).ask('A question?'), /claude_code_result_success/)

  const noResult = fakeSpawn([INIT()], { exitCode: 2 })
  await assert.rejects(engine(noResult.spawn).ask('A question?'), /claude_code_no_result \(exit 2\)/)

  const missing: SpawnFn = () => { const c = new FakeChild(); setImmediate(() => c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))); return c }
  await assert.rejects(engine(missing).ask('A question?'), /claude_code_spawn_failed: ENOENT/)
  assert.throws(() => new ClaudeCodeEngine({ env: { PATH: '/bin' } }), /CLAUDE_CODE_OAUTH_TOKEN is not set/)
})

// ---------- the ledger and the probe stage ----------

const pq = (query: string): ProposedQuery => ({ query_id: `00000000-0000-4000-8000-${String(query.length).padStart(12, '0')}`, query, source: 'seed', touchpoint_id: null, prior: null, norm: normaliseQuery(query), requested: false })

test('the ledger counts a Claude Code probe and never charges it, even past the cap', () => {
  const l = new Ledger(0.01)
  assert.equal(l.priceOf('claude_code'), 0)
  assert.equal(l.charge('claude_code', 'probe claude'), 0)
  assert.equal(l.canAfford('claude_code', 1000), true, 'a subscription call is never stopped by a dollar cap')
  assert.equal(l.canAfford('claude', 0), false)
  assert.equal(l.summary().by_kind.claude_code.calls, 1)
  assert.equal(l.total, 0)
})

test('probe stage, code lane: a subscription limit fails the probe and is counted; nothing paid replaces it', async () => {
  const code = new StubEngine('claude', () => { throw new SubscriptionLimit('rejected', 'five_hour') }, 'claude-code/claude-sonnet-5', { costKind: 'claude_code' })
  const pplx = new StubEngine('perplexity', () => ({ text: 'x', citations: ['https://a.example'] }))
  const ledger = new Ledger(10)
  const out = await captureStderr(() => probeQueries([pplx, code], [pq('How do I write in my voice?')], ['mindmake.co'], ledger))
  assert.equal(out.result.probes, 1)
  assert.equal(out.result.probes_failed, 1)
  assert.equal(out.result.probes_skipped_limit, 1)
  assert.equal(out.result.probes_fallback, 0)
  assert.equal(ledger.total, ledger.priceOf('perplexity'), 'the Claude Code probe cost nothing')
})

test('probe stage, code_then_api: the limit hands the probe to the API lane, charged at its price, in the packet as the API model', async () => {
  const api = new StubEngine('claude', () => ({ text: 'From the API.', citations: ['https://www.mindmake.co/x'], searched: true }), 'claude-sonnet-5')
  const code = new StubEngine('claude', () => { throw new SubscriptionLimit('rejected', 'five_hour') }, 'claude-code/claude-sonnet-5', { costKind: 'claude_code', fallback: api })
  const ledger = new Ledger(10)
  const q = pq('Which guide should I read?')
  const out = await probeQueries([code], [q], ['mindmake.co'], ledger)
  const row = out.probesByQuery.get(q.query_id)![0]
  assert.equal(row.engine, 'claude')
  assert.equal(row.model, 'claude-sonnet-5')
  assert.equal(row.cost_usd, ledger.priceOf('claude'))
  assert.equal(ledger.total, ledger.priceOf('claude'))
  assert.equal(out.probes_fallback, 1)
  assert.equal(out.probes_skipped_limit, 0)
  assert.equal(out.detailsByQuery!.get(q.query_id)![0].first_host_ours, true)
  // With the cap already spent, the fallback is not made and the limit is counted.
  const broke = new Ledger(0.001)
  const none = await captureStderr(() => probeQueries([code], [pq('Another question here?')], ['mindmake.co'], broke))
  assert.equal(none.result.probes_skipped_limit, 1)
  assert.equal(broke.total, 0)
  // The limit stopped it and the API fallback then failed: still counted as stopped by the limit, and failed.
  const apiDown = new StubEngine('claude', () => { throw new Error('api 529') }, 'claude-sonnet-5')
  const codeDown = new StubEngine('claude', () => { throw new SubscriptionLimit('rejected', 'five_hour') }, 'claude-code/claude-sonnet-5', { costKind: 'claude_code', fallback: apiDown })
  const both = new Ledger(10)
  const down = await captureStderr(() => probeQueries([codeDown], [pq('A third question here?')], ['mindmake.co'], both))
  assert.equal(down.result.probes_skipped_limit, 1)
  assert.equal(down.result.probes_failed, 1)
  assert.equal(down.result.probes_fallback, 0)
  assert.equal(apiDown.asked.length, 1, 'the fallback was tried')
})

test('probe stage: the subscription lane keeps asking after the dollar cap stops the paid engines', async () => {
  const code = new StubEngine('claude', () => ({ text: 'x', citations: [] }), 'claude-code/m', { costKind: 'claude_code' })
  const pplx = new StubEngine('perplexity', () => ({ text: 'x', citations: [] }))
  const ledger = new Ledger(0.015)
  const out = await captureStderr(() => probeQueries([pplx, code], [pq('one question here?'), pq('two questions here?'), pq('three questions here!')], ['mindmake.co'], ledger))
  assert.equal(pplx.asked.length, 1)
  assert.equal(code.asked.length, 3)
  assert.equal(out.result.probes_skipped_cap, 2)
})

test('probe stage, compare: the API lane answers beside the code lane on the first questions, is charged, tallied, and never in the packet', async () => {
  const code = new StubEngine('claude', q => ({ text: 'code', citations: q.startsWith('one') ? ['https://a.example/1', 'https://b.example'] : [], retrieved: ['https://a.example/1', 'https://b.example', 'https://c.example'], searched: true }), 'claude-code/m', { costKind: 'claude_code' })
  const api = new StubEngine('claude', q => ({ text: 'api', citations: ['https://www.a.example/2'], retrieved: ['https://a.example/2', 'https://d.example'], searched: q.startsWith('one') }), 'claude-sonnet-5')
  const ledger = new Ledger(10)
  const qs = [pq('one question here?'), pq('two questions here?'), pq('three questions here!')]
  const out = await probeQueries([code], qs, ['mindmake.co'], ledger, [], 25, 0, { shadow: { client: api, questions: 2 } })
  assert.equal(api.asked.length, 2, 'the first two questions only')
  assert.equal(code.asked.length, 3)
  assert.equal(ledger.total, 2 * ledger.priceOf('claude'), 'the API lane is paid; the code lane is not')
  for (const q of qs) assert.deepEqual(out.probesByQuery.get(q.query_id)!.map(p => p.model), ['claude-code/m'], 'only the code lane is in the packet')
  assert.deepEqual(out.compare, {
    questions: 2,
    code: { answered: 2, searched: 2, inline_citations: 2, zero_citation: 1 },
    api: { answered: 2, searched: 1, inline_citations: 2, zero_citation: 0 },
    code_failed: 0, api_failed: 0,
    both_cited: 1, first_host_agree: 1,
    retrieved_hosts_shared: 2, retrieved_hosts_union: 8,
  })
})

// ---------- the lane switch ----------

test('lane switch: dated default, the variable, and a missing token falls back to the API', () => {
  assert.equal(COMPARE_FIRST_RUN_UNTIL, '2026-11-16')
  const tok = { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic' }
  assert.deepEqual(resolveClaudeLane(tok, '2026-11-16'), { lane: 'compare', reason: 'dated_default' }, 'the run of 22 November compares')
  assert.deepEqual(resolveClaudeLane(tok, '2026-11-09'), { lane: 'compare', reason: 'dated_default' })
  assert.deepEqual(resolveClaudeLane(tok, '2026-11-23'), { lane: 'code', reason: 'dated_default' }, 'from the research week of 23 November')
  assert.deepEqual(resolveClaudeLane({ ...tok, AEO_CLAUDE_LANE: '' }, '2026-11-30'), { lane: 'code', reason: 'dated_default' }, 'an empty variable is the dated default')
  for (const lane of ['code', 'api', 'compare', 'code_then_api'] as const) assert.deepEqual(resolveClaudeLane({ ...tok, AEO_CLAUDE_LANE: lane }, '2026-11-30'), { lane, reason: 'set' })
  assert.deepEqual(resolveClaudeLane({ ...tok, AEO_CLAUDE_LANE: ' API ' }, '2026-11-30'), { lane: 'api', reason: 'set' })
  assert.deepEqual(resolveClaudeLane({ ...tok, AEO_CLAUDE_LANE: 'bogus' }, '2026-11-30'), { lane: 'code', reason: 'dated_default', unknown: 'bogus' })
  // No token: code, compare and code_then_api all become the API lane, so Claude is never zeroed.
  for (const lane of ['code', 'compare', 'code_then_api', '']) assert.equal(resolveClaudeLane({ AEO_CLAUDE_LANE: lane }, '2026-11-16').lane, 'api')
  assert.equal(resolveClaudeLane({}, '2026-11-30').reason, 'no_token')
})

const LIVE_ENV = { CONTROL_CENTER_URL: 'https://cc.example', AEO_ENGINE_SECRET: 's', ANTHROPIC_API_KEY: 'sk-synthetic', OPENAI_API_KEY: 'o', PERPLEXITY_API_KEY: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic', PATH: '/bin' }

test('lane switch: buildDeps builds each lane, and reads the variable per run, never at module load', async () => {
  const claudeOf = (env: Record<string, string>, week: string) => {
    const deps = buildDeps(parseArgs(['--week', week]), env, new Date('2026-11-20T00:00:00Z'), { spawn: fakeSpawn([]).spawn })
    return { deps, claude: deps.engines.find(e => e.engine === 'claude')! }
  }
  const { result } = await captureStderr(async () => {
    const compare = claudeOf(LIVE_ENV, '2026-11-16')
    assert.ok(compare.claude instanceof ClaudeCodeEngine)
    assert.ok(compare.deps.shadow instanceof AnthropicClient)
    assert.equal(compare.deps.claudeLane, 'compare')

    const code = claudeOf(LIVE_ENV, '2026-11-23')
    assert.ok(code.claude instanceof ClaudeCodeEngine)
    assert.equal(code.claude.fallback, undefined)
    assert.equal(code.deps.shadow, undefined)

    const thenApi = claudeOf({ ...LIVE_ENV, AEO_CLAUDE_LANE: 'code_then_api' }, '2026-11-23')
    assert.ok(thenApi.claude instanceof ClaudeCodeEngine)
    assert.ok(thenApi.claude.fallback instanceof AnthropicClient)

    const api = claudeOf({ ...LIVE_ENV, AEO_CLAUDE_LANE: 'api' }, '2026-11-23')
    assert.ok(api.claude instanceof AnthropicClient)

    const { CLAUDE_CODE_OAUTH_TOKEN: _t, ...noToken } = LIVE_ENV
    const missing = claudeOf(noToken, '2026-11-16')
    assert.ok(missing.claude instanceof AnthropicClient, 'a missing token never zeroes Claude')
    assert.equal(missing.deps.shadow, undefined)

    // Gemini joins only with its key, and only as a probe engine.
    assert.ok(!code.deps.engines.some(e => e.engine === 'gemini'))
    const withGemini = claudeOf({ ...LIVE_ENV, GEMINI_API_KEY: 'g' }, '2026-11-23')
    assert.ok(withGemini.deps.engines.some(e => e instanceof GeminiClient))
    return true
  })
  assert.equal(result, true)
})

// ---------- the sealed summary and the report ----------

test('summary and report: the compare tally and the limit counts travel as counts only, and the report says what the limit stopped', async () => {
  const { buildRunSummary } = await import('../src/protocol/measure.js')
  const { buildResearchReport } = await import('../src/protocol/reports.js')
  const { validateReport } = await import('../src/schema/report.js')
  const { readJson } = await import('./helpers.js')
  const packet = readJson('expected/packet.ctrl.json') as import('../src/schema/packet.js').AeoPacket
  const compare = { questions: 5, code: { answered: 5, searched: 5, inline_citations: 11, zero_citation: 0 }, api: { answered: 4, searched: 4, inline_citations: 6, zero_citation: 1 }, code_failed: 0, api_failed: 1, both_cited: 3, first_host_agree: 2, retrieved_hosts_shared: 9, retrieved_hosts_union: 30 }
  const sum = buildRunSummary({
    subjectArg: 'ctrl', weekStart: '2026-11-16', now: new Date('2026-11-22T10:00:00Z'), engines: packet.engines, capUsd: 5, spentUsd: 1, maxProbeUsd: 0.07,
    results: [{ packet, domains: ['ctrl.mindmake.co', 'mindmake.co'], extras: { probes_skipped_limit: 3, probes_limit_warning: 6, probes_fallback: 2, probes_skipped_free_tier: 0, gated_failed: 0, gated_skipped_cap: 0, typed_urls_dropped: 4, compare } }],
    failures: [], errorCode: null, claudeLane: 'compare', subscription: { calls: 24, tokens: 36000 },
  })
  const s = sum.subjects[0]
  assert.deepEqual(s.claude_compare, compare)
  assert.equal(s.probes_skipped_limit, 3)
  assert.equal(s.probes_limit_warning, 6)
  assert.equal(s.probes_fallback, 2)
  assert.equal(s.typed_urls_dropped, 4)
  assert.ok(!('probes_skipped_free_tier' in s), 'a zero count is left out')
  assert.equal(sum.claude_lane, 'compare')
  assert.equal(sum.subscription_tokens, 36000)
  assert.ok(!/https?:\/\//.test(JSON.stringify(sum)), 'no URL in the summary')
  const report = buildResearchReport({ runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: new Date('2026-11-22T10:00:00Z'), revision: 'abc', capturedAt: new Date('2026-11-22T10:00:00Z'), scope: 'one', expected: ['ctrl'], summaries: [sum], totalCapUsd: 25, planError: null })
  assert.deepEqual(validateReport(report), { ok: true })
  assert.ok(report.activity.some(a => a.line === 'The Claude Code subscription\'s limit stopped 5 Claude asks; the paid API answered 2 of them.'))
  assert.ok(report.activity.some(a => a.line === 'The Claude Code subscription was past its warning threshold on 6 Claude asks, still answered.'))
  assert.ok(!JSON.stringify(report).includes('first_host_agree'), 'the compare tally stays in the sealed summary')
})
