/**
 * The cited-pages sheet and its fetch-only mention check
 * (src/pipeline/48-cited-pages.ts). Ruling (Krish, 2026-11-13): AEO keeps a
 * sheet per venture of the pages AI assistants cite for its questions and
 * checks whether each page already mentions the venture; outreach comes
 * later, with his yes. Synthetic pages and a fake fetch only; no network.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { CachedSite, LiveSite, type Clock, type SiteFetcher, type SitePage } from '../src/clients/site.js'
import { CAPS } from '../src/config/run.js'
import { brandNamesFor, parseSubjectsConfig, subjectsConfig } from '../src/config/subjects.js'
import { normaliseUrl, pageKey } from '../src/lib/urls.js'
import { annotateOffSite, buildSheet, checkMentions, mentionOf, mustNotOn, sheetCounts, transitions, type Sheet } from '../src/pipeline/48-cited-pages.js'
import { hostShare, mentionFetchesPerHost, thirdPartyPerHost } from '../src/pipeline/45-pages.js'
import { renderKit } from '../src/pipeline/62-kits.js'
import { attachFeatures } from '../src/pipeline/68-features.js'
import { buildResearchReport, type ResearchInput } from '../src/protocol/reports.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import type { PriorProbe } from '../src/schema/context.js'
import type { Kit } from '../src/schema/kit.js'
import { citedPageErrors, validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { validateReport } from '../src/schema/report.js'
import { featuredRun } from './golden.js'
import { ROOT, readJson } from './helpers.js'
import { schemaErrors } from './schema-check.js'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/packet.schema.json'), 'utf8')) as Record<string, unknown>
const TODAY = '2026-11-22'
const DOMAINS = ['heartside.io', 'linkedin.com/in/someone-synthetic']

const ev = (engine: 'perplexity' | 'chatgpt' | 'claude', citations: string[]) => ({ engine, citations, retrieved: [], fan_out: [] })
const qid = (n: number) => `${String(n).padStart(8, 'c')}-0000-4000-8000-000000000000`

function fakeClock(): Clock { let t = 1_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms } } }

/** A fetch that answers from a table and records every call. No network. */
function fakeFetch(table: Record<string, { status?: number; type?: string; body?: string }>) {
  const seen: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const row = table[url]
    if (!row) return new Response('nothing', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(row.body ?? '', { status: row.status ?? 200, headers: { 'content-type': row.type ?? 'text/html; charset=utf-8' } })
  }) as typeof fetch
  return { fn, seen }
}

const page = (body: string) => `<html><head><title>T</title></head><body>${body}</body></html>`

// ---------- the URL rule ----------

test('URLs: the fragment and utm parameters out, the host lower-cased without www, the path kept', () => {
  assert.equal(normaliseUrl('https://WWW.Example.com/Guide/Voice?utm_source=x&id=7&UTM_medium=y#top'), 'https://example.com/Guide/Voice?id=7')
  assert.equal(normaliseUrl('https://example.com/a/?utm_campaign=z'), 'https://example.com/a/')
  assert.equal(normaliseUrl('https://example.com/a?q=a%20b'), 'https://example.com/a?q=a%20b', 'a query with no utm keeps its own encoding')
  assert.equal(normaliseUrl('mailto:someone'), null)
  assert.equal(normaliseUrl('not a url'), null)
  assert.equal(pageKey('http://www.example.com/a/'), pageKey('https://example.com/a'))
})

// ---------- the sheet ----------

