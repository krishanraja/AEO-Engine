import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SiteFetcher, SitePage } from '../src/clients/site.js'
import { OfflineSite } from '../src/clients/site.js'
import { CAPS } from '../src/config/run.js'
import { isHeld, ownerRepoOf, parseSubjectsConfig, subjectsConfig, type SubjectsConfig } from '../src/config/subjects.js'
import { Ledger } from '../src/lib/cost.js'
import type { ProbeDetail } from '../src/lib/probeDetail.js'
import { probeDetail } from '../src/lib/probeDetail.js'
import { EM_DASH_RE } from '../src/lib/text.js'
import { auditHost, auditHosts, siteAudit, type AuditPage, type SiteAudit } from '../src/pipeline/15-site.js'
import type { ProbeEvidence } from '../src/pipeline/40-probe.js'
import { alignmentOf, firstCitedEntries, firstNotOurs, genericWordsFor, matchPages, readFirstCited, thirdPartyPerHost, type CitedEntry, type PageMatch } from '../src/pipeline/45-pages.js'
import { assignStatus } from '../src/pipeline/50-score.js'
import { diagnose, diagnoseAll, gapClassOf, kitPriority, type Diagnosis } from '../src/pipeline/52-diagnose.js'
import { writeDigest, type DigestInput } from '../src/pipeline/60-digest.js'
import { gapFor } from '../src/pipeline/20-gap.js'
import { buildKits, cutAtWord, h2sFrom, kitCandidate, pageFixes, renderKit, suggestedPath, TITLE_MAX, type Kit, type KitInput } from '../src/pipeline/62-kits.js'
import { withFallback } from '../src/pipeline/stage.js'
import type { Engine, PacketQuery, Probe } from '../src/schema/packet.js'
import { captureStderr } from './standin.js'
import { FIXTURES, ROOT, StubModel, fixtureContext, subject } from './helpers.js'

const OURS = ['ours.example']
const qid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
const detail = (n: number, engine: Engine, over: Partial<ProbeDetail> = {}): ProbeDetail => ({ query_id: qid(n), engine, first_host_ours: false, our_position: null, cited_any: false, searched: true, zero_citation: false, retrieved_ours: false, ...over })
const page = (url: string, title: string, over: Partial<AuditPage> = {}): AuditPage => ({ url, status: 200, title, h1: title, h1_count: 1, h2_count: 3, words: 400, has_answer_first: true, noindex: false, canonical_self: true, date_published: '2026-01-01', date_modified: null, client_rendered: false, ...over })

// ---------- 45: our best page ----------

test('matchPages: the share of the question\'s words in the title and H1; below the line no page answers it', () => {
  assert.equal(alignmentOf('What is a personal AI writing style?', 'What is a personal AI writing style? | Ours'), 1)
  assert.equal(alignmentOf('How do I write LinkedIn posts with AI?', 'Writing posts for LinkedIn'), 0.5, 'linkedin and post (plural s taken off); write is not writing')
  assert.equal(alignmentOf('the of and', 'anything'), 0)
  const pages = [
    page('https://ours.example/', 'Ours: a standard you keep'),
    page('https://ours.example/answers/style', 'What is a personal AI writing style?'),
    page('https://ours.example/gone', 'What is a personal AI writing style?', { status: 404 }),
  ]
  const m = matchPages([{ query_id: qid(1), query: 'What is a personal AI writing style?' }, { query_id: qid(2), query: 'Which CRM suits a florist?' }], pages)
  assert.equal(m.get(qid(1))?.our_best_url, 'https://ours.example/answers/style')
  assert.equal(m.get(qid(1))?.alignment, 1)
  assert.equal(m.get(qid(2))?.our_best_url, null)
  assert.ok((m.get(qid(2))?.alignment ?? 1) < CAPS.PAGE_MATCH_MIN)
})

// ---------- 52: the gap class, as a table ----------

test('diagnose: each gap class, in order', () => {
  const rows: Array<[string, ProbeDetail[], string | null, string]> = [
    ['no answer', [], 'https://ours.example/a', 'unknown'],
    ['first on one engine', [detail(1, 'chatgpt', { first_host_ours: true, cited_any: true }), detail(1, 'claude', { cited_any: true })], null, 'won'],
    ['cited, not first', [detail(1, 'chatgpt', { cited_any: true, our_position: 3 }), detail(1, 'claude', { retrieved_ours: true })], 'https://ours.example/a', 'cited_not_first'],
    ['retrieved, not cited', [detail(1, 'chatgpt', { retrieved_ours: true }), detail(1, 'claude')], null, 'retrieved_not_cited'],
    ['a page, never retrieved', [detail(1, 'chatgpt'), detail(1, 'claude')], 'https://ours.example/a', 'not_retrieved'],
    ['no page', [detail(1, 'chatgpt'), detail(1, 'claude')], null, 'no_page'],
  ]
  for (const [why, ds, best, want] of rows) assert.equal(gapClassOf(ds, best), want, why)
})

