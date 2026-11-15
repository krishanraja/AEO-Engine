/**
 * Page reads ask for HTML only (BUILD-LOG, 2026-11-15). The reader's wide
 * Accept header listed Markdown and plain text, and sites that negotiate on
 * it answered with those forms, which the HTML extractor misread (no H1, no
 * H2s, other words). A page read now asks for HTML only and refuses any other
 * answer unread; robots.txt and sitemaps keep the wide header. A fake server
 * that negotiates as those sites did; no network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CachedSite, LiveSite, PAGE_ACCEPT, type Clock } from '../src/clients/site.js'
import { extractPage } from '../src/lib/html.js'
import { auditHost } from '../src/pipeline/15-site.js'
import { readFirstCited, type CitedEntry } from '../src/pipeline/45-pages.js'
import { buildSheet, checkMentions } from '../src/pipeline/48-cited-pages.js'
import { captureStderr } from './standin.js'

function fakeClock(): Clock { let t = 1_000_000; return { now: () => t, sleep: async (ms: number) => { t += ms } } }

interface Row { html?: string; md?: string; plain?: string }

/**
 * A server that negotiates: Markdown when the Accept header lists it (or when
 * Markdown is all it has), else HTML; plain text always as plain text.
 */
function negotiatingFetch(table: Record<string, Row>) {
  const seen: Array<{ url: string; accept: string }> = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const accept = String((init?.headers as Record<string, string> | undefined)?.accept ?? '')
    seen.push({ url, accept })
    const row = table[url]
    const answer = (body: string, type: string, status = 200) => new Response(body, { status, headers: { 'content-type': `${type}; charset=utf-8` } })
    if (!row) return answer('not here', 'text/plain', 404)
    if (row.plain !== undefined) return answer(row.plain, 'text/plain')
    if (row.md !== undefined && (accept.includes('text/markdown') || row.html === undefined)) return answer(row.md, 'text/markdown')
    return answer(row.html ?? '', 'text/html')
  }) as typeof fetch
  return { fn, seen }
}

const WORDS = 'word '.repeat(200)
const GUIDE_HTML = `<html><head><title>Best dog gifts</title></head><body><h1>Best dog gifts</h1><p>The best dog gifts, ranked. ${WORDS}</p><h2>Mugs</h2><h2>Collars</h2><p>We like <a href="https://heartside.io/">Heartside</a>.</p></body></html>`
const GUIDE_MD = `# Best dog gifts\n\nThe best dog gifts, ranked. ${WORDS}\n\n## Mugs\n\n## Collars\n\nWe like [Heartside](https://heartside.io/).`

const TABLE: Record<string, Row> = {
  'https://neg.example/robots.txt': { plain: 'User-agent: *\nDisallow:' },
  'https://neg.example/guide': { html: GUIDE_HTML, md: GUIDE_MD },
  'https://mdonly.example/robots.txt': { plain: 'User-agent: *\nDisallow:' },
  'https://mdonly.example/guide': { md: GUIDE_MD },
}

test('page accept: the wide header gets the Markdown form, which the HTML extractor misreads (the defect this guards)', async () => {
  const { fn } = negotiatingFetch(TABLE)
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  const wide = await site.get('https://neg.example/guide')
  assert.equal(wide?.headers['content-type'], 'text/markdown; charset=utf-8')
  const misread = extractPage(wide!.text)
  assert.deepEqual([misread.h1.length, misread.h2.length], [0, 0], 'read as HTML, the Markdown form has no headings')
})

