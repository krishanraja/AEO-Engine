/**
 * Stage 48: the cited-pages sheet, and whether each page already mentions
 * the venture.
 *
 * Ruling (Krish, 2026-11-13): AEO keeps a sheet per venture of the pages AI
 * assistants cite for its questions and checks whether each page already
 * mentions the venture; outreach from the sheet comes later, venture by
 * venture, with his yes. So the sheet starts from the pages the assistants
 * already cite, and says where the brand should appear before anyone writes
 * to anyone. AEO measures and checks: it never finds a contact, never writes
 * or sends outreach and never negotiates. The outreach columns belong to the
 * venture engines and Control Center (brief section J).
 *
 * (a) buildSheet, pure: every page cited for the venture's tracked questions,
 *     from this run's raw inline citations (packet engines, first sample) and
 *     the four weeks of probes Control Center serves (`probes_4w`). A URL is
 *     normalised (src/lib/urls.ts); one that cannot be carried (an email or a
 *     handle in it, a grounding redirect) is left out. Our own pages and the
 *     general platforms are kept and flagged, never outreach targets. Ranked
 *     by times first, times cited, questions, then URL; at most
 *     CAPS.CITED_PAGES_PER_SUBJECT rows. From the four weeks, a probe's first
 *     listed page counts as first only when it did not cite us, since its
 *     list is the pages cited that were not ours.
 *
 * (b) checkMentions: the top CAPS.MENTION_CHECKS_PER_SUBJECT outreach targets,
 *     at most CAPS.MENTION_CHECKS_PER_HOST a host, read through the fetch-only
 *     site reader (src/clients/site.ts, every rule of it: GET only, no script,
 *     public hosts, an honest User-Agent, size, time and type caps, a budget
 *     and a throttle per host), robots.txt asked first as the reader's own
 *     token and again for a same-domain redirect hop (src/pipeline/45-pages.ts,
 *     robotsAllows and getPolitely); a page the pages-cited-first read already
 *     fetched this run (itself asked of robots.txt first) is reused, never
 *     fetched again. Fresh fetches on one host come out of the subject's share
 *     of the run's per-host budget (45-pages.ts, mentionFetchesPerHost). A page
 *     links to us (an <a href> to one of the venture's domains, path-aware),
 *     else names us (a distinctive name, whole word on both sides and any case,
 *     its letters and digits compared so "Make Your Mind Up" meets
 *     makeyourmindup, or one of the venture's domains written as text), else
 *     neither. mention_ok is null when it does not mention us (a must_not
 *     phrase only matters on a page that does); else false when one of the
 *     venture's brand checks' must_not phrases is on the page (refresh
 *     needed), true when none is. No page text is kept: only these flags.
 *
 * (c) transitions: with the sheet Control Center served (`prior.cited_pages`),
 *     a page that went from none to a mention is acquired, and one whose
 *     mention went to none is lost. Without it, nothing: never guessed.
 *
 * Logs carry counts only, never a URL or a page's words.
 */
import type { CachedSite } from '../clients/site.js'
import { CAPS } from '../config/run.js'
import { hostOf, mentionsDomain, urlMatchesDomain } from '../lib/domains.js'
import { linksOf, visibleTextOf } from '../lib/html.js'
import { log } from '../lib/log.js'
import { brandNamesOf } from '../lib/names.js'
import { isGeneralPlatform } from '../lib/platforms.js'
import { classifySource, type SourceType } from '../lib/sourceType.js'
import { normaliseQuery } from '../lib/text.js'
import { normaliseUrl } from '../lib/urls.js'
import { isOutreachTarget, mentioned, MENTIONS, type CitedPageRow, type CitedPagesCounts, type Mention } from '../schema/citedPages.js'
import type { PriorProbe, PriorWeek } from '../schema/context.js'
import type { Kit } from '../schema/kit.js'
import { ENGINES_ALL, GATED_ENGINES, type Engine } from '../schema/packet.js'
import { isGroundingRedirect, type ProbeEvidence } from './40-probe.js'
import { hasPhrase, withoutUrls } from './42-brand.js'
import { carryable, getPolitely, robotsAllows, robotsFor } from './45-pages.js'

export type { CitedPageRow, CitedPagesCounts, Mention }
/** robots.txt per origin, shared with the pages-cited-first read (src/pipeline/45-pages.ts). */
export { robotsFor }

const ENGINE_ORDER: readonly string[] = [...ENGINES_ALL, ...GATED_ENGINES]