test('diagnose: the first cited page is the first engine\'s, and general platforms owning the firsts mark it', () => {
  const evidence = new Map<string, ProbeEvidence[]>([[qid(1), [
    { engine: 'perplexity', citations: ['https://ours.example/x', 'https://medium.com/@someone/post', 'https://www.youtube.com/watch?v=1'], retrieved: [], fan_out: [] },
    { engine: 'chatgpt', citations: ['https://www.linkedin.com/pulse/x'], retrieved: [], fan_out: [] },
    { engine: 'claude', citations: ['https://niche.example/guide'], retrieved: [], fan_out: [] },
  ]]])
  const entries = firstCitedEntries(evidence, OURS)
  const e = entries.get(qid(1))!
  assert.deepEqual(e.map(x => [x.engine, x.position, x.host, x.url]), [['perplexity', 2, 'medium.com', null], ['chatgpt', 1, 'linkedin.com', 'https://www.linkedin.com/pulse/x'], ['claude', 1, 'niche.example', 'https://niche.example/guide']], 'ours is passed over; a handle URL is still first, its host kept and its URL not')
  const d = diagnose(qid(1), [detail(1, 'perplexity', { cited_any: true })], undefined, e)
  assert.equal(d.first_cited?.host, 'medium.com')
  assert.equal(d.first_cited?.url, null)
  assert.equal(d.owned_by_platform, true, 'two of three first-cited hosts are platforms')
  const mixed = diagnose(qid(1), [detail(1, 'claude')], undefined, [e[2]])
  assert.equal(mixed.owned_by_platform, false)
})

test('kit priority: class weight, demand and platform ownership; won and unknown are zero', () => {
  assert.equal(kitPriority('cited_not_first', 50, false), 6)
  assert.equal(kitPriority('retrieved_not_cited', 60, false), 4.8)
  assert.equal(kitPriority('not_retrieved', 0, false), 2)
  assert.equal(kitPriority('no_page', 100, true), 1)
  assert.equal(kitPriority('won', 100, false), 0)
  assert.equal(kitPriority('unknown', 100, false), 0)
})

// ---------- 50: status by kit priority ----------

const probe = (engine: Engine, we_cited: boolean): Probe => ({ engine, model: 'm', question: 'q', answer_snapshot: 'x'.repeat(300), we_cited, citations: ['https://h.example/a', 'https://i.example/b'], cost_usd: 0.01 })
const row = (n: number, score: number, probes: Probe[], competitors: string[] = ['h.example']): PacketQuery => ({
  query_id: qid(n), query: `q${n}`, source: 'seed', demand_score: score, demand_basis: { llm_demand: 0, transcript_evidence: 0, rising_volume: 0, labels: [] }, call_evidence: [],
  gap: { we_cited_engines: probes.filter(p => p.we_cited).map(p => p.engine), competitor_domains: competitors }, trend: 'new', status: 'drop', touchpoint_id: null, probes,
})
const diag = (n: number, gap_class: Diagnosis['gap_class'], owned = false): Diagnosis => ({ query_id: qid(n), gap_class, our_best_url: null, alignment: 0, our_cited_url: null, first_cited: null, owned_by_platform: owned })

test('status: recommend ranks the questions we are absent from by kit priority; watch takes every question we are cited on', () => {
  const three = (cited = false) => [probe('perplexity', cited), probe('chatgpt', false), probe('claude', false)]
  const rows = [
    row(1, 90, three(true)),  // won: watch, however high its demand
    row(2, 80, three(true)),  // cited, not first: watch
    row(3, 70, three()),      // no page, owned by platforms: 0.85
    row(4, 60, three()),      // no page: 1.6
    row(5, 40, three()),      // retrieved, not cited: 4.2
    row(6, 35, three()),      // not retrieved: 2.7
    row(7, 20, three()),      // not retrieved: 2.4 (third slot needs no score)
    row(8, 25, three()),      // no page: 1.25, past three and under 30: watch? no, drop
    row(9, 10, []),           // not probed: never recommended
  ]
  const d = new Map([diag(1, 'won'), diag(2, 'cited_not_first'), diag(3, 'no_page', true), diag(4, 'no_page'), diag(5, 'retrieved_not_cited'), diag(6, 'not_retrieved'), diag(7, 'not_retrieved'), diag(8, 'no_page'), diag(9, 'unknown')].map(x => [x.query_id, x]))
  assignStatus(rows, d)
  assert.deepEqual(rows.map(r => r.status), ['watch', 'watch', 'recommend', 'recommend', 'recommend', 'recommend', 'recommend', 'drop', 'drop'])
  // Five recommended, chosen by priority: 5 (4.2), 6 (2.7), 7 (2.4), 4 (1.6), 3 (0.85); row 8 is under 30 past the first three.
  const fewer = rows.map(r => ({ ...r, probes: [...r.probes] }))
  const d2 = new Map(d)
  d2.set(qid(4), diag(4, 'won'))
  d2.set(qid(3), diag(3, 'cited_not_first'))
  assignStatus(fewer, d2)
  assert.deepEqual(fewer.map(r => r.status), ['watch', 'watch', 'watch', 'watch', 'recommend', 'recommend', 'recommend', 'drop', 'drop'])
})

// ---------- 62: the kits ----------

const CFG: SubjectsConfig = { held: ['legibility', 'full-time'], ownerRepos: { ctrl: 'krishanraja/mindmake', heartside: 'krishanraja/heartside', circle: null } }

