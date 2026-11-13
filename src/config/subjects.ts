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
 *
 * check:config validates the file; a file that does not validate stops the
 * kit stage (which then prepares nothing) rather than guess.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EM_DASH_RE } from '../lib/text.js'
import { PRODUCT_SLUGS } from '../schema/packet.js'

export interface SubjectsConfig { held: string[]; ownerRepos: Record<string, string | null> }

const isProductSlug = (s: unknown): s is string => typeof s === 'string' && (PRODUCT_SLUGS as readonly string[]).includes(s)
const REPO_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const ABOUT_MAX = 400
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Checks the file's shape. Pure; check:config and the loader both call it. */
export function parseSubjectsConfig(raw: unknown): { ok: true; value: SubjectsConfig } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isRecord(raw)) return { ok: false, errors: ['subjects: must be an object'] }
  for (const k of Object.keys(raw)) if (!['_about', 'held', 'owner_repos'].includes(k)) errors.push(`subjects.${k}: unknown field`)
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
  return errors.length ? { ok: false, errors } : { ok: true, value: { held, ownerRepos } }
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

/** The repository that ships a product's fixes, or null when unknown. */
export function ownerRepoOf(productSlug: string | null | undefined, cfg: SubjectsConfig): string | null {
  return productSlug ? cfg.ownerRepos[productSlug] ?? null : null
}
