/**
 * Stage 45: pages.
 *
 * (a) matchPages: for each tracked question, our best page from the site
 *     audit, by the share of the question's distinctive words in the page's
 *     title and H1. A word is not distinctive when it is filler (much, own,
 *     need, best...), "ai", or in more than half of the subject's questions,
 *     because a word every question shares matches every page. Below
 *     CAPS.PAGE_MATCH_MIN, or with fewer than two distinctive words matched
 *     (one, when the question has only one), no page of ours answers it.
 *
 * (b) The pages cited first. For each question, each engine's first inline
 *     citation that is not ours (raw order, before the packet's cleaning), in
 *     engine order: the first is the question's first-cited page. A first
 *     citation whose URL carries an email or a handle is still the first:
 *     its host and type are kept with no URL, and it is never read; one that
 *     is a grounding redirect hides its source, so that engine has no
 *     first-cited page, and the next source is never promoted. Pages are read
 *     fetch only, deduped across questions, at most
 *     THIRD_PARTY_MAX_PAGES_PER_SUBJECT a subject and
 *     THIRD_PARTY_MAX_PAGES_PER_HOST a host, the highest-priority questions
 *     first, and never their links. A video or a forum thread is typed and not
 *     read: its shape is the platform's, not the page's. Logs carry counts.
 */
import type { SiteFetcher } from '../clients/site.js'
import { CAPS } from '../config/run.js'
import { hostOf, urlMatchesDomain } from '../lib/domains.js'
import { extractPage, type PageFacts } from '../lib/html.js'
import { log } from '../lib/log.js'
import { classifySource, type SourceType } from '../lib/sourceType.js'
import { tokensOf } from '../lib/text.js'
import type { ProbeEngine } from '../schema/packet.js'
import { ANSWER_FIRST_MAX_WORDS, SERVER_RENDERED_MIN_WORDS, type AuditPage } from './15-site.js'
import { cleanCitation, isGroundingRedirect, type ProbeEvidence } from './40-probe.js'

export interface PageMatch { query_id: string; alignment: number; our_best_url: string | null; page: AuditPage | null }

/** Words that say little about what a question is about: question filler, and "ai", which nearly every question here carries. */
export const GENERIC_WORDS: ReadonlySet<string> = new Set([
  'ai', 'why', 'when', 'where', 'who', 'whom', 'whose', 'there', 'their', 'them', 'they', 'about', 'any', 'some', 'much', 'many', 'own',
  'more', 'most', 'other', 'all', 'just', 'not', 'no', 'if', 'so', 'get', 'make', 'need', 'use', 'using', 'way', 'best', 'good', 'really',
])

/** tokensOf, with a trailing plural s taken off, so "posts" meets "post". */
function stems(s: string): Set<string> {
  return new Set(tokensOf(s).map(t => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)))
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** The share of the question's words (stop words out) found in the text, 0 to 1. */
export function alignmentOf(question: string, text: string): number {
  const q = stems(question)
  if (!q.size) return 0
  const t = stems(text)
  let n = 0
  for (const w of q) if (t.has(w)) n++
  return round2(n / q.size)
}

/**
 * The words that are not distinctive for this set of questions: the fixed
 * filler, plus any word in more than half of them when there are at least
 * four (a venture's own subject word, which every question carries).
 */
export function genericWordsFor(questions: readonly string[]): Set<string> {
  const out = new Set(GENERIC_WORDS)
  if (questions.length < 4) return out
  const df = new Map<string, number>()
  for (const q of questions) for (const w of stems(q)) df.set(w, (df.get(w) ?? 0) + 1)
  for (const [w, n] of df) if (n * 2 > questions.length) out.add(w)
  return out
}

/** How well a page's title and H1 cover a question's distinctive words: the share matched, and how many. */
export function matchScore(question: string, text: string, generic: ReadonlySet<string>): { alignment: number; matched: number; distinct: number } {
  const q = [...stems(question)].filter(w => !generic.has(w))
  if (!q.length) return { alignment: 0, matched: 0, distinct: 0 }
  const t = stems(text)
  const matched = q.filter(w => t.has(w)).length
  return { alignment: round2(matched / q.length), matched, distinct: q.length }
}