function kitInput(over: Partial<KitInput> = {}): KitInput {
  const venture = { ...subject('ctrl'), domains: OURS }
  const queries = [
    { ...row(1, 60, [probe('perplexity', false), probe('chatgpt', false)]), query: 'What is a personal AI writing style?' },
    { ...row(2, 40, [probe('perplexity', true)]), query: 'How do I brief an AI assistant on my voice for LinkedIn posts and also every other channel a busy founder writes for each week?' },
    { ...row(3, 90, [probe('perplexity', false)]), query: 'Which platform owns this?' },
    { ...row(4, 99, [probe('perplexity', true)]), query: 'A question we already won?' },
    { ...row(5, 50, []), query: 'A question nobody answered?' },
  ]
  const ev = (n: number, citations: string[], fan_out: string[] = [], engine: ProbeEvidence['engine'] = 'perplexity'): [string, ProbeEvidence[]] => [qid(n), [{ engine, citations, retrieved: [], fan_out }]]
  const evidence = new Map([
    ev(1, ['https://www.example-writer-tools.com/blog/train', 'https://www.reddit.com/r/x/1', 'https://www.g2.com/products/x'], ['personal AI writing style definition', 'site:reddit.com "AI writing style"', 'What is a personal AI writing style?', 'personal ai writing style definition', 'ask someone@example.com']),
    ev(2, ['https://forum.example-dev.org/t/1', 'https://ours.example/old']),
    ev(3, ['https://www.youtube.com/watch?v=1', 'https://www.linkedin.com/pulse/x']),
  ])
  const details = new Map([[qid(1), [detail(1, 'perplexity', { retrieved_ours: true }), detail(1, 'chatgpt')]], [qid(2), [detail(2, 'perplexity', { cited_any: true, our_position: 2 })]], [qid(3), [detail(3, 'perplexity')]], [qid(4), [detail(4, 'perplexity', { first_host_ours: true, cited_any: true })]]])
  const audit: SiteAudit = {
    hosts: [{ host: 'ours.example', gates: [{ gate: 'search_bots_allowed', pass: true, detail: '' }, { gate: 'sitemap_present', pass: false, detail: 'none' }] }],
    pages: [page('https://ours.example/answers/style', 'What is a personal AI writing style?', { has_answer_first: false, date_published: null, canonical_self: false })],
    requests: 4, errors: 0,
  }
  const entries = firstCitedEntries(evidence, OURS)
  const matches = new Map<string, PageMatch>([[qid(1), { query_id: qid(1), alignment: 1, our_best_url: 'https://ours.example/answers/style', page: audit.pages[0] }]])
  const diagnoses = diagnoseAll(queries, details, matches, entries)
  return { subject: venture, queries, diagnoses, evidence, details, cited: entries, audit, domains: OURS, engines: ['perplexity', 'chatgpt', 'claude'], config: CFG, ...over }
}

function assertCleanKit(k: Kit): void {
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') { assert.ok(!EM_DASH_RE.test(v), `${path} has an em dash`); assert.ok(!/@[A-Za-z0-9_]{2,}/.test(v), `${path} has a handle or address`) }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [key, x] of Object.entries(v)) walk(x, `${path}.${key}`)
  }
  walk(k, k.kit_id)
  assert.ok(k.title.length <= TITLE_MAX)
  assert.ok(k.h2s.length <= 6 && k.h2s.every(h => h.length <= 120))
  assert.ok(k.beat.length <= 3 && k.off_site.length <= 5 && k.evidence.length <= 6)
}

test('kits: the shape, highest priority first, none for won or unknown, and every string clean', () => {
  const kits = buildKits(kitInput())
  assert.deepEqual(kits.map(k => [k.query_id, k.gap_class, k.priority]), [
    [qid(2), 'cited_not_first', 5.6],
    [qid(1), 'retrieved_not_cited', 4.8],
    [qid(3), 'no_page', 0.95],
  ])
  const k = kits.find(x => x.query_id === qid(1))!
  assert.equal(k.kit_id, `kit:ctrl:${qid(1).slice(0, 8)}`)
  assert.equal(k.v, 1)
  assert.equal(k.product_slug, 'ctrl')
  assert.deepEqual(k.target, { kind: 'update_page', url: 'https://ours.example/answers/style', host: 'ours.example', suggested_path: null })
  assert.equal(k.capsule.rules.length, 5)
  assert.equal(k.capsule.must_cover, null)
  assert.deepEqual(k.h2s, ['Personal AI writing style definition', 'AI writing style'], 'deduped; the question itself, the site: operator and the address out (what is left of that line is too short to keep)')
  assert.deepEqual(k.beat.map(b => [b.host, b.engine, b.position]), [['example-writer-tools.com', 'perplexity', 1]])
  assert.deepEqual(k.off_site.map(o => [o.host, o.source_type]), [['reddit.com', 'forum'], ['g2.com', 'review']], 'a vendor page is not a place to be')
  assert.deepEqual(k.site_fixes.map(f => [f.gate, f.url]), [['page_canonical_self', 'https://ours.example/answers/style'], ['page_answer_first', 'https://ours.example/answers/style'], ['page_dated', 'https://ours.example/answers/style'], ['sitemap_present', null]])
  assert.ok(k.site_fixes.every(f => f.owner_repo === 'krishanraja/mindmake'))
  assert.deepEqual(k.verify, { engines: ['perplexity'], samples: 3, success: 'cited first on 2 of 3 samples on at least one engine', recheck: 'next research run', baseline: 'retrieved_not_cited' })
  assert.ok(k.evidence.some(e => e.startsWith('class: retrieved_not_cited')))
  assert.ok(!k.evidence.some(e => /writer-tools\.com\/blog/.test(e)), 'evidence names hosts, never a page or an answer')
  for (const x of kits) assertCleanKit(x)
  const long = kits.find(x => x.query_id === qid(2))!
  assert.ok(long.title.length <= TITLE_MAX && !/\s$/.test(long.title))
})

test('kits: the target kinds', () => {
  const kits = buildKits(kitInput())
  assert.equal(kits.find(k => k.query_id === qid(1))?.target.kind, 'update_page')
  const newPage = kits.find(k => k.query_id === qid(2))!
  assert.deepEqual(newPage.target, { kind: 'new_page', url: null, host: 'ours.example', suggested_path: suggestedPath(newPage.question) })
  assert.match(newPage.target.suggested_path ?? '', /^\/answers\/brief-ai-assistant-voice-linkedin/)
  const off = kits.find(k => k.query_id === qid(3))!
  assert.deepEqual(off.target, { kind: 'off_site_only', url: null, host: 'youtube.com', suggested_path: null })
  // No host of our own: nothing to write a page on, so off site only.
  const homeless = buildKits(kitInput({ domains: [], audit: { hosts: [], pages: [], requests: 0, errors: 0 } }))
  assert.ok(homeless.filter(k => k.query_id !== qid(1)).every(k => k.target.kind === 'off_site_only'))
})