export interface SheetInput {
  /** This run's questions (the packet's), each with its words. */
  questions: ReadonlyArray<{ query_id: string; query: string }>
  /** The packet engines' evidence per question: raw inline citations, in the engine's order. */
  evidence: ReadonlyMap<string, readonly ProbeEvidence[]>
  /** The four weeks of probes Control Center serves. */
  probes4w?: readonly PriorProbe[] | null
  /** The venture's own domains, with Krish's ruled corrections applied. */
  domains: readonly string[]
  /** The engines a row may name: the packet's. */
  engines: readonly string[]
  max?: number
}

/** The sheet, and what the mention check and the kits need beside it (in memory only). */
export interface Sheet {
  rows: CitedPageRow[]
  /** Per row, the URL as an engine cited it (www and all), which is what is fetched. */
  fetchUrl: Map<string, string>
  /** Per row, the normalised words of the questions it was cited for. */
  questionsOf: Map<string, Set<string>>
}

interface Acc { host: string; fetch: string; questions: Set<string>; engines: Set<string>; cited: number; first: number }

/** Aggregates and ranks the cited pages. Pure. */
export function buildSheet(i: SheetInput): Sheet {
  const allowed = new Set(i.engines)
  const acc = new Map<string, Acc>()
  const add = (raw: string, position: number, question: string, engine: string, countsFirst: boolean, seen: Set<string>) => {
    if (isGroundingRedirect(String(raw))) return
    const c = carryable(String(raw))
    if (!c) return
    const url = normaliseUrl(c)
    if (!url || seen.has(url)) return
    seen.add(url)
    const host = hostOf(url)
    if (!host) return
    const row = acc.get(url) ?? { host, fetch: c, questions: new Set<string>(), engines: new Set<string>(), cited: 0, first: 0 }
    row.cited++
    if (position === 0 && countsFirst) row.first++
    row.questions.add(question)
    if (allowed.has(engine)) row.engines.add(engine)
    acc.set(url, row)
  }
  for (const q of i.questions) {
    const key = normaliseQuery(q.query) || q.query_id
    for (const ev of i.evidence.get(q.query_id) ?? []) {
      const seen = new Set<string>()
      ev.citations.forEach((raw, n) => add(raw, n, key, ev.engine, true, seen))
    }
  }
  for (const p of i.probes4w ?? []) {
    if (!p || !Array.isArray(p.competitors_cited)) continue
    const key = (typeof p.question === 'string' && normaliseQuery(p.question)) || String(p.query_id ?? p.id ?? '')
    if (!key) continue
    const seen = new Set<string>()
    // Its list holds the pages cited that were not ours, so its first is the answer's first only when it cited us nowhere.
    p.competitors_cited.forEach((raw, n) => add(String(raw), n, key, String(p.engine), p.we_cited === false, seen))
  }
  const rows: CitedPageRow[] = [...acc.entries()].map(([url, r]) => ({
    url,
    host: r.host.slice(0, 120),
    page_type: classifySource(r.fetch),
    questions: r.questions.size,
    engines: [...r.engines].sort((a, b) => ENGINE_ORDER.indexOf(a) - ENGINE_ORDER.indexOf(b)) as Engine[],
    times_cited: r.cited,
    times_first: r.first,
    mention: 'unchecked' as Mention,
    mention_ok: null,
    checked_at: null,
    platform: isGeneralPlatform(r.host),
    own: i.domains.some(d => urlMatchesDomain(url, d)),
  }))
  rows.sort((a, b) => b.times_first - a.times_first || b.times_cited - a.times_cited || b.questions - a.questions || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  const kept = rows.slice(0, Math.max(0, i.max ?? CAPS.CITED_PAGES_PER_SUBJECT))
  const fetchUrl = new Map<string, string>()
  const questionsOf = new Map<string, Set<string>>()
  for (const r of kept) {
    const a = acc.get(r.url)
    if (!a) continue
    fetchUrl.set(r.url, a.fetch)
    questionsOf.set(r.url, a.questions)
  }
  return { rows: kept, fetchUrl, questionsOf }
}

/** The most characters that are not letters or digits a name's letters may be split by on a page ("Make Your Mind Up", "Heart-side"). */
const NAME_GAP_MAX = 3
const escapeChar = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether the text names one of `names`: a name's letters and digits, in
 * order, as a whole word on both sides, any case, each pair of them split by
 * at most NAME_GAP_MAX characters that are neither. So "Make Your Mind Up"
 * meets makeyourmindup and the other way round, and "Heartsides" is not
 * "Heartside". URLs and bare domains are taken out first: one of the
 * venture's domains written as text counts on its own (mentionOf). Pure.
 */
export function namedOnPage(text: string, names: readonly string[]): boolean {
  const stripped = withoutUrls(text)
  return brandNamesOf(names).some(n => {
    const chars = [...n.toLowerCase()].filter(c => /[\p{L}\p{N}]/u.test(c))
    if (chars.length < 2) return false
    const body = chars.map(escapeChar).join(`[^\\p{L}\\p{N}]{0,${NAME_GAP_MAX}}`)
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu').test(stripped)
  })
}

/**
 * Whether a page mentions the venture: an <a href> to one of its domains
 * (path-aware), else a distinctive name (namedOnPage) or one of its domains
 * written as text ("heartside.io" with no link, path-aware too) in its
 * visible words, else none. Pure; the page's words are read here and never
 * kept.
 */
export function mentionOf(html: string, pageUrl: string, domains: readonly string[], names: readonly string[]): Exclude<Mention, 'unchecked'> {
  for (const href of linksOf(html)) {
    let abs: string
    try { abs = new URL(href, pageUrl).href } catch { continue }
    if (!/^https?:/i.test(abs)) continue
    if (domains.some(d => urlMatchesDomain(abs, d))) return 'link'
  }
  const text = visibleTextOf(html)
  if (namedOnPage(text, names)) return 'name'
  return domains.some(d => mentionsDomain(text, d)) ? 'name' : 'none'
}

/** Whether one of the phrases is in the page's visible words, URLs and bare domains taken out. Pure. */
export function mustNotOn(html: string, mustNot: readonly string[]): boolean {
  if (!mustNot.length) return false
  const text = withoutUrls(visibleTextOf(html))
  return mustNot.some(p => hasPhrase(text, p))
}

export interface MentionOptions {
  domains: readonly string[]
  /** The venture's distinctive names (Control Center's brand_names, else config/subjects.json's overlay). */
  names: readonly string[]
  /** Every must_not phrase of the venture's brand checks. */
  mustNot: readonly string[]
  /** The check's day, YYYY-MM-DD. */
  today: string
  max?: number
  /** Pages checked on one host, reused or fetched: at most CAPS.MENTION_CHECKS_PER_HOST. */
  perHost?: number
  /**
   * Pages fetched fresh on one host: the subject's share of the run's
   * per-host budget (45-pages.ts, mentionFetchesPerHost), at most perHost.
   * A page already read this run is reused whatever this says.
   */
  fetchPerHost?: number
  subject?: string
}

export interface MentionCounts { attempted: number; checked: number; reused: number; fetched: number; refused_robots: number; unread: number; skipped_host_budget: number }

/**
 * Reads the top outreach targets for a mention and fills their mention,
 * mention_ok and checked_at in place. `site` is the subject's cached reader:
 * a page it already holds is reused; any other is read only when robots.txt
 * leaves it open to this reader. With no reader, nothing is read.
 */
export async function checkMentions(sheet: Sheet, site: CachedSite | null, o: MentionOptions): Promise<MentionCounts> {
  const out: MentionCounts = { attempted: 0, checked: 0, reused: 0, fetched: 0, refused_robots: 0, unread: 0, skipped_host_budget: 0 }
  if (!site) return out
  const max = o.max ?? CAPS.MENTION_CHECKS_PER_SUBJECT
  const perHostMax = o.perHost ?? CAPS.MENTION_CHECKS_PER_HOST
  const fetchMax = Math.min(perHostMax, o.fetchPerHost ?? perHostMax)
  const perHost = new Map<string, number>()
  const fetchedOn = new Map<string, number>()
  for (const row of sheet.rows) {
    if (out.attempted >= max) break
    if (!isOutreachTarget(row)) continue
    if ((perHost.get(row.host) ?? 0) >= perHostMax) continue
    const url = sheet.fetchUrl.get(row.url) ?? row.url
    const reuse = site.has(url)
    // A fresh fetch only inside the subject's share of the host's budget.
    if (!reuse && (fetchedOn.get(row.host) ?? 0) >= fetchMax) { out.skipped_host_budget++; continue }
    perHost.set(row.host, (perHost.get(row.host) ?? 0) + 1)
    out.attempted++
    let page
    if (reuse) {
      page = await site.get(url)
      out.reused++
    } else {
      if (!(await robotsAllows(site, url))) { out.refused_robots++; continue }
      fetchedOn.set(row.host, (fetchedOn.get(row.host) ?? 0) + 1)
      page = await getPolitely(site, url)
      out.fetched++
    }
    if (!page || page.status < 200 || page.status >= 300 || !page.text) { out.unread++; continue }
    const m = mentionOf(page.text, page.url, o.domains, o.names)
    row.mention = m
    // A must_not phrase only matters on a page that mentions us.
    row.mention_ok = mentioned(m) ? !mustNotOn(page.text, o.mustNot) : null
    row.checked_at = o.today
    out.checked++
  }
  log('cited_pages_checked', { ...(o.subject ? { subject: o.subject } : {}), rows: sheet.rows.length, ...out })
  return out
}

export interface Transitions { acquired: Array<{ host: string; page_type: SourceType }>; lost: Array<{ host: string; page_type: SourceType }> }

/**
 * Mentions acquired and lost since the sheet Control Center served, by
 * normalised URL: none to a link or the name is acquired; a link or the name
 * to none is lost. A row not read this run, or one the served sheet does not
 * hold, moves nothing. Null when no sheet was served: never guessed.
 */
export function transitions(rows: readonly CitedPageRow[], prior: PriorWeek['cited_pages'] | null | undefined): Transitions | null {
  if (!Array.isArray(prior)) return null
  const before = new Map<string, Mention>()
  for (const p of prior) {
    if (!p || typeof p.url !== 'string' || !(MENTIONS as readonly unknown[]).includes(p.mention)) continue
    const k = normaliseUrl(p.url)
    if (k) before.set(k, p.mention as Mention)
  }
  const out: Transitions = { acquired: [], lost: [] }
  for (const r of rows) {
    const was = before.get(r.url)
    if (was === undefined) continue
    if (was === 'none' && mentioned(r.mention)) out.acquired.push({ host: r.host, page_type: r.page_type })
    if (mentioned(was) && r.mention === 'none') out.lost.push({ host: r.host, page_type: r.page_type })
  }
  return out
}

const byType = (list: Transitions['acquired']): Partial<Record<SourceType, number>> => {
  const out: Partial<Record<SourceType, number>> = {}
  for (const x of list) out[x.page_type] = (out[x.page_type] ?? 0) + 1
  return out
}

/**
 * The sheet in counts, for the sealed summary and the report. `since` is the
 * research week of the sheet Control Center served (`prior.week_start`), so
 * the report says which sheet a mention moved against; kept only beside a
 * transition and only as YYYY-MM-DD.
 */
export function sheetCounts(rows: readonly CitedPageRow[], checks: Pick<MentionCounts, 'reused'> | null, moved: Transitions | null, since: string | null = null): CitedPagesCounts {
  const targets = rows.filter(isOutreachTarget)
  return {
    rows: rows.length,
    own: rows.filter(r => r.own).length,
    platform: rows.filter(r => r.platform).length,
    targets: targets.length,
    checked: rows.filter(r => r.checked_at !== null).length,
    reused: checks?.reused ?? 0,
    link: rows.filter(r => r.mention === 'link').length,
    name: rows.filter(r => r.mention === 'name').length,
    none: rows.filter(r => r.mention === 'none').length,
    mention_ok_false: rows.filter(r => r.mention_ok === false).length,
    to_check: targets.filter(r => !mentioned(r.mention)).length,
    ...(moved ? { acquired: byType(moved.acquired), lost: byType(moved.lost) } : {}),
    ...(moved && typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since) ? { since } : {}),
  }
}

/**
 * A kit's off-site places with what the sheet knows of them: for each host,
 * the pages on it cited for the kit's question and read this run. Any that
 * links to us makes it a link, else any that names us a name, else none;
 * mention_ok is false when any of them carries a must_not phrase, true when
 * one mentions us and none does, else null. A host none of whose pages was
 * read is left as it was. Pure; returns new kits.
 */
export function annotateOffSite(kits: readonly Kit[], sheet: Sheet, questionWords: ReadonlyMap<string, string>): Kit[] {
  return kits.map(k => {
    const norm = questionWords.get(k.query_id) ?? normaliseQuery(k.question)
    const off_site = k.off_site.map(o => {
      const rows = sheet.rows.filter(r => r.host === o.host && r.mention !== 'unchecked' && sheet.questionsOf.get(r.url)?.has(norm))
      if (!rows.length) return { ...o }
      const mention: Mention = rows.some(r => r.mention === 'link') ? 'link' : rows.some(r => r.mention === 'name') ? 'name' : 'none'
      const mention_ok = rows.some(r => r.mention_ok === false) ? false : mentioned(mention) ? true : null
      return { ...o, mention, mention_ok }
    })
    return { ...k, off_site }
  })
}
