/**
 * Stage 62: the win kits. Pure and deterministic. For a venture's questions
 * that are not won (and were answered), one kit each: the page to make or fix
 * so an assistant cites it first, the pages it has to beat, the site fixes in
 * its way, the third-party places it is absent from, and how the next
 * research run checks it.
 *
 * Our own data shows the mechanism: the only first citation in two
 * fortnights was a mindmake.co answer page written for exactly that question.
 * So a kit is written for one question, in the buyer's words.
 *
 * None for a held product (config/subjects.json, or Control Center's
 * subject.engine_held, which wins): it is measured and gets no kit (Ruling,
 * Krish, 2026-11-13). None for a prospect or an aspiration: only a venture
 * has a product to ship a page for. None for a question the packet lists as
 * not worth chasing (the digest's walls), so a kit never contradicts it.
 *
 * The target: update the page of ours the engines already named or the
 * matcher found; else write a new page, when the venture has a site and
 * general platforms do not own the first citation; else be present off site.
 *
 * Kits never reach a packet or a log. The top one per subject travels in the
 * sealed run summary as `kit_candidate`, rendered as plain text, and the
 * highest of those becomes one proposal on Krish's list (src/protocol/reports.ts).
 */
import { hostOf, urlMatchesDomain } from '../lib/domains.js'
import { classifySource, type SourceType } from '../lib/sourceType.js'
import { CLEAN, normaliseQuery, scrubPII, tokensOf } from '../lib/text.js'
import { isHeld, ownerRepoOf, type SubjectsConfig } from '../config/subjects.js'
import type { ProbeDetail } from '../lib/probeDetail.js'
import type { ContextSubject } from '../schema/context.js'
import type { CitedFeatures, Kit, KitBeat, KitCandidate, KitOffSite, KitSiteFix, KitTarget, TargetKind } from '../schema/kit.js'
import type { PacketQuery } from '../schema/packet.js'
import { auditHosts, failedGates, SERVER_RENDERED_MIN_WORDS, type AuditPage, type SiteAudit } from './15-site.js'
import type { ProbeEvidence } from './40-probe.js'
import { answersFirst, carryable, type CitedEntry } from './45-pages.js'
import { GAP_LABEL, KIT_CLASSES, kitPriority, type Diagnosis, type GapClass } from './52-diagnose.js'

// The kit's shape lives in src/schema/kit.ts, where the packet's `kits` feature reads it too.
export type { Kit, KitBeat, KitCandidate, KitOffSite, KitSiteFix, KitTarget, TargetKind }

export const CAPSULE_RULES = [
  '40 to 60 words',
  'the first sentence answers the question as asked',
  'stands alone if quoted',
  'facts only from the venture canon or published pieces',
  'no number unless sourced',
] as const

export const VERIFY_SUCCESS = 'cited first on 2 of 3 samples on at least one engine'

export const TITLE_MAX = 70
export const H2_MAX = 120
export const H2S_MAX = 6
export const BEAT_MAX = 3
export const OFF_SITE_MAX = 5
export const EVIDENCE_MAX = 6
export const SITE_FIXES_MAX = 12
export const PAYLOAD_MAX = 8000

const HOST_FIX: Record<string, string> = {
  search_bots_allowed: 'Let the search bots (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot, Bingbot, Applebot) read the site in robots.txt.',
  user_bots_allowed: 'Let the assistants\' user fetchers (ChatGPT-User, Claude-User, Perplexity-User) read the site in robots.txt.',
  homepage_200: 'Serve the home page with status 200.',
  homepage_server_rendered: `Render the home page on the server: at least ${SERVER_RENDERED_MIN_WORDS} words in the HTML as sent, with no script run.`,
  homepage_single_h1: 'Give the home page exactly one H1.',
  sitemap_present: 'Publish a sitemap at /sitemap.xml and name it in robots.txt.',
}