test('kits: none for a held product (the file, or Control Center\'s engine_held, which wins), a prospect or an aspiration', () => {
  const base = kitInput()
  assert.ok(buildKits(base).length > 0)
  assert.deepEqual(buildKits({ ...base, subject: { ...base.subject, product_slug: 'legibility' } }), [])
  assert.deepEqual(buildKits({ ...base, subject: { ...base.subject, product_slug: 'full-time' } }), [])
  assert.deepEqual(buildKits({ ...base, subject: { ...base.subject, engine_held: true } }), [], 'Control Center holds it')
  assert.ok(buildKits({ ...base, subject: { ...base.subject, product_slug: 'legibility', engine_held: false } }).length > 0, 'Control Center released it')
  assert.deepEqual(buildKits({ ...base, subject: { ...base.subject, kind: 'prospect', product_slug: null } }), [])
  assert.deepEqual(buildKits({ ...base, subject: { ...base.subject, kind: 'aspiration', product_slug: null } }), [])
})

test('kits: rendered as plain text for Krish, every section labelled, within 8000 characters and with no em dash', () => {
  const k = buildKits(kitInput()).find(x => x.query_id === qid(1))!
  const text = renderKit(k)
  for (const label of ['Win kit kit:ctrl:', 'Question: What is a personal AI writing style?', 'Why it is not won: retrieved, not cited', 'Target: Update the page https://ours.example/answers/style', 'Answer capsule', 'Sections (H2s)', 'Pages to beat', 'Site fixes:', 'Ships in krishanraja/mindmake', 'Off site', 'Verify:', 'Evidence:', 'AEO ships nothing']) assert.ok(text.includes(label), label)
  assert.ok(text.length <= 8000)
  assert.ok(!EM_DASH_RE.test(text))
  const huge = renderKit({ ...k, h2s: Array.from({ length: 6 }, () => 'x'.repeat(120)), evidence: Array.from({ length: 6 }, () => 'y'.repeat(200)), site_fixes: Array.from({ length: 12 }, () => ({ gate: 'g', host: 'h', url: 'https://ours.example/' + 'p'.repeat(400), fix: 'z'.repeat(300), owner_repo: null })) })
  assert.ok(huge.length <= 8000)
  const c = kitCandidate(k)
  assert.deepEqual({ ...c, exact_payload: c.exact_payload.length > 0 }, { product_slug: 'ctrl', query_id: qid(1), priority: 4.8, title: k.title, exact_payload: true, gap_class: 'retrieved_not_cited', target_kind: 'update_page', reference: 'https://ours.example/answers/style' })
  assert.equal(cutAtWord('one two three four', 9), 'one two')
  assert.deepEqual(h2sFrom('Q?', []), [])
})

// ---------- 15: the site audit ----------

