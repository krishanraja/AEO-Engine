/**
 * Brand-accuracy checks (src/pipeline/42-brand.ts; brief section B6): Full
 * Time is never "betting tips", Mindmake is not "Mindmaker". Synthetic
 * answers from stub engines only; no network.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Ledger } from '../src/lib/cost.js'
import { askBrandChecks, brandChecksOf, brandSummary, hasPhrase, judgeAnswer } from '../src/pipeline/42-brand.js'
import { brandProposalId, buildDirectiveReport, buildResearchReport, type ResearchInput } from '../src/protocol/reports.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import type { KitCandidate } from '../src/schema/kit.js'
import { validateReport } from '../src/schema/report.js'
import { featuredRun } from './golden.js'
import { ROOT, StubEngine } from './helpers.js'
import { schemaErrors } from './schema-check.js'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/control-center/engine-report.schema.json'), 'utf8')) as Record<string, unknown>
const SECRET_ANSWER = 'A synthetic answer sentence that must never leave the run'

test('checks are read loosely: a question and at least one phrase, each once, at most three a subject', () => {
  const raw = [
    { question: 'What is Full Time, the football show?', must_not: ['betting tips', 'betting tips', ' '], must: ['football'] },
    { question: 'short', must_not: ['x'] },
    { question: 'What does Mindmake do for leaders?', must_not: ['Mindmaker'] },
    { question: 'What does Mindmake do for leaders?', must: ['Mindmake'] },
    { question: 'A question with no phrase at all?' },
    { question: 'Who makes the ctrl writing tool?', must: ['Mindmake'] },
    { question: 'A fourth good question here?', must: ['x1'] },
    'not a check',
  ]
  const checks = brandChecksOf(raw)
  assert.deepEqual(checks, [
    { question: 'What is Full Time, the football show?', must_not: ['betting tips'], must: ['football'] },
    { question: 'What does Mindmake do for leaders?', must_not: ['Mindmaker'], must: [] },
    { question: 'Who makes the ctrl writing tool?', must_not: [], must: ['Mindmake'] },
  ])
  assert.deepEqual(brandChecksOf(null), [])
})

test('pass or fail: no must_not phrase, every must phrase, whole words in any case, URLs not read', () => {
  assert.equal(hasPhrase('Mindmake helps leaders.', 'mindmake'), true)
  assert.equal(hasPhrase('Mindmaker helps leaders.', 'Mindmake'), false, 'whole words: Mindmaker is not Mindmake')
  assert.equal(hasPhrase('MINDMAKER helps', 'Mindmaker'), true)
  assert.equal(hasPhrase('best betting\n tips', 'betting tips'), true, 'any run of spaces between words')
  assert.deepEqual(judgeAnswer('Full Time is a football show.', { must_not: ['betting tips'], must: ['football'] }), { pass: true, must_not: [], must: [] })
  assert.deepEqual(judgeAnswer('Full Time gives betting tips.', { must_not: ['betting tips'], must: ['football'] }), { pass: false, must_not: ['betting tips'], must: ['football'] })
  assert.deepEqual(judgeAnswer('See https://example.com/betting-tips and fulltime.fm/football', { must_not: ['betting tips'], must: ['football'] }), { pass: false, must_not: [], must: ['football'] }, 'a URL is neither a use nor a mention')
})

test('asked once on every packet engine, charged inside the cap, the Claude Code lane free; a gated engine never asked', async () => {
  const say = (text: string) => () => ({ text, citations: [] })
  const perplexity = new StubEngine('perplexity', say(`Full Time is a football show. ${SECRET_ANSWER}`))
  const chatgpt = new StubEngine('chatgpt', say(`Full Time is for betting tips. ${SECRET_ANSWER}`))
  const claude = new StubEngine('claude', say('Full Time, a football podcast.'), 'claude-code/x', { costKind: 'claude_code' })
  const gemini = new StubEngine('gemini', say('betting tips'))
  const ledger = new Ledger(1)
  const checks = brandChecksOf([{ question: 'What is Full Time, the football show?', must_not: ['betting tips'], must: ['football'] }, { question: 'Is Full Time a tipster?', must_not: ['tipster'] }])
  const out = await askBrandChecks([perplexity, chatgpt, claude, gemini], checks, ledger)
  assert.equal(gemini.asked.length, 0, 'a gated engine is not asked')
  assert.deepEqual([perplexity.asked.length, chatgpt.asked.length, claude.asked.length], [2, 2, 2])
  assert.equal(ledger.total, 0.12, 'charged per paid ask (2 x 0.01 + 2 x 0.05); Claude Code free')
  assert.equal(out.results[0].pass, false)
  assert.deepEqual(out.results[0].engines.map(e => [e.engine, e.pass, e.must_not, e.must]), [['perplexity', true, [], []], ['chatgpt', false, ['betting tips'], ['football']], ['claude', true, [], []]])
  assert.equal(out.results[1].pass, true)
  const s = brandSummary(out)
  assert.deepEqual([s.checks, s.answered, s.passed, s.answers], [2, 2, 1, 6])
  assert.ok(!JSON.stringify(s).includes(SECRET_ANSWER), 'no answer text leaves the stage')
  // The cap stops the paid asks and counts them; the free lane still answers.
  const tight = new Ledger(0.05)
  const capped = await askBrandChecks([perplexity, chatgpt, claude], checks.slice(0, 1), tight)
  assert.equal(capped.skipped_cap, 1)
  assert.deepEqual(capped.results[0].engines.map(e => e.engine), ['perplexity', 'claude'])
})

test('an offline research run asks a venture\'s checks, at most three, and keeps only pass or fail with the phrases', async () => {
  const r = await featuredRun('ctrl', [], ctx => {
    const ctrl = ctx.subjects.find(s => s.slug === 'ctrl')!
    ctrl.brand_checks = [
      { question: 'How do I get an AI assistant to write like me?', must_not: ['generic'], must: ['voice'] },
      { question: 'Should I build my own AI skill?', must_not: ['Mindmaker'], must: [] },
      { question: 'How do I stop AI output sounding generic?', must_not: ['xyzzy'], must: [] },
      { question: 'A fourth check that is never asked?', must_not: [], must: ['x'] },
    ]
  })
  assert.deepEqual(r.failures, [])
  const b = r.results[0].more?.brand
  assert.ok(b)
  assert.equal(b.checks, 3)
  for (const res of b.results) for (const e of res.engines) assert.ok(['perplexity', 'chatgpt', 'claude'].includes(e.engine))
  // The packet is unchanged by them: no field.
  assert.ok(!JSON.stringify(r.results[0].packet).includes('must_not'))
})

// ---------- the report and the one suggestion ----------

const sub = (slug: string, over: Partial<SubjectSummary> = {}): SubjectSummary => ({ slug, kind: 'venture', product_slug: slug, ok: true, questions: 25, probed_questions: 25, cited_first: 0, probes: 75, probes_failed: 0, probes_skipped_cap: 0, gap_classes: { won: 0, cited_not_first: 1, retrieved_not_cited: 2, not_retrieved: 3, no_page: 19, unknown: 0 }, kits: 0, ...over })
const runSummary = (subjects: SubjectSummary[]): RunSummary => ({ v: 1, subject_arg: 'all', week_start: '2026-11-16', generated_at: '2026-11-22T10:00:00Z', engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 2, max_probe_usd: 0.07, error_code: null, subjects })
const research = (subjects: SubjectSummary[], over: Partial<ResearchInput> = {}): ResearchInput => ({ runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: new Date('2026-11-22T10:30:00Z'), revision: 'abc', capturedAt: new Date('2026-11-22T04:00:00Z'), scope: 'all', expected: subjects.map(s => s.slug), summaries: [runSummary(subjects)], totalCapUsd: 25, planError: null, decisions: [], ...over })
const failed = {
  checks: 2, answered: 2, passed: 1, answers: 6, skipped_cap: 0,
  results: [
    { question: 'What is Full Time, the football show?', pass: false, engines: [{ engine: 'perplexity', pass: true, must_not: [], must: [] }, { engine: 'chatgpt', pass: false, must_not: ['betting tips'], must: ['football'] }] },
    { question: 'Is Full Time a tipster?', pass: true, engines: [{ engine: 'perplexity', pass: true, must_not: [], must: [] }] },
  ],
}
const kit: KitCandidate = { product_slug: 'heartside', query_id: 'aaaaaaa1-0000-4000-8000-000000000000', priority: 3, title: 'A question?', exact_payload: 'Win kit kit:heartside:aaaaaaa1 (v1)\nQuestion: A question?', gap_class: 'no_page', target_kind: 'new_page', reference: 'heartside.io' }

test('report: "Brand checks: X of Y passed", and a failed check becomes one suggestion only when no kit was proposed, never for a held venture or one he decided', () => {
  const plain = buildResearchReport(research([sub('heartside', { brand_checks: failed })]))
  assert.deepEqual(schemaErrors(SCHEMA, plain), [])
  assert.deepEqual(validateReport(plain), { ok: true })
  assert.ok(plain.activity.some(a => a.line.includes('Brand checks: 1 of 2 passed.')))
  assert.equal(plain.proposals.length, 1)
  const p = plain.proposals[0]
  assert.equal(p.proposal_id, brandProposalId('heartside', 'What is Full Time, the football show?'))
  assert.match(p.proposal_id, /^aeo:brand:heartside:[0-9a-f]{8}$/)
  assert.deepEqual([p.wall, p.kind, p.stage, p.amount_usd], ['strategy', 'advice', undefined, null])
  assert.match(p.exact_payload ?? '', /^Brand check failed for heartside\nQuestion: What is Full Time, the football show\?\n\n- perplexity: passed\n- chatgpt: used "betting tips", which it must not; left out "football", which it must say\n/)
  assert.ok(plain.activity.some(a => a.line === 'One brand check that failed, for heartside, is on Krish\'s list as a suggestion; no kit was proposed this run.'))
  // With a kit proposed this run, no suggestion: at most one AEO proposal a run besides check-ins.
  const withKit = buildResearchReport(research([sub('heartside', { brand_checks: failed, kits: 1, kit_candidate: kit })]))
  assert.deepEqual(withKit.proposals.map(x => x.proposal_id), ['aeo:kit:heartside:aaaaaaa1'])
  assert.ok(withKit.activity.some(a => a.line.includes('Brand checks: 1 of 2 passed.')), 'still counted')
  // Never for a held venture.
  assert.deepEqual(buildResearchReport(research([sub('full-time', { held: true, brand_checks: failed })])).proposals, [])
  // Never one he decided; never when his decisions could not be read; never from a run of one subject.
  assert.deepEqual(buildResearchReport(research([sub('heartside', { brand_checks: failed })], { decisions: [{ proposal_id: p.proposal_id, decision: 'declined', decided_at: '2026-11-20T09:00:00Z', payload_sha256: p.payload_sha256 }] })).proposals, [])
  assert.deepEqual(buildResearchReport(research([sub('heartside', { brand_checks: failed })], { decisions: null })).proposals, [])
  assert.deepEqual(buildResearchReport(research([sub('heartside', { brand_checks: failed })], { scope: 'one' })).proposals, [])
  // The daily report carries it until he decides.
  const last = { run_id: plain.run_id, accepted_at: '2026-11-22T10:31:00Z', report: plain as unknown as Record<string, unknown> }
  const day = new Date('2026-11-23T05:12:00Z')
  const daily = buildDirectiveReport({ runId: 'aeo:2026-11-23:directive', mode: 'synthetic', observedAt: day, revision: 'abc', capturedAt: day, directive: { directive_id: 'aeo:2026-11-23', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last, lastError: null, decisions: [] })
  assert.deepEqual(daily.proposals, [p])
})
