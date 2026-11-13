/**
 * Outcomes (src/pipeline/63-outcomes.ts): what Control Center's search
 * signals say about the page a venture shipped or a kit targets. Missing is
 * unknown, never zero; GA4 and Clarity are kept apart, never summed.
 * Synthetic signals only; this engine holds no Search Console, Bing, GA4 or
 * Clarity credential.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { normaliseQuery } from '../src/lib/text.js'
import { withEvidence } from '../src/pipeline/62-kits.js'
import { known, outcomeCounts, outcomeFor, outcomeLine, outcomesFor, outcomeTargets, readSignals, windowEnding } from '../src/pipeline/63-outcomes.js'
import { buildResearchReport, referralsPart, type ResearchInput } from '../src/protocol/reports.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import type { Kit } from '../src/schema/kit.js'
import { validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { featuredRun, GOLDEN_NOW, SYNTHETIC_SIGNALS } from './golden.js'
import { ROOT, readJson } from './helpers.js'
import { schemaErrors } from './schema-check.js'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/packet.schema.json'), 'utf8')) as Record<string, unknown>
const NOW = new Date('2026-11-22T10:00:00Z')
const PAGE = 'https://heartside.io/answers/dog-gift'
/** The venture's own domains: a referral row given as a bare path is read only against them. */
const OWN = ['heartside.io', 'linkedin.com/in/someone-synthetic']

const SIGNALS = {
  gsc_queries: [
    { query: 'dog gift', page: 'https://www.heartside.io/answers/dog-gift/', impressions: 100, clicks: 4, position: 6, date_from: '2026-11-01', date_to: '2026-11-07' },
    { query: 'gift from my dog', page: 'http://heartside.io/answers/dog-gift?utm_source=x', impressions: 300, clicks: 6, position: 10, date_from: '2026-11-15', date_to: '2026-11-21' },
    { query: 'before', page: PAGE, impressions: 50, clicks: 0, position: 20, date_from: '2026-10-10', date_to: '2026-10-16' },
    { query: 'too old', page: PAGE, impressions: 999, clicks: 99, position: 1, date_from: '2026-08-01', date_to: '2026-08-31' },
    { query: 'other page', page: 'https://heartside.io/mug', impressions: 7, clicks: 1, position: 3, date_from: '2026-11-10', date_to: '2026-11-10' },
    { query: 'broken', page: 7, impressions: 'x' },
  ],
  bing: { url_info: [{ url: 'https://heartside.io/answers/dog-gift', indexed: true, last_crawled: '2026-11-20T03:00:00Z' }, { url: 'nope' }] },
  ai_referrals: [
    { landing_page: '/answers/dog-gift', source: 'chatgpt.com', sessions: 5, date: '2026-11-20', via: 'ga4' },
    { landing_page: 'https://heartside.io/answers/dog-gift', source: 'perplexity.ai', sessions: 2, date: '2026-11-20', via: 'clarity' },
    { landing_page: '/answers/dog-gift', source: 'chatgpt.com', sessions: 3, date: '2026-11-20', via: 'clarity' },
    { landing_page: '/answers/dog-gift', source: 'chatgpt.com', sessions: 40, date: '2026-09-01', via: 'ga4' },
    { landing_page: '/answers/dog-gift', source: 'claude.ai', sessions: 9, date: '2026-11-20' },
  ],
}

test('joins on the normalised URL: www, utm, a trailing slash and the scheme meet; a landing page given as a path meets it too', () => {
  const s = readSignals(SIGNALS)
  const o = outcomeFor(PAGE, '2026-11-01', s, NOW, OWN)
  const w = windowEnding(NOW)
  assert.deepEqual(w, { from: '2026-10-26', to: '2026-11-22' })
  // In the window: 100 + 300 impressions, position weighted by impressions: (600 + 3000) / 400 = 9.
  assert.deepEqual(o.gsc, { impressions: 400, clicks: 10, position: 9, from: '2026-10-26', to: '2026-11-22', before: { impressions: 50, clicks: 0, position: 20, from: '2026-10-04', to: '2026-10-31' } })
  assert.deepEqual(o.bing, { indexed: true, last_crawled: '2026-11-20' })
  // GA4 and Clarity apart, never summed; a row with no via is dropped; the old row is outside the window.
  assert.deepEqual(o.ai_referrals, { from: '2026-10-26', to: '2026-11-22', ga4: 5, clarity: 5 })
  assert.equal(known(o), true)
  assert.equal(outcomeLine(o), 'outcome, last 28 days: Search Console 400 impressions, 10 clicks, position 9; before it shipped 50 impressions, 0 clicks; Bing indexed, crawled 2026-11-20; AI referrals GA4 5, Clarity 5')
  assert.ok((outcomeLine(o) ?? '').length <= 200 && !/https?:/.test(outcomeLine(o) ?? ''))
})

