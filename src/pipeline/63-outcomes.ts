/**
 * Stage 63: outcomes. When Control Center serves a subject's search signals
 * (`subject.search_signals`, brief section C: Search Console rows, Bing URL
 * information, and AI-assistant referrals from GA4 and from Clarity), each
 * answer page a venture shipped or a kit targets is read against them, over
 * the last CAPS.OUTCOME_WINDOW_DAYS days:
 *
 * - Search Console: impressions, clicks and the average position (weighted by
 *   impressions) of the queries whose page is that URL, and the same for the
 *   window before the page shipped when its shipping day is known. A row
 *   belongs to the window that holds its last day (date_to); one that runs
 *   across the shipping day (from before it to on or after it) belongs to
 *   neither window, since it mixes the two.
 * - Bing: whether the URL is indexed, and when it was last crawled.
 * - AI referrals: sessions to that landing page from an AI assistant, GA4's
 *   and Clarity's apart (`via`), never summed, because they count
 *   differently.
 *
 * Missing is unknown, never zero: a signal Control Center did not serve, or
 * served empty, is null; a Search Console list that holds no row on the
 * page's host does not cover it, and is null for that page too; the window
 * before shipping is null unless a row on the page's host starts (date_from)
 * on or before that window's first day, since rows that start later say
 * nothing of its early days; a Bing list with no row for the URL is null; a
 * referral list (GA4's or Clarity's) with no row on the page's host is null
 * for that page. Only a signal that covers the page and holds no row for it
 * in the window reads as zero. Joins are on the normalised URL
 * (src/lib/urls.ts, pageKey). A landing page given as a bare path names no
 * host, so it is read only against the venture's own hosts (its domains with
 * no path): it meets each of our pages with that path, once a page, and is
 * counted once in the venture's total however many of our hosts it meets.
 *
 * Pure. Counts and URLs of our own pages only; never a log line but counts.
 */
import { CAPS } from '../config/run.js'
import { hostOf, splitDomain, urlMatchesDomain } from '../lib/domains.js'
import { pageKey } from '../lib/urls.js'
import type { SearchSignals, ShippedDeclaration } from '../schema/context.js'
import type { Kit } from '../schema/kit.js'
import type { OutcomeCounts } from '../schema/outcome.js'
import type { GscWindow, PacketOutcome } from '../schema/packet.js'
import { shippedFor } from './55-panel.js'

export type { OutcomeCounts, PacketOutcome }

const DAY_MS = 86_400_000
const YMD_RE = /^\d{4}-\d{2}-\d{2}/
const ymd = (d: Date) => d.toISOString().slice(0, 10)

/** A date as YYYY-MM-DD, or null: a YYYY-MM-DD prefix is taken as written, anything else parsed. */
export function dayOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const m = YMD_RE.exec(v.trim())
  if (m && !Number.isNaN(Date.parse(`${m[0]}T00:00:00Z`))) return m[0]
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : ymd(new Date(t))
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** A Search Console row: `from` and `to` its first and last day (each the other when only one was given). */
interface GscRow { key: string; host: string; impressions: number; clicks: number; position: number | null; from: string; to: string }
/** A referral row: a full URL (`key` and `host`), or a bare path (`path`, no host). */
interface RefRow { key: string | null; host: string | null; path: string | null; sessions: number; day: string }

/** The signals, read loosely: a row of the wrong shape is dropped; a list absent or empty is unknown (null). */
export interface Signals {
  gsc: GscRow[] | null
  bing: Map<string, { indexed: boolean | null; last_crawled: string | null }> | null
  ga4: RefRow[] | null
  clarity: RefRow[] | null
}

export const NO_SIGNALS: Signals = { gsc: null, bing: null, ga4: null, clarity: null }