test('site audit: the hosts are ours, never a platform, at most three; gates pass or fail with a detail', async () => {
  assert.deepEqual(auditHosts(['mindmake.co', 'www.mindmake.co', 'linkedin.com/in/krishraja', 'krishraja.com', 'a.example', 'b.example']), ['mindmake.co', 'krishraja.com', 'a.example'])
  const { result: audit } = await captureStderr(() => siteAudit({ slug: 'ctrl', kind: 'venture' }, new OfflineSite(FIXTURES, { strict: true }), ['ctrl.mindmake.co', 'mindmake.co']))
  const gates = Object.fromEntries(audit.hosts.map(h => [h.host, Object.fromEntries(h.gates.map(g => [g.gate, g.pass]))]))
  assert.deepEqual(gates['ctrl.mindmake.co'], { search_bots_allowed: true, user_bots_allowed: true, homepage_200: true, homepage_server_rendered: true, homepage_single_h1: true, sitemap_present: true })
  assert.equal(gates['mindmake.co'].sitemap_present, false)
  const urls = audit.pages.map(p => p.url)
  assert.ok(urls.includes('https://ctrl.mindmake.co/answers/personal-ai-writing-style'))
  assert.ok(urls.indexOf('https://ctrl.mindmake.co/answers/personal-ai-writing-style') < urls.indexOf('https://ctrl.mindmake.co/pricing'), 'answer-like paths first')
  assert.ok(!urls.some(u => u.includes('/account/')), 'a path robots.txt closes is not read')
  assert.ok(!urls.some(u => u.endsWith('.js')))
  const answer = audit.pages.find(p => p.url.endsWith('/personal-ai-writing-style'))!
  assert.deepEqual({ ...answer, title: null, words: answer.words > 150 }, { url: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style', status: 200, title: null, h1: 'What is a personal AI writing style?', h1_count: 1, h2_count: 2, words: true, has_answer_first: true, noindex: false, canonical_self: true, date_published: '2026-08-14', date_modified: '2026-09-01', client_rendered: false })
  const blog = audit.pages.find(p => p.url.includes('/blog/'))!
  assert.equal(blog.has_answer_first, false)
  assert.equal(blog.canonical_self, false)
  assert.ok(audit.requests > 0 && audit.pages.length <= CAPS.SITE_MAX_PAGES_PER_SUBJECT)
})

test('site audit: a missing robots.txt allows every bot; an unreadable one fails both bot gates; the page budget holds', async () => {
  const table: Record<string, SitePage> = {
    'https://a.example/robots.txt': { status: 404, headers: {}, text: '', url: 'https://a.example/robots.txt' },
    'https://a.example/': { status: 200, headers: {}, text: `<h1>A</h1><p>${'w '.repeat(200)}</p>`, url: 'https://a.example/' },
    'https://a.example/sitemap.xml': { status: 200, headers: {}, text: `<urlset>${Array.from({ length: 40 }, (_, i) => `<url><loc>https://a.example/blog/p${i}</loc></url>`).join('')}</urlset>`, url: 'https://a.example/sitemap.xml' },
  }
  const asked: string[] = []
  const f: SiteFetcher = {
    async get(url) { asked.push(url); return table[url] ?? (url.startsWith('https://a.example/blog/') ? { status: 200, headers: {}, text: '<h1>p</h1>', url } : null) },
    stats: () => ({ requests: asked.length, refused: 0, errors: 0, hosts: 1 }),
  }
  const { result } = await captureStderr(() => siteAudit({ slug: 's', kind: 'venture' }, f, ['a.example', 'b.example'], 10))
  const a = result.hosts.find(h => h.host === 'a.example')!
  const b = result.hosts.find(h => h.host === 'b.example')!
  assert.equal(a.gates.find(g => g.gate === 'search_bots_allowed')?.pass, true)
  assert.match(a.gates.find(g => g.gate === 'search_bots_allowed')?.detail ?? '', /no robots\.txt \(status 404\)/)
  assert.equal(b.gates.find(g => g.gate === 'user_bots_allowed')?.pass, false)
  // An unreadable robots.txt closes the host: nothing past it is read, and the gates it could not measure are left out, not failed.
  assert.deepEqual(b.gates.map(g => g.gate), ['search_bots_allowed', 'user_bots_allowed'])
  assert.ok(!asked.some(u => u.startsWith('https://b.example/') && !u.endsWith('/robots.txt')))
  assert.equal(result.pages.length, 10, 'the subject reads its page budget')
  assert.ok(asked.filter(u => u.startsWith('https://a.example/blog/')).length <= CAPS.SITE_MAX_PAGES_PER_HOST, 'the host its page budget')
})

// ---------- 45: the pages cited first ----------

test('first cited: at most fifteen pages a subject and three a host, never a video or a forum thread, never a link of theirs', async () => {
  const entries = new Map<string, CitedEntry[]>()
  for (let i = 0; i < 25; i++) {
    const host = `h${i % 6}.example`
    const url = `https://${host}/page-${i}`
    entries.set(qid(i), [{ engine: 'perplexity', position: 1, url, host, source_type: 'unknown', features: { url, host, source_type: 'unknown', read: false, title_matches_question: null, answer_first_words: null, words: null, h2_count: null, dated: null, server_rendered: null } }])
  }
  entries.set(qid(90), [{ engine: 'chatgpt', position: 1, url: 'https://www.youtube.com/watch?v=1', host: 'youtube.com', source_type: 'video', features: { url: 'https://www.youtube.com/watch?v=1', host: 'youtube.com', source_type: 'video', read: false, title_matches_question: null, answer_first_words: null, words: null, h2_count: null, dated: null, server_rendered: null } }])
  const asked: string[] = []
  const f: SiteFetcher = {
    async get(url) { asked.push(url); return { status: 200, headers: {}, text: `<title>Question ${url} best</title><h1>T</h1><p>${'w '.repeat(40)}</p><a href="https://next.example/">next</a><h2>a</h2>`, url } },
    stats: () => ({ requests: asked.length, refused: 0, errors: 0, hosts: 1 }),
  }
  const queries = [...entries.keys()].map(k => ({ query_id: k, query: 'Question best' }))
  const { result } = await captureStderr(() => readFirstCited(queries, entries, f))
  assert.equal(asked.length, 15)
  const perHost = new Map<string, number>()
  for (const u of asked) perHost.set(new URL(u).host, (perHost.get(new URL(u).host) ?? 0) + 1)
  assert.ok([...perHost.values()].every(n => n <= 3))
  assert.ok(!asked.some(u => u.includes('youtube') || u.includes('next.example')))
  assert.equal(result.skipped_type, 1)
  const read = [...result.byQuery.values()].flat().filter(e => e.features.read)
  assert.equal(read.length, 15)
  assert.deepEqual({ ...read[0].features, url: '', host: '' }, { url: '', host: '', source_type: 'listicle', read: true, title_matches_question: true, answer_first_words: 40, words: read[0].features.words, h2_count: 1, dated: false, server_rendered: false })
})

// ---------- 60: the digest carries the gap class ----------

test('digest: the evidence the model reads carries each question\'s gap class, and every recommendation carries its diagnosis line', async () => {
  const ctx = fixtureContext()
  const s = subject('ctrl')
  const p = (engine: Engine): Probe => ({ engine, model: 'm', question: 'q', answer_snapshot: 'a'.repeat(250), we_cited: false, citations: ['https://rival.example/a'], cost_usd: 0.01 })
  const q = [{ ...row(1, 60, [p('perplexity'), p('chatgpt')], ['rival.example']), query: 'How do I write in my own voice with AI?', status: 'recommend' as const }]
  const d = new Map([[qid(1), { ...diag(1, 'retrieved_not_cited'), our_best_url: 'https://ctrl.mindmake.co/answers/voice', first_cited: { host: 'rival.example', url: 'https://rival.example/a', source_type: 'listicle' as const, features: { url: 'https://rival.example/a', host: 'rival.example', source_type: 'listicle' as const, read: true, title_matches_question: true, answer_first_words: 42, words: 1800, h2_count: 7, dated: true, server_rendered: true } } }]])
  const input: DigestInput = { subject: s, ctx, weekStart: '2026-09-07', engines: ['perplexity', 'chatgpt', 'claude'], queries: q, themes: { themes_status: 'no_calls', themes: [], calls: { considered: 0, attributed: 0 } }, gap: gapFor(s, s.domains), krishHitsDomains: s.domains, diagnoses: d }
  const model = new StubModel(JSON.stringify({ recommendations: [{ query_id: qid(1), title: 'T', angle: 'A', evidence: ['one', 'two', 'three', 'four', 'five', 'six'], why_you_can_win: 'W' }] }))
  const { result } = await captureStderr(() => writeDigest(model, new Ledger(10), input))
  const user = model.requests[0].user
  assert.ok(user.includes('"gap_class": "retrieved_not_cited"'))
  assert.ok(user.includes('"our_best_url": "https://ctrl.mindmake.co/answers/voice"'))
  assert.ok(user.includes('"source_type": "listicle"') && user.includes('"answer_first_words": 42'))
  const ev = result.recommendations[0].evidence
  assert.equal(ev.length, 6)
  assert.match(ev[5], /^gap: retrieved_not_cited \(retrieved, not cited\); our page: https:\/\/ctrl\.mindmake\.co\/answers\/voice; first cited: rival\.example, listicle, 1800 words, answer first in 42 words, 7 H2s, dated$/)
  // The deterministic fallback says the same, and opens its angle with the fix.
  const { result: fb } = await captureStderr(() => writeDigest(new StubModel('THROW'), new Ledger(10), input))
  assert.match(fb.recommendations[0].angle, /^An engine's search returns our page and the answer cites others/)
  assert.ok(fb.recommendations[0].evidence.some(e => e.startsWith('gap: retrieved_not_cited')))
  // With no diagnosis (an aspiration) the evidence carries no class.
  const { result: plain } = await captureStderr(() => writeDigest(new StubModel('THROW'), new Ledger(10), { ...input, diagnoses: undefined }))
  assert.ok(!plain.recommendations[0].evidence.some(e => e.startsWith('gap:')))
})

// ---------- the stage guard and the config ----------

test('withFallback: a failed stage logs a count and its error class, never its message, and returns the fallback', async () => {
  const { result, text } = await captureStderr(() => withFallback('site_audit', () => { throw new TypeError('Invalid URL: https://secret.example/path') }, 'fallback', { subject: 'ctrl' }))
  assert.equal(result, 'fallback')
  assert.match(text, /"event":"stage_failed","stage":"site_audit","failed":1,"error_kind":"TypeError","subject":"ctrl"/)
  assert.ok(!text.includes('secret.example'))
  assert.equal(await withFallback('x', async () => 7, 0), 7)
  assert.deepEqual(await withFallback('x', () => { throw new Error('e') }, () => [1]), [1])
})

test('config/subjects.json: valid, product slugs only, Legibility and Full Time held, and the owner repositories', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'config/subjects.json'), 'utf8'))
  const parsed = parseSubjectsConfig(raw)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  const cfg = subjectsConfig()
  assert.deepEqual(cfg.held, ['legibility', 'full-time'])
  assert.equal(ownerRepoOf('ctrl', cfg), 'krishanraja/mindmake')
  assert.equal(ownerRepoOf('publication', cfg), 'krishanraja/makeyourmindup')
  assert.equal(ownerRepoOf('circle', cfg), null)
  assert.equal(ownerRepoOf('pulse', cfg), null)
  assert.equal(isHeld({ product_slug: 'legibility' }, cfg), true)
  assert.equal(isHeld({ product_slug: 'legibility', engine_held: false }, cfg), false)
  assert.equal(isHeld({ product_slug: 'heartside', engine_held: true }, cfg), true)
  assert.equal(isHeld({ product_slug: null }, cfg), false)
  const bad = parseSubjectsConfig({ _about: 'x', held: ['secret-prospect-co', 'legibility', 'legibility'], owner_repos: { 'secret-prospect-co': 'a/b', ctrl: 'not a repo' }, extra: 1 })
  assert.equal(bad.ok, false)
  const errs = bad.ok ? [] : bad.errors
  for (const want of [/subjects\.extra: unknown field/, /held\[0\]: must be a venture's product slug/, /held\[2\]: repeated/, /owner_repos: a key must be a venture's product slug/, /owner_repos\.ctrl: owner\/name or null/]) assert.ok(errs.some(e => want.test(e)), String(want))
})