test('the sheet: this run and the four weeks of probes, ranked by times first, times cited, questions, then URL; ours and platforms flagged', () => {
  const evidence = new Map([
    [qid(1), [ev('perplexity', ['https://www.lists.example/best-dog-gifts?utm_source=ai', 'https://heartside.io/answers/x']), ev('chatgpt', ['https://lists.example/best-dog-gifts#top', 'https://www.reddit.com/r/dogs/x'])]],
    [qid(2), [ev('claude', ['https://heartside.io/', 'https://lists.example/best-dog-gifts']), ev('chatgpt', ['https://www.reddit.com/r/dogs/x', 'https://medium.com/@someone/x', 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc'])]],
  ])
  const probes4w: PriorProbe[] = [
    { id: 'p1', question: 'What gift says my dog loves me?', engine: 'perplexity', we_cited: false, competitors_cited: ['https://review.example/dog-gifts', 'https://lists.example/best-dog-gifts'], run_at: '2026-11-08T09:00:00Z', run_id: null, query_id: qid(1) },
    // It cited us, so its first listed page is not the answer's first.
    { id: 'p2', question: 'A personalised dog mug?', engine: 'claude', we_cited: true, competitors_cited: ['https://review.example/dog-gifts'], run_at: '2026-11-08T09:00:00Z', run_id: null, query_id: qid(3) },
  ]
  const sheet = buildSheet({ questions: [{ query_id: qid(1), query: 'What gift says my dog loves me?' }, { query_id: qid(2), query: 'Which dog gift is best?' }], evidence, probes4w, domains: DOMAINS, engines: ['perplexity', 'chatgpt', 'claude'] })
  const urls = sheet.rows.map(r => r.url)
  // lists: first twice, cited four times; reddit and review: first once, cited twice on two questions each (then by URL); ours after.
  assert.deepEqual(urls, ['https://lists.example/best-dog-gifts', 'https://reddit.com/r/dogs/x', 'https://review.example/dog-gifts', 'https://heartside.io/', 'https://heartside.io/answers/x'])
  const lists = sheet.rows[0]
  assert.deepEqual({ ...lists }, { url: 'https://lists.example/best-dog-gifts', host: 'lists.example', page_type: 'listicle', questions: 2, engines: ['perplexity', 'chatgpt', 'claude'], times_cited: 4, times_first: 2, mention: 'unchecked', mention_ok: null, checked_at: null, platform: false, own: false })
  assert.equal(sheet.rows.find(r => r.url === 'https://review.example/dog-gifts')?.times_first, 1, 'first only on the probe that did not cite us')
  assert.equal(sheet.rows.find(r => r.url === 'https://heartside.io/')?.own, true)
  assert.equal(sheet.rows.find(r => r.url === 'https://reddit.com/r/dogs/x')?.platform, true)
  assert.ok(!urls.some(u => u.includes('@') || u.includes('grounding')), 'a handle in a URL, or a grounding redirect, is never a row')
  assert.equal(sheet.fetchUrl.get('https://lists.example/best-dog-gifts'), 'https://www.lists.example/best-dog-gifts?utm_source=ai', 'fetched as an engine cited it')
  // The cap.
  const many = new Map([[qid(9), [ev('perplexity', Array.from({ length: 80 }, (_, i) => `https://many.example/p${String(i).padStart(2, '0')}`))]]])
  const capped = buildSheet({ questions: [{ query_id: qid(9), query: 'Many pages?' }], evidence: many, domains: DOMAINS, engines: ['perplexity'] })
  assert.equal(CAPS.CITED_PAGES_PER_SUBJECT, 50)
  assert.equal(capped.rows.length, 50)
  assert.equal(capped.rows[0].url, 'https://many.example/p00', 'the first cited ranks first')
  assert.deepEqual(capped.rows.slice(1, 3).map(r => r.url), ['https://many.example/p01', 'https://many.example/p02'], 'then by URL')
})

// ---------- the mention check ----------

test('mention: a link to one of our domains (path-aware), else the name as a whole word in any case, else none', () => {
  const at = 'https://lists.example/best'
  assert.equal(mentionOf(page('<p>Try <a href="https://www.heartside.io/mug">this</a>.</p>'), at, DOMAINS, ['Heartside']), 'link')
  assert.equal(mentionOf(page('<a href="https://linkedin.com/in/someone-synthetic/details">profile</a>'), at, DOMAINS, []), 'link', 'under the domain\'s path')
  assert.equal(mentionOf(page('<a href="https://linkedin.com/in/someone-else">profile</a>'), at, DOMAINS, []), 'none', 'not under the path')
  assert.equal(mentionOf(page('<a href="/heartside.io">relative</a>'), at, DOMAINS, []), 'none', 'a relative link stays on the page\'s own site')
  assert.equal(mentionOf(page('<p>We loved HEARTSIDE for this.</p>'), at, DOMAINS, ['Heartside']), 'name')
  assert.equal(mentionOf(page('<p>Heartsides and hearts.</p>'), at, DOMAINS, ['Heartside']), 'none', 'no substring match')
  assert.equal(mentionOf(page('<script>var x = "Heartside"</script><p>Nothing here.</p>'), at, DOMAINS, ['Heartside']), 'none', 'only visible words')
  assert.equal(mentionOf(page('<p>Heartside</p>'), at, DOMAINS, []), 'none', 'with no distinctive name, links and domains only')
  // A domain written as text with no link is a mention by name, path-aware too.
  assert.equal(mentionOf(page('<p>Order one at heartside.io today.</p>'), at, DOMAINS, []), 'name')
  assert.equal(mentionOf(page('<p>See www.heartside.io/mug.</p>'), at, DOMAINS, []), 'name')
  assert.equal(mentionOf(page('<p>Not notheartside.io, nor heartside.com.</p>'), at, DOMAINS, []), 'none')
  assert.equal(mentionOf(page('<p>linkedin.com/in/someone-synthetic says hello.</p>'), at, DOMAINS, []), 'name')
  assert.equal(mentionOf(page('<p>linkedin.com/in/someone-else says hello.</p>'), at, DOMAINS, []), 'none')
  // Names compare letters and digits, whole word on both sides.
  assert.equal(mentionOf(page('<p>We read Make Your Mind Up every week.</p>'), at, DOMAINS, ['makeyourmindup']), 'name')
  assert.equal(mentionOf(page('<p>We read makeyourmindup every week.</p>'), at, DOMAINS, ['Make Your Mind Up']), 'name')
  assert.equal(mentionOf(page('<p>Heart-Side gifts.</p>'), at, DOMAINS, ['Heartside']), 'name')
  assert.equal(mentionOf(page('<p>remakeyourmindup and makeyourmindups.</p>'), at, DOMAINS, ['makeyourmindup']), 'none', 'whole word on both sides')
  assert.equal(mentionOf(page('<p>Heartsides and hearts.</p>'), at, DOMAINS, ['Heartside']), 'none', 'still no substring match')
  assert.equal(mustNotOn(page('<p>Full Time betting tips here.</p>'), ['betting tips']), true)
  assert.equal(mustNotOn(page('<p>Full Time, the football show.</p>'), ['betting tips']), false)
  assert.equal(mustNotOn(page('<a href="https://example.com/betting-tips">x</a>'), ['betting tips']), false, 'a URL is not a phrase')
})

function sheetOf(urls: string[]): Sheet {
  const evidence = new Map([[qid(1), urls.map(u => ev('perplexity', [u]))]])
  return buildSheet({ questions: [{ query_id: qid(1), query: 'What gift says my dog loves me?' }], evidence, domains: DOMAINS, engines: ['perplexity'] })
}

test('mention check: robots.txt first, GET only, at most three pages a host and twenty a subject, flags only and never the page', async () => {
  const urls = [
    ...Array.from({ length: 5 }, (_, i) => `https://a.example/p${i}`),
    ...Array.from({ length: 30 }, (_, i) => `https://h${String(i).padStart(2, '0')}.example/page`),
    'https://closed.example/private/page',
    'https://www.reddit.com/r/dogs/x',
    'https://heartside.io/answers/x',
    'http://127.0.0.1/admin',
  ]
  const table: Record<string, { status?: number; type?: string; body?: string }> = {
    'https://a.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow:' },
    'https://closed.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private' },
    'https://closed.example/private/page': { body: page('<a href="https://heartside.io">x</a>') },
  }
  for (let i = 0; i < 5; i++) table[`https://a.example/p${i}`] = { body: page(i === 0 ? '<a href="https://heartside.io/">Heartside</a>' : i === 1 ? '<p>Heartside is lovely. Not betting tips.</p>' : '<p>Nothing.</p>') }
  for (let i = 0; i < 30; i++) table[`https://h${String(i).padStart(2, '0')}.example/page`] = { body: page('<p>Nothing.</p>') }
  const { fn, seen } = fakeFetch(table)
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  const sheet = sheetOf(urls)
  // Every row here is cited once and first once, so they rank by URL.
  const out = await checkMentions(sheet, site, { domains: DOMAINS, names: ['Heartside'], mustNot: ['betting tips'], today: TODAY })
  assert.equal(out.attempted, CAPS.MENTION_CHECKS_PER_SUBJECT, 'twenty a subject')
  assert.equal(seen.filter(u => u.startsWith('https://a.example/p')).length, CAPS.MENTION_CHECKS_PER_HOST, 'three a host')
  assert.ok(!seen.includes('https://closed.example/private/page'), 'robots.txt closed it, so it is never fetched')
  assert.ok(!seen.some(u => u.includes('reddit.com') || u.includes('heartside.io') || u.includes('127.0.0.1')), 'never a platform, never our own page')
  const byUrl = new Map(sheet.rows.map(r => [r.url, r]))
  assert.deepEqual([byUrl.get('https://a.example/p0')?.mention, byUrl.get('https://a.example/p0')?.mention_ok, byUrl.get('https://a.example/p0')?.checked_at], ['link', true, TODAY])
  assert.deepEqual([byUrl.get('https://a.example/p1')?.mention, byUrl.get('https://a.example/p1')?.mention_ok], ['name', false], 'a must_not phrase on the page: refresh needed')
  assert.deepEqual([byUrl.get('https://a.example/p2')?.mention, byUrl.get('https://a.example/p2')?.mention_ok], ['none', null], 'betting tips on a page that does not mention us: null, not false')
  assert.deepEqual([byUrl.get('https://a.example/p3')?.mention, byUrl.get('https://a.example/p3')?.checked_at], ['unchecked', null], 'past the host cap')
  assert.equal(byUrl.get('https://closed.example/private/page')?.mention, 'unchecked')
  assert.equal(byUrl.get('https://www.reddit.com/r/dogs/x'.replace('www.', ''))?.mention, 'unchecked')
  // The row carries flags only: no page text anywhere in it.
  assert.ok(!JSON.stringify(sheet.rows).includes('lovely'))
  const counts = sheetCounts(sheet.rows, out, null)
  assert.equal(counts.link + counts.name, 2)
  assert.equal(counts.mention_ok_false, 1)
  assert.equal(counts.own, 1)
  assert.equal(counts.platform, 1)
})

test('mention check: a page the pages-cited-first read already fetched is reused, never fetched twice', async () => {
  const table = { 'https://lists.example/best': { body: page('<a href="https://heartside.io">x</a>') }, 'https://lists.example/robots.txt': { type: 'text/plain', body: '' } }
  const { fn, seen } = fakeFetch(table)
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  // The first read, through the same reader, as stage 45 makes it.
  await site.get('https://lists.example/best')
  assert.equal(seen.length, 1)
  const sheet = sheetOf(['https://lists.example/best?utm_source=chatgpt.com'])
  const out = await checkMentions(sheet, site, { domains: DOMAINS, names: [], mustNot: [], today: TODAY })
  assert.equal(out.reused, 1)
  assert.equal(out.fetched, 0)
  assert.equal(seen.length, 1, 'no second fetch, and no robots.txt read for a page already held')
  assert.equal(sheet.rows[0].mention, 'link')
})

test('mention check: the reader\'s rules hold through the fake fetch: no private host, no non-text body, no script run, an unreadable robots.txt closes the host', async () => {
  const table = {
    'https://pdf.example/robots.txt': { type: 'text/plain', body: '' },
    'https://pdf.example/guide': { type: 'application/pdf', body: '%PDF Heartside' },
    'https://down.example/robots.txt': { status: 503, type: 'text/plain', body: '' },
    'https://down.example/page': { body: page('<a href="https://heartside.io">x</a>') },
    'https://js.example/robots.txt': { type: 'text/plain', body: '' },
    'https://js.example/page': { body: page('<div id="root"></div><script>document.write(\'<a href="https://heartside.io">x</a>\')</script>') },
  }
  const { fn, seen } = fakeFetch(table)
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  const sheet = sheetOf(['https://pdf.example/guide', 'https://down.example/page', 'https://js.example/page', 'https://localhost/x', 'https://10.0.0.1/x'])
  const out = await checkMentions(sheet, site, { domains: DOMAINS, names: ['Heartside'], mustNot: [], today: TODAY })
  const byUrl = new Map(sheet.rows.map(r => [r.url, r]))
  assert.equal(byUrl.get('https://pdf.example/guide')?.mention, 'unchecked', 'a non-text body is refused unread')
  assert.ok(!seen.includes('https://down.example/page'), 'robots.txt could not be read, so the host is closed')
  assert.equal(byUrl.get('https://js.example/page')?.mention, 'none', 'no script is run, so a link a script writes is not there')
  assert.ok(!seen.some(u => u.includes('localhost') || u.includes('10.0.0.1')), 'never a private host')
  assert.equal(out.checked, 1)
})

test('mention check: fresh fetches on one host stay inside the subject\'s share of the run\'s per-host budget; pages already read are still checked', async () => {
  const urls = Array.from({ length: 4 }, (_, i) => `https://a.example/p${i}`)
  const table: Record<string, { status?: number; type?: string; body?: string }> = { 'https://a.example/robots.txt': { type: 'text/plain', body: '' } }
  for (const u of urls) table[u] = { body: page('<p>Heartside, the dog gift.</p>') }
  const { fn, seen } = fakeFetch(table)
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  await site.get('https://a.example/p0')
  const sheet = sheetOf(urls)
  const out = await checkMentions(sheet, site, { domains: DOMAINS, names: ['Heartside'], mustNot: [], today: TODAY, fetchPerHost: 1 })
  assert.deepEqual([out.reused, out.fetched, out.skipped_host_budget], [1, 1, 2], 'the page already read, and one fresh fetch')
  assert.equal(seen.filter(u => u.startsWith('https://a.example/p')).length, 2)
  const zero = await checkMentions(sheetOf(urls), new CachedSite(new LiveSite({ fetchImpl: fakeFetch(table).fn, clock: fakeClock() })), { domains: DOMAINS, names: ['Heartside'], mustNot: [], today: TODAY, fetchPerHost: 0 })
  assert.deepEqual([zero.fetched, zero.checked], [0, 0], 'no share left: nothing fresh is read')
  // The share: robots.txt, the pages cited first and the mention check's fresh fetches, times the subjects, never past the budget.
  for (let n = 1; n <= 20; n++) {
    const each = 1 + thirdPartyPerHost(n) + mentionFetchesPerHost(n)
    assert.ok(each <= hostShare(n) && each * n <= CAPS.SITE_MAX_REQUESTS_PER_HOST, `subjects ${n}`)
  }
  assert.deepEqual([thirdPartyPerHost(1), mentionFetchesPerHost(1)], [CAPS.THIRD_PARTY_MAX_PAGES_PER_HOST, CAPS.MENTION_CHECKS_PER_HOST])
})

test('mention check: a same-domain redirect is asked of robots.txt again; one it closes is not followed', async () => {
  const table: Record<string, { status?: number; type?: string; body?: string; location?: string }> = {
    'https://r.example/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /members/' },
    'https://r.example/open': { status: 301, location: '/members/page' },
    'https://r.example/members/page': { body: page('<a href="https://heartside.io">x</a>') },
  }
  const seen: string[] = []
  const fn = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const row = table[url]
    if (!row) return new Response('nothing', { status: 404, headers: { 'content-type': 'text/plain' } })
    return new Response(row.body ?? '', { status: row.status ?? 200, headers: { 'content-type': row.type ?? 'text/html', ...(row.location ? { location: row.location } : {}) } })
  }) as typeof fetch
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  const sheet = sheetOf(['https://r.example/open'])
  const out = await checkMentions(sheet, site, { domains: DOMAINS, names: [], mustNot: [], today: TODAY })
  assert.ok(!seen.includes('https://r.example/members/page'), 'the hop robots.txt closes is never requested')
  assert.deepEqual([out.fetched, out.unread, sheet.rows[0].mention], [1, 1, 'unchecked'])
})

