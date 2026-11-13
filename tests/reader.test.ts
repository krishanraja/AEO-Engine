import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SiteFetcher, SitePage } from '../src/clients/site.js'
import { decodeEntities, extractPage, jsonLdOf, visibleDateOf } from '../src/lib/html.js'
import { isAllowed, parseRobots, rulesFor, verdicts } from '../src/lib/robots.js'
import { parseSitemap, readSitemaps } from '../src/lib/sitemap.js'
import { classifySource } from '../src/lib/sourceType.js'

// ---------- html ----------

const PAGE = `<!doctype html><html><head>
<title>What is a  personal AI writing style? | Example</title>
<meta name="description" content="A synthetic page &amp; its summary">
<link rel="canonical" href="https://ours.example/answers/style">
<meta name="robots" content="index, follow">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","datePublished":"2026-08-14T09:00:00Z","dateModified":"2026-09-01","author":{"@type":"Person","name":"Synthetic Author"}},{"@type":"Organization","sameAs":["https://social.example/ours"]}]}</script>
<script type="application/ld+json">{ broken json </script>
<style>.x{content:"hidden words here"}</style>
</head><body>
<!-- a comment with words that nobody sees -->
<nav>Home About</nav>
<h1 class="t">What is a <em>personal</em> AI writing style?</h1>
<div class="byline"><time datetime="2026-08-14">14 August 2026</time></div>
<p>  </p>
<p>A personal AI writing style is the standard you keep, written as graded examples rather than adjectives, so the tool can check itself against it.</p>
<h2>Examples over adjectives</h2><p>More text.</p>
<h2>Checking the drift
<p>Unclosed heading above.</p>
<script>document.write("words a script would add")</script>
</body></html>`

test('html: title, description, canonical, headings, the first paragraph after the H1 and its words', () => {
  const f = extractPage(PAGE)
  assert.equal(f.title, 'What is a personal AI writing style? | Example')
  assert.equal(f.description, 'A synthetic page & its summary')
  assert.equal(f.canonical, 'https://ours.example/answers/style')
  assert.equal(f.noindex, false)
  assert.deepEqual(f.h1, ['What is a personal AI writing style?'])
  assert.equal(f.h2.length, 2)
  assert.equal(f.h2[0], 'Examples over adjectives')
  assert.match(f.first_paragraph ?? '', /^A personal AI writing style is the standard/)
  assert.equal(f.first_paragraph_words, 25)
  assert.ok(f.words > 30 && f.words < 80, `words ${f.words}`)
})

test('html: scripts, styles and comments are not visible words; JSON-LD dates, types, sameAs and author; a broken block costs only itself', () => {
  const f = extractPage(PAGE)
  const visible = f.words
  assert.equal(extractPage(PAGE.replace(/<script>document[^<]*<\/script>/, '')).words, visible, 'an inline script adds no words')
  assert.deepEqual(f.json_ld.types, ['Article', 'Organization'], 'an author is read for its name, not its type')
  assert.equal(f.json_ld.date_published, '2026-08-14')
  assert.equal(f.json_ld.date_modified, '2026-09-01')
  assert.deepEqual(f.json_ld.same_as, ['https://social.example/ours'])
  assert.deepEqual(f.json_ld.authors, ['Synthetic Author'])
  assert.equal(f.visible_date, '2026-08-14')
})

test('html: noindex from meta robots or googlebot; malformed pages never throw', () => {
  assert.equal(extractPage('<meta name="robots" content="noindex,follow"><h1>x</h1>').noindex, true)
  assert.equal(extractPage("<meta content='none' name='googlebot'>").noindex, true)
  assert.equal(extractPage('<META NAME="ROBOTS" CONTENT="index">').noindex, false)
  for (const bad of ['', '<h1>', '<html><body><h1>Only a heading', '<p>no heading</p>', '<script type="application/ld+json">{"@type":', '<<<>>>']) {
    const f = extractPage(bad)
    assert.equal(typeof f.words, 'number')
  }
  assert.equal(extractPage('<html><head><title>T</title><body><h1>Body</h1><p>one two three</p></body>').words, 4, 'an unclosed head ends at the body')
  const noH1 = extractPage('<p>Text with no heading at all.</p>')
  assert.equal(noH1.first_paragraph, null)
  assert.equal(noH1.first_paragraph_words, null)
  assert.deepEqual(extractPage('<h1>One</h1><p>first</p><h1>Two</h1>').h1, ['One', 'Two'])
})

test('html: linear on hostile bodies, 512 KB of open tags with no close parse in well under a second each', () => {
  const N = 512 * 1024
  for (const unit of ['<', '<h1', '<meta', '<p', '<script', '<h1>', '<p>', '<div id=root ', '<loc']) {
    const body = unit.repeat(Math.ceil(N / unit.length)).slice(0, N)
    const t = Date.now()
    extractPage(body)
    parseSitemap(body)
    assert.ok(Date.now() - t < 1000, `${unit}: ${Date.now() - t} ms`)
  }
})

