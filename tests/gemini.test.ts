/**
 * Gemini, offline: the request shape, the grounding read, and the gate that
 * keeps its probes out of the packet and out of the North Star until Control
 * Center opens it. Every response here is synthetic; fetch is replaced.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FreeTierExhausted, GeminiClient, answerFrom, hostLike, parseGemini, resolveRedirect, type Resolver } from '../src/clients/gemini.js'
import { OfflineControlCenter } from '../src/clients/offline.js'
import { attemptOf, CAPS, MODELS, PRICE_USD_PER_CALL, resolveEngines } from '../src/config/run.js'
import { buildDeps, parseArgs } from '../src/index.js'
import { Ledger } from '../src/lib/cost.js'
import { normaliseQuery } from '../src/lib/text.js'
import type { ProposedQuery } from '../src/pipeline/30-propose.js'
import { isGroundingRedirect, probeQueries } from '../src/pipeline/40-probe.js'
import { runAll } from '../src/pipeline/run.js'
import { buildRunSummary, countCitedFirst } from '../src/protocol/measure.js'
import { buildResearchReport } from '../src/protocol/reports.js'
import { openGatedEngines, validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { validateReport } from '../src/schema/report.js'
import { FIXTURES, StubEngine, readJson } from './helpers.js'
import { captureStderr } from './standin.js'

const REDIRECT = (n: number) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/SYNTHETIC${n}`

/** A synthetic grounded response: supports out of order, a repeated chunk, an index out of range. */
const RESPONSE = {
  candidates: [{
    content: { role: 'model', parts: [{ text: 'A synthetic answer, ' }, { text: 'in two parts.' }] },
    groundingMetadata: {
      webSearchQueries: ['ai writing own voice', 'style rules ai'],
      groundingChunks: [
        { web: { uri: REDIRECT(0), title: 'example-tools.com' } },
        { web: { uri: REDIRECT(1), title: 'mindmake.co' } },
        { web: { uri: REDIRECT(2), title: 'A Page Title, Not A Host' } },
        { web: { uri: REDIRECT(3), title: 'www.example-guide.com' } },
      ],
      groundingSupports: [
        { segment: { startIndex: 40, endIndex: 60, text: 'later' }, groundingChunkIndices: [1, 0] },
        { segment: { endIndex: 10, text: 'first' }, groundingChunkIndices: [3] },
        { segment: { startIndex: 20, endIndex: 30, text: 'middle' }, groundingChunkIndices: [2, 3, 9] },
      ],
    },
  }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
}

interface Call { url: string; init: RequestInit }
async function withFetch<T>(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>, fn: () => Promise<T>): Promise<{ result: T; calls: Call[] }> {
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

test('gemini: the request puts the key in a header, never the URL, and asks with Google Search grounding', async () => {
  const resolved: string[] = []
  const g = new GeminiClient('synthetic-gemini-key', { resolve: async u => { resolved.push(u); return null } })
  const { result, calls } = await withFetch([{ status: 200, body: RESPONSE }], () => g.ask('How do I write in my own voice?'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`)
  assert.equal(MODELS.gemini, 'gemini-3.6-flash')
  assert.ok(!calls[0].url.includes('synthetic-gemini-key') && !calls[0].url.includes('key='))
  assert.equal((calls[0].init.headers as Record<string, string>)['x-goog-api-key'], 'synthetic-gemini-key')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { contents: [{ role: 'user', parts: [{ text: 'How do I write in my own voice?' }] }], tools: [{ google_search: {} }] })
  assert.equal(result.text, 'A synthetic answer, in two parts.')
  assert.deepEqual(result.fan_out, ['ai writing own voice', 'style rules ai'])
  assert.equal(result.searched, true)
  assert.deepEqual(result.retrieved, [REDIRECT(0), REDIRECT(1), REDIRECT(2), REDIRECT(3)])
  assert.equal(g.groundingQueries, 2)
  assert.throws(() => new GeminiClient(''), /GEMINI_API_KEY is not set/)
})

test('gemini: inline order is the supports by start index, each chunk once; an unresolved chunk is its title as a host', async () => {
  const p = parseGemini(RESPONSE)
  assert.deepEqual(p.order, [3, 2, 1, 0], 'start 0 (missing), then 20, then 40; the out-of-range index is ignored')
  const a = await answerFrom(p, [], async () => null)
  assert.deepEqual(a.citations, ['https://example-guide.com/', REDIRECT(2), 'https://mindmake.co/', 'https://example-tools.com/'])
  assert.equal(hostLike('www.Example-Guide.com'), 'example-guide.com')
  assert.equal(hostLike('A Page Title'), null)
  assert.equal(hostLike('localhost'), null)
  assert.throws(() => parseGemini({ candidates: [] }), /gemini_no_candidate/)
  const bare = parseGemini({ candidates: [{ content: { parts: [{ text: 'From memory.' }] } }] })
  assert.deepEqual(bare, { text: 'From memory.', fanOut: [], chunks: [], order: [] })
})

test('gemini: only the first citation and our own domains are resolved, at most three a probe', async () => {
  const asked: string[] = []
  const resolver: Resolver = async u => { asked.push(u); return `https://real.example/${u.slice(-1)}` }
  const p = parseGemini(RESPONSE)
  const a = await answerFrom(p, ['mindmake.co'], resolver)
  assert.deepEqual(asked, [REDIRECT(3), REDIRECT(1)], 'the first inline citation, then the chunk titled with our domain')
  assert.deepEqual(a.citations, ['https://real.example/3', REDIRECT(2), 'https://real.example/1', 'https://example-tools.com/'])
  // Six chunks all titled ours: three resolutions, the rest by title.
  const many = parseGemini({ candidates: [{ content: { parts: [{ text: 't' }] }, groundingMetadata: { webSearchQueries: ['q'], groundingChunks: Array.from({ length: 6 }, (_, i) => ({ web: { uri: REDIRECT(i), title: 'ctrl.mindmake.co' } })), groundingSupports: [{ segment: { startIndex: 0 }, groundingChunkIndices: [0, 1, 2, 3, 4, 5] }] } }] })
  let n = 0
  const capped = await answerFrom(many, ['mindmake.co'], async () => `https://ctrl.mindmake.co/page-${++n}`)
  assert.equal(n, CAPS.GEMINI_MAX_RESOLUTIONS_PER_PROBE)
  assert.equal(CAPS.GEMINI_MAX_RESOLUTIONS_PER_PROBE, 3)
  assert.deepEqual(capped.citations, ['https://ctrl.mindmake.co/page-1', 'https://ctrl.mindmake.co/page-2', 'https://ctrl.mindmake.co/page-3', 'https://ctrl.mindmake.co/'])
  // A resolver that fails falls back to the title.
  const failing = await answerFrom(p, [], async () => { throw new Error('network') })
  assert.equal(failing.citations[0], 'https://example-guide.com/')
})

test('gemini: a redirect is read from its Location header with redirects not followed; anything else is never fetched', async () => {
  const { result, calls } = await withFetch([{ status: 302, body: {}, headers: { location: 'https://www.example-guide.com/voice' } }], () => resolveRedirect(REDIRECT(1)))
  assert.equal(result, 'https://www.example-guide.com/voice')
  assert.equal(calls[0].url, REDIRECT(1))
  assert.equal(calls[0].init.redirect, 'manual')
  assert.equal(calls[0].init.method, 'GET')
  const notRedirect = await withFetch([], () => resolveRedirect('https://www.example-guide.com/voice'))
  assert.equal(notRedirect.result, null)
  assert.equal(notRedirect.calls.length, 0, 'a source page is never fetched')
  const ok200 = await withFetch([{ status: 200, body: {} }], () => resolveRedirect(REDIRECT(2)))
  assert.equal(ok200.result, null)
})

test('gemini: the free-tier share stops the job before an answer as large as the largest so far could pass it, without a call', async () => {
  const g = new GeminiClient('k', { maxQueries: 5, resolve: async () => null })
  assert.equal(g.exhausted, false)
  await withFetch([{ status: 200, body: RESPONSE }, { status: 200, body: RESPONSE }], async () => {
    await g.ask('First question here?')
    await g.ask('Second question here?')
  })
  // Two answers of two queries each: 4 used, and 4 + 2 would pass 5, so it stops at 4, never past its share.
  assert.equal(g.groundingQueries, 4)
  assert.equal(g.exhausted, true)
  const third = await withFetch([], () => g.ask('Third question here?').then(() => 'asked', e => e))
  assert.ok(third.result instanceof FreeTierExhausted)
  assert.equal(third.calls.length, 0)
  // Before any answer the margin is one query: a share of one allows one ask.
  const one = new GeminiClient('k', { maxQueries: 1, resolve: async () => null })
  assert.equal(one.exhausted, false)
  assert.equal(CAPS.GEMINI_MAX_QUERIES_PER_JOB, 150)
  assert.ok(CAPS.GEMINI_MAX_QUERIES_PER_JOB * 10 * 3 <= 5000, 'inside the free tier at ten subjects and three runs a month')
})

test('gemini is registered only with its key, on the job\'s first attempt, with a small positive estimate', () => {
  assert.ok(!resolveEngines({}).includes('gemini'))
  assert.deepEqual(resolveEngines({ GEMINI_API_KEY: 'g' }), ['perplexity', 'chatgpt', 'claude', 'gemini'])
  assert.deepEqual(resolveEngines({ GEMINI_API_KEY: 'g', AEO_ATTEMPT: '1' }), ['perplexity', 'chatgpt', 'claude', 'gemini'])
  // A retry is a fresh process with a fresh count, so it asks no Gemini.
  assert.deepEqual(resolveEngines({ GEMINI_API_KEY: 'g', AEO_ATTEMPT: '2' }), ['perplexity', 'chatgpt', 'claude'])
  assert.equal(attemptOf({}), 1)
  assert.equal(attemptOf({ AEO_ATTEMPT: ' 2 ' }), 2)
  assert.equal(attemptOf({ AEO_ATTEMPT: 'two' }), 1)
  assert.equal(attemptOf({ AEO_ATTEMPT: '0' }), 1)
  assert.equal(PRICE_USD_PER_CALL.gemini, 0.005)
})

const pq = (query: string): ProposedQuery => ({ query_id: `00000000-0000-4000-8000-${String(query.length).padStart(12, '0')}`, query, source: 'seed', touchpoint_id: null, prior: null, norm: normaliseQuery(query), requested: false })

/** A gemini stand-in that says when it is past its share, as GeminiClient does. */
class SpentGemini extends StubEngine {
  constructor(public exhausted: boolean, answer: () => import('../src/clients/types.js').EngineAnswer) { super('gemini', answer) }
}

test('the free tier: a skipped Gemini probe is never charged, whether the stage sees it exhausted or the client says so', async () => {
  const pplx = new StubEngine('perplexity', () => ({ text: 'x', citations: ['https://a.example/'], searched: true }))
  const qs = Array.from({ length: 25 }, (_, i) => pq(`Synthetic question number ${String(i).padStart(2, '0')} about voice?`)).map((q, i) => ({ ...q, query_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
  const ledger = new Ledger(10)
  const spent = new SpentGemini(true, () => { throw new Error('never asked') })
  const out = await probeQueries([pplx, spent], qs, ['mindmake.co'], ledger)
  assert.equal(out.probes_skipped_free_tier, 25)
  assert.equal(spent.asked.length, 0, 'an exhausted engine is not asked')
  assert.equal(ledger.total, Math.round(25 * ledger.priceOf('perplexity') * 10000) / 10000, 'the perplexity probes only')
  assert.ok(!ledger.entries.some(e => e.kind === 'gemini'))

  // A client that only finds out when asked: the charge made before the ask is taken back.
  const late = new Ledger(10)
  const throws = new StubEngine('gemini', () => { throw new FreeTierExhausted(150, 150) })
  const back = await probeQueries([pplx, throws], qs.slice(0, 4), ['mindmake.co'], late)
  assert.equal(back.probes_skipped_free_tier, 4)
  assert.equal(late.total, Math.round(4 * late.priceOf('perplexity') * 10000) / 10000)
  assert.equal(late.summary().by_kind.gemini, undefined)
  assert.equal(late.refund('gemini', 'probe gemini'), 0, 'nothing left to take back')
})

test('the gate opened: an unresolved grounding redirect never reaches the packet, and the measurement still reads it first', async () => {
  const q = pq('Which guide should I read for my voice?')
  const gem = new StubEngine('gemini', () => ({ text: 'Synthetic.', citations: [REDIRECT(7), 'https://mindmake.co/', 'https://example-tools.com/'], searched: true }))
  const out = await probeQueries([gem], [q], ['mindmake.co'], new Ledger(10), [], 25, 0, { open: ['gemini'] })
  const probe = out.probesByQuery.get(q.query_id)![0]
  assert.equal(probe.engine, 'gemini')
  assert.deepEqual(probe.citations, ['https://mindmake.co/', 'https://example-tools.com/'])
  assert.ok(!JSON.stringify(probe).includes('vertexaisearch'))
  const d = out.detailsByQuery!.get(q.query_id)![0]
  assert.equal(d.first_host_ours, false, 'an unknown first source is not promoted away: ours was second')
  assert.equal(d.our_position, 2)
  assert.equal(isGroundingRedirect(REDIRECT(1)), true)
  assert.equal(isGroundingRedirect('https://mindmake.co/'), false)
  assert.equal(isGroundingRedirect('not a url'), false)
})

// ---------- the packet gate ----------


test('the gate: a gated engine is measured beside the packet and kept out of it until the context opens it', async () => {
  const pplx = new StubEngine('perplexity', () => ({ text: 'x', citations: ['https://other.example/a'], searched: true }))
  const gem = new StubEngine('gemini', () => ({ text: 'y', citations: ['https://mindmake.co/'], searched: true }))
  const q = pq('Which guide should I read first?')
  const shut = await probeQueries([pplx, gem], [q], ['mindmake.co'], new Ledger(10))
  assert.deepEqual(shut.probesByQuery.get(q.query_id)!.map(p => p.engine), ['perplexity'])
  assert.deepEqual(shut.detailsByQuery!.get(q.query_id)!.map(d => [d.engine, d.first_host_ours]), [['perplexity', false], ['gemini', true]])
  assert.equal(shut.probes, 1, 'the packet stats count the packet engines only')
  assert.deepEqual(gem.contexts[0], { domains: ['mindmake.co'] }, 'gemini is told our domains, so it can resolve ours')
  const open = await probeQueries([pplx, gem], [q], ['mindmake.co'], new Ledger(10), [], 25, 0, { open: ['gemini'] })
  assert.deepEqual(open.probesByQuery.get(q.query_id)!.map(p => p.engine), ['perplexity', 'gemini'])

  // A gated engine's failures and free-tier skips never touch the packet's stats.
  const broken = new StubEngine('gemini', () => { throw new Error('boom') })
  const spent = new StubEngine('gemini', () => { throw new FreeTierExhausted(150, 150) })
  const counts = await captureStderr(() => probeQueries([pplx, broken], [q], ['mindmake.co'], new Ledger(10)))
  assert.equal(counts.result.probes_failed, 0)
  assert.equal(counts.result.gated_failed, 1)
  const skipped = await probeQueries([pplx, spent], [q], ['mindmake.co'], new Ledger(10))
  assert.equal(skipped.probes_failed, 0)
  assert.equal(skipped.probes_skipped_free_tier, 1)

  assert.deepEqual(openGatedEngines(undefined), [])
  assert.deepEqual(openGatedEngines(['something_else']), [])
  assert.deepEqual(openGatedEngines(['engine_gemini']), ['gemini'])
})

test('the gate: the packet validator refuses gemini unless it is open, and the North Star ignores it', () => {
  const packet = readJson('expected/packet.ctrl.json') as AeoPacket
  const withGemini = structuredClone(packet)
  const q = withGemini.queries.find(x => x.probes.length)!
  q.probes.push({ ...q.probes[0], engine: 'gemini' as never })
  assert.equal(validatePacket(withGemini).ok, false)
  assert.equal(validatePacket(withGemini, ['gemini']).ok, true)

  const probed = packet.queries.filter(x => x.probes.length)
  const geminiFirst = probed.map(x => ({ query_id: x.query_id, engine: 'gemini' as const, first_host_ours: true, our_position: 1, cited_any: true, searched: true, zero_citation: false, retrieved_ours: false }))
  const before = countCitedFirst(packet, ['ctrl.mindmake.co', 'mindmake.co'])
  const after = countCitedFirst(packet, ['ctrl.mindmake.co', 'mindmake.co'], geminiFirst)
  assert.equal(after.cited_first, before.cited_first, 'gemini cited us first on every question, and the count is what the packet engines alone say')
  // Beside a packet engine's detail that is not ours, gemini's still adds nothing to that question.
  const one = probed[0]
  const mixed = [{ query_id: one.query_id, engine: 'claude' as const, first_host_ours: false, our_position: null, cited_any: false, searched: true, zero_citation: false, retrieved_ours: false }, geminiFirst[0]]
  const onlyClaude = [mixed[0]]
  assert.equal(countCitedFirst(packet, ['ctrl.mindmake.co', 'mindmake.co'], mixed).cited_first, countCitedFirst(packet, ['ctrl.mindmake.co', 'mindmake.co'], onlyClaude).cited_first)
  assert.equal(before.probed_questions, after.probed_questions)
})

test('the gate, end to end: an offline run with a gated gemini keeps the golden packet, and the summary counts gemini apart', async () => {
  const deps = buildDeps(parseArgs(['--offline', '--fixtures', FIXTURES]), { XAI_API_KEY: '' })
  const gem = new StubEngine('gemini', () => ({ text: 'Synthetic gemini answer.', citations: ['https://ctrl.mindmake.co/'], searched: true }), MODELS.gemini)
  deps.engines.push(gem)
  const { result } = await captureStderr(() => runAll(deps, { subject: 'ctrl', weekStart: '2026-09-07', dry: true, outPath: null, commandId: null }))
  const r = result.results[0]
  const expected = readJson('expected/packet.ctrl.json') as AeoPacket
  const strip = (p: AeoPacket) => { const { run_id: _r, generated_at: _g, ...rest } = p; return rest }
  // The ledger counts gemini's calls, so only cost-free fields compare; the packet itself is unchanged.
  assert.deepEqual(strip(r.packet), strip(expected))
  assert.deepEqual(r.extras?.gated_engines, ['gemini'])
  const sum = buildRunSummary({ subjectArg: 'ctrl', weekStart: '2026-09-07', now: new Date('2026-09-13T10:00:00Z'), engines: r.packet.engines, capUsd: 25, spentUsd: deps.ledger.total, maxProbeUsd: 0.07, results: result.results, failures: [], errorCode: null })
  const s = sum.subjects[0]
  assert.equal(s.cited_first, 2, 'gemini cited us first everywhere, and the North Star did not move')
  assert.deepEqual(s.gated_engines, ['gemini'])
  assert.deepEqual(s.engines?.gemini, { probes: 24, searched: 24, zero_citation: 0, first_host_ours: 24, cited_any: 24 })
  assert.deepEqual(sum.engines, ['perplexity', 'chatgpt', 'claude'])
  const report = buildResearchReport({ runId: 'aeo:2026-09-13:research', mode: 'synthetic', observedAt: new Date('2026-09-13T10:00:00Z'), revision: 'abc', capturedAt: new Date('2026-09-13T10:00:00Z'), scope: 'one', expected: ['ctrl'], summaries: [sum], totalCapUsd: 25, planError: null })
  assert.deepEqual(validateReport(report), { ok: true })
  assert.ok(report.activity.some(a => a.line === 'gemini: searched on 24 of 24 asks; measured beside the packets, not counted toward questions cited first.'))
  assert.ok(report.activity.some(a => /on 3 assistants/.test(a.line)), 'the packet engines are the assistants counted')

  // Opened by the context: gemini's probes enter the packet and it validates.
  const open = buildDeps(parseArgs(['--offline', '--fixtures', FIXTURES]), { XAI_API_KEY: '' })
  const base = open.cc as OfflineControlCenter
  const getContext = base.getContext.bind(base)
  base.getContext = async () => ({ ...(await getContext()), packet_features: ['engine_gemini'] })
  open.engines.push(new StubEngine('gemini', () => ({ text: 'Synthetic.', citations: ['https://other.example/'], searched: true }), MODELS.gemini))
  const opened = await captureStderr(() => runAll(open, { subject: 'ctrl', weekStart: '2026-09-07', dry: true, outPath: null, commandId: null }))
  const pk = opened.result.results[0].packet
  assert.deepEqual(pk.engines, ['perplexity', 'chatgpt', 'claude', 'gemini'])
  assert.ok(pk.queries.some(q => q.probes.some(p => p.engine === ('gemini' as never))))
  assert.equal(opened.result.results[0].extras?.gated_engines, undefined)
})