test('probe detail: retrieved_ours reads the engine\'s retrieved list, path-aware, and is false when the engine says nothing', () => {
  const ours = ['mindmake.co', 'linkedin.com/in/krishraja']
  assert.equal(probeDetail('q', 'chatgpt', { text: '', citations: ['https://x.example'], retrieved: ['https://y.example', 'https://www.mindmake.co/answers/a'] }, ours).retrieved_ours, true)
  assert.equal(probeDetail('q', 'chatgpt', { text: '', citations: [], retrieved: ['https://linkedin.com/pulse/someone'] }, ours).retrieved_ours, false)
  assert.equal(probeDetail('q', 'chatgpt', { text: '', citations: [] }, ours).retrieved_ours, false)
})

// ---------- the review's cases ----------

/** A fetcher from a table of URL to page; anything else is a 404. Records every URL asked. */
function pageTable(table: Record<string, Partial<SitePage>>): SiteFetcher & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async get(url) { asked.push(url); const t = table[url]; return t ? { status: 200, headers: {}, text: '', url, ...t } : { status: 404, headers: {}, text: '', url } },
    stats: () => ({ requests: asked.length, refused: 0, errors: 0, hosts: 1 }),
  }
}

test('site audit: a path domain never puts someone else\'s platform in the audit; one on our own domain still counts', () => {
  assert.deepEqual(auditHosts(['github.com/krishanraja', 'substack.com/@krish', 'linkedin.com/in/krishraja', 'podcasts.apple.com/us/podcast/x/id1', 'mindmake.co']), ['mindmake.co'])
  assert.deepEqual(auditHosts(['ctrl.mindmake.co/answers', 'mindmake.co']), ['mindmake.co', 'ctrl.mindmake.co'])
  assert.deepEqual(auditHosts(['github.com/krishanraja']), [])
})