test('html: an app shell (an empty mount point, or mostly script) is told apart from a short page served whole', () => {
  assert.equal(extractPage('<html><body><div id="root"></div><script src="/a.js"></script></body></html>').app_shell, true)
  assert.equal(extractPage('<html><body><div id="__next">  </div></body></html>').app_shell, true)
  assert.equal(extractPage(`<html><body><h1>T</h1><p>short</p><script>${'x'.repeat(4000)}</script></body></html>`).app_shell, true)
  assert.equal(extractPage('<html><body><h1>Short answer</h1><p>Forty words or so, all in the HTML.</p></body></html>').app_shell, false)
  assert.equal(extractPage('<html><body><div id="__next"><h1>Rendered</h1><p>On the server.</p></div></body></html>').app_shell, false)
})

test('html: a visible date written in words after "updated", entities decoded, and an em dash never comes out', () => {
  assert.equal(visibleDateOf('<p>Last updated: March 3, 2026</p>'), '2026-03-03')
  assert.equal(visibleDateOf('<p>Published on 12 November 2026 by us</p>'), '2026-11-12')
  assert.equal(visibleDateOf('<p>No date here</p>'), null)
  assert.equal(decodeEntities('a &mdash; b &#8212; c &#x2014; d'), 'a , b , c , d')
  assert.equal(decodeEntities('&lt;p&gt; &#39;q&#39;'), "<p> 'q'")
  assert.deepEqual(jsonLdOf('<script type="application/ld+json">[{"@type":["FAQPage","WebPage"]}]</script>').types, ['FAQPage', 'WebPage'])
})

// ---------- robots ----------

test('robots: a specific group wins over *, groups for one token merge, and a token with no group falls back to *', () => {
  const r = parseRobots([
    'User-agent: *',
    'Disallow: /private/',
    '',
    'User-agent: PerplexityBot',
    'Disallow: /',
    '',
    'User-agent: ChatGPT-User',
    'User-agent: Claude-User',
    'Disallow: /drafts/',
    '',
    'User-agent: ChatGPT-User/1.0',
    'Disallow: /tmp/',
    'Sitemap: https://ours.example/sitemap.xml',
  ].join('\n'))
  assert.deepEqual(r.sitemaps, ['https://ours.example/sitemap.xml'])
  assert.equal(isAllowed(r, 'PerplexityBot', '/'), false)
  assert.equal(isAllowed(r, 'perplexitybot', '/answers/x'), false, 'case-insensitive')
  assert.equal(isAllowed(r, 'Googlebot', '/'), true)
  assert.equal(isAllowed(r, 'Googlebot', '/private/x'), false)
  assert.equal(isAllowed(r, 'Claude-User', '/drafts/a'), false)
  assert.equal(isAllowed(r, 'Claude-User', '/private/x'), true, 'its own group, not *')
  assert.equal(rulesFor(r, 'ChatGPT-User').length, 2, 'two groups for one token merge')
  assert.equal(isAllowed(r, 'ChatGPT-User', '/tmp/a'), false)
  assert.equal(isAllowed(r, 'PerplexityBot', '/robots.txt'), true)
})

test('robots: the longest match wins, Allow beats Disallow on a tie, wildcards and $ anchors', () => {
  const r = parseRobots('User-agent: *\nDisallow: /blog/\nAllow: /blog/answers/\nDisallow: /*.pdf$\nAllow: /same\nDisallow: /same\nDisallow:\n')
  assert.equal(isAllowed(r, 'Bingbot', '/blog/old-post'), false)
  assert.equal(isAllowed(r, 'Bingbot', '/blog/answers/style'), true, 'longer Allow wins')
  assert.equal(isAllowed(r, 'Bingbot', '/files/a.pdf'), false)
  assert.equal(isAllowed(r, 'Bingbot', '/files/a.pdf?x=1'), true, '$ anchors the end')
  assert.equal(isAllowed(r, 'Bingbot', '/same'), true, 'Allow on a tie')
  assert.equal(isAllowed(r, 'Bingbot', '/anything'), true, 'an empty Disallow allows')
})

test('robots: an empty or missing file allows every bot; verdicts cover all nine tokens', () => {
  const v = verdicts(parseRobots(''), '/')
  assert.equal(Object.keys(v).length, 9)
  assert.ok(Object.values(v).every(Boolean))
  const blockAll = verdicts(parseRobots('User-agent: *\nDisallow: /\n'), '/')
  assert.ok(Object.values(blockAll).every(x => x === false))
  assert.equal(parseRobots('Disallow: /\n').groups.length, 0, 'a rule with no user-agent belongs to no group')
})

// ---------- sitemap ----------

function tableFetcher(table: Record<string, string>): SiteFetcher & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async get(url: string): Promise<SitePage | null> {
      asked.push(url)
      const t = table[url]
      return t === undefined ? { status: 404, headers: {}, text: '', url } : { status: 200, headers: { 'content-type': 'application/xml' }, text: t, url }
    },
    stats: () => ({ requests: asked.length, refused: 0, errors: 0, hosts: 1 }),
  }
}