test('transitions: acquired and lost only against the sheet Control Center served; with none, never guessed', () => {
  const sheet = sheetOf(['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4'])
  const set = (url: string, mention: 'link' | 'name' | 'none' | 'unchecked') => { const r = sheet.rows.find(x => x.url === url)!; r.mention = mention }
  set('https://a.example/1', 'link'); set('https://b.example/2', 'none'); set('https://c.example/3', 'name'); set('https://d.example/4', 'unchecked')
  assert.equal(transitions(sheet.rows, undefined), null)
  const moved = transitions(sheet.rows, [
    { url: 'https://www.a.example/1#x', mention: 'none' },
    { url: 'https://b.example/2', mention: 'name' },
    { url: 'https://c.example/3', mention: 'name' },
    { url: 'https://d.example/4', mention: 'link' },
    { url: 'https://e.example/5', mention: 'none' },
    { url: 7, mention: 'none' },
  ])
  assert.deepEqual(moved, { acquired: [{ host: 'a.example', page_type: 'unknown' }], lost: [{ host: 'b.example', page_type: 'unknown' }] })
  const counts = sheetCounts(sheet.rows, null, moved)
  assert.deepEqual([counts.acquired, counts.lost], [{ unknown: 1 }, { unknown: 1 }])
})

test('kits: an off-site place says whether its pages for that question already mention us, and the kit says skip or refresh', () => {
  const sheet = sheetOf(['https://lists.example/a', 'https://forum.example/t/1'])
  const lists = sheet.rows.find(r => r.host === 'lists.example')!
  const forum = sheet.rows.find(r => r.host === 'forum.example')!
  lists.mention = 'link'; lists.mention_ok = true; lists.checked_at = TODAY
  forum.mention = 'name'; forum.mention_ok = false; forum.checked_at = TODAY
  const kit = { query_id: qid(1), question: 'What gift says my dog loves me?', off_site: [{ host: 'lists.example', source_type: 'listicle', engines: ['perplexity'] }, { host: 'forum.example', source_type: 'forum', engines: ['perplexity'] }, { host: 'other.example', source_type: 'unknown', engines: ['chatgpt'] }] } as unknown as Kit
  const [k] = annotateOffSite([kit], sheet, new Map([[qid(1), 'gift says dog loves']]))
  assert.deepEqual(k.off_site.map(o => [o.mention, o.mention_ok]), [['link', true], ['name', false], [undefined, undefined]])
  // Another question's kit takes nothing from these rows.
  const [other] = annotateOffSite([{ ...kit, query_id: qid(2), question: 'Something else entirely?' }], sheet, new Map())
  assert.ok(other.off_site.every(o => !('mention' in o)))
  const text = renderKit({ ...(readJson('expected/packet.ctrl.features.json') as AeoPacket).kits![0], off_site: k.off_site } as Kit)
  assert.match(text, /lists\.example \(listicle\), cited by perplexity; already mentions us \(a link\): skip/)
  assert.match(text, /forum\.example \(forum\), cited by perplexity; a page there carries a phrase a brand check forbids: refresh needed/)
})