/** The target page's own checks, each with its fix, from the audit's record of it. */
export function pageFixes(p: AuditPage): Array<{ gate: string; fix: string }> {
  const out: Array<{ gate: string; fix: string }> = []
  if (p.status !== 200) out.push({ gate: 'page_200', fix: `Serve the page with status 200 (it answers ${p.status}).` })
  if (p.noindex) out.push({ gate: 'page_indexable', fix: 'Take noindex off the page (meta robots or the X-Robots-Tag header).' })
  if (p.canonical_self === false) out.push({ gate: 'page_canonical_self', fix: 'Point the page\'s canonical at the page itself.' })
  if (p.h1_count !== 1) out.push({ gate: 'page_single_h1', fix: `Give the page one H1 that states the question (it has ${p.h1_count}).` })
  if (!p.has_answer_first) out.push({ gate: 'page_answer_first', fix: 'Open with the answer capsule right under the H1: 40 to 60 words that answer the question as asked.' })
  // Only with evidence of a script-filled shell: a short page served whole is short, not client-rendered.
  if (p.client_rendered) out.push({ gate: 'page_server_rendered', fix: `Render the page on the server: its HTML is a shell a script fills in, and ${p.words} words reach a fetcher that runs no script.` })
  if (!p.date_published && !p.date_modified) out.push({ gate: 'page_dated', fix: 'Date the page: datePublished and dateModified in JSON-LD, and a visible date.' })
  return out
}

/** A title of at most `max` characters, cut at a word. */
export function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max + 1)
  const i = cut.lastIndexOf(' ')
  return (i > max / 2 ? cut.slice(0, i) : s.slice(0, max)).replace(/[\s,;:.-]+$/, '')
}

export const SLUG_MAX = 60

/** /answers/<the question's words>: the shape of the one page that won a first citation. Whole words only, up to SLUG_MAX characters. */
export function suggestedPath(question: string): string {
  let slug = ''
  for (const w of tokensOf(question)) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > SLUG_MAX) break
    slug = next
  }
  // A first word longer than the cap is cut, the only cut there is.
  if (!slug) slug = (tokensOf(question)[0] ?? '').slice(0, SLUG_MAX)
  return `/answers/${slug || 'question'}`
}

const cleanLine = (s: string, max: number, neverSay: readonly string[]) => CLEAN(scrubPII(CLEAN(s, max * 2), neverSay), max)

