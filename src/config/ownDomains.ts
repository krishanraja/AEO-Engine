/**
 * Which domains are ours, over and above Control Center's lists.
 *
 * Control Center holds each subject's domains and Krish's own, and this engine
 * reads them every run. config/own-domains.json is the small set of corrections
 * Krish has ruled on, kept here so a wrong list there cannot count a stranger's
 * site as ours or miss one of his (Ruling, Krish, 2026-11-13: krishraja.ai,
 * krishraja.com and themindmaker.ai are his; fractionl.us is not).
 *
 *   krish.add       Krish's own domains: added for every prospect (whose read
 *                   is whether Mindmake or Krish is in the answer) and for a
 *                   venture named in apply_krish_to.
 *   apply_krish_to  ventures, by product slug, that count Krish's own
 *                   domains as theirs.
 *   subjects        per venture, by product slug: { add, remove }.
 *   not_ours        never ours, for any subject, whatever Control Center
 *                   lists: a domain on it, a subdomain of it, or a path under
 *                   it is removed.
 *
 * Only a venture's product slug (PRODUCT_SLUGS) may key apply_krish_to or
 * subjects. This file sits in a public repository, and a prospect or an
 * aspiration is never named in one (docs/NEVER-PUBLISH.md; the reports number
 * them for the same reason), so neither kind can be corrected here, and a
 * subject entry applies to a venture only.
 *
 * check:config validates the file; a file that does not validate stops the
 * subject that reads it rather than measuring against a list nobody checked.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hostMatches, splitDomain } from '../lib/domains.js'
import { EM_DASH_RE } from '../lib/text.js'
import { PRODUCT_SLUGS } from '../schema/packet.js'

export interface SubjectOverlay { add: string[]; remove: string[] }

export interface OwnDomains {
  krishAdd: string[]
  applyKrishTo: string[]
  subjects: Record<string, SubjectOverlay>
  notOurs: string[]
}

export const EMPTY_OWN_DOMAINS: OwnDomains = { krishAdd: [], applyKrishTo: [], subjects: {}, notOurs: [] }

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[a-z0-9._~%-]+)*$/
/** A venture's product slug: the only key this public file may carry. */
const isProductSlug = (s: unknown): s is string => typeof s === 'string' && (PRODUCT_SLUGS as readonly string[]).includes(s)
const PRODUCT_SLUG_HINT = `a venture's product slug (${PRODUCT_SLUGS.join(', ')}), never a prospect or an aspiration`
const ABOUT_MAX = 300

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function domainList(path: string, v: unknown, errors: string[]): string[] {
  if (!Array.isArray(v)) { errors.push(`${path}: must be an array of domains`); return [] }
  const out: string[] = []
  v.forEach((d, i) => {
    if (typeof d !== 'string' || !DOMAIN_RE.test(d)) errors.push(`${path}[${i}]: must be a lower-case domain, optionally with a path, and no scheme`)
    else if (out.includes(d)) errors.push(`${path}[${i}]: repeated`)
    else out.push(d)
  })
  return out
}

function closedKeys(path: string, v: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`${path}.${k}: unknown field`)
}

