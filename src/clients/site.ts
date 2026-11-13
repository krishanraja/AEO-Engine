/**
 * The site reader: how this engine reads a web page, and the only way it does.
 *
 * During research for this phase a headless browser render of the venture
 * sites fired their tracking pixels. So this reader fetches, and does nothing
 * else:
 *
 * - GET only, and never a script run: no browser, no DOM, no JavaScript
 *   (check:config refuses browser automation packages). The bytes the server
 *   sends are what an assistant's own fetcher reads.
 * - `redirect: 'manual'`: a 3xx is followed here, at most SITE_MAX_HOPS hops,
 *   and only on the registrable domain the request started on.
 * - Text only (HTML, XML, plain, Markdown, JSON). A path that names a script,
 *   a stylesheet, an image, a font or a file is never requested, and a
 *   response of another type is refused unread.
 * - A body cap (SITE_MAX_BYTES) and a deadline (SITE_TIMEOUT_MS).
 * - Per host: at most SITE_MAX_REQUESTS_PER_HOST requests in a process, at
 *   least SITE_MIN_GAP_MS apart, each one counted; a host that fails
 *   SITE_MAX_ERRORS_PER_HOST times in a row is read no further. A request's
 *   slot (its count and its start time) is reserved before it waits, so calls
 *   made at once to one host still go one gap apart and never past the budget.
 *   Our own hosts are read once per research run, in its site job
 *   (src/site.ts), so the budget is the run's, not each subject job's.
 * - Public web hosts only, on every hop: never an IP literal, localhost, a
 *   single-label or local name (.local, .internal, .lan, .home.arpa), and never
 *   a port other than the scheme's own. A page cited first is a URL an engine
 *   gave, and the runner is not a way into anything.
 * - An honest User-Agent naming this engine and this repository. It never
 *   poses as a crawler: robots.txt is read as itself and resolved per bot.
 *
 * Counts leave this file, never a URL or a page's text: callers log stats().
 *
 * OfflineSite is the twin the fixtures run on: tests/fixtures/site/<sha8(url)>.json
 * holds { status, headers, text } for one URL, read through the same budget,
 * hops and type rules. No test touches the network.
 */
import { CAPS } from '../config/run.js'
import { sha8 } from '../lib/text.js'
import { asArray, asRecord, asString, isTextType, requestText } from './http.js'
import { readFixture } from './offline.js'
import { MissingFixture } from './types.js'

/** Who is asking, said plainly. Never a crawler's name and never a browser's. */
export const SITE_USER_AGENT = 'AEO-Engine/1.0 (+https://github.com/krishanraja/AEO-Engine; fetch-only audit)'

/** The reader's rules in one place, which check:config reads. */
export const SITE_FETCH = {
  method: 'GET',
  redirect: 'manual',
  maxHops: CAPS.SITE_MAX_HOPS,
  timeoutMs: CAPS.SITE_TIMEOUT_MS,
  maxBytes: CAPS.SITE_MAX_BYTES,
  minGapMs: CAPS.SITE_MIN_GAP_MS,
  maxPerHost: CAPS.SITE_MAX_REQUESTS_PER_HOST,
  maxErrorsPerHost: CAPS.SITE_MAX_ERRORS_PER_HOST,
} as const

const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,text/markdown;q=0.8,application/json;q=0.7'

/** A path this reader never requests: scripts, styles, images, fonts, media and files. */
export const ASSET_PATH = /\.(js|mjs|cjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|m4a|mp3|wav|ogg|pdf|zip|gz|tgz|rar|7z|dmg|exe|wasm|json\.gz)$/i

export interface SitePage {
  status: number
  /** Lower-cased: content-type, location, x-robots-tag and last-modified, when sent. */
  headers: Record<string, string>
  text: string
  /** The URL that answered, after any redirect. */
  url: string
}

export interface SiteStats { requests: number; refused: number; errors: number; hosts: number }

