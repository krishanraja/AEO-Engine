/**
 * Krish's approved voice rules (directive `taste`, protocol 1.5.0): the
 * directive is accepted with or without them, they reach the digest's
 * drafting prompt as one labelled block, and nothing else in the run sees
 * them. Synthetic rules only.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import type { ModelClient, ModelRequest } from '../src/clients/types.js'
import { buildDeps, parseArgs, readTaste } from '../src/index.js'
import { digestSystem, tasteBlock } from '../src/pipeline/60-digest.js'
import { runAll } from '../src/pipeline/run.js'
import { parseTaste, type Taste } from '../src/schema/report.js'
import { captureStderr, StandIn } from './standin.js'

const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'
const SENTINEL = 'SYNTHETIC-RULE-7f3a: open on the claim, never on a question'
const TASTE: Taste = {
  rule: 'Synthetic: follow for how it is written, never what it is about.',
  approved_voice_rules: [{ layer: 'form', rule: SENTINEL, his_words: 'synthetic words, not his', what_it_means: 'The first line states the point.' }],
}

async function directiveFrom(body: Record<string, unknown>) {
  const s = new StandIn(TOKEN)
  const base = await s.start()
  s.directive = body as unknown as StandIn['directive']
  try {
    return (await new GrowthEngineHttp(base, TOKEN).getDirective()).directive
  } finally {
    await s.close()
  }
}

test('a 1.5.0 directive is accepted with taste, without it, and with fields this engine does not know', async () => {
  const s = new StandIn(TOKEN)
  const base = { ...structuredClone(s.directive), schema_version: '1.5.0', north_star: { urgency: 4 }, some_1_9_field: { x: 1 } }

  const withTaste = await directiveFrom({ ...base, taste: { ...TASTE, approved_voice_rules: [{ ...TASTE.approved_voice_rules[0], later_field: true }, { layer: null, rule: '' }] } })
  assert.equal(withTaste.schema_version, '1.5.0')
  assert.deepEqual(withTaste.taste, TASTE, 'typed, unknown fields dropped, an entry without rule text dropped')

  const none = await directiveFrom({ ...base, taste: { rule: 'r', approved_voice_rules: [] } })
  assert.deepEqual(none.taste, { rule: 'r', approved_voice_rules: [] }, 'empty is kept as none approved, not turned into unknown')

  const absent = await directiveFrom(base)
  assert.equal(absent.taste, undefined, 'absent stays unknown')
  const misshapen = await directiveFrom({ ...base, taste: 'not an object' })
  assert.equal(misshapen.taste, undefined, 'misshapen is unknown, never an empty list')

  assert.equal(parseTaste(undefined), null)
  assert.equal(parseTaste({ rule: 'r' }), null)
})

test('the drafting prompt carries the approved rules as a labelled block, says none when none, and nothing when unknown', () => {
  const dressed = digestSystem(undefined, TASTE)
  assert.match(dressed, /KRISH'S APPROVED VOICE RULES/)
  assert.ok(dressed.includes(SENTINEL))
  assert.match(dressed, /HOW the words you draft are written/)
  assert.match(dressed, /Never use them to choose what a recommendation is about/)
  assert.ok(dressed.indexOf('ABSOLUTE RULE') < dressed.indexOf("KRISH'S APPROVED VOICE RULES"))

  const none = digestSystem(undefined, { rule: '', approved_voice_rules: [] })
  assert.match(none, /He has approved none yet\. Do not invent a voice rule/)
  assert.doesNotMatch(none, /^- /m)

  assert.equal(tasteBlock(null), '')
  assert.doesNotMatch(digestSystem(), /APPROVED VOICE RULES/)
  assert.doesNotMatch(digestSystem(undefined, null), /APPROVED VOICE RULES/)
})

test('taste reaches the digest drafting call only; transcripts, proposals, probes and scores are unchanged by it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-taste-'))
  try {
    const run = async (taste: Taste | null) => {
      const args = parseArgs(['--offline', '--dry', '--subject', 'all', '--week', '2026-09-07', '--out', join(dir, `p-${taste ? 't' : 'n'}.json`)])
      const deps = buildDeps(args, {}, new Date('2026-09-08T00:00:00Z'))
      const inner = deps.model
      const seen: ModelRequest[] = []
      const model: ModelClient = {
        classify: req => { seen.push(req); return inner.classify(req) },
        writeJson: req => { seen.push(req); return inner.writeJson(req) },
      }
      const asked: string[] = []
      deps.engines = deps.engines.map(e => ({ engine: e.engine, model: e.model, ask: (q: string) => { asked.push(q); return e.ask(q) } }))
      deps.model = model
      deps.taste = taste
      const out = await captureStderr(() => runAll(deps, { subject: 'all', weekStart: '2026-09-07', dry: true, outPath: join(dir, `p-${taste ? 't' : 'n'}.json`), commandId: null }))
      return { seen, asked, result: out.result }
    }
    const withTaste = await run(TASTE)
    const without = await run(null)

    const digestCalls = withTaste.seen.filter(r => r.stage === 'digest')
    assert.ok(digestCalls.length > 0, 'the digest drafted')
    for (const r of digestCalls) assert.ok(r.system.includes(SENTINEL), 'every digest drafting call carries the rules')
    for (const r of withTaste.seen.filter(r => r.stage !== 'digest')) {
      assert.ok(!r.system.includes(SENTINEL) && !r.user.includes(SENTINEL), `stage ${r.stage} never sees the rules`)
    }
    assert.ok(!withTaste.asked.some(q => q.includes(SENTINEL)), 'no probe question carries them')
    assert.deepEqual(withTaste.asked, without.asked, 'the same questions are asked')

    // Measurement is untouched: the queries, probes, scores and statuses match.
    const strip = (r: typeof withTaste.result) => r.results.map(x => ({ slug: x.slug, queries: x.packet.queries, stats: x.packet.stats, gap: x.packet.competitor_gap }))
    assert.deepEqual(strip(withTaste.result), strip(without.result))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the run reads taste through the directive door, and unknown when it cannot', async () => {
  const s = new StandIn(TOKEN)
  const base = await s.start()
  try {
    s.directive = { ...structuredClone(s.directive), schema_version: '1.5.0', taste: TASTE } as unknown as StandIn['directive']
    const { result, text } = await captureStderr(() => readTaste({ CONTROL_CENTER_PROTOCOL_URL: base, CONTROL_CENTER_ENGINE_TOKEN: TOKEN }))
    assert.deepEqual(result, TASTE)
    assert.ok(!text.includes(SENTINEL) && !text.includes(TOKEN), 'the log carries counts, never a rule or the bearer')
    assert.match(text, /"state":"approved","rules":1/)
  } finally {
    await s.close()
  }
  assert.equal((await captureStderr(() => readTaste({}))).result, null, 'no bearer here: unknown')
  assert.equal((await captureStderr(() => readTaste({ CONTROL_CENTER_PROTOCOL_URL: 'https://127.0.0.1:1', CONTROL_CENTER_ENGINE_TOKEN: TOKEN }))).result, null, 'unreachable: unknown, not fatal')
})
