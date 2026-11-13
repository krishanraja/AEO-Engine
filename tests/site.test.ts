import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { requestText } from '../src/clients/http.js'
import { LiveSite, OfflineSite, publicWebUrl, registrableDomain, SITE_FETCH, SITE_USER_AGENT, siteFixtureName, type Clock } from '../src/clients/site.js'
import { MissingFixture } from '../src/clients/types.js'
import { CAPS } from '../src/config/run.js'
import { FIXTURES } from './helpers.js'

/** A clock a test drives: sleep moves time on and records how long it was asked to wait. */
function fakeClock(start = 1_000_000): Clock & { slept: number[]; t: number } {
  const c = { t: start, slept: [] as number[], now: () => c.t, sleep: async (ms: number) => { c.slept.push(ms); c.t += ms } }
  return c
}

interface Seen { url: string; init: RequestInit; at: number }

/** A fetch that answers from a table, by URL, and records every call. No network. */
function fakeFetch(table: Record<string, { status?: number; headers?: Record<string, string>; body?: string }>, clock?: { now(): number }) {
  const seen: Seen[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, init: init ?? {}, at: clock?.now() ?? 0 })
    const row = table[url]
    if (!row) return new Response('not here', { status: 404, headers: { 'content-type': 'text/html' } })
    return new Response(row.body ?? '', { status: row.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...(row.headers ?? {}) } })
  }) as typeof fetch
  return { fn, seen }
}

test('requestText: redirect manual, a 3xx comes back with its Location, the body is capped, a non-text body is never read', async () => {
  const { fn, seen } = fakeFetch({
    'https://a.example/old': { status: 301, headers: { location: '/new' } },
    'https://a.example/big': { body: 'x'.repeat(5000) },
    'https://a.example/logo': { headers: { 'content-type': 'image/png' }, body: 'PNGDATA' },
  })
  const r = await requestText('https://a.example/old', { fetchImpl: fn })
  assert.equal(r.status, 301)
  assert.equal(r.headers.get('location'), '/new')
  assert.equal(seen[0].init.redirect, 'manual')
  assert.equal(seen[0].init.method, 'GET')
  const big = await requestText('https://a.example/big', { fetchImpl: fn, maxBytes: 1000 })
  assert.equal(big.text.length, 1000)
  assert.equal(big.truncated, true)
  const img = await requestText('https://a.example/logo', { fetchImpl: fn })
  assert.equal(img.text, '')
})