// ---------- the packet ----------

test('packet: cited_pages and a kit\'s off-site mention go only when Control Center lists cited_pages, and a row that breaks a rule is left out alone', async () => {
  const on = await featuredRun('ctrl', ['cited_pages', 'kits'])
  const p = on.results[0].packet
  assert.ok(p.cited_pages && p.cited_pages.length > 0 && p.cited_pages.length <= 50)
  assert.ok(p.kits?.some(k => k.off_site.some(o => 'mention' in o)))
  assert.deepEqual(schemaErrors(SCHEMA, p), [])
  assert.equal(validatePacket(p, { features: ['cited_pages', 'kits'] }).ok, true)
  const kitsOnly = (await featuredRun('ctrl', ['kits'])).results[0].packet
  assert.ok(!('cited_pages' in kitsOnly))
  assert.ok(kitsOnly.kits?.every(k => k.off_site.every(o => !('mention' in o))), 'no mention field without the feature')
  assert.equal(validatePacket(p, { features: ['kits'] }).ok, false, 'refused when not listed')
  // A row that would break a packet rule is dropped on its own.
  const row = { ...p.cited_pages![0], url: 'https://x.example/ask-someone@example.com' }
  assert.ok(citedPageErrors(row).length > 0)
  const base = readJson('expected/packet.ctrl.json') as AeoPacket
  const out = attachFeatures(base, { features: ['cited_pages'], details: new Map(), evidence: new Map(), citedPages: [p.cited_pages![0], row] })
  assert.equal(out.rowsDropped, 1)
  assert.equal(validatePacket(out.packet, { features: ['cited_pages'] }).ok, true)
  // In the sealed summary: counts only.
  const more = on.results[0].more
  assert.ok(more?.cited_pages && more.cited_pages.rows === p.cited_pages.length)
  assert.ok(!JSON.stringify(more.cited_pages).includes('http'), 'the summary\'s sheet is counts, never a URL')
})

