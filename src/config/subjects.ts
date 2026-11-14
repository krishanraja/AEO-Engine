/**
 * Per venture settings this engine keeps itself, keyed by product slug only
 * (config/subjects.json; the file is public, so no prospect or aspiration is
 * ever named in it):
 *
 *   held         ventures AEO measures and prepares no win kit or proposal
 *                for (Ruling, Krish, 2026-11-13: while Legibility and Full
 *                Time are held). Applied until Control Center serves
 *                `subject.engine_held` in the context, which wins when present.
 *   owner_repos  the repository that ships each product's page and site
 *                fixes, named in a kit; null when unknown.
 *   host_repos   optional: the repository that ships each host, which wins
 *                over the product's (fleet integration I-10: a fix on
 *                krishraja.com ships in krish-raja, not mindmake); null for a
 *                host no repository ships (a Cloudflare or Substack site).
 *                Keys are lowercase hosts without www. A host with no entry
 *                falls back to the product's repository.
 *   brand_names  optional: each product's distinctive names, the interim
 *                overlay until Control Center serves subject.brand_names
 *                (brief B3); a product whose name is a common word has none.
 *
 * check:config validates the file; a file that does not validate stops the
 * kit stage (which then prepares nothing) rather than guess.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EM_DASH_RE } from '../lib/text.js'
import { PRODUCT_SLUGS } from '../schema/packet.js'

/**
 * `brandNames`: the interim overlay of each product's distinctive names (the
 * cited-pages mention check and the probes' name mentions read it), used
 * only until Control Center serves `subject.brand_names`, which wins. A
 * product whose name is a common word (ctrl, circle, pulse, full-time,
 * legibility) has none: links and domains only.
 */
export interface SubjectsConfig { held: string[]; ownerRepos: Record<string, string | null>; hostRepos?: Record<string, string | null>; brandNames?: Record<string, string[]> }

const isProductSlug = (s: unknown): s is string => typeof s === 'string' && (PRODUCT_SLUGS as readonly string[]).includes(s)
const REPO_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const ABOUT_MAX = 400
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Checks the file's shape. Pure; check:config and the loader both call it. */
export function parseSubjectsConfig(raw: unknown): { ok: true; value: SubjectsConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['subjects: must be an object'] }
  for (const k of Object.keys(raw)) if (!['_about', 'held', 'owner_repos', 'host_repos', 'brand_names'].includes(k)) errors.push(`subjects.${k}: unknown field`)
  const about = raw._about
  if (typeof about !== 'string' || !about.trim() || about.length > ABOUT_MAX || EM_DASH_RE.test(about)) errors.push(`subjects._about: one plain line of at most ${ABOUT_MAX} characters, no em dash`)
  const held: string[] = []
  if (Array.isArray(raw.held)) {
    raw.held.forEach((s, i) => {
      if (!isProductSlug(s)) errors.push(`subjects.held[${i}]: must be a venture's product slug (${PRODUCT_SLUGS.join(', ')})`)
      else if (held.includes(s)) errors.push(`subjects.held[${i}]: repeated`)
      else held.push(s)
    })
  } else errors.push('subjects.held: must be an array of product slugs')
  const ownerRepos: Record<string, string | null> = {}
  if (isRecord(raw.owner_repos)) {
    for (const [slug, repo] of Object.entries(raw.owner_repos)) {
      if (!isProductSlug(slug)) { errors.push(`subjects.owner_repos: a key must be a venture's product slug (${PRODUCT_SLUGS.join(', ')})`); continue }
      if (repo !== null && !(typeof repo === 'string' && REPO_RE.test(repo))) { errors.push(`subjects.owner_repos.${slug}: owner/name or null`); continue }
      ownerRepos[slug] = repo as string | null
    }
  } else errors.push('subjects.owner_repos: must be an object')
  // Optional: absent means every host falls back to its product's repository.
  const hostRepos: Record<string, string | null> = {}
  if (raw.host_repos !== undefined) {
    if (isRecord(raw.host_repos)) {
      for (const [host, repo] of Object.entries(raw.host_repos)) {
        if (!HOST_RE.test(host) || host.startsWith('www.')) { errors.push(`subjects.host_repos: "${host.slice(0, 80)}" must be a lowercase host without www`); continue }
        if (repo !== null && !(typeof repo === 'string' && REPO_RE.test(repo))) { errors.push(`subjects.host_repos.${host}: owner/name or null`); continue }
        hostRepos[host] = repo as string | null
      }
    } else errors.push('subjects.host_repos: must be an object')
  }
  // Optional: absent means no overlay names for any product.
  const brandNames: Record<string, string[]> = {}
  if (raw.brand_names !== undefined) {
    if (isRecord(raw.brand_names)) {
      for (const [slug, names] of Object.entries(raw.brand_names)) {
        if (!isProductSlug(slug)) { errors.push(`subjects.brand_names: a key must be a venture's product slug (${PRODUCT_SLUGS.join(', ')})`); continue }
        if (!Array.isArray(names) || !names.every(n => typeof n === 'string' && n.trim().length >= 2 && n.length <= 80 && !EM_DASH_RE.test(n))) { errors.push(`subjects.brand_names.${slug}: a list of names of 2 to 80 characters`); continue }
        brandNames[slug] = names.map(n => (n as string).trim())
      }
    } else errors.push('subjects.brand_names: must be an object')
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { held, ownerRepos, hostRepos, brandNames } }
}