test('site audit: robots.txt is asked before the home page and the sitemaps; a closed or unreadable one leaves the host unread past it', async () => {
  const closed = pageTable({ 'https://shut.example/robots.txt': { text: 'User-agent: *\nDisallow: /\nSitemap: https://shut.example/sitemap.xml' } })
  const a = await captureStderr(() => auditHost('shut.example', closed))
  assert.deepEqual(closed.asked, ['https://shut.example/robots.txt'], 'not the home page, not a sitemap')
  assert.deepEqual(a.result.gates.map(g => [g.gate, g.pass]), [['search_bots_allowed', false], ['user_bots_allowed', false]], 'the gates it could not measure are left out')
  const down = pageTable({ 'https://down.example/robots.txt': { status: 503 } })
  const b = await captureStderr(() => auditHost('down.example', down))
  assert.deepEqual(down.asked, ['https://down.example/robots.txt'], 'a 5xx robots.txt closes the host (RFC 9309)')
  assert.match(b.result.gates[0].detail, /could not be read \(status 503\)/)
  // A robots.txt that closes only the sitemap: the home page is read, the sitemap is not, and its gate is left out.
  const part = pageTable({ 'https://part.example/robots.txt': { text: 'User-agent: *\nDisallow: /sitemap' }, 'https://part.example/': { text: `<h1>Home</h1><p>${'w '.repeat(200)}</p>` } })
  const c = await captureStderr(() => auditHost('part.example', part))
  assert.deepEqual(part.asked, ['https://part.example/robots.txt', 'https://part.example/'])
  assert.ok(!c.result.gates.some(g => g.gate === 'sitemap_present'))
  assert.equal(c.result.gates.find(g => g.gate === 'homepage_200')?.pass, true)
})

test('site audit: a host is read once a process however many subjects share it, and never from a subject job given the run\'s shared audit', async () => {
  const f = pageTable({ 'https://shared.example/robots.txt': { status: 404 }, 'https://shared.example/': { text: '<h1>Home</h1>' } })
  const first = await captureStderr(() => siteAudit({ slug: 'one', kind: 'venture' }, f, ['shared.example']))
  const asked = f.asked.length
  const second = await captureStderr(() => siteAudit({ slug: 'two', kind: 'prospect' }, f, ['shared.example', 'linkedin.com/in/x']))
  assert.equal(f.asked.length, asked, 'the second subject made no request')
  assert.equal(second.result.requests, 0)
  assert.deepEqual(second.result.hosts, first.result.hosts)
  const never: SiteFetcher = { async get() { throw new Error('a subject job read a page of ours') }, stats: () => ({ requests: 0, refused: 0, errors: 0, hosts: 0 }) }
  const shared = new Map([['shared.example', { host: 'shared.example', gates: first.result.hosts[0].gates, pages: first.result.pages, requests: 3, errors: 0 }]])
  const fromFile = await captureStderr(() => siteAudit({ slug: 'three', kind: 'venture' }, never, ['shared.example', 'other.example'], 25, shared))
  assert.deepEqual(fromFile.result.pages, first.result.pages)
  assert.deepEqual(fromFile.result.hosts.map(h => h.host), ['shared.example'], 'a host the shared audit lacks is not read here')
  assert.equal(fromFile.result.requests, 0)
})

test('matchPages: a word every question shares, or one distinctive word, never makes an unrelated page ours', () => {
  const pages = [page('https://ours.example/news', 'AI product news'), page('https://ours.example/style', 'Personal AI writing style'), page('https://ours.example/write', 'How to write with AI'), page('https://ours.example/voice', 'Set up your voice profile')]
  const qs = [
    { query_id: qid(1), query: 'How do I price an AI product?' },
    { query_id: qid(2), query: 'What should a personal AI skill contain?' },
    { query_id: qid(3), query: 'How do I write a LinkedIn post with AI?' },
    { query_id: qid(4), query: 'How do I set up a voice profile?' },
  ]
  const m = matchPages(qs, pages)
  assert.equal(m.get(qid(1))?.our_best_url, null, 'product alone')
  assert.equal(m.get(qid(2))?.our_best_url, null, 'personal alone')
  assert.equal(m.get(qid(3))?.our_best_url, null, 'write alone')
  assert.equal(m.get(qid(4))?.our_best_url, 'https://ours.example/voice')
  // A subject word in most of the questions is not distinctive: it matches nothing on its own.
  const many = ['How do I keep my voice consistent across email?', 'Can my voice survive an AI rewrite?', 'Which voice settings matter for posts?', 'Does a voice profile need examples?', 'How do I test my voice for drift?'].map((query, i) => ({ query_id: qid(10 + i), query }))
  assert.ok(genericWordsFor(many.map(q => q.query)).has('voice'))
  const mm = matchPages(many, [page('https://ours.example/news', 'Voice news'), page('https://ours.example/profile', 'Voice profile examples')])
  assert.equal(mm.get(qid(10))?.our_best_url, null, 'voice alone')
  assert.equal(mm.get(qid(13))?.our_best_url, 'https://ours.example/profile', 'profile and example')
})