test('missing is unknown, never zero: no signals, an empty list, a host the data does not cover, a URL Bing has no row for', () => {
  const none = outcomeFor(PAGE, null, readSignals(undefined), NOW, OWN)
  assert.deepEqual(none, { url: PAGE, gsc: null, bing: null, ai_referrals: null })
  assert.equal(known(none), false)
  assert.equal(outcomeLine(none), null)
  const empty = outcomeFor(PAGE, null, readSignals({ gsc_queries: [], bing: { url_info: [] }, ai_referrals: [] }), NOW, OWN)
  assert.deepEqual(empty, none, 'served empty is unknown too')
  const s = readSignals(SIGNALS)
  const elsewhere = outcomeFor('https://other.example/page', null, s, NOW, OWN)
  assert.equal(elsewhere.gsc, null, 'Search Console holds no row on that host: unknown for it')
  assert.equal(elsewhere.bing, null)
  assert.equal(elsewhere.ai_referrals, null, 'no referral row on that host, and a bare path is never another host\'s: unknown, not zero')
  // A page the data covers with no row in the window is a measured zero; with no shipping day, no "before".
  const quiet = outcomeFor('https://heartside.io/answers/quiet', null, s, NOW, OWN)
  assert.deepEqual(quiet.gsc, { impressions: 0, clicks: 0, position: null, from: '2026-10-26', to: '2026-11-22', before: null })
  assert.deepEqual(quiet.ai_referrals, { from: '2026-10-26', to: '2026-11-22', ga4: 0, clarity: 0 })
  // GA4 served under the brief's first name only: Clarity stays unknown.
  const legacy = outcomeFor(PAGE, null, readSignals({ ga4_ai_referrals: [{ landing_page: '/answers/dog-gift', source: 'chatgpt.com', sessions: 4, date: '2026-11-21' }] }), NOW, OWN)
  assert.deepEqual(legacy.ai_referrals, { from: '2026-10-26', to: '2026-11-22', ga4: 4, clarity: null })
})

test('the window before shipping: unknown unless the rows reach back to its first day; a row across the shipping day counts in neither window', () => {
  const rows = (extra: object[]) => readSignals({ gsc_queries: [
    { query: 'after', page: PAGE, impressions: 100, clicks: 5, position: 5, date_from: '2026-11-03', date_to: '2026-11-09' },
    { query: 'before', page: PAGE, impressions: 40, clicks: 2, position: 8, date_from: '2026-10-12', date_to: '2026-10-18' },
    ...extra,
  ] })
  // Shipped 1 November: the window before runs 4 to 31 October. Nothing on the host starts by 4 October, so it is unknown, never zero.
  assert.equal(outcomeFor(PAGE, '2026-11-01', rows([]), NOW, OWN).gsc?.before, null)
  // A row on the host from 1 October reaches back: the window before is measured (that row is outside it).
  const reach = { query: 'old', page: 'https://heartside.io/mug', impressions: 9, clicks: 0, position: 4, date_from: '2026-10-01', date_to: '2026-10-02' }
  assert.deepEqual(outcomeFor(PAGE, '2026-11-01', rows([reach]), NOW, OWN).gsc?.before, { impressions: 40, clicks: 2, position: 8, from: '2026-10-04', to: '2026-10-31' })
  // A row from 28 October to 3 November runs across the shipping day: in neither window.
  const across = { query: 'across', page: PAGE, impressions: 500, clicks: 50, position: 2, date_from: '2026-10-28', date_to: '2026-11-03' }
  const o = outcomeFor(PAGE, '2026-11-01', rows([reach, across]), NOW, OWN)
  assert.deepEqual([o.gsc?.impressions, o.gsc?.before?.impressions], [100, 40])
  // With no shipping day, a row counts by its last day as before.
  assert.equal(outcomeFor(PAGE, null, rows([across]), NOW, OWN).gsc?.impressions, 600)
})