/**
 * A subject's distinctive names: Control Center's `subject.brand_names` when
 * it serves a list (even an empty one), else this file's overlay for the
 * product, else none.
 */
export function brandNamesFor(subject: { product_slug?: string | null; brand_names?: unknown }, cfg: SubjectsConfig): string[] {
  if (Array.isArray(subject.brand_names)) return subject.brand_names.filter((n): n is string => typeof n === 'string')
  return subject.product_slug ? [...(cfg.brandNames?.[subject.product_slug] ?? [])] : []
}

export function subjectsConfigPath(): string {
  const candidates = ['../../config/subjects.json', '../../../config/subjects.json'].map(rel => fileURLToPath(new URL(rel, import.meta.url)))
  return candidates.find(p => existsSync(p)) ?? candidates[0]
}

let cached: SubjectsConfig | null = null

/** Reads and checks config/subjects.json once. Throws, naming what is wrong. */
export function subjectsConfig(): SubjectsConfig {
  if (cached) return cached
  let raw: unknown
  try { raw = JSON.parse(readFileSync(subjectsConfigPath(), 'utf8')) } catch (e) { throw new Error(`config/subjects.json could not be read: ${(e as Error).message}`) }
  const parsed = parseSubjectsConfig(raw)
  if (!parsed.ok) throw new Error(`config/subjects.json is invalid: ${parsed.errors.slice(0, 5).join('; ')}`)
  cached = parsed.value
  return cached
}

/**
 * Whether a subject's product is held: Control Center's `engine_held` when it
 * serves one, else this file. Only a venture has a product; anything without
 * one is never held here (it gets no kit anyway).
 */
export function isHeld(subject: { product_slug?: string | null; engine_held?: unknown }, cfg: SubjectsConfig): boolean {
  if (typeof subject.engine_held === 'boolean') return subject.engine_held
  return !!subject.product_slug && cfg.held.includes(subject.product_slug)
}

/** A host as host_repos keys it: lowercase, no port, no leading www. */
export function hostKey(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '')
}

/**
 * The repository that ships a fix: the host's own entry when host_repos has
 * one (even null, a host no repository ships), else the product's, else null.
 * `basis` says which, so a kit can say when it fell back to the product.
 */
export function ownerRepoFor(productSlug: string | null | undefined, cfg: SubjectsConfig, host?: string | null): { repo: string | null; basis: 'host' | 'product' | 'none' } {
  if (host) {
    const k = hostKey(host)
    if (cfg.hostRepos && Object.prototype.hasOwnProperty.call(cfg.hostRepos, k)) return { repo: cfg.hostRepos[k] ?? null, basis: 'host' }
  }
  const repo = productSlug ? cfg.ownerRepos[productSlug] ?? null : null
  return { repo, basis: repo ? 'product' : 'none' }
}

/** The repository that ships a fix: the host's when host_repos names it, else the product's, else null. */
export function ownerRepoOf(productSlug: string | null | undefined, cfg: SubjectsConfig, host?: string | null): string | null {
  return ownerRepoFor(productSlug, cfg, host).repo
}
