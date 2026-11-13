/**
 * The research run's site audit: every research subject's own hosts, each
 * read once, before the subject jobs start.
 *
 *   tsx src/site.ts --subjects '<json array of slugs or ids>' --out <path> [--offline] [--fixtures <dir>]
 *
 * Each subject runs in its own job, four at a time, and many share a host:
 * every prospect's "ours" is Mindmake's and Krish's sites, and ctrl's include
 * mindmake.co. Audited per job, one host would get each job's budget, several
 * jobs at once. So the workflow's site job runs this once (one process, one
 * budget, one throttle per host), seals the result to the workflow run
 * (src/lib/seal.ts) and hands it to every subject job as an artifact kept one
 * day; a subject job then reads its hosts from the file (--site-in) and never
 * requests one of our pages itself. A missing or unreadable file means no
 * audit for that run, never a second read of the hosts.
 *
 * The file holds our own public pages' records and gates, keyed by host, and
 * no subject: it never says which subject asked for which host. Logs carry
 * counts only.
 */
import { readFileSync } from 'node:fs'
import { ControlCenterHttp } from './clients/controlCenter.js'
import { OfflineControlCenter } from './clients/offline.js'
import { LiveSite, OfflineSite, type SiteFetcher } from './clients/site.js'
import type { ControlCenterClient } from './clients/types.js'
import { errText, log } from './lib/log.js'
import { seal, unseal } from './lib/seal.js'
import { krishHitsDomains } from './pipeline/00-context.js'
import { auditHost, auditHosts, failedGates, HOST_GATES, type AuditPage, type GateResult, type HostAuditResult } from './pipeline/15-site.js'
import { writePacket } from './pipeline/70-ship.js'
import type { AeoContext } from './schema/context.js'

/** The seal's context: bound to the workflow run, and never the run summary's. */
export const siteSealContext = (env: NodeJS.ProcessEnv = process.env) => `site:${env.GITHUB_RUN_ID ?? 'local'}`

export interface SharedAudit { v: 1; hosts: HostAuditResult[] }

/** The hosts a run audits: each selected subject's own hosts (aspirations have none of ours), each once, in subject order. */
export function runHosts(ctx: AeoContext, subjects: readonly string[] | 'all'): string[] {
  const all = Array.isArray(ctx.subjects) ? ctx.subjects : []
  const picked = subjects === 'all' ? all : all.filter(s => subjects.includes(s.slug) || subjects.includes(s.id))
  const out: string[] = []
  for (const s of picked) {
    if (s.kind === 'aspiration') continue
    for (const h of auditHosts(krishHitsDomains(ctx, s))) if (!out.includes(h)) out.push(h)
  }
  return out
}

/** Reads the context once and audits each host once, one after another. */
export async function auditRun(cc: ControlCenterClient, site: SiteFetcher, subjects: readonly string[] | 'all'): Promise<SharedAudit> {
  const ctx = await cc.getContext('all')
  const hosts = runHosts(ctx, subjects)
  const results: HostAuditResult[] = []
  for (const host of hosts) {
    try {
      results.push(await auditHost(host, site))
    } catch (e) {
      // One host that cannot be read costs only itself; the error's class, never its message.
      log('site_host_failed', { failed: 1, error_kind: e instanceof Error ? e.name : typeof e })
    }
  }
  const st = site.stats()
  log('site_run_audit', {
    hosts: results.length, pages: results.reduce((n, r) => n + r.pages.length, 0), requests: st.requests, errors: st.errors, refused: st.refused,
    gates_failed: failedGates({ hosts: results }),
  })
  return { v: 1, hosts: results }
}

const isGate = (g: unknown): g is GateResult => {
  const x = g as GateResult
  return !!x && typeof x === 'object' && (HOST_GATES as readonly string[]).includes(x.gate) && typeof x.pass === 'boolean' && typeof x.detail === 'string'
}
const isPage = (p: unknown): p is AuditPage => {
  const x = p as AuditPage
  return !!x && typeof x === 'object' && typeof x.url === 'string' && typeof x.status === 'number' && typeof x.words === 'number' && typeof x.h1_count === 'number'
}