const idx = (...locs: string[]) => `<sitemapindex>${locs.map(l => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`
const set = (...locs: string[]) => `<urlset>${locs.map(l => `<url><loc>${l}</loc></url>`).join('')}</urlset>`

test('sitemap: parses a urlset and an index, tolerant of CDATA and entities', () => {
  assert.deepEqual(parseSitemap(set('https://o.example/a', 'https://o.example/b?x=1&amp;y=2')), { kind: 'urlset', locs: ['https://o.example/a', 'https://o.example/b?x=1&y=2'] })
  assert.deepEqual(parseSitemap(idx('<![CDATA[https://o.example/s1.xml]]>')), { kind: 'index', locs: ['https://o.example/s1.xml'] })
  assert.equal(parseSitemap('<html>not a sitemap</html>').kind, 'unknown')
})

test('sitemap: follows an index two levels deep and no further, keeps its own host only, and stops at the URL cap', async () => {
  const f = tableFetcher({
    'https://o.example/sitemap.xml': idx('https://o.example/l1.xml', 'https://cdn.other.example/l1.xml'),
    'https://o.example/l1.xml': idx('https://o.example/l2.xml'),
    'https://o.example/l2.xml': idx('https://o.example/l3.xml', 'https://o.example/pages.xml'),
    'https://o.example/pages.xml': set('https://o.example/a', 'https://elsewhere.example/b'),
    'https://o.example/l3.xml': set('https://o.example/deep'),
  })
  const inv = await readSitemaps('o.example', [], f)
  assert.equal(inv.present, true)
  assert.deepEqual(inv.urls, [], 'the pages sit three levels down, past the limit')
  assert.ok(!f.asked.includes('https://o.example/l3.xml'))
  assert.ok(!f.asked.some(u => u.includes('other.example')), 'a sitemap on another domain is never read')

  const shallow = tableFetcher({ 'https://o.example/s.xml': idx('https://o.example/pages.xml'), 'https://o.example/pages.xml': set(...Array.from({ length: 300 }, (_, i) => `https://o.example/p${i}`), 'https://elsewhere.example/x') })
  const capped = await readSitemaps('o.example', ['https://o.example/s.xml'], shallow, { maxUrls: 200 })
  assert.equal(capped.urls.length, 200)
  assert.ok(capped.urls.every(u => u.startsWith('https://o.example/')))

  const none = await readSitemaps('o.example', [], tableFetcher({}))
  assert.deepEqual(none, { present: false, urls: [], files: 1, refused: 0 })

  // A sitemap robots.txt closes to this reader is never requested, nor are its children.
  const closed = tableFetcher({ 'https://o.example/s.xml': idx('https://o.example/private/p.xml', 'https://o.example/pages.xml'), 'https://o.example/pages.xml': set('https://o.example/a') })
  const open = await readSitemaps('o.example', ['https://o.example/s.xml'], closed, { allowed: u => !u.pathname.startsWith('/private/') })
  assert.deepEqual(open, { present: true, urls: ['https://o.example/a'], files: 2, refused: 1 })
  assert.ok(!closed.asked.some(u => u.includes('/private/')))
})

// ---------- source type ----------

test('source type: a static table from host and path, with listicle patterns', () => {
  const cases: Array<[string, string, string?]> = [
    ['https://www.reddit.com/r/writing/comments/abc/x', 'forum'],
    ['https://www.quora.com/How-do-I', 'forum'],
    ['https://ux.stackexchange.com/questions/1', 'forum'],
    ['https://forum.example-dev.org/t/skills/123', 'forum'],
    ['https://www.youtube.com/watch?v=x', 'video'],
    ['https://vimeo.com/123', 'video'],
    ['https://www.g2.com/products/x/reviews', 'review'],
    ['https://www.capterra.com/p/1/x', 'review'],
    ['https://www.trustpilot.com/review/x.example', 'review'],
    ['https://en.wikipedia.org/wiki/Style_guide', 'reference'],
    ['https://docs.example-assistant.com/custom-instructions', 'reference'],
    ['https://www.example.com/blog/best-ai-writing-tools', 'listicle'],
    ['https://www.example.com/top-10-assistants', 'listicle'],
    ['https://www.example.com/7-best-tools', 'listicle'],
    ['https://www.example.com/notion-vs-coda', 'listicle'],
    ['https://www.example.com/jasper-alternatives', 'listicle'],
    ['https://www.example.com/post', 'listicle', 'The 9 best AI writing tools in 2026'],
    ['https://www.forbes.com/sites/x/2026/ai-writing', 'news'],
    ['https://techcrunch.com/2026/11/01/x', 'news'],
    ['https://www.crunchbase.com/organization/x', 'directory'],
    ['https://www.example-writer-tools.com/blog/2026/train-your-voice', 'vendor'],
    ['https://www.example.com/pricing', 'vendor'],
    ['https://www.example.com/', 'vendor'],
    ['https://www.example-prompting.com/voice-guide', 'unknown'],
    ['not a url', 'unknown'],
  ]
  for (const [url, want, title] of cases) assert.equal(classifySource(url, title), want, url)
})