// ---------- the report ----------

const sub = (slug: string, over: Partial<SubjectSummary> = {}): SubjectSummary => ({ slug, kind: 'venture', product_slug: slug, ok: true, questions: 25, probed_questions: 25, cited_first: 0, probes: 75, probes_failed: 0, probes_skipped_cap: 0, gap_classes: { won: 0, cited_not_first: 1, retrieved_not_cited: 2, not_retrieved: 3, no_page: 19, unknown: 0 }, kits: 0, ...over })
const runSummary = (subjects: SubjectSummary[]): RunSummary => ({ v: 1, subject_arg: 'all', week_start: '2026-11-16', generated_at: '2026-11-22T10:00:00Z', engines: ['perplexity', 'chatgpt', 'claude'], cap_usd: 5, spent_usd: 2, max_probe_usd: 0.07, error_code: null, subjects })
const research = (subjects: SubjectSummary[], over: Partial<ResearchInput> = {}): ResearchInput => ({ runId: 'aeo:2026-11-22:research', mode: 'synthetic', observedAt: new Date('2026-11-22T10:30:00Z'), revision: 'abc', capturedAt: new Date('2026-11-22T04:00:00Z'), scope: 'all', expected: subjects.map(s => s.slug), summaries: [runSummary(subjects)], totalCapUsd: 25, planError: null, decisions: [], runPage: 'https://github.com/synthetic/aeo/actions/runs/1', ...over })

