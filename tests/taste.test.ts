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
import { digestSystem, type DigestResult } from '../src/pipeline/60-digest.js'
import { applyVoice, tasteBlock, voiceSystem } from '../src/pipeline/65-voice.js'
import { runAll } from '../src/pipeline/run.js'
import { Ledger } from '../src/lib/cost.js'
import { StubModel, subject } from './helpers.js'
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

test('the judging prompt never carries taste; the wording-only prompt carries it labelled, says none when none, and nothing when unknown', () => {
  assert.equal(digestSystem.length <= 1, true, 'digestSystem takes no taste')
  assert.ok(!digestSystem().includes('APPROVED VOICE RULES'))

  const dressed = voiceSystem(TASTE)
  assert.match(dressed, /KRISH'S APPROVED VOICE RULES/)
  assert.ok(dressed.includes(SENTINEL))
  assert.match(dressed, /HOW the words are written/)
  assert.match(dressed, /keep every item, its id and its order exactly/)

  const none = tasteBlock({ rule: '', approved_voice_rules: [] })
  assert.match(none, /He has approved none yet\. Do not invent a voice rule/)
  assert.doesNotMatch(none, /^- /m)
  assert.equal(tasteBlock(null), '')
})

/** A model that answers the voice pass by echoing what it was given with each line reworded, plus an optional twist. */
function voicing(inner: ModelClient, seen: ModelRequest[], twist: (j: Record<string, any>) => void = () => {}): ModelClient {
  const answer = (req: ModelRequest): Promise<string> | string => {
    seen.push(req)
    if (req.stage !== 'voice') return req.stage === 'classify' ? inner.classify(req) : inner.writeJson(req)
    const j = JSON.parse(req.user.slice(req.user.indexOf('{'))) as Record<string, any>
    for (const r of j.recommendations) { r.title = `Voiced ${r.title}`; r.angle = `Voiced ${r.angle}` }
    for (const w of j.watch_list) w.why = `Voiced ${w.why}`
    if (j.approach_hook) j.approach_hook = `Voiced ${j.approach_hook}`
    twist(j)
    return JSON.stringify(j)
  }
  return { classify: async req => answer(req), writeJson: async req => answer(req) }
}

test('taste never reaches a judging call; recommendations, walls, signal and measurement are identical with and without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-taste-'))
  try {
    const run = async (taste: Taste | null, tag: string) => {
      const out = join(dir, `p-${tag}.json`)
      const args = parseArgs(['--offline', '--dry', '--subject', 'all', '--week', '2026-09-07', '--out', out])
      const deps = buildDeps(args, {}, new Date('2026-09-08T00:00:00Z'))
      const seen: ModelRequest[] = []
      deps.model = voicing(deps.model, seen)
      const asked: string[] = []
      deps.engines = deps.engines.map(e => ({ engine: e.engine, model: e.model, ask: (q: string) => { asked.push(q); return e.ask(q) } }))
      deps.taste = taste
      const r = await captureStderr(() => runAll(deps, { subject: 'all', weekStart: '2026-09-07', dry: true, outPath: out, commandId: null }))
      return { seen, asked, result: r.result }
    }
    const withTaste = await run(TASTE, 't')
    const without = await run(null, 'n')
    const noneApproved = await run({ rule: 'r', approved_voice_rules: [] }, 'e')

    // The judging call (the digest) and every other stage never see a rule.
    for (const r of withTaste.seen.filter(r => r.stage !== 'voice')) {
      assert.ok(!r.system.includes(SENTINEL) && !r.user.includes(SENTINEL), `stage ${r.stage} never sees the rules`)
    }
    const voiceCalls = withTaste.seen.filter(r => r.stage === 'voice')
    assert.ok(voiceCalls.length > 0, 'the wording pass ran')
    for (const r of voiceCalls) assert.ok(r.system.includes(SENTINEL))
    assert.equal(without.seen.filter(r => r.stage === 'voice').length, 0, 'unknown taste: no call')
    assert.equal(noneApproved.seen.filter(r => r.stage === 'voice').length, 0, 'none approved: no call, nothing invented')
    assert.ok(!withTaste.asked.some(q => q.includes(SENTINEL)))
    assert.deepEqual(withTaste.asked, without.asked, 'the same questions are asked')

    const decided = (r: typeof withTaste.result) => r.results.map(x => ({
      slug: x.slug,
      queries: x.packet.queries,
      stats: x.packet.stats,
      gap: x.packet.competitor_gap,
      not_worth_chasing: x.packet.not_worth_chasing,
      strongest_signal: x.packet.strongest_signal,
      recommendations: x.packet.recommendations.map(({ title: _t, angle: _a, ...rest }) => rest),
      watch: x.packet.watch_list.map(w => w.query_id),
      hook: x.packet.approach_hook === null,
    }))
    assert.deepEqual(decided(withTaste.result), decided(without.result), 'every decision and measurement is the same')
    const titles = withTaste.result.results.flatMap(x => x.packet.recommendations.map(r => r.title))
    // Model-written digests are reworded; a fallback digest is left plain (its lines are built from the score table).
    for (const x of withTaste.result.results) {
      const titles = x.packet.recommendations.map(r => r.title)
      if (x.packet.stats.digest_writer === 'claude') assert.ok(titles.length > 0 && titles.every(t => t.startsWith('Voiced ')), `${x.slug}: only the wording changed`)
      else assert.ok(titles.every(t => !t.startsWith('Voiced ')), `${x.slug}: fallback left plain`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the wording pass keeps the digest whole when it adds, drops, reorders or adds a number', async () => {
  const s = subject('ctrl')
  const rec = (id: string, title: string) => ({ n: 1, title, target_query: 'q', query_id: id, angle: 'Angle with 3 engines', evidence: ['e'], engines: [], demand: 40, why_you_can_win: null })
  const draft: DigestResult = {
    strongest_signal: 's', recommendations: [rec('a', 'First'), { ...rec('b', 'Second'), n: 2 }], not_worth_chasing: [], watch_list: [{ query_id: 'w', query: 'q', why: 'why' }],
    competitor_gap: { domain: null, times_cited: 0, questions: [] } as unknown as DigestResult['competitor_gap'], playbook: null, approach_hook: null, digest_writer: 'claude',
  }
  const tryWith = async (twist: (j: Record<string, any>) => void) => applyVoice(voicing(new StubModel('THROW'), [], twist), new Ledger(10), s, TASTE, draft)

  const ok = await tryWith(() => {})
  assert.deepEqual(ok.recommendations.map(r => [r.query_id, r.title]), [['a', 'Voiced First'], ['b', 'Voiced Second']])
  assert.equal(ok.approach_hook, null)

  for (const twist of [
    (j: Record<string, any>) => j.recommendations.reverse(),
    (j: Record<string, any>) => j.recommendations.pop(),
    (j: Record<string, any>) => j.recommendations.push({ query_id: 'c', title: 't', angle: 'a' }),
    (j: Record<string, any>) => { j.recommendations[0].angle = 'Angle with 9 engines' },
    (j: Record<string, any>) => { j.approach_hook = 'A hook nobody asked for' },
    (j: Record<string, any>) => { j.watch_list = [] },
  ]) assert.deepEqual(await tryWith(twist), draft)

  assert.deepEqual(await applyVoice(new StubModel('THROW'), new Ledger(10), s, TASTE, draft), draft, 'a failed call keeps the draft')
  assert.deepEqual(await applyVoice(new StubModel('THROW'), new Ledger(10), s, { rule: '', approved_voice_rules: [] }, draft), draft)
  assert.deepEqual(await applyVoice(new StubModel('THROW'), new Ledger(10), s, TASTE, { ...draft, digest_writer: 'fallback' }), { ...draft, digest_writer: 'fallback' })
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