test('requestText: a deadline aborts and throws with no URL in the message', async () => {
  const slow = (async (_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch
  await assert.rejects(requestText('https://slow.example/secret-path', { fetchImpl: slow, timeoutMs: 5 }), (e: Error) => /timeout/.test(e.message) && !e.message.includes('secret-path'))
})

test('site: an honest User-Agent, GET only, and never a crawler\'s or a browser\'s name', async () => {
  const { fn, seen } = fakeFetch({ 'https://ours.example/': { body: '<h1>Hi</h1>' } })
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  const r = await site.get('https://ours.example/')
  assert.equal(r?.status, 200)
  const headers = seen[0].init.headers as Record<string, string>
  assert.equal(headers['user-agent'], SITE_USER_AGENT)
  assert.match(SITE_USER_AGENT, /^AEO-Engine\/1\.0 \(\+https:\/\/github\.com\/krishanraja\/AEO-Engine; fetch-only audit\)$/)
  assert.ok(!/bot|mozilla|chrome|safari|gecko/i.test(SITE_USER_AGENT))
  assert.equal(seen[0].init.method, 'GET')
  assert.equal(seen[0].init.redirect, 'manual')
  assert.equal(SITE_FETCH.redirect, 'manual')
})

test('site: the per-host budget is enforced and counted, and other hosts keep theirs', async () => {
  const table: Record<string, { body: string }> = {}
  for (let i = 0; i < 50; i++) table[`https://ours.example/p${i}`] = { body: 'ok' }
  table['https://other.example/'] = { body: 'ok' }
  const { fn, seen } = fakeFetch(table)
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  let got = 0
  for (let i = 0; i < 50; i++) if (await site.get(`https://ours.example/p${i}`)) got++
  assert.equal(got, CAPS.SITE_MAX_REQUESTS_PER_HOST)
  assert.equal(seen.length, CAPS.SITE_MAX_REQUESTS_PER_HOST, 'no request past the budget')
  assert.ok(await site.get('https://other.example/'))
  const st = site.stats()
  assert.equal(st.requests, CAPS.SITE_MAX_REQUESTS_PER_HOST + 1)
  assert.equal(st.refused, 50 - CAPS.SITE_MAX_REQUESTS_PER_HOST)
  assert.equal(st.hosts, 2)
})

test('site: requests to one host are at least a second apart on the injected clock; another host does not wait', async () => {
  const clock = fakeClock()
  const { fn, seen } = fakeFetch({ 'https://ours.example/a': { body: 'a' }, 'https://ours.example/b': { body: 'b' }, 'https://ours.example/c': { body: 'c' }, 'https://else.example/': { body: 'x' } }, clock)
  const site = new LiveSite({ fetchImpl: fn, clock })
  await site.get('https://ours.example/a')
  await site.get('https://ours.example/b')
  await site.get('https://else.example/')
  await site.get('https://ours.example/c')
  const ours = seen.filter(s => s.url.startsWith('https://ours.example')).map(s => s.at)
  for (let i = 1; i < ours.length; i++) assert.ok(ours[i] - ours[i - 1] >= SITE_FETCH.minGapMs, `gap ${ours[i] - ours[i - 1]}`)
  assert.equal(clock.slept.length, 2, 'only the same host waited')
  assert.ok(clock.slept.every(ms => ms <= SITE_FETCH.minGapMs))
})

test('site: redirects are followed by hand, on the same registrable domain only, at most three hops', async () => {
  const { fn, seen } = fakeFetch({
    'https://ours.example/a': { status: 301, headers: { location: 'https://www.ours.example/b' } },
    'https://www.ours.example/b': { status: 302, headers: { location: '/c' } },
    'https://www.ours.example/c': { body: '<h1>C</h1>' },
    'https://ours.example/away': { status: 301, headers: { location: 'https://tracker.example/x' } },
    'https://ours.example/l1': { status: 301, headers: { location: '/l2' } },
    'https://ours.example/l2': { status: 301, headers: { location: '/l3' } },
    'https://ours.example/l3': { status: 301, headers: { location: '/l4' } },
    'https://ours.example/l4': { status: 301, headers: { location: '/l5' } },
    'https://ours.example/l5': { body: 'never' },
    'https://ours.example/toasset': { status: 301, headers: { location: '/app.js' } },
  })
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  const r = await site.get('https://ours.example/a')
  assert.equal(r?.status, 200)
  assert.equal(r?.url, 'https://www.ours.example/c')
  assert.equal(await site.get('https://ours.example/away'), null, 'a hop off the domain is refused')
  assert.ok(!seen.some(s => s.url.includes('tracker.example')), 'and never requested')
  assert.equal(await site.get('https://ours.example/l1'), null, 'past three hops is refused')
  assert.ok(!seen.some(s => s.url.endsWith('/l5')))
  assert.equal(await site.get('https://ours.example/toasset'), null)
  assert.ok(!seen.some(s => s.url.endsWith('.js')))
  assert.ok(seen.every(s => s.init.redirect === 'manual'))
})

test('site: a non-text response is refused unread; an error page of another type still says its status', async () => {
  const { fn } = fakeFetch({
    'https://ours.example/feed': { headers: { 'content-type': 'application/octet-stream' }, body: 'bin' },
    'https://ours.example/gone': { status: 410, headers: { 'content-type': 'image/png' } },
    'https://ours.example/data': { headers: { 'content-type': 'application/ld+json' }, body: '{"a":1}' },
    'https://ours.example/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *' },
    'https://ours.example/sitemap.xml': { headers: { 'content-type': 'application/xml' }, body: '<urlset/>' },
  })
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  assert.equal(await site.get('https://ours.example/feed'), null)
  assert.deepEqual({ ...(await site.get('https://ours.example/gone')), headers: {} }, { status: 410, headers: {}, text: '', url: 'https://ours.example/gone' })
  assert.equal((await site.get('https://ours.example/data'))?.text, '{"a":1}')
  assert.equal((await site.get('https://ours.example/robots.txt'))?.text, 'User-agent: *')
  assert.equal((await site.get('https://ours.example/sitemap.xml'))?.status, 200)
})

test('site: never requests a script, a stylesheet, an image, a font or a file, and never a non-web URL', async () => {
  const { fn, seen } = fakeFetch({})
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  for (const u of ['https://ours.example/app.js', 'https://ours.example/site.css', 'https://ours.example/logo.png', 'https://ours.example/a.jpeg', 'https://ours.example/i.svg', 'https://ours.example/f.woff2', 'https://ours.example/doc.pdf', 'https://ours.example/m.mjs', 'ftp://ours.example/', 'javascript:alert(1)', 'https://user:pw@ours.example/', 'not a url']) {
    assert.equal(await site.get(u), null, u)
  }
  assert.equal(seen.length, 0)
  assert.equal(site.stats().refused, 12)
})

test('site: a host that keeps failing is read no further', async () => {
  let calls = 0
  const failing = (async () => { calls++; throw new TypeError('fetch failed') }) as unknown as typeof fetch
  const site = new LiveSite({ fetchImpl: failing, clock: fakeClock() })
  for (let i = 0; i < 6; i++) assert.equal(await site.get(`https://down.example/p${i}`), null)
  assert.equal(calls, CAPS.SITE_MAX_ERRORS_PER_HOST)
  assert.equal(site.stats().errors, CAPS.SITE_MAX_ERRORS_PER_HOST)
})

test('site: the registrable domain, without a suffix list', () => {
  assert.equal(registrableDomain('www.mindmake.co'), 'mindmake.co')
  assert.equal(registrableDomain('ctrl.mindmake.co'), 'mindmake.co')
  assert.equal(registrableDomain('a.b.example.co.uk'), 'example.co.uk')
  assert.equal(registrableDomain('example.com'), 'example.com')
})

test('offline site: reads a fixture by the URL\'s hash; a missing one throws when strict and reads as unavailable otherwise', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-site-'))
  try {
    mkdirSync(join(dir, 'site'))
    writeFileSync(join(dir, 'site', siteFixtureName('https://ours.example/')), JSON.stringify({ status: 200, headers: { 'content-type': 'text/html' }, text: '<h1>Home</h1>' }))
    const loose = new OfflineSite(dir)
    assert.equal((await loose.get('https://ours.example'))?.text, '<h1>Home</h1>', 'the URL is normalised before hashing')
    assert.equal(await loose.get('https://ours.example/missing'), null)
    const strict = new OfflineSite(dir, { strict: true })
    await assert.rejects(strict.get('https://ours.example/missing'), MissingFixture)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('offline site: the repository\'s synthetic fixtures follow a same-domain redirect', async () => {
  const site = new OfflineSite(FIXTURES, { strict: true })
  const r = await site.get('https://docs.example-assistant.com/custom-instructions')
  assert.equal(r?.status, 200)
  assert.equal(r?.url, 'https://docs.example-assistant.com/custom-instructions/')
})

test('site: calls made at once to one host are reserved a gap apart before they wait, and never pass the budget', async () => {
  // A clock whose sleep does not move time: each call's wait is exactly how far ahead its slot was reserved.
  const t0 = 5_000_000
  const waits: number[] = []
  const clock: Clock = { now: () => t0, sleep: async ms => { waits.push(ms) } }
  const { fn, seen } = fakeFetch(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://ours.example/p${i}`, { body: 'ok' }])))
  const site = new LiveSite({ fetchImpl: fn, clock, maxPerHost: 4 })
  const got = await Promise.all(Array.from({ length: 6 }, (_, i) => site.get(`https://ours.example/p${i}`)))
  assert.equal(got.filter(Boolean).length, 4, 'the budget holds when the calls come at once')
  assert.equal(seen.length, 4)
  assert.deepEqual(waits.sort((a, b) => a - b), [1, 2, 3].map(n => n * SITE_FETCH.minGapMs), 'each slot one gap after the last, none shared')
  assert.equal(site.stats().refused, 2)
})

test('site: never a private, local or internal host, an IP literal or another port, on the first request or any hop', async () => {
  const { fn, seen } = fakeFetch({
    'https://ours.example/port': { status: 301, headers: { location: 'https://ours.example:8443/x' } },
    'https://ours.example:8443/x': { body: 'never' },
  })
  const site = new LiveSite({ fetchImpl: fn, clock: fakeClock() })
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/admin', 'http://localhost/', 'http://127.0.0.1/', 'http://0x7f.1/', 'http://[::1]/', 'https://intranet/', 'https://printer.local/', 'https://svc.internal/', 'https://router.home.arpa/', 'https://ours.example:8443/x', 'http://10.0.0.1/']) {
    assert.equal(await site.get(u), null, u)
  }
  assert.equal(await site.get('https://ours.example/port'), null, 'a hop to another port is refused')
  assert.deepEqual(seen.map(s => s.url), ['https://ours.example/port'])
  assert.ok(publicWebUrl(new URL('https://www.example-writer-tools.com/blog/x')))
  assert.ok(publicWebUrl(new URL('https://ours.example:443/')), 'the scheme\'s own port, written out, is the same URL')
})