/** Our best page per question. Only pages that answered 2xx are candidates; ties keep the audit's order. */
export function matchPages(queries: ReadonlyArray<{ query_id: string; query: string }>, pages: readonly AuditPage[], min: number = CAPS.PAGE_MATCH_MIN): Map<string, PageMatch> {
  const live = pages.filter(p => p.status >= 200 && p.status < 300)
  const generic = genericWordsFor(queries.map(q => q.query))
  const out = new Map<string, PageMatch>()
  for (const q of queries) {
    let best: AuditPage | null = null
    let score = { alignment: 0, matched: 0, distinct: 0 }
    for (const p of live) {
      const m = matchScore(q.query, `${p.title ?? ''} ${p.h1 ?? ''}`, generic)
      if (m.alignment > score.alignment || (m.alignment === score.alignment && m.matched > score.matched)) { score = m; best = p }
    }
    const ok = !!best && score.alignment >= min && score.matched >= Math.min(2, score.distinct)
    out.set(q.query_id, { query_id: q.query_id, alignment: score.alignment, our_best_url: ok ? best!.url : null, page: ok ? best : null })
  }
  return out
}

export interface CitedFeatures {
  /** Null when the cited URL carries an email or a handle: the host and type are kept, the URL is not. */
  url: string | null
  host: string
  source_type: SourceType
  /** Whether the page was read. When false, every feature below is null. */
  read: boolean
  /** Half or more of the question's words are in the page's title. */
  title_matches_question: boolean | null
  /** Words in the first paragraph under its H1. */
  answer_first_words: number | null
  words: number | null
  h2_count: number | null
  dated: boolean | null
  server_rendered: boolean | null
}

/** `url` is null when the page cited first cannot be carried (an email or a handle in it); such an entry is never read. */
export interface CitedEntry { engine: ProbeEngine; position: number; url: string | null; host: string; source_type: SourceType; features: CitedFeatures }

const unread = (url: string | null, host: string, source_type: SourceType): CitedFeatures => ({ url, host, source_type, read: false, title_matches_question: null, answer_first_words: null, words: null, h2_count: null, dated: null, server_rendered: null })

/** Third-party pages a subject may read on one host: at most THIRD_PARTY_MAX_PAGES_PER_HOST, and fewer when a run's subjects together would pass the per-host budget. */
export function thirdPartyPerHost(subjects: number): number {
  return Math.max(1, Math.min(CAPS.THIRD_PARTY_MAX_PAGES_PER_HOST, Math.floor(CAPS.SITE_MAX_REQUESTS_PER_HOST / Math.max(1, subjects))))
}

/** A URL a kit may name: http(s), no email or handle, no redirect token; its href normalised (ASCII). */
export function carryable(u: string): string | null {
  const c = cleanCitation(u)
  if (!c) return null
  try {
    const x = new URL(c)
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null
    x.hash = ''
    return x.href.slice(0, 500)
  } catch { return null }
}

/**
 * One engine's first inline citation that is not ours, with its 1-based
 * position in the raw list. Its URL is null when it cannot be carried (an
 * email or a handle in it), its host kept. A grounding redirect, or a URL
 * with no host, hides the source: that engine then has no first-cited page.
 * The next citation is never promoted to first.
 */
export function firstNotOurs(ev: ProbeEvidence, domains: readonly string[]): { url: string | null; host: string; position: number } | null {
  for (const [i, raw] of ev.citations.entries()) {
    if (domains.some(d => urlMatchesDomain(raw, d))) continue
    if (isGroundingRedirect(String(raw))) return null
    const url = carryable(raw)
    const host = hostOf(url ?? String(raw))
    if (!host) return null
    return { url, host, position: i + 1 }
  }
  return null
}

/** Per question, each engine's first citation not ours, in engine order, unread. Pure. */
export function firstCitedEntries(evidence: ReadonlyMap<string, readonly ProbeEvidence[]>, domains: readonly string[]): Map<string, CitedEntry[]> {
  const out = new Map<string, CitedEntry[]>()
  for (const [qid, evs] of evidence) {
    const entries: CitedEntry[] = []
    for (const ev of evs) {
      const f = firstNotOurs(ev, domains)
      if (!f) continue
      // A URL that cannot be carried is typed by its host alone.
      const source_type = classifySource(f.url ?? `https://${f.host}/`)
      entries.push({ engine: ev.engine, position: f.position, url: f.url, host: f.host, source_type, features: unread(f.url, f.host, source_type) })
    }
    if (entries.length) out.set(qid, entries)
  }
  return out
}