test('page accept: a page read asks for HTML only and takes only HTML; robots.txt keeps the wide header; an error page still says its status', async () => {
  const { fn, seen } = negotiatingFetch({ ...TABLE, 'https://neg.example/gone': {} })
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  assert.ok(!/markdown|text\/plain|json|\*\//.test(PAGE_ACCEPT))
  const page = await site.get('https://neg.example/guide', { html: true })
  assert.equal(seen.at(-1)?.accept, PAGE_ACCEPT)
  assert.equal(page?.headers['content-type'], 'text/html; charset=utf-8')
  assert.deepEqual([extractPage(page!.text).h1.length, extractPage(page!.text).h2.length], [1, 2])
  const refusedBefore = site.stats().refused
  assert.equal(await site.get('https://mdonly.example/guide', { html: true }), null, 'a page that answers only in Markdown is unread, never misread')
  assert.equal(site.stats().refused, refusedBefore + 1)
  const robots = await site.get('https://neg.example/robots.txt')
  assert.equal(robots?.text, 'User-agent: *\nDisallow:')
  assert.match(seen.at(-1)!.accept, /text\/plain/, 'robots.txt is asked with the wide header')
  const gone = await site.get('https://neg.example/missing', { html: true })
  assert.deepEqual([gone?.status, gone?.text], [404, ''], 'a 404 answered as plain text still says 404, with no body read')
})

test('page accept: the pages-cited-first read and the mention check read the HTML form, and a Markdown-only page stays unread and unchecked', async () => {
  const { fn, seen } = negotiatingFetch(TABLE)
  const site = new CachedSite(new LiveSite({ fetchImpl: fn, clock: fakeClock() }))
  const qid = '00000001-0000-4000-8000-000000000001'
  const entry = (url: string): CitedEntry => {
    const host = new URL(url).hostname
    return { engine: 'perplexity', position: 1, url, host, source_type: 'unknown', features: { url, host, source_type: 'unknown', read: false, title_matches_question: null, answer_first_words: null, words: null, h2_count: null, dated: null, server_rendered: null } }
  }
  const qid2 = '00000002-0000-4000-8000-000000000002'
  const entries = new Map([[qid, [entry('https://neg.example/guide')]], [qid2, [entry('https://mdonly.example/guide')]]])
  const queries = [{ query_id: qid, query: 'What are the best dog gifts?' }, { query_id: qid2, query: 'What are the best dog gifts?' }]
  const { result: first } = await captureStderr(() => readFirstCited(queries, entries, site))
  const pageAsks = seen.filter(s => !s.url.endsWith('/robots.txt'))
  assert.ok(pageAsks.length === 2 && pageAsks.every(s => s.accept === PAGE_ACCEPT), 'every page is asked for HTML only')
  assert.ok(seen.filter(s => s.url.endsWith('/robots.txt')).every(s => /text\/plain/.test(s.accept)), 'robots.txt keeps the wide header')
  assert.equal(first.failed, 1, 'the Markdown-only page is counted as not read')
  const neg = first.byQuery.get(qid)![0].features
  assert.deepEqual([neg.read, neg.h2_count, neg.server_rendered, neg.title_matches_question], [true, 2, true, true])
  assert.equal(first.byQuery.get(qid2)![0].features.read, false)

  const sheet = buildSheet({ questions: [{ query_id: qid, query: 'What are the best dog gifts?' }], evidence: new Map([[qid, [{ engine: 'perplexity', citations: ['https://neg.example/guide', 'https://mdonly.example/guide'], retrieved: [], fan_out: [] }]]]), domains: ['heartside.io'], engines: ['perplexity'] })
  const asksBefore = seen.length
  const { result: out } = await captureStderr(() => checkMentions(sheet, site, { domains: ['heartside.io'], names: ['Heartside'], mustNot: [], today: '2026-11-22' }))
  assert.equal(seen.length, asksBefore, 'both pages were already read this run, so neither is fetched again')
  assert.deepEqual([out.reused, out.checked, out.unread], [2, 1, 1])
  const byUrl = new Map(sheet.rows.map(r => [r.url, r.mention]))
  assert.equal(byUrl.get('https://neg.example/guide'), 'link')
  assert.equal(byUrl.get('https://mdonly.example/guide'), 'unchecked', 'unknown, never a guess from the Markdown form')
})

test('page accept: the site audit reads our home page as HTML, so its H1 and words gates measure the page, not its Markdown form', async () => {
  const { fn, seen } = negotiatingFetch({
    'https://ours.example/robots.txt': { plain: 'User-agent: *\nDisallow:' },
    'https://ours.example/': { html: GUIDE_HTML, md: GUIDE_MD },
  })
  const { result } = await captureStderr(() => auditHost('ours.example', new LiveSite({ fetchImpl: fn, clock: fakeClock() })))
  const gate = (g: string) => result.gates.find(x => x.gate === g)?.pass
  assert.deepEqual([gate('homepage_200'), gate('homepage_single_h1'), gate('homepage_server_rendered')], [true, true, true])
  assert.equal(seen.find(s => s.url === 'https://ours.example/')?.accept, PAGE_ACCEPT)
  assert.match(seen.find(s => s.url === 'https://ours.example/robots.txt')!.accept, /text\/plain/)
})