test('AI referrals: a bare path meets only our own hosts, once a page and once in the total; a list with no row on the page\'s host is unknown', () => {
  const s = readSignals({ ai_referrals: [
    { landing_page: '/answers/dog-gift', source: 'chatgpt.com', sessions: 5, date: '2026-11-20', via: 'ga4' },
    { landing_page: 'https://shop.heartside.io/answers/other', source: 'chatgpt.com', sessions: 2, date: '2026-11-20', via: 'ga4' },
  ] })
  // A page someone else hosts with the same path: the bare path is not theirs, and GA4 covers no row on their host.
  assert.equal(outcomeFor('https://medium.com/answers/dog-gift', null, s, NOW, OWN).ai_referrals, null)
  // Two of our hosts with that path: each page reads it once, and the total counts it once.
  const pages = new Map([['q1', { url: PAGE, shipped_at: null, from: 'shipped' as const }], ['q2', { url: 'https://shop.heartside.io/answers/dog-gift', shipped_at: null, from: 'kit' as const }]])
  const outs = outcomesFor(pages, s, NOW, OWN)
  assert.deepEqual([...outs.values()].map(o => o.ai_referrals?.ga4), [5, 5])
  assert.deepEqual(outcomeCounts(outs, s, OWN).ga4, { sessions: 5, pages: 2 }, 'never doubled')
  // A domain with a path is not one of our hosts: a bare path never lands on a profile.
  assert.equal(outcomeFor('https://linkedin.com/in/someone-synthetic/answers/dog-gift', null, s, NOW, OWN).ai_referrals, null)
  // Without our domains, a bare path meets nothing: heartside.io is then unknown; shop.heartside.io, covered by a full URL, reads a measured zero.
  assert.equal(outcomeFor(PAGE, null, s, NOW).ai_referrals, null)
  assert.deepEqual(outcomeCounts(outcomesFor(pages, s, NOW), s).ga4, { sessions: 0, pages: 0 })
  // No tracked page covered at all: the total is unknown, never zero.
  assert.equal(outcomeCounts(outcomesFor(new Map([['q1', { url: PAGE, shipped_at: null, from: 'shipped' as const }]]), s, NOW), s).ga4, null)
})

test('the tracked page: what the venture shipped wins over a kit\'s target; a kit with no URL tracks nothing', () => {
  const queries = [{ query_id: 'aaaaaaa1-0000-4000-8000-000000000000', query: 'What gift says my dog loves me?' }, { query_id: 'aaaaaaa2-0000-4000-8000-000000000000', query: 'A mug from my dog?' }, { query_id: 'aaaaaaa3-0000-4000-8000-000000000000', query: 'No page yet?' }]
  const kits = [
    { query_id: queries[0].query_id, target: { kind: 'update_page', url: 'https://heartside.io/kit-page', host: 'heartside.io', suggested_path: null } },
    { query_id: queries[1].query_id, target: { kind: 'update_page', url: 'https://heartside.io/mug', host: 'heartside.io', suggested_path: null } },
    { query_id: queries[2].query_id, target: { kind: 'new_page', url: null, host: 'heartside.io', suggested_path: '/answers/no-page-yet' } },
  ] as Array<Pick<Kit, 'query_id' | 'target'>>
  const t = outcomeTargets(queries, [{ question: 'What gift says my dog loves me?', url: PAGE, shipped_at: '2026-11-01' }], kits, normaliseQuery)
  assert.deepEqual([...t.entries()], [
    [queries[0].query_id, { url: PAGE, shipped_at: '2026-11-01', from: 'shipped' }],
    [queries[1].query_id, { url: 'https://heartside.io/mug', shipped_at: null, from: 'kit' }],
  ])
  const counts = outcomeCounts(outcomesFor(t, readSignals(SIGNALS), NOW, OWN), readSignals(SIGNALS), OWN)
  assert.deepEqual(counts, { served: { gsc: true, bing: true, ga4: true, clarity: true }, pages: 2, ga4: { sessions: 5, pages: 1 }, clarity: { sessions: 5, pages: 1 }, gsc: { impressions: 407, clicks: 11, pages: 2 }, days: 28 })
})