/** The features of one read page, for one question. */
export function featuresOf(url: string, host: string, question: string, facts: PageFacts, status: number): CitedFeatures {
  const ok = status >= 200 && status < 300
  const source_type = classifySource(url, facts.title)
  if (!ok) return { ...unread(url, host, source_type), read: true }
  return {
    url, host, source_type, read: true,
    title_matches_question: alignmentOf(question, facts.title ?? '') >= 0.5,
    answer_first_words: facts.first_paragraph_words,
    words: facts.words,
    h2_count: facts.h2.length,
    dated: !!(facts.json_ld.date_published || facts.json_ld.date_modified || facts.visible_date),
    server_rendered: facts.words >= SERVER_RENDERED_MIN_WORDS,
  }
}

const NOT_READ: readonly SourceType[] = ['video', 'forum']

export interface FirstCitedRead { byQuery: Map<string, CitedEntry[]>; read: number; skipped_cap: number; skipped_type: number; failed: number }

/**
 * Reads the first-cited pages, highest-priority question first (the order
 * given), each question's first-cited page before the other engines' firsts.
 * Returns the entries with their features; an entry not read keeps read:false.
 */
export async function readFirstCited(
  queries: ReadonlyArray<{ query_id: string; query: string }>,
  entries: ReadonlyMap<string, readonly CitedEntry[]>,
  fetcher: SiteFetcher,
  o: { maxPages?: number; maxPerHost?: number; subject?: string } = {},
): Promise<FirstCitedRead> {
  const maxPages = o.maxPages ?? CAPS.THIRD_PARTY_MAX_PAGES_PER_SUBJECT
  const maxPerHost = o.maxPerHost ?? CAPS.THIRD_PARTY_MAX_PAGES_PER_HOST
  const cache = new Map<string, { facts: PageFacts; status: number } | null>()
  const perHost = new Map<string, number>()
  let read = 0
  let skippedCap = 0
  let skippedType = 0
  let failed = 0
  const plan: string[] = []
  for (const pass of [0, 1]) {
    for (const q of queries) {
      const list = entries.get(q.query_id) ?? []
      for (const e of pass === 0 ? list.slice(0, 1) : list.slice(1)) if (e.url && !plan.includes(e.url)) plan.push(e.url)
    }
  }
  for (const url of plan) {
    const host = hostOf(url)
    const type = classifySource(url)
    if (NOT_READ.includes(type)) { skippedType++; continue }
    if (read >= maxPages || (perHost.get(host) ?? 0) >= maxPerHost) { skippedCap++; continue }
    perHost.set(host, (perHost.get(host) ?? 0) + 1)
    read++
    const res = await fetcher.get(url)
    if (!res) { failed++; cache.set(url, null); continue }
    cache.set(url, { facts: extractPage(res.text), status: res.status })
  }
  const byQuery = new Map<string, CitedEntry[]>()
  for (const q of queries) {
    const list = entries.get(q.query_id)
    if (!list) continue
    byQuery.set(q.query_id, list.map(e => {
      const got = e.url ? cache.get(e.url) : null
      if (!got || !e.url) return e
      const features = featuresOf(e.url, e.host, q.query, got.facts, got.status)
      return { ...e, source_type: features.source_type, features }
    }))
  }
  // Entries for questions not in the order given are kept as they were.
  for (const [qid, list] of entries) if (!byQuery.has(qid)) byQuery.set(qid, [...list])
  log('first_cited_read', { ...(o.subject ? { subject: o.subject } : {}), questions: queries.length, read, failed, skipped_cap: skippedCap, skipped_type: skippedType })
  return { byQuery, read, skipped_cap: skippedCap, skipped_type: skippedType, failed }
}

/** Used by the kit and the digest to say whether a first-cited page leads with its answer. */
export const answersFirst = (f: CitedFeatures): boolean | null => (f.answer_first_words === null ? null : f.answer_first_words > 0 && f.answer_first_words <= ANSWER_FIRST_MAX_WORDS)
