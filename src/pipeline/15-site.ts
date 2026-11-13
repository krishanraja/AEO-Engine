/**
 * Stage 15: the site audit. For each of the subject's own hosts (at most
 * SITE_MAX_HOSTS_PER_SUBJECT, from the domains the probes read with Krish's
 * ruled corrections applied; a general platform such as linkedin.com is never
 * audited as ours, and a domain with a path counts only when its registrable
 * domain is also one of the subject's plain domains, so a profile on someone
 * else's platform never puts that platform's host in the audit), it reads,
 * fetch only (src/clients/site.ts):
 *
 * - robots.txt, and each bot's verdict for the home page;
 * - the home page, the sitemap inventory (robots.txt's Sitemap lines, else
 *   /sitemap.xml) and up to SITE_MAX_PAGES_PER_HOST pages in all, the paths
 *   that look like answers (answers, blog, faq, guides, learn, help) first.
 *
 * Every read past robots.txt asks robots.txt first, as this reader's own
 * token (which resolves to the * group): a path it closes is not read, the
 * home page and the sitemaps included. A robots.txt that cannot be read (a
 * 5xx, or no answer) closes the host, as RFC 9309 says, and only its two bot
 * gates are recorded; a 4xx means there is none, and everything is open.
 *
 * A host is audited once per run: once per process here (a cache keyed by
 * the fetcher), and once per research run in the workflow, whose site job
 * audits every subject's hosts before the subject jobs start (src/site.ts) and
 * hands them the result, so a host shared by many subjects is read once and
 * the per-host budget is the run's.
 *
 * Per host it records pass or fail gates, never a score; a gate it could not
 * measure because robots.txt closed the page is left out, never failed. Per
 * page it records what the diagnosis and the kits read. Nothing here is logged
 * but counts.
 */
import { registrableDomain, type SiteFetcher, type SitePage } from '../clients/site.js'
import { CAPS } from '../config/run.js'
import { splitDomain } from '../lib/domains.js'
import { extractPage } from '../lib/html.js'
import { log } from '../lib/log.js'
import { isGeneralPlatform } from '../lib/platforms.js'
import { EMPTY_ROBOTS, isAllowed, parseRobots, SEARCH_BOTS, USER_BOTS, verdicts, type BotToken, type Robots } from '../lib/robots.js'
import { readSitemaps } from '../lib/sitemap.js'
import type { ContextSubject } from '../schema/context.js'
import { HOST_GATES, type HostGate } from '../schema/kit.js'

// The gate list lives with the kit shapes (src/schema/kit.ts), so the packet's `site` feature reads the same one.
export { HOST_GATES, type HostGate }

export interface GateResult { gate: HostGate; pass: boolean; detail: string }
export interface HostAudit { host: string; gates: GateResult[] }

export interface AuditPage {
  url: string
  status: number
  title: string | null
  /** The first H1, or null. */
  h1: string | null
  h1_count: number
  h2_count: number
  /** Raw visible words, as served (no script run). */
  words: number
  /** The first paragraph after the H1 is at most ANSWER_FIRST_MAX_WORDS words. */
  has_answer_first: boolean
  noindex: boolean
  /** Null when the page names no canonical; false when it names another page. */
  canonical_self: boolean | null
  date_published: string | null
  date_modified: string | null
  /**
   * Fewer than SERVER_RENDERED_MIN_WORDS words as served, and the HTML is a
   * shell a script fills in (an empty mount point, or mostly script). A short
   * page with neither is a short page, not a client-rendered one.
   */
  client_rendered: boolean
}

export interface SiteAudit { hosts: HostAudit[]; pages: AuditPage[]; requests: number; errors: number }

/** One host's audit: what the run's site job seals for the subject jobs, and what the per-process cache holds. */
export interface HostAuditResult { host: string; gates: GateResult[]; pages: AuditPage[]; requests: number; errors: number }

export const EMPTY_AUDIT: SiteAudit = { hosts: [], pages: [], requests: 0, errors: 0 }

/** A page that serves fewer words than this without a script run reads as client-rendered. */
export const SERVER_RENDERED_MIN_WORDS = 150
/** An answer-first page opens with a paragraph of at most this many words under its H1. */
export const ANSWER_FIRST_MAX_WORDS = 80
/** The reader's own token, for robots.txt: it resolves to the * group, so the audit reads only what any polite reader may. */
export const READER_TOKEN = 'AEO-Engine'

const ANSWER_PATH = /(^|\/)(answers?|blog|faqs?|guides?|learn|help)(\/|$|-)/i

/**
 * The hosts to audit: each plain domain's host, each once, never a general
 * platform, at most `max`. A domain with a path (linkedin.com/in/someone,
 * github.com/someone) is a page on a host, not the host: its host is audited
 * only when its registrable domain is also one of the plain domains, so
 * mindmake.co/ctrl beside mindmake.co counts and a profile on a platform never does.
 */
