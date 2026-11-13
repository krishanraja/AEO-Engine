/**
 * What the site reader takes from a page's HTML, by regular expression and
 * with no dependency: no DOM, no parser, and never a script run. A page here
 * is the bytes the server sent, which is what an assistant's fetcher reads
 * too; anything a browser would add by running JavaScript is, correctly,
 * absent. Tolerant of malformed HTML: an unclosed tag, a missing head or a
 * broken JSON-LD block costs that one field, never the page.
 */

export interface JsonLdSummary {
  /** Every @type found, top level, inside @graph and nested, each once. */
  types: string[]
  date_published: string | null
  date_modified: string | null
  same_as: string[]
  /** Author names (or the author string), each once. */
  authors: string[]
}

export interface PageFacts {
  title: string | null
  description: string | null
  canonical: string | null
  /** A meta robots (or googlebot) tag says noindex. The X-Robots-Tag header is the fetcher's to read. */
  noindex: boolean
  h1: string[]
  h2: string[]
  /** The first non-empty paragraph after the first H1, as text, or null. */
  first_paragraph: string | null
  first_paragraph_words: number | null
  /** Words a reader would see in the raw HTML: scripts, styles, templates and tags stripped. */
  words: number
  json_ld: JsonLdSummary
  /** A date shown on the page itself (a <time datetime>, or a "published" or "updated" line), as YYYY-MM-DD, when obvious. */
  visible_date: string | null
  /**
   * The HTML looks like a shell a script fills in: an empty mount point (a
   * root, app or __next element with nothing in it), or scripts are most of
   * its bytes. Evidence of client rendering, read only beside a low word count.
   */
  app_shell: boolean
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: ',', ndash: ',', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' }

/** Decodes the common named entities and every numeric one. */
export function decodeEntities(s: string): string {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return ' '
      // The em and en dash become commas, as everywhere else in this engine.
      if (n === 0x2014 || n === 0x2013) return ','
      try { return String.fromCodePoint(n) } catch { return ' ' }
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Every tag pattern here stops at the next '<' ([^<>] rather than [^>]), so a
 * body of many '<' with no '>' is read in linear time: a page cited first is
 * someone else's bytes, and no deadline covers parsing them.
 */

/** Tags out, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(String(html ?? '').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function wordCount(text: string): number {
  const t = String(text ?? '').trim()
  return t ? t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length : 0
}

/** Comments out, and every element whose content no reader sees: script, style, template, noscript, svg, head. */
function visibleHtml(html: string): string {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<head\b[^<>]*>[\s\S]*?(<\/head\s*>|(?=<body\b)|$)/gi, ' ')
    .replace(/<(script|style|template|noscript|svg)\b[^<>]*>[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
}

/** The value of one attribute in a tag's source, quoted or not. */
export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim()
}

function allTags(html: string, tag: string): string[] {
  return String(html ?? '').match(new RegExp(`<${tag}\\b[^<>]*>`, 'gi')) ?? []
}

function metaContent(html: string, key: 'name' | 'property', value: RegExp): string | null {
  for (const t of allTags(html, 'meta')) {
    const k = attr(t, key)
    if (k && value.test(k)) return attr(t, 'content')
  }
  return null
}

function headings(html: string, level: 1 | 2): string[] {
  const out: string[] = []
  const re = new RegExp(`<h${level}\\b[^<>]*>([\\s\\S]*?)(?:<\\/h${level}\\s*>|(?=<h[1-6]\\b)|$)`, 'gi')
  for (const m of String(html ?? '').matchAll(re)) {
    const t = textOf(m[1])
    if (t) out.push(t.slice(0, 300))
  }
  return out
}

function firstParagraphAfterH1(html: string): string | null {
  // Ends at the close, the next heading or the end: never a scan that fails and restarts at the next <h1.
  const m = /<h1\b[^<>]*>[\s\S]*?(<\/h1\s*>|(?=<h[1-6]\b)|$)/i.exec(html)
  if (!m) return null
  const rest = html.slice(m.index + m[0].length)
  for (const p of rest.matchAll(/<p\b[^<>]*>([\s\S]*?)(?:<\/p\s*>|(?=<p\b|<h[1-6]\b|<\/(?:div|section|article|main|body)\b)|$)/gi)) {
    const t = textOf(p[1])
    if (t) return t.slice(0, 2000)
  }
  return null
}

const YMD = /^(\d{4}-\d{2}-\d{2})/

function asDate(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = YMD.exec(v.trim())
  if (m && !Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return m[1]
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
}

function walkLd(node: unknown, out: JsonLdSummary, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walkLd(n, out, depth + 1); return }
  const o = node as Record<string, unknown>
  const types = Array.isArray(o['@type']) ? o['@type'] : [o['@type']]
  for (const t of types) if (typeof t === 'string' && t.trim() && !out.types.includes(t.trim())) out.types.push(t.trim().slice(0, 80))
  out.date_published ??= asDate(o.datePublished)
  out.date_modified ??= asDate(o.dateModified)
  const same = Array.isArray(o.sameAs) ? o.sameAs : typeof o.sameAs === 'string' ? [o.sameAs] : []
  for (const s of same) if (typeof s === 'string' && s.trim() && !out.same_as.includes(s.trim()) && out.same_as.length < 20) out.same_as.push(s.trim().slice(0, 300))
  const authors = Array.isArray(o.author) ? o.author : o.author !== undefined ? [o.author] : []
  for (const a of authors) {
    const name = typeof a === 'string' ? a : a && typeof a === 'object' ? (a as Record<string, unknown>).name : null
    if (typeof name === 'string' && name.trim() && !out.authors.includes(name.trim()) && out.authors.length < 10) out.authors.push(name.trim().slice(0, 120))
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'author' && v && typeof v === 'object') walkLd(v, out, depth + 1)
}

/** Every JSON-LD block that parses, summarised. A block that does not parse is skipped. */
export function jsonLdOf(html: string): JsonLdSummary {
  const out: JsonLdSummary = { types: [], date_published: null, date_modified: null, same_as: [], authors: [] }
  for (const m of String(html ?? '').matchAll(/<script\b([^<>]*)>([\s\S]*?)(?:<\/script\s*>|$)/gi)) {
    if (!/application\/ld\+json/i.test(attr(m[1], 'type') ?? '')) continue
    try { walkLd(JSON.parse(m[2].trim()), out) } catch { /* a broken block costs only itself */ }
  }
  return out
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function wordDate(s: string): string | null {
  const a = /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i.exec(s)
  const b = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(s)
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(s)
  const parts = a ? { d: a[1], m: a[2], y: a[3] } : b ? { d: b[2], m: b[1], y: b[3] } : null
  if (parts) {
    const mm = String(MONTHS.indexOf(parts.m.toLowerCase()) + 1).padStart(2, '0')
    return asDate(`${parts.y}-${mm}-${parts.d.padStart(2, '0')}`)
  }
  return iso ? asDate(iso[1]) : null
}

/** A <time datetime>, else a date written right after "published", "updated", "posted" or "last modified". */
export function visibleDateOf(html: string): string | null {
  const body = visibleHtml(html)
  for (const t of allTags(body, 'time')) {
    const d = asDate(attr(t, 'datetime') ?? '')
    if (d) return d
  }
  const text = textOf(body)
  const m = /\b(?:published|updated|posted|last (?:updated|modified))\b[:\s,]*(?:on\s+)?(.{0,40})/i.exec(text)
  return m ? wordDate(m[1]) : null
}

/** Everything the reader takes from one page. Never throws. */
export function extractPage(html: string): PageFacts {
  const src = String(html ?? '')
  const titleM = /<title\b[^<>]*>([\s\S]*?)(<\/title\s*>|$)/i.exec(src)
  const title = titleM ? textOf(titleM[1]).slice(0, 300) || null : null
  const description = metaContent(src, 'name', /^description$/i) ?? metaContent(src, 'property', /^og:description$/i)
  let canonical: string | null = null
  for (const t of allTags(src, 'link')) {
    if ((attr(t, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) { canonical = attr(t, 'href'); break }
  }
  const robots = [metaContent(src, 'name', /^robots$/i), metaContent(src, 'name', /^googlebot$/i)].filter(Boolean).join(',').toLowerCase()
  const visible = visibleHtml(src)
  const first = firstParagraphAfterH1(visible)
  return {
    title,
    description: description ? description.slice(0, 500) : null,
    canonical: canonical || null,
    noindex: /\b(noindex|none)\b/.test(robots),
    h1: headings(visible, 1),
    h2: headings(visible, 2),
    first_paragraph: first,
    first_paragraph_words: first === null ? null : wordCount(first),
    words: wordCount(textOf(visible)),
    json_ld: jsonLdOf(src),
    visible_date: visibleDateOf(src),
    app_shell: appShellOf(src),
  }
}

const MOUNT_IDS = new Set(['root', 'app', '__next', '__nuxt', '___gatsby', 'svelte', 'main-app'])

/** An empty mount point, or scripts making up most of the bytes (see PageFacts.app_shell). */
export function appShellOf(html: string): boolean {
  const src = String(html ?? '')
  // One bounded scan per candidate element, then its id read as an attribute: no pattern that backtracks across a tag.
  for (const m of src.matchAll(/<(div|main|section|body)\b([^<>]{0,1000})>\s*<\/\1\s*>/gi)) {
    if (MOUNT_IDS.has((attr(`<x ${m[2]}>`, 'id') ?? '').toLowerCase())) return true
  }
  if (/<(app-root|ion-app)\b/i.test(src)) return true
  let scripts = 0
  for (const m of src.matchAll(/<script\b[^<>]*>[\s\S]*?(?:<\/script\s*>|$)/gi)) scripts += m[0].length
  return src.length > 0 && scripts * 2 > src.length
}