export interface SiteFetcher {
  /**
   * One text resource. Null when it is not read: the budget is spent, the
   * path is an asset, the type is not text, a redirect leaves the domain or
   * passes the hop limit, or the request failed. A 4xx or 5xx comes back
   * with its status. Never throws, except MissingFixture from a strict
   * offline twin.
   */
  get(url: string): Promise<SitePage | null>
  /** Counts only. */
  stats(): SiteStats
}

/** One request as a transport makes it: no redirect followed, headers lower-cased. */
export type Transport = (url: string, headers: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; text: string }>

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const REAL_CLOCK: Clock = { now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)) }

/** Public suffixes of two labels that this reader meets; anything else is read as one label. */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'co.in', 'co.za', 'com.sg', 'com.hk', 'co.kr', 'com.tr', 'com.cn', 'co.il'])

/** The registrable domain of a host, without a public suffix list: the last two labels, or three under a known two-label suffix. */
export function registrableDomain(host: string): string {
  const h = String(host || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  if (/^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return h
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  return TWO_LABEL_SUFFIXES.has(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}

const webUrl = (u: URL): boolean => (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password

/** Names that never reach the public web: a local or internal zone, or a reserved one. */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'intranet', 'corp', 'home.arpa', 'arpa']

/**
 * A host on the public web: a dotted name with a top-level label that is not
 * all digits, never an IP literal (v4 in any form the URL parser accepts, or
 * v6), localhost, a single label, or a private zone; and no port but the
 * scheme's own (the parser drops an explicit :443 or :80, so any port left is
 * another). This reader resolves no name, so it judges by the name alone.
 */
export function publicWebUrl(u: URL): boolean {
  if (!webUrl(u) || u.port !== '') return false
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!h || h.includes(':') || h.startsWith('[')) return false
  const labels = h.split('.')
  if (labels.length < 2 || labels.some(l => !l)) return false
  if (/^\d+$/.test(labels[labels.length - 1]) || /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i.test(h)) return false
  return !PRIVATE_SUFFIXES.some(sfx => h === sfx || h.endsWith(`.${sfx}`))
}
const isAsset = (u: URL): boolean => ASSET_PATH.test(u.pathname)

const KEEP_HEADERS = ['content-type', 'location', 'x-robots-tag', 'last-modified']
function pick(h: Headers | Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of KEEP_HEADERS) {
    const v = h instanceof Headers ? h.get(k) : (h as Record<string, unknown>)[k] ?? Object.entries(h).find(([x]) => x.toLowerCase() === k)?.[1]
    if (typeof v === 'string' && v) out[k] = v.slice(0, 1000)
  }
  return out
}

export interface BudgetOptions { clock?: Clock; maxPerHost?: number; minGapMs?: number; maxHops?: number; maxErrorsPerHost?: number }

/** The rules every reader keeps, over any transport. */
export class BudgetedSite implements SiteFetcher {
  private readonly perHost = new Map<string, number>()
  /** The earliest start the host's next request may have: reserved synchronously, before any wait. */
  private readonly nextAt = new Map<string, number>()
  private readonly failing = new Map<string, number>()
  private requests = 0
  private refused = 0
  private errors = 0
  private readonly clock: Clock
  private readonly maxPerHost: number
  private readonly minGapMs: number
  private readonly maxHops: number
  private readonly maxErrors: number

  constructor(private readonly transport: Transport, o: BudgetOptions = {}) {
    this.clock = o.clock ?? REAL_CLOCK
    this.maxPerHost = o.maxPerHost ?? SITE_FETCH.maxPerHost
    this.minGapMs = o.minGapMs ?? SITE_FETCH.minGapMs
    this.maxHops = o.maxHops ?? SITE_FETCH.maxHops
    this.maxErrors = o.maxErrorsPerHost ?? SITE_FETCH.maxErrorsPerHost
  }

  stats(): SiteStats {
    return { requests: this.requests, refused: this.refused, errors: this.errors, hosts: this.perHost.size }
  }

  private refuse(): null { this.refused++; return null }

  async get(url: string): Promise<SitePage | null> {
    let current: URL
    try { current = new URL(url) } catch { return this.refuse() }
    if (!publicWebUrl(current) || isAsset(current)) return this.refuse()
    current.hash = ''
    const origin = registrableDomain(current.hostname)
    for (let hop = 0; ; hop++) {
      const host = current.hostname.toLowerCase()
      if ((this.perHost.get(host) ?? 0) >= this.maxPerHost || (this.failing.get(host) ?? 0) >= this.maxErrors) return this.refuse()
      // Reserve this request's place before waiting: its count, and a start
      // one gap after the last reserved start. Nothing awaits between the
      // check and the reservation, so concurrent calls cannot share a slot.
      const now = this.clock.now()
      const at = Math.max(now, this.nextAt.get(host) ?? now)
      this.nextAt.set(host, at + this.minGapMs)
      this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1)
      this.requests++
      if (at > now) await this.clock.sleep(at - now)
      let res: Awaited<ReturnType<Transport>>
      try {
        res = await this.transport(current.href, { 'user-agent': SITE_USER_AGENT, accept: ACCEPT })
      } catch (e) {
        if (e instanceof MissingFixture) throw e
        this.errors++
        this.failing.set(host, (this.failing.get(host) ?? 0) + 1)
        return null
      }
      this.failing.set(host, 0)
      const location = res.headers.location
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= this.maxHops) return this.refuse()
        let next: URL
        try { next = new URL(location, current) } catch { return this.refuse() }
        if (!publicWebUrl(next) || isAsset(next) || registrableDomain(next.hostname) !== origin) return this.refuse()
        next.hash = ''
        current = next
        continue
      }
      if (!isTextType(res.headers['content-type'])) {
        // An error page of another type still says its status; a 2xx of another type is refused unread.
        if (res.status >= 200 && res.status < 300) return this.refuse()
        return { status: res.status, headers: res.headers, text: '', url: current.href }
      }
      return { status: res.status, headers: res.headers, text: res.text, url: current.href }
    }
  }
}