export function auditHosts(domains: readonly string[], max: number = CAPS.SITE_MAX_HOSTS_PER_SUBJECT): string[] {
  const plain: string[] = []
  const pathed: string[] = []
  for (const d of domains) {
    const { host, path } = splitDomain(d)
    if (!host || !host.includes('.') || isGeneralPlatform(host)) continue
    ;(path ? pathed : plain).push(host)
  }
  const ours = new Set(plain.map(h => registrableDomain(h)))
  const out: string[] = []
  for (const host of [...plain, ...pathed.filter(h => ours.has(registrableDomain(h)))]) {
    if (out.includes(host)) continue
    out.push(host)
    if (out.length >= max) break
  }
  return out
}

const stripUrl = (u: string): string => {
  try {
    const x = new URL(u)
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '') || ''}`
  } catch { return u }
}

/** One page's record, from what the server sent. */
export function pageRecord(res: SitePage): AuditPage {
  const f = extractPage(res.text)
  let canonical_self: boolean | null = null
  if (f.canonical) {
    try { canonical_self = stripUrl(new URL(f.canonical, res.url).href) === stripUrl(res.url) } catch { canonical_self = false }
  }
  const words = f.first_paragraph_words
  return {
    url: res.url,
    status: res.status,
    title: f.title,
    h1: f.h1[0] ?? null,
    h1_count: f.h1.length,
    h2_count: f.h2.length,
    words: f.words,
    has_answer_first: words !== null && words > 0 && words <= ANSWER_FIRST_MAX_WORDS,
    noindex: f.noindex || /\b(noindex|none)\b/i.test(res.headers['x-robots-tag'] ?? ''),
    canonical_self,
    date_published: f.json_ld.date_published ?? f.visible_date,
    date_modified: f.json_ld.date_modified,
    client_rendered: f.words < SERVER_RENDERED_MIN_WORDS && f.app_shell,
  }
}

function botGate(gate: 'search_bots_allowed' | 'user_bots_allowed', bots: readonly BotToken[], robots: Robots | null, robotsStatus: number | null): GateResult {
  if (!robots) return { gate, pass: false, detail: `robots.txt could not be read${robotsStatus ? ` (status ${robotsStatus})` : ''}, so no bot's access is known` }
  const v = verdicts(robots, '/')
  const blocked = bots.filter(b => !v[b])
  if (blocked.length) return { gate, pass: false, detail: `robots.txt closes the home page to ${blocked.join(', ')}` }
  return { gate, pass: true, detail: robotsStatus && robotsStatus >= 400 ? `no robots.txt (status ${robotsStatus}), so every bot may read` : `robots.txt lets ${bots.join(', ')} read the home page` }
}

/** Inventory URLs in the order they are read: answer-like paths first, then shallower paths, then sitemap order. */
export function prioritise(urls: readonly string[], skip: ReadonlySet<string>): string[] {
  const rows = urls.map((u, i) => {
    let path = '/'
    try { path = new URL(u).pathname } catch { /* keep / */ }
    return { u, i, answer: ANSWER_PATH.test(path) ? 0 : 1, depth: path.split('/').filter(Boolean).length }
  })
  return rows
    .filter(r => !skip.has(stripUrl(r.u)) && r.depth > 0)
    .sort((a, b) => a.answer - b.answer || a.depth - b.depth || a.i - b.i)
    .map(r => r.u)
}

const pathOf = (u: URL): string => u.pathname + u.search

/**
 * One host, read once: robots.txt, then (only what robots.txt leaves open to
 * this reader) the home page, the sitemaps and up to `maxPages` pages, the
 * home page included. Its requests and errors are this audit's own.
 */