function refRow(r: Record<string, unknown>): RefRow | null {
  const sessions = count(r.sessions)
  const day = dayOf(r.date)
  const lp = typeof r.landing_page === 'string' ? r.landing_page.trim() : ''
  if (sessions === null || !day || !lp) return null
  if (lp.startsWith('/')) return { key: null, host: null, path: lp.split(/[?#]/)[0].replace(/\/+$/, '') || '/', sessions, day }
  const key = pageKey(lp)
  const host = hostOf(lp)
  return key && host ? { key, host, path: null, sessions, day } : null
}

export function readSignals(raw: SearchSignals | null | undefined): Signals {
  if (!raw || typeof raw !== 'object') return NO_SIGNALS
  const rec = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null)
  let gsc: GscRow[] | null = null
  if (Array.isArray(raw.gsc_queries) && raw.gsc_queries.length) {
    gsc = []
    for (const x of raw.gsc_queries) {
      const r = rec(x)
      if (!r || typeof r.page !== 'string') continue
      const key = pageKey(r.page)
      const impressions = count(r.impressions)
      const clicks = count(r.clicks)
      const to = dayOf(r.date_to) ?? dayOf(r.date_from)
      const from = dayOf(r.date_from) ?? to
      if (!key || impressions === null || clicks === null || !to || !from) continue
      const position = count(r.position)
      gsc.push({ key, host: hostOf(r.page), impressions, clicks, position: position && position > 0 ? position : null, from: from <= to ? from : to, to: from <= to ? to : from })
    }
  }
  let bing: Signals['bing'] = null
  const info = rec(raw.bing)?.url_info
  if (Array.isArray(info) && info.length) {
    bing = new Map()
    for (const x of info) {
      const r = rec(x)
      const key = r && typeof r.url === 'string' ? pageKey(r.url) : null
      if (!r || !key) continue
      bing.set(key, { indexed: typeof r.indexed === 'boolean' ? r.indexed : null, last_crawled: dayOf(r.last_crawled) })
    }
  }
  const lists: { ga4: RefRow[]; clarity: RefRow[] } = { ga4: [], clarity: [] }
  let ga4Served = false
  let claritySeen = false
  if (Array.isArray(raw.ai_referrals)) {
    for (const x of raw.ai_referrals) {
      const r = rec(x)
      if (!r || (r.via !== 'ga4' && r.via !== 'clarity')) continue
      const row = refRow(r)
      if (!row) continue
      if (r.via === 'ga4') { ga4Served = true; lists.ga4.push(row) } else { claritySeen = true; lists.clarity.push(row) }
    }
  }
  // The first shape the brief named: GA4 rows only.
  if (Array.isArray(raw.ga4_ai_referrals)) {
    for (const x of raw.ga4_ai_referrals) {
      const r = rec(x)
      const row = r ? refRow(r) : null
      if (row) { ga4Served = true; lists.ga4.push(row) }
    }
  }
  return { gsc: gsc && gsc.length ? gsc : null, bing: bing && bing.size ? bing : null, ga4: ga4Served ? lists.ga4 : null, clarity: claritySeen ? lists.clarity : null }
}

/** The window of `days` days ending on `end` (inclusive), as YYYY-MM-DD. */
export function windowEnding(end: Date, days: number = CAPS.OUTCOME_WINDOW_DAYS): { from: string; to: string } {
  return { from: ymd(new Date(end.getTime() - (days - 1) * DAY_MS)), to: ymd(end) }
}

const inWindow = (day: string, w: { from: string; to: string }) => day >= w.from && day <= w.to

/** Whether a row runs across the shipping day: it starts before it and ends on or after it. */
const straddles = (r: Pick<GscRow, 'from' | 'to'>, shipped: string | null) => !!shipped && r.from < shipped && r.to >= shipped

function gscWindow(rows: readonly GscRow[], key: string, w: { from: string; to: string }, shipped: string | null): GscWindow {
  let impressions = 0
  let clicks = 0
  let weighted = 0
  for (const r of rows) {
    if (r.key !== key || !inWindow(r.to, w) || straddles(r, shipped)) continue
    impressions += r.impressions
    clicks += r.clicks
    if (r.position !== null) weighted += r.position * r.impressions
  }
  return { impressions: Math.round(impressions), clicks: Math.round(clicks), position: impressions > 0 && weighted > 0 ? Math.round((weighted / impressions) * 10) / 10 : null, from: w.from, to: w.to }
}

/** A tracked page as the referral joins read it: its key, host and path, and whether it is on one of the venture's own hosts. */
interface PageRef { key: string; host: string; path: string; ours: boolean }

/** Whether a URL is on one of the venture's own hosts: a domain with no path (a profile on someone else's platform is not a host of ours). */
export function onOwnHost(url: string, own: readonly string[]): boolean {
  return own.some(d => !splitDomain(d).path && urlMatchesDomain(url, d))
}

function pageRef(url: string, own: readonly string[]): PageRef {
  let path = '/'
  try { path = new URL(url).pathname.replace(/\/+$/, '') || '/' } catch { /* keep / */ }
  return { key: pageKey(url) ?? url, host: hostOf(url), path, ours: onOwnHost(url, own) }
}

/** Whether a referral row lands on the page: the same URL, or a bare path on one of our own pages. */
const lands = (r: RefRow, p: PageRef) => (r.key !== null && r.key === p.key) || (r.path !== null && p.ours && r.path === p.path)

/** Whether a referral list says anything of the page's host: a row on it, or a bare-path row when the page is ours. */
const covers = (rows: readonly RefRow[], p: PageRef) => rows.some(r => (r.host !== null && r.host === p.host) || (r.path !== null && p.ours))

function sessions(rows: readonly RefRow[] | null, p: PageRef, w: { from: string; to: string }): number | null {
  if (!rows || !covers(rows, p)) return null
  let n = 0
  for (const r of rows) if (inWindow(r.day, w) && lands(r, p)) n += r.sessions
  return Math.round(n)
}

/**
 * One page's outcome. `shippedAt`, when known, gives the window before it
 * shipped. `own` is the venture's domains: a bare-path referral row meets
 * only a page on one of them.
 */
export function outcomeFor(url: string, shippedAt: string | null, s: Signals, now: Date, own: readonly string[] = [], days: number = CAPS.OUTCOME_WINDOW_DAYS): PacketOutcome {
  const page = pageRef(url, own)
  const key = page.key
  const w = windowEnding(now, days)
  const host = page.host
  let gsc: PacketOutcome['gsc'] = null
  if (s.gsc && s.gsc.some(r => r.host === host)) {
    const shipped = dayOf(shippedAt)
    const before = shipped ? windowEnding(new Date(Date.parse(`${shipped}T00:00:00Z`) - DAY_MS), days) : null
    // The window before shipping is measured only when the rows reach back to its first day.
    const reaches = !!before && s.gsc.some(r => r.host === host && r.from <= before.from)
    gsc = { ...gscWindow(s.gsc, key, w, shipped), before: before && reaches ? gscWindow(s.gsc, key, before, shipped) : null }
  }
  const b = s.bing?.get(key) ?? null
  const ga4 = sessions(s.ga4, page, w)
  const clarity = sessions(s.clarity, page, w)
  return {
    url: url.slice(0, 500),
    gsc,
    bing: b ? { indexed: b.indexed, last_crawled: b.last_crawled } : null,
    ai_referrals: ga4 === null && clarity === null ? null : { from: w.from, to: w.to, ga4, clarity },
  }
}

/** Whether any part of an outcome is known. */
export const known = (o: PacketOutcome): boolean => o.gsc !== null || o.bing !== null || o.ai_referrals !== null

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The kit's evidence line for an outcome, counts only and no URL, at most 200 characters; null when nothing is known. */
export function outcomeLine(o: PacketOutcome, days: number = CAPS.OUTCOME_WINDOW_DAYS): string | null {
  if (!known(o)) return null
  const parts: string[] = []
  if (o.gsc) {
    parts.push(`Search Console ${plural(o.gsc.impressions, 'impression')}, ${plural(o.gsc.clicks, 'click')}${o.gsc.position !== null ? `, position ${o.gsc.position}` : ''}`)
    if (o.gsc.before) parts.push(`before it shipped ${plural(o.gsc.before.impressions, 'impression')}, ${plural(o.gsc.before.clicks, 'click')}`)
  }
  if (o.bing) parts.push(`Bing ${o.bing.indexed === null ? 'index unknown' : o.bing.indexed ? 'indexed' : 'not indexed'}${o.bing.last_crawled ? `, crawled ${o.bing.last_crawled}` : ''}`)
  if (o.ai_referrals) {
    const r = o.ai_referrals
    parts.push(`AI referrals ${[r.ga4 !== null ? `GA4 ${r.ga4}` : null, r.clarity !== null ? `Clarity ${r.clarity}` : null].filter(Boolean).join(', ')}`)
  }
  return `outcome, last ${days} days: ${parts.join('; ')}`.slice(0, 200)
}

export interface OutcomeTarget { url: string; shipped_at: string | null; from: 'shipped' | 'kit' }

/**
 * The answer page each question is tracked on: the page the venture said it
 * shipped for it, else the page its kit targets (when the kit names one).
 * Pure.
 */
export function outcomeTargets(
  queries: ReadonlyArray<{ query_id: string; query: string; norm?: string }>,
  shipped: readonly ShippedDeclaration[],
  kits: readonly Pick<Kit, 'query_id' | 'target'>[],
  normOf: (q: string) => string,
): Map<string, OutcomeTarget> {
  const out = new Map<string, OutcomeTarget>()
  for (const q of queries) {
    const s = shippedFor({ query_id: q.query_id, norm: q.norm ?? normOf(q.query) }, shipped)
    if (s) { out.set(q.query_id, { url: s.url, shipped_at: s.shipped_at, from: 'shipped' }); continue }
    const k = kits.find(x => x.query_id === q.query_id && x.target.url)
    if (k?.target.url) out.set(q.query_id, { url: k.target.url, shipped_at: null, from: 'kit' })
  }
  return out
}

/** Every tracked page's outcome, by question. `own` as in outcomeFor. */
export function outcomesFor(targets: ReadonlyMap<string, OutcomeTarget>, s: Signals, now: Date, own: readonly string[] = []): Map<string, PacketOutcome> {
  const out = new Map<string, PacketOutcome>()
  for (const [qid, t] of targets) out.set(qid, outcomeFor(t.url, t.shipped_at, s, now, own))
  return out
}

/**
 * The subject's outcomes in counts, each page once (two questions may share
 * a page). A referral total counts each row once, so a bare path that meets
 * pages on two of our hosts is never doubled; it is unknown (null) when no
 * tracked page is covered, never zero.
 */
export function outcomeCounts(outcomes: ReadonlyMap<string, PacketOutcome>, s: Signals, own: readonly string[] = [], days: number = CAPS.OUTCOME_WINDOW_DAYS): OutcomeCounts {
  const byPage = new Map<string, PacketOutcome>()
  for (const o of outcomes.values()) byPage.set(pageKey(o.url) ?? o.url, o)
  const pages = [...byPage.values()]
  const refs = (k: 'ga4' | 'clarity') => {
    const rows = s[k]
    if (!rows) return null
    const known = pages.filter(p => typeof p.ai_referrals?.[k] === 'number')
    if (!known.length) return null
    const refsOf = known.map(p => pageRef(p.url, own))
    const w = { from: known[0].ai_referrals?.from ?? '', to: known[0].ai_referrals?.to ?? '' }
    const total = rows.filter(r => inWindow(r.day, w) && refsOf.some(p => lands(r, p))).reduce((n, r) => n + r.sessions, 0)
    return { sessions: Math.round(total), pages: known.filter(p => (p.ai_referrals?.[k] ?? 0) > 0).length }
  }
  const gscPages = pages.filter(p => p.gsc)
  return {
    served: { gsc: !!s.gsc, bing: !!s.bing, ga4: !!s.ga4, clarity: !!s.clarity },
    pages: pages.length,
    ga4: refs('ga4'),
    clarity: refs('clarity'),
    gsc: s.gsc ? { impressions: gscPages.reduce((n, p) => n + (p.gsc?.impressions ?? 0), 0), clicks: gscPages.reduce((n, p) => n + (p.gsc?.clicks ?? 0), 0), pages: gscPages.filter(p => (p.gsc?.impressions ?? 0) > 0).length } : null,
    days,
  }
}