export interface LiveSiteOptions extends BudgetOptions { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number }

/** The live reader: global fetch (or one a test injects), through requestText, which never follows a redirect itself. */
export class LiveSite extends BudgetedSite {
  constructor(o: LiveSiteOptions = {}) {
    super(async (url, headers) => {
      const r = await requestText(url, { timeoutMs: o.timeoutMs ?? SITE_FETCH.timeoutMs, maxBytes: o.maxBytes ?? SITE_FETCH.maxBytes, headers, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) })
      return { status: r.status, headers: pick(r.headers), text: r.text }
    }, o)
  }
}

/**
 * The offline twin. A missing fixture throws MissingFixture when strict;
 * otherwise it reads as a failed request (the URL is unavailable). No throttle
 * by default: fixtures have no host to be polite to.
 */
export class OfflineSite extends BudgetedSite {
  constructor(dir: string, o: BudgetOptions & { strict?: boolean } = {}) {
    super(async url => {
      let raw: unknown
      try {
        raw = readFixture(dir, `site/${sha8(url)}.json`, `site page ${url}`)
      } catch (e) {
        if (e instanceof MissingFixture && o.strict) throw e
        throw new Error('site_fixture_unavailable')
      }
      const j = asRecord(raw)
      const status = typeof j.status === 'number' ? j.status : 0
      return { status, headers: pick(asRecord(j.headers)), text: asString(j.text) || asArray(j.lines).map(String).join('\n') }
    }, { minGapMs: 0, ...o })
  }
}

/** The fixture file a URL maps to (tests/fixtures/site/<this>.json). */
export const siteFixtureName = (url: string): string => `${sha8(new URL(url).href)}.json`