export async function auditHost(host: string, fetcher: SiteFetcher, maxPages: number = CAPS.SITE_MAX_PAGES_PER_HOST): Promise<HostAuditResult> {
  const before = fetcher.stats()
  const pages: AuditPage[] = []
  const seen = new Set<string>()
  const r = await fetcher.get(`https://${host}/robots.txt`)
  // 2xx: its rules. 4xx: there is none, so all is open. Anything else (a 5xx,
  // a redirect off the domain, no answer): unreadable, so the host is closed.
  let robots: Robots | null = null
  if (r && r.status >= 200 && r.status < 300) robots = parseRobots(r.text)
  else if (r && r.status >= 400 && r.status < 500) robots = EMPTY_ROBOTS
  const gates: GateResult[] = [
    botGate('search_bots_allowed', SEARCH_BOTS, robots, r?.status ?? null),
    botGate('user_bots_allowed', USER_BOTS, robots, r?.status ?? null),
  ]
  const done = (): HostAuditResult => {
    const after = fetcher.stats()
    return { host, gates, pages, requests: after.requests - before.requests, errors: after.errors - before.errors }
  }
  if (!robots) return done()
  const open = robots
  const allowed = (u: URL) => isAllowed(open, READER_TOKEN, pathOf(u))

  if (allowed(new URL(`https://${host}/`)) && maxPages > 0) {
    const home = await fetcher.get(`https://${host}/`)
    const rec = home ? pageRecord(home) : null
    if (rec) { seen.add(stripUrl(rec.url)); seen.add(stripUrl(`https://${host}/`)); pages.push(rec) }
    gates.push(
      { gate: 'homepage_200', pass: rec?.status === 200, detail: rec ? `the home page answers ${rec.status}` : 'the home page could not be read' },
      { gate: 'homepage_server_rendered', pass: !!rec && rec.status === 200 && rec.words >= SERVER_RENDERED_MIN_WORDS, detail: rec ? `${rec.words} words in the home page's HTML as served` : 'the home page could not be read' },
      { gate: 'homepage_single_h1', pass: !!rec && rec.status === 200 && rec.h1_count === 1, detail: rec ? `${rec.h1_count} H1 on the home page` : 'the home page could not be read' },
    )
  }

  const inv = await readSitemaps(host, open.sitemaps, fetcher, { allowed })
  // Every sitemap closed to this reader: not measured, so no gate.
  if (inv.files > 0 || inv.refused === 0) {
    gates.push({ gate: 'sitemap_present', pass: inv.present, detail: inv.present ? `${inv.urls.length} page URLs in the sitemap` : `no sitemap read (${open.sitemaps.length ? 'robots.txt names one that did not read' : 'none named in robots.txt and none at /sitemap.xml'})` })
  }

  for (const u of prioritise(inv.urls, seen)) {
    if (pages.length >= maxPages) break
    if (seen.has(stripUrl(u))) continue
    let parsed: URL
    try { parsed = new URL(u) } catch { continue }
    if (!allowed(parsed)) continue
    seen.add(stripUrl(u))
    const res = await fetcher.get(u)
    if (!res) continue
    const rec = pageRecord(res)
    if (!pages.some(p => stripUrl(p.url) === stripUrl(rec.url))) pages.push(rec)
    seen.add(stripUrl(rec.url))
  }
  return done()
}

/** Host audits already made in this process, per fetcher: a host shared by several subjects is read once. */
const CACHE = new WeakMap<SiteFetcher, Map<string, Promise<HostAuditResult>>>()

/** The host's audit from this process's cache, reading it on first ask. */
export function cachedHostAudit(host: string, fetcher: SiteFetcher): Promise<HostAuditResult> {
  let byHost = CACHE.get(fetcher)
  if (!byHost) { byHost = new Map(); CACHE.set(fetcher, byHost) }
  let p = byHost.get(host)
  if (!p) { p = auditHost(host, fetcher); byHost.set(host, p) }
  return p
}

/**
 * The subject's view of its hosts: their gates, and up to `maxPages` of their
 * pages, one host at a time in turn, each host's best first. From `shared`
 * (the run's site job) when given, which then makes no request at all;
 * otherwise read through `fetcher`, each host once a process. `requests` and
 * `errors` count only what this call read.
 */
export async function siteAudit(
  subject: Pick<ContextSubject, 'slug' | 'kind'>,
  fetcher: SiteFetcher | null,
  domains: readonly string[],
  maxPages: number = CAPS.SITE_MAX_PAGES_PER_SUBJECT,
  shared?: ReadonlyMap<string, HostAuditResult>,
): Promise<SiteAudit> {
  const hosts = auditHosts(domains)
  const results: HostAuditResult[] = []
  let requests = 0
  let errors = 0
  for (const host of hosts) {
    if (shared) {
      const s = shared.get(host)
      if (s) results.push(s)
      continue
    }
    if (!fetcher) continue
    const cached = CACHE.get(fetcher)?.has(host) ?? false
    const res = await cachedHostAudit(host, fetcher)
    if (!cached) { requests += res.requests; errors += res.errors }
    results.push(res)
  }
  const pages: AuditPage[] = []
  const seen = new Set<string>()
  const queues = results.map(r => [...r.pages])
  while (pages.length < maxPages && queues.some(q => q.length)) {
    for (const q of queues) {
      if (pages.length >= maxPages) break
      const p = q.shift()
      if (!p || seen.has(stripUrl(p.url))) continue
      seen.add(stripUrl(p.url))
      pages.push(p)
    }
  }
  const audit: SiteAudit = { hosts: results.map(r => ({ host: r.host, gates: r.gates })), pages, requests, errors }
  log('site_audit', {
    subject: subject.slug, hosts: audit.hosts.length, pages: pages.length, requests, errors, shared: !!shared,
    gates_failed: failedGates(audit),
  })
  return audit
}

/** The failed gates of an audit, counted. */
export function failedGates(audit: Pick<SiteAudit, 'hosts'>): number {
  return audit.hosts.reduce((n, h) => n + h.gates.filter(g => !g.pass).length, 0)
}