/** Checks the file's shape. Pure; check:config and the loader both call it. */
export function parseOwnDomains(raw: unknown): { ok: true; value: OwnDomains } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['own-domains: must be an object'] }
  closedKeys('own-domains', raw, ['_about', 'krish', 'apply_krish_to', 'subjects', 'not_ours'], errors)
  for (const k of ['_about', 'krish', 'apply_krish_to', 'subjects', 'not_ours']) if (!(k in raw)) errors.push(`own-domains.${k}: required`)
  const about = raw._about
  if (typeof about !== 'string' || !about.trim() || about.length > ABOUT_MAX || EM_DASH_RE.test(about)) errors.push(`own-domains._about: one plain line of at most ${ABOUT_MAX} characters, no em dash`)

  let krishAdd: string[] = []
  if (isRecord(raw.krish)) {
    closedKeys('own-domains.krish', raw.krish, ['add'], errors)
    krishAdd = domainList('own-domains.krish.add', raw.krish.add, errors)
  } else errors.push('own-domains.krish: must be an object with add')

  const applyKrishTo: string[] = []
  if (Array.isArray(raw.apply_krish_to)) {
    raw.apply_krish_to.forEach((s, i) => {
      if (!isProductSlug(s)) errors.push(`own-domains.apply_krish_to[${i}]: must be ${PRODUCT_SLUG_HINT}`)
      else if (!applyKrishTo.includes(s)) applyKrishTo.push(s)
    })
  } else errors.push('own-domains.apply_krish_to: must be an array of slugs')

  const subjects: Record<string, SubjectOverlay> = {}
  if (isRecord(raw.subjects)) {
    for (const [slug, o] of Object.entries(raw.subjects)) {
      const p = `own-domains.subjects.${slug}`
      if (!isProductSlug(slug)) { errors.push(`own-domains.subjects: a key must be ${PRODUCT_SLUG_HINT}`); continue }
      if (!isRecord(o)) { errors.push(`${p}: must be an object with add and or remove`); continue }
      closedKeys(p, o, ['add', 'remove'], errors)
      subjects[slug] = { add: 'add' in o ? domainList(`${p}.add`, o.add, errors) : [], remove: 'remove' in o ? domainList(`${p}.remove`, o.remove, errors) : [] }
    }
  } else errors.push('own-domains.subjects: must be an object')

  const notOurs = domainList('own-domains.not_ours', raw.not_ours, errors)
  for (const d of [...krishAdd, ...Object.values(subjects).flatMap(s => s.add)]) {
    if (notOurs.some(n => covers(n, d))) errors.push(`own-domains: ${d} is added and also not ours`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { krishAdd, applyKrishTo, subjects, notOurs } }
}

/** The file beside this repository's src/, found from this module whether it runs from src/ or a build. */
export function ownDomainsPath(): string {
  const candidates = ['../../config/own-domains.json', '../../../config/own-domains.json'].map(rel => fileURLToPath(new URL(rel, import.meta.url)))
  return candidates.find(p => existsSync(p)) ?? candidates[0]
}

let cached: OwnDomains | null = null

/** Reads and checks config/own-domains.json once. Throws, naming what is wrong, when it is missing or does not validate. */
export function ownDomains(): OwnDomains {
  if (cached) return cached
  const path = ownDomainsPath()
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { throw new Error(`config/own-domains.json could not be read: ${(e as Error).message}`) }
  const parsed = parseOwnDomains(raw)
  if (!parsed.ok) throw new Error(`config/own-domains.json is invalid: ${parsed.errors.slice(0, 5).join('; ')}`)
  cached = parsed.value
  return cached
}

/** True when `rule` covers `domain`: the same host or a subdomain of it, and, when the rule has a path, the same path or one under it. */
export function covers(rule: string, domain: string): boolean {
  const r = splitDomain(rule)
  const d = splitDomain(domain)
  if (!r.host || !d.host || !hostMatches(d.host, r.host)) return false
  return !r.path || d.path === r.path || d.path.startsWith(`${r.path}/`)
}

const norm = (d: unknown) => String(d ?? '').toLowerCase().trim()

/**
 * A subject's domain list with the overlay applied: the krish additions where
 * they belong, a venture's own add and remove, and every not_ours entry taken
 * out. Order kept (Control Center's first), each domain once. Pure.
 *
 * A venture is matched by its slug or its product slug (the file's keys are
 * product slugs, and Control Center's subject slug may differ). A prospect or
 * an aspiration is never matched by a key, whatever its slug.
 */
export function applyOwnDomains(
  base: readonly string[],
  subject: { kind: string; slug: string; product_slug?: string | null },
  overlay: OwnDomains,
): string[] {
  const keys = subject.kind === 'venture' ? [...new Set([subject.slug, subject.product_slug ?? ''].filter(Boolean))] : []
  const list = base.map(norm)
  if (subject.kind === 'prospect' || keys.some(k => overlay.applyKrishTo.includes(k))) list.push(...overlay.krishAdd)
  const per = keys.map(k => overlay.subjects[k]).filter((o): o is SubjectOverlay => !!o)
  for (const o of per) list.push(...o.add)
  const removed = [...per.flatMap(o => o.remove), ...overlay.notOurs]
  return [...new Set(list.filter(Boolean))].filter(d => !removed.some(r => covers(r, d)))
}