/** Up to six section headings from the engines' own search queries for the question: deduped, cleaned, never the question itself. */
export function h2sFrom(question: string, evidence: readonly ProbeEvidence[], neverSay: readonly string[] = []): string[] {
  const seen = new Set<string>([normaliseQuery(question)])
  const out: string[] = []
  for (const ev of evidence) {
    for (const raw of ev.fan_out) {
      const t = cleanLine(String(raw).replace(/\bsite:\S+/gi, ' ').replace(/["\u201c\u201d]/g, ' '), H2_MAX, neverSay)
      const key = normaliseQuery(t)
      if (!key || seen.has(key) || t.length < 8) continue
      seen.add(key)
      out.push(t.charAt(0).toUpperCase() + t.slice(1))
      if (out.length >= H2S_MAX) return out
    }
  }
  return out
}

/** Up to five third-party hosts cited for the question, on any engine, where we are not: their type and the engines citing them. A competitor's own page (vendor) is not a place to be. */
export function offSiteFrom(evidence: readonly ProbeEvidence[], domains: readonly string[]): KitOffSite[] {
  const byHost = new Map<string, { type: SourceType; engines: Set<string>; best: number; order: number }>()
  let order = 0
  for (const ev of evidence) {
    for (const [i, raw] of ev.citations.entries()) {
      if (domains.some(d => urlMatchesDomain(raw, d))) continue
      const url = carryable(raw)
      if (!url) continue
      const host = hostOf(url)
      if (!host) continue
      const row = byHost.get(host) ?? { type: classifySource(url), engines: new Set<string>(), best: i + 1, order: order++ }
      row.engines.add(ev.engine)
      row.best = Math.min(row.best, i + 1)
      byHost.set(host, row)
    }
  }
  return [...byHost.entries()]
    .filter(([, r]) => r.type !== 'vendor')
    .sort((a, b) => b[1].engines.size - a[1].engines.size || a[1].best - b[1].best || a[1].order - b[1].order)
    .slice(0, OFF_SITE_MAX)
    .map(([host, r]) => ({ host, source_type: r.type, engines: [...r.engines] }))
}

export interface KitInput {
  subject: Pick<ContextSubject, 'slug' | 'kind' | 'product_slug' | 'never_say'> & { engine_held?: unknown }
  queries: readonly PacketQuery[]
  diagnoses: ReadonlyMap<string, Diagnosis>
  /** The packet engines' evidence per question. */
  evidence: ReadonlyMap<string, readonly ProbeEvidence[]>
  /** The packet engines' details per question. */
  details: ReadonlyMap<string, readonly ProbeDetail[]>
  cited: ReadonlyMap<string, readonly CitedEntry[]>
  audit: SiteAudit
  domains: readonly string[]
  /** The packet's engines, in order. */
  engines: readonly string[]
  config: SubjectsConfig
  /** The questions the digest walled as not worth chasing (packet.not_worth_chasing): no kit for them. */
  walled?: ReadonlySet<string>
  /**
   * The page a venture named for a question (a 1.23.0 request's targets), by
   * the question's normalised words. A URL on one of our domains becomes the
   * kit's target page; any other is passed over.
   */
  targets?: ReadonlyMap<string, string>
}

function featureLine(f: CitedFeatures): string {
  if (!f.read || f.words === null) return 'not read'
  const parts = [`${f.words} words`]
  const first = answersFirst(f)
  parts.push(first === null ? 'no paragraph under an H1' : first ? `answer first in ${f.answer_first_words} words` : `first paragraph ${f.answer_first_words} words`)
  if (f.h2_count !== null) parts.push(`${f.h2_count} H2s`)
  if (f.dated !== null) parts.push(f.dated ? 'dated' : 'undated')
  if (f.server_rendered !== null) parts.push(f.server_rendered ? 'server rendered' : 'not server rendered')
  if (f.title_matches_question) parts.push('title matches the question')
  return parts.join(', ')
}

function evidenceLines(d: Diagnosis, demand: number, priority: number, details: readonly ProbeDetail[], audit: SiteAudit): string[] {
  const n = details.length
  const out = [
    `class: ${d.gap_class} (${GAP_LABEL[d.gap_class]})`,
    `demand ${demand} of 100; priority ${priority}`,
    `answered on ${n} engines: cited on ${details.filter(x => x.cited_any).length}, first on ${details.filter(x => x.first_host_ours).length}, a page of ours retrieved on ${details.filter(x => x.retrieved_ours).length}`,
  ]
  if (d.first_cited) out.push(`first cited: ${d.first_cited.host} (${d.first_cited.source_type})`)
  out.push(d.our_best_url
    ? `our best page matches ${Math.round(d.alignment * 100)} percent of the question's distinctive words`
    : d.our_cited_url
      ? `no audited page of ours matches the question; an engine already ${d.gap_class === 'cited_not_first' ? 'cites' : 'retrieves'} one on ${hostOf(d.our_cited_url)}`
      : `no page of ours matches the question (best ${Math.round(d.alignment * 100)} percent of its distinctive words)`)
  if (d.owned_by_platform) out.push('general platforms own the first citation')
  const failed = failedGates(audit)
  if (failed) out.push(`${failed} site gates fail across ${audit.hosts.length} hosts`)
  return out.slice(0, EVIDENCE_MAX)
}

/** Every kit for a subject, highest priority first; ties on query_id. Empty for a held product, a prospect or an aspiration. */
export function buildKits(i: KitInput): Kit[] {
  const product = i.subject.product_slug
  if (i.subject.kind !== 'venture' || !product || isHeld(i.subject, i.config)) return []
  const neverSay = i.subject.never_say ?? []
  const hosts = auditHosts(i.domains)
  const ourHost = i.audit.hosts[0]?.host ?? hosts[0] ?? null
  const hostFixes: KitSiteFix[] = i.audit.hosts.flatMap(h => h.gates.filter(g => !g.pass).map(g => ({ gate: g.gate, host: h.host, url: null, fix: HOST_FIX[g.gate] ?? g.detail, owner_repo: ownerRepoOf(product, i.config, h.host) })))
  const kits: Kit[] = []
  for (const q of i.queries) {
    const d = i.diagnoses.get(q.query_id)
    if (!d || !KIT_CLASSES.includes(d.gap_class) || i.walled?.has(q.query_id)) continue
    const priority = kitPriority(d.gap_class, q.demand_score, d.owned_by_platform)
    const evidence = i.evidence.get(q.query_id) ?? []
    const details = i.details.get(q.query_id) ?? []
    const cited = i.cited.get(q.query_id) ?? []

    // A page of ours to fix: the one the matcher found, else the one the
    // engines already cited or retrieved. A new page only when there is none,
    // the venture has a site, and platforms do not own the first citation.
    const off_site = offSiteFrom(evidence, i.domains)
    const ourUrl = d.our_best_url ?? d.our_cited_url
    // The page the venture named for this question wins, when it is ours: an
    // audited page is updated, a page not yet there is written at that address.
    const named = venturePage(i.targets?.get(normaliseQuery(q.query)), i.domains)
    let target: KitTarget
    if (named) {
      const audited = i.audit.pages.some(p => p.url === named && p.status === 200)
      target = audited || named === ourUrl ? { kind: 'update_page', url: named, host: hostOf(named), suggested_path: null } : { kind: 'new_page', url: named, host: hostOf(named), suggested_path: pathOf(named) }
    } else if (ourUrl) target = { kind: 'update_page', url: ourUrl, host: hostOf(ourUrl), suggested_path: null }
    else if (ourHost && !d.owned_by_platform) target = { kind: 'new_page', url: null, host: ourHost, suggested_path: suggestedPath(q.query) }
    else target = { kind: 'off_site_only', url: null, host: off_site[0]?.host ?? '', suggested_path: null }

    const page = target.kind === 'update_page' ? i.audit.pages.find(p => p.url === target.url) ?? null : null
    const site_fixes = [
      ...(page ? pageFixes(page).map(f => ({ gate: f.gate, host: target.host, url: page.url, fix: f.fix, owner_repo: ownerRepoOf(product, i.config, target.host) })) : []),
      ...hostFixes,
    ].slice(0, SITE_FIXES_MAX)

    const answered = [...new Set(evidence.map(e => e.engine))]
    kits.push({
      kit_id: `kit:${product}:${q.query_id.slice(0, 8)}`,
      v: 1,
      product_slug: product,
      query_id: q.query_id,
      question: cleanLine(q.query, 400, neverSay),
      gap_class: d.gap_class,
      priority,
      owned_by_platform: d.owned_by_platform,
      target,
      title: cutAtWord(cleanLine(q.query, 400, neverSay), TITLE_MAX),
      capsule: { rules: [...CAPSULE_RULES], must_cover: null },
      h2s: h2sFrom(q.query, evidence, neverSay),
      beat: cited.slice(0, BEAT_MAX).map(c => ({ url: c.url, host: c.host, engine: c.engine, position: c.position, features: c.features })),
      site_fixes,
      off_site,
      verify: { engines: answered.length ? answered : [...i.engines], samples: 3, success: VERIFY_SUCCESS, recheck: 'next research run', baseline: d.gap_class },
      evidence: evidenceLines(d, q.demand_score, priority, details, i.audit).map(l => cleanLine(l, 200, neverSay)),
    })
  }
  return kits.sort((a, b) => b.priority - a.priority || a.query_id.localeCompare(b.query_id))
}

/** A venture's named page, when it is a carryable URL on one of our domains; else null. */
export function venturePage(url: string | undefined, domains: readonly string[]): string | null {
  if (!url) return null
  const c = carryable(url)
  return c && domains.some(d => urlMatchesDomain(c, d)) ? c : null
}

function pathOf(url: string): string | null {
  try { return new URL(url).pathname.slice(0, 120) || '/' } catch { return null }
}

const TARGET_LINE: Record<TargetKind, (k: Kit) => string> = {
  update_page: k => `Update the page ${k.target.url} on ${k.target.host}.`,
  new_page: k => (k.target.url ? `Write a new page at ${k.target.url}, the address the venture named.` : `Write a new page on ${k.target.host} at ${k.target.suggested_path}.`),
  off_site_only: k => `${k.owned_by_platform ? 'No page of ours can win this alone: general platforms own the first citation.' : 'This venture has no site of its own to put a page on.'} Be present where it is answered${k.target.host ? `, starting with ${k.target.host}` : ''}.`,
}

/** The kit as plain text for Krish, in the kit's own order with readable labels, at most PAYLOAD_MAX characters. No em dash. */
export function renderKit(k: Kit): string {
  const lines: string[] = [
    `Win kit ${k.kit_id} (v${k.v})`,
    `Product: ${k.product_slug}`,
    `Question: ${k.question}`,
    `Why it is not won: ${GAP_LABEL[k.gap_class]} (${k.gap_class})`,
    `Priority: ${k.priority}`,
    '',
    `Target: ${TARGET_LINE[k.target.kind](k)}`,
    `Title: ${k.title}`,
    '',
    'Answer capsule, under the H1:',
    ...k.capsule.rules.map(r => `- ${r}`),
  ]
  if (k.h2s.length) lines.push('', 'Sections (H2s), from the searches the assistants ran:', ...k.h2s.map(h => `- ${h}`))
  if (k.beat.length) lines.push('', 'Pages to beat (cited first today):', ...k.beat.map((b, n) => `${n + 1}. ${b.url ?? `a page on ${b.host}`} (${b.host}, ${b.features.source_type}; ${b.engine} position ${b.position}): ${featureLine(b.features)}`))
  if (k.site_fixes.length) lines.push('', 'Site fixes:', ...k.site_fixes.map(f => `- [${f.gate}] ${f.url ?? f.host}: ${f.fix}${f.owner_repo ? ` Ships in ${f.owner_repo}.` : ''}`))
  if (k.off_site.length) lines.push('', 'Off site, where the assistants look and we are absent:', ...k.off_site.map(o => `- ${o.host} (${o.source_type}), cited by ${o.engines.join(', ')}${offSiteMention(o)}`))
  lines.push('', `Verify: at the ${k.verify.recheck}, ask ${k.verify.engines.join(', ')} ${k.verify.samples} times each. Success: ${k.verify.success}. Baseline: ${k.verify.baseline}.`)
  if (k.evidence.length) lines.push('', 'Evidence:', ...k.evidence.map(e => `- ${e}`))
  lines.push('', 'AEO ships nothing. The product\'s build session or its growth engine ships this kit, and the next research run checks it.')
  const text = lines.join('\n').replace(/\u2014|\u2013/g, ',')
  return text.length <= PAYLOAD_MAX ? text : `${text.slice(0, PAYLOAD_MAX - 20).replace(/\n[^\n]*$/, '')}\n(cut to fit)`
}

/** What the cited-pages sheet says of an off-site place, for the kit's text: already mentioned (skip), refresh needed, or not yet. */
function offSiteMention(o: KitOffSite): string {
  if (o.mention_ok === false) return '; a page there carries a phrase a brand check forbids: refresh needed'
  if (o.mention === 'link' || o.mention === 'name') return `; already mentions us (${o.mention === 'link' ? 'a link' : 'by name'}): skip`
  if (o.mention === 'none') return '; read this run, no mention of us yet'
  return ''
}

/**
 * A kit with one more evidence line (an outcome reading, src/pipeline/63-outcomes.ts),
 * cleaned like the rest; the line takes the last place when the evidence is full.
 */
export function withEvidence(k: Kit, line: string | null, neverSay: readonly string[] = []): Kit {
  if (!line) return k
  const clean = cleanLine(line, 200, neverSay)
  if (!clean) return k
  return { ...k, evidence: [...k.evidence.slice(0, EVIDENCE_MAX - 1), clean] }
}

export function kitCandidate(k: Kit): KitCandidate {
  return {
    product_slug: k.product_slug,
    query_id: k.query_id,
    priority: k.priority,
    title: k.title,
    exact_payload: renderKit(k),
    gap_class: k.gap_class,
    target_kind: k.target.kind,
    // What shipping it changes: the page, else the host the new page goes on;
    // off site there is no page of ours, so the kit names itself, never a third party's host.
    reference: (k.target.url ?? (k.target.kind === 'off_site_only' ? k.kit_id : k.target.host) ?? '').slice(0, 500),
  }
}

/** Counts of each gap class across a subject's questions. */
export function gapCounts(diagnoses: ReadonlyMap<string, Diagnosis>): Record<GapClass, number> {
  const out = { won: 0, cited_not_first: 0, retrieved_not_cited: 0, not_retrieved: 0, no_page: 0, unknown: 0 } as Record<GapClass, number>
  for (const d of diagnoses.values()) out[d.gap_class]++
  return out
}