test('diagnose: two engines citing one platform first are two votes; a grounding redirect hides a source and never promotes the next', () => {
  const evidence = new Map<string, ProbeEvidence[]>([[qid(1), [
    { engine: 'perplexity', citations: ['https://www.linkedin.com/pulse/a'], retrieved: [], fan_out: [] },
    { engine: 'chatgpt', citations: ['https://www.linkedin.com/pulse/b'], retrieved: [], fan_out: [] },
    { engine: 'claude', citations: ['https://vendor.example.com/guide'], retrieved: [], fan_out: [] },
  ]]])
  const d = diagnose(qid(1), [detail(1, 'perplexity'), detail(1, 'chatgpt'), detail(1, 'claude')], undefined, firstCitedEntries(evidence, OURS).get(qid(1)))
  assert.equal(d.owned_by_platform, true)
  assert.equal(firstNotOurs({ engine: 'perplexity', citations: ['https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', 'https://vendor.example.com/x'], retrieved: [], fan_out: [] }, OURS), null)
  assert.deepEqual(thirdPartyPerHost(1), CAPS.THIRD_PARTY_MAX_PAGES_PER_HOST)
  assert.ok(thirdPartyPerHost(30) * 30 <= CAPS.SITE_MAX_REQUESTS_PER_HOST)
})

test('kits: a page of ours the engines already cited or retrieved is the one to update when the matcher found none; a new page only for no page', () => {
  const ev = (citations: string[], retrieved: string[] = []): ProbeEvidence[] => [{ engine: 'perplexity', citations, retrieved, fan_out: [] }]
  const base = kitInput()
  const venture = { ...base.subject, domains: ['ours.example'] }
  const queries = [
    { ...row(21, 60, [probe('perplexity', true)]), query: 'How do I set up a voice profile?' },
    { ...row(22, 60, [probe('perplexity', false)]), query: 'Which tone works for a cover letter?' },
    { ...row(23, 60, [probe('perplexity', false)]), query: 'Where do I keep my style rules?' },
  ]
  const evidence = new Map([
    [qid(21), ev(['https://vendor.example.com/guide', 'https://ours.example/blog/some-post'])],
    [qid(22), ev(['https://vendor.example.com/tone'], ['https://ours.example/answers/tone'])],
    [qid(23), ev(['https://vendor.example.com/rules'])],
  ])
  const details = new Map([
    [qid(21), [detail(21, 'perplexity', { cited_any: true, our_position: 2, retrieved_ours: true })]],
    [qid(22), [detail(22, 'perplexity', { retrieved_ours: true })]],
    [qid(23), [detail(23, 'perplexity')]],
  ])
  const cited = firstCitedEntries(evidence, ['ours.example'])
  const diagnoses = diagnoseAll(queries, details, new Map(), cited, evidence, ['ours.example'])
  const kits = buildKits({ ...base, subject: venture, queries, evidence, details, cited, diagnoses, domains: ['ours.example'] })
  const by = (n: number) => kits.find(k => k.query_id === qid(n))!
  assert.deepEqual([by(21).gap_class, by(21).target], ['cited_not_first', { kind: 'update_page', url: 'https://ours.example/blog/some-post', host: 'ours.example', suggested_path: null }])
  assert.deepEqual([by(22).gap_class, by(22).target], ['retrieved_not_cited', { kind: 'update_page', url: 'https://ours.example/answers/tone', host: 'ours.example', suggested_path: null }])
  assert.equal(by(23).gap_class, 'no_page')
  assert.equal(by(23).target.kind, 'new_page')
  assert.match(renderKit(by(21)), /Target: Update the page https:\/\/ours\.example\/blog\/some-post on ours\.example\./)
  assert.ok(by(21).evidence.some(e => /an engine already cites one on ours\.example/.test(e)))
})

test('kits: with no site of our own the target says so, starts off site where we are absent (never a vendor), and closes on the kit, never a third party\'s host', () => {
  const kits = buildKits(kitInput({ domains: [], audit: { hosts: [], pages: [], requests: 0, errors: 0 } }))
  const k = kits.find(x => x.query_id === qid(2))!
  assert.equal(k.owned_by_platform, false)
  assert.deepEqual(k.target, { kind: 'off_site_only', url: null, host: 'forum.example-dev.org', suggested_path: null })
  const text = renderKit(k)
  assert.match(text, /Target: This venture has no site of its own to put a page on\. Be present where it is answered, starting with forum\.example-dev\.org\./)
  assert.ok(!/general platforms own/.test(text.split('\n').find(l => l.startsWith('Target:')) ?? ''))
  assert.equal(kitCandidate(k).reference, k.kit_id)
  const owned = buildKits(kitInput()).find(x => x.query_id === qid(3))!
  assert.match(renderKit(owned), /Target: No page of ours can win this alone: general platforms own the first citation\./)
})

test('kits: none for a question the packet walls off as not worth chasing', () => {
  const all = buildKits(kitInput())
  const walled = buildKits(kitInput({ walled: new Set([qid(2)]) }))
  assert.ok(all.some(k => k.query_id === qid(2)))
  assert.ok(!walled.some(k => k.query_id === qid(2)))
  assert.equal(walled.length, all.length - 1)
})

test('kits: a suggested path is whole words; a short page served whole is not called client-rendered', () => {
  assert.equal(suggestedPath('How much of my own writing does an AI assistant need before it learns my personal writing style properly?'), '/answers/much-own-writing-ai-assistant-need-before-learns-personal')
  assert.ok(suggestedPath('x '.repeat(100) + 'y').length <= '/answers/'.length + 60)
  assert.equal(suggestedPath('Antidisestablishmentarianismantidisestablishmentarianismantidisestablishmentarianism?'), `/answers/${'antidisestablishmentarianismantidisestablishmentarianismantidisestablishmentarianism'.slice(0, 60)}`)
  const short = pageFixes(page('https://ours.example/a', 'A', { words: 60 }))
  assert.ok(!short.some(f => f.gate === 'page_server_rendered'))
  const shell = pageFixes(page('https://ours.example/a', 'A', { words: 12, client_rendered: true }))
  assert.ok(shell.some(f => f.gate === 'page_server_rendered' && /shell a script fills in/.test(f.fix)))
})