/** The shared audit's hosts, from what was unsealed: anything malformed is dropped, never trusted. */
export function parseShared(raw: unknown): Map<string, HostAuditResult> {
  const out = new Map<string, HostAuditResult>()
  const j = raw as Partial<SharedAudit>
  if (!j || j.v !== 1 || !Array.isArray(j.hosts)) return out
  for (const h of j.hosts) {
    if (!h || typeof h.host !== 'string' || !Array.isArray(h.gates) || !Array.isArray(h.pages)) continue
    out.set(h.host, {
      host: h.host,
      gates: h.gates.filter(isGate),
      pages: h.pages.filter(isPage).map(p => ({ ...p, client_rendered: p.client_rendered === true })),
      requests: 0,
      errors: 0,
    })
  }
  return out
}

/**
 * The run's shared audit for a subject job (--site-in). Always a map: empty
 * when the file is missing, unsealed by another run, or malformed, and the
 * log says which. An empty map still means "read no page of ours here".
 */
export function readSharedAudit(path: string, env: NodeJS.ProcessEnv = process.env): Map<string, HostAuditResult> {
  const secret = env.AEO_ENGINE_SECRET ?? ''
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { log('shared_site_audit', { state: 'missing' }); return new Map() }
  try {
    const hosts = parseShared(unseal(text, secret, siteSealContext(env)))
    log('shared_site_audit', { state: 'read', hosts: hosts.size, pages: [...hosts.values()].reduce((n, h) => n + h.pages.length, 0) })
    return hosts
  } catch {
    log('shared_site_audit', { state: 'unreadable' })
    return new Map()
  }
}

export interface SiteArgs { subjects: string[] | 'all'; out: string | null; offline: boolean; fixtures: string }

export function parseSiteArgs(argv: readonly string[]): SiteArgs {
  const a: SiteArgs = { subjects: 'all', out: null, offline: false, fixtures: 'tests/fixtures' }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${k} needs a value`); return v }
    switch (k) {
      case '--subjects': {
        const v = next().trim()
        if (v === 'all' || v === '') { a.subjects = 'all'; break }
        const list = JSON.parse(v) as unknown
        if (!Array.isArray(list) || !list.every(x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x))) throw new Error('--subjects must be a JSON array of slugs or ids')
        a.subjects = list as string[]
        break
      }
      case '--out': a.out = next(); break
      case '--offline': a.offline = true; break
      case '--fixtures': a.fixtures = next(); break
      default: throw new Error(`unknown argument ${k}`)
    }
  }
  return a
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseSiteArgs(argv)
  if (!args.out) throw new Error('--out is required')
  const secret = env.AEO_ENGINE_SECRET ?? ''
  if (!secret) { log('site_run_audit_not_written', { reason: 'AEO_ENGINE_SECRET is not set' }); return 1 }
  const cc: ControlCenterClient = args.offline ? new OfflineControlCenter(args.fixtures) : new ControlCenterHttp(env.CONTROL_CENTER_URL ?? '', secret)
  const site: SiteFetcher = args.offline ? new OfflineSite(args.fixtures) : new LiveSite()
  const audit = await auditRun(cc, site, args.subjects)
  writePacket(args.out, JSON.parse(seal(audit, secret, siteSealContext(env))))
  log('site_run_audit_written', { hosts: audit.hosts.length })
  return 0
}

const invokedDirectly = process.argv[1] && /src[\\/]site\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main().then(code => { process.exitCode = code }, e => { log('site_run_audit_failed', { error_kind: e instanceof Error ? e.name : typeof e, error: errText(e).slice(0, 120).replace(/https?:\/\/\S+/g, '[url]') }); process.exitCode = 1 })
}