test('report: one line a venture, "AI referrals: N sessions to M answer pages in 28 days", GA4 and Clarity apart, unknown when not served', () => {
  assert.equal(referralsPart({ served: { gsc: true, bing: true, ga4: true, clarity: true }, pages: 2, ga4: { sessions: 5, pages: 1 }, clarity: { sessions: 5, pages: 1 }, gsc: null, days: 28 }), 'AI referrals: GA4 5 sessions to 1 answer page, Clarity 5 sessions to 1 answer page in 28 days (counted apart, never summed)')
  assert.equal(referralsPart({ served: { gsc: false, bing: false, ga4: true, clarity: false }, pages: 3, ga4: { sessions: 12, pages: 3 }, clarity: null, gsc: null, days: 28 }), 'AI referrals: GA4 12 sessions to 3 answer pages in 28 days (counted apart, never summed)')
  assert.equal(referralsPart({ served: { gsc: false, bing: false, ga4: false, clarity: false }, pages: 3, ga4: null, clarity: null, gsc: null, days: 28 }), 'AI referrals: unknown (no AI-referral readings served)')
  assert.equal(referralsPart({ served: { gsc: false, bing: false, ga4: true, clarity: false }, pages: 0, ga4: { sessions: 0, pages: 0 }, clarity: null, gsc: null, days: 28 }), 'AI referrals: no answer page tracked yet (no shipped page and no kit target page)')
  assert.equal(referralsPart(undefined), 'AI referrals: unknown (no search signals served)')
  const sub = (slug: string, over: Partial<SubjectSummary>): SubjectSummary => ({ slug, kind: 'venture', product_slug: slug, ok: true, questions: 25, probed_questions: 25, cited_first: 0, probes: 75, probes_failed: 0, probes_skipped_cap: 0, ...over })
  const summary: RunSummary = { v: 1, subject_arg: 'all', week_start: '2026-11-16', generated_at: NOW.toISOString(), engines: ['perplexity'], cap_usd: 5, spent_usd: 1, max_probe_usd: 0.07, error_code: null, subjects: [sub('heartside', { outcomes: { served: { gsc: true, bing: false, ga4: true, clarity: true }, pages: 2, ga4: { sessions: 5, pages: 1 }, clarity: { sessions: 2, pages: 1 }, gsc: { impressions: 9, clicks: 1, pages: 1 }, days: 28 } }), sub('ctrl', {})] }
  const input: ResearchInput = { runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: NOW, revision: 'abc', capturedAt: NOW, scope: 'all', expected: ['heartside', 'ctrl'], summaries: [summary], totalCapUsd: 25, planError: null, decisions: [] }
  const lines = buildResearchReport(input).activity.map(a => a.line)
  assert.ok(lines.includes('For heartside: AI referrals: GA4 5 sessions to 1 answer page, Clarity 2 sessions to 1 answer page in 28 days (counted apart, never summed).'))
  assert.ok(lines.includes('For ctrl: AI referrals: unknown (no search signals served).'), 'always one line a venture')
  assert.ok(!lines.some(l => /https?:\/\//.test(l)))
})

test('packet and kits: queries[].outcome only with the outcome feature and served signals; a kit\'s evidence gains one line', async () => {
  const on = await featuredRun('ctrl', ['outcome', 'kits'])
  const p = on.results[0].packet
  const withOutcome = p.queries.filter(q => q.outcome)
  assert.ok(withOutcome.length > 0)
  assert.deepEqual(schemaErrors(SCHEMA, p), [])
  assert.equal(validatePacket(p, { features: ['outcome', 'kits'] }).ok, true)
  assert.equal(validatePacket(p, { features: ['kits'] }).ok, false)
  const tracked = withOutcome.find(q => q.outcome?.url.endsWith('/answers/personal-ai-writing-style'))!
  assert.deepEqual(tracked.outcome?.ai_referrals, { from: '2026-08-17', to: '2026-09-13', ga4: 3, clarity: 2 })
  assert.equal(windowEnding(GOLDEN_NOW).to, '2026-09-13')
  assert.ok(p.kits?.some(k => k.evidence.some(e => e.startsWith('outcome, last 28 days: Search Console 160 impressions'))))
  assert.ok(SYNTHETIC_SIGNALS.gsc_queries.length > 0)
  // Without signals served, no outcome is attached, even with the feature listed.
  const none = await featuredRun('ctrl', ['outcome'], ctx => { delete ctx.subjects.find(s => s.slug === 'ctrl')!.search_signals })
  assert.ok(none.results[0].packet.queries.every(q => !('outcome' in q)))
  assert.equal(none.results[0].more?.outcomes?.served.ga4, false)
  // A kit's evidence keeps its cap of six lines: the reading takes the last place when it is full.
  const kit = (readJson('expected/packet.ctrl.features.json') as AeoPacket).kits![0]
  const full = { ...kit, evidence: ['a', 'b', 'c', 'd', 'e', 'f'] } as Kit
  assert.deepEqual(withEvidence(full, 'outcome, last 28 days: Bing indexed').evidence, ['a', 'b', 'c', 'd', 'e', 'outcome, last 28 days: Bing indexed'])
  assert.equal(withEvidence(full, null), full)
})