test('report: one count line a venture, never a URL; acquired and lost mentions as events and one count line', () => {
  const counts = { rows: 50, own: 2, platform: 6, targets: 42, checked: 20, reused: 7, link: 2, name: 1, none: 17, mention_ok_false: 1, to_check: 39, acquired: { listicle: 1 }, lost: { forum: 1 }, since: '2026-11-02' }
  const r = buildResearchReport(research([sub('heartside', { cited_pages: counts }), sub('legibility', { held: true, cited_pages: { ...counts, acquired: undefined, lost: undefined } })]))
  assert.deepEqual(validateReport(r), { ok: true })
  const lines = r.activity.map(a => a.line)
  assert.ok(lines.some(l => l.includes('Cited pages: 50 tracked, 3 mention heartside, 39 to check, 1 carrying a phrase a brand check forbids.')))
  assert.ok(lines.some(l => l.startsWith('Why legibility\'s questions are not won:') && l.includes('Cited pages: 50 tracked, 3 mention legibility')), 'a held venture is measured too')
  assert.deepEqual(r.events.map(e => [e.event, e.proposal_id, e.evidence_url]), [['mention_acquired', null, 'https://github.com/synthetic/aeo/actions/runs/1'], ['mention_lost', null, 'https://github.com/synthetic/aeo/actions/runs/1']])
  assert.ok(lines.includes('Cited-page mentions since the sheet Control Center served from the research week of 2026-11-02: 1 mention acquired, 1 lost. heartside: 1 acquired, 1 lost.'), 'named by the served sheet\'s week, never this run\'s id')
  assert.ok(!lines.some(l => l.startsWith('Cited-page mentions') && l.includes('aeo:2026-11-22:research')))
  const unnamed = buildResearchReport(research([sub('heartside', { cited_pages: { ...counts, since: undefined } })])).activity.map(a => a.line)
  assert.ok(unnamed.includes('Cited-page mentions since the sheet Control Center served: 1 mention acquired, 1 lost. heartside: 1 acquired, 1 lost.'))
  // The week is carried only beside a transition.
  assert.equal(sheetCounts([], null, null, '2026-11-02').since, undefined)
  assert.equal(sheetCounts([], null, { acquired: [], lost: [] }, '2026-11-02').since, '2026-11-02')
  assert.equal(sheetCounts([], null, { acquired: [], lost: [] }, 'last week').since, undefined)
  assert.ok(!lines.some(l => /https?:\/\//.test(l)), 'no URL in a line')
  // A held venture gets a sheet and no proposal.
  assert.deepEqual(r.proposals, [])
})

test('a held venture: its sheet is built and checked, and it gets no kit and no proposal', async () => {
  const run = await featuredRun('ctrl', ['cited_pages', 'kits'], ctx => {
    const ctrl = ctx.subjects.find(s => s.slug === 'ctrl')!
    ctrl.engine_held = true
    ctrl.brand_checks = [{ question: 'What is the ctrl tool from Mindmake?', must_not: ['personal'], must: [] }]
  })
  const result = run.results[0]
  assert.ok((result.packet.cited_pages ?? []).length > 0, 'measured: the sheet is there')
  assert.ok(!result.packet.kits?.length, 'held: no kit')
  assert.equal(result.diagnosis?.held, true)
  const s: SubjectSummary = { ...sub('ctrl'), held: true, cited_pages: result.more?.cited_pages, brand_checks: result.more?.brand }
  assert.ok(s.brand_checks && s.brand_checks.checks === 1)
  const r = buildResearchReport(research([s]))
  assert.deepEqual(r.proposals, [], 'no kit, no brand check suggestion, for a held venture')
})

test('distinctive names: Control Center\'s brand_names when served, else config/subjects.json\'s interim overlay; none for a common word', () => {
  const cfg = subjectsConfig()
  assert.deepEqual(brandNamesFor({ product_slug: 'mindmake' }, cfg), ['Mindmake'])
  assert.deepEqual(brandNamesFor({ product_slug: 'heartside' }, cfg), ['Heartside'])
  assert.deepEqual(brandNamesFor({ product_slug: 'publication' }, cfg), ['makeyourmindup'])
  for (const slug of ['ctrl', 'circle', 'pulse', 'full-time', 'legibility']) assert.deepEqual(brandNamesFor({ product_slug: slug }, cfg), [], slug)
  assert.deepEqual(brandNamesFor({ product_slug: 'heartside', brand_names: ['Heartside Gifts'] }, cfg), ['Heartside Gifts'], 'served wins')
  assert.deepEqual(brandNamesFor({ product_slug: 'heartside', brand_names: [] }, cfg), [], 'served empty wins too')
  const bad = parseSubjectsConfig({ _about: 'x', held: [], owner_repos: {}, brand_names: { 'secret-prospect-co': ['X1'], heartside: 'Heartside', mindmake: ['M'] } })
  assert.equal(bad.ok, false)
  const errs = bad.ok ? [] : bad.errors
  for (const want of [/brand_names: a key must be a venture's product slug/, /brand_names\.heartside: a list of names/, /brand_names\.mindmake: a list of names/]) assert.ok(errs.some(e => want.test(e)), String(want))
})
