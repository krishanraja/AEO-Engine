/**
 * A local stand-in for Control Center's growth engine routes, in process, on
 * a loopback port. It enforces what the protocol says the real one does: the
 * bearer, the Idempotency-Key, a recomputed digest, closed objects, replay on
 * an identical report, 409 on a different one, and terminal attempts that
 * never change. Synthetic only: nothing here is a live record.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { reportDigest } from '../src/lib/canonical.js'
import { validateReport, type Attempt } from '../src/schema/report.js'

export interface Seen { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }
export interface Stored { payload_sha256: string; mode: string; accepted_at: string; report: Record<string, unknown> }
type Route = 'attempts' | 'directive' | 'reports' | 'readback' | 'decisions'

export const SYNTHETIC_DIRECTIVE = {
  schema_version: '1.0.0',
  directive_id: 'aeo:2026-10-19',
  engine_id: 'aeo-engine',
  for_date: '2026-10-19',
  aim: 'Synthetic aim',
  objectives: [{ key: 'queries_cited_first', label: 'Questions where we are cited first', target: null, unit: 'questions', window: 'fortnight', timezone: 'UTC', latest: null, availability: 'unreported' }],
  next_action: { proposal_id: null, instruction: 'Report the gap', why: 'Synthetic', close_condition: null },
  decisions_since: [] as Array<{ proposal_id: string; decision: 'approved' | 'declined'; decided_at: string; payload_sha256: string | null }>,
  constraints: { walls: 'Nothing sends, posts, spends, deletes or changes a permission without a decision from Krish whose payload_sha256 matches what you are about to do.', spend_cap_usd: 0, max_actions: 5 },
}

export class StandIn {
  readonly seen: Seen[] = []
  readonly attempts = new Map<string, Attempt[]>()
  readonly reports = new Map<string, Stored>()
  directive = structuredClone(SYNTHETIC_DIRECTIVE)
  decisions: Array<{ proposal_id: string; decision: string; decided_at: string; payload_sha256: string | null }> = []
  /** Force a status and body on one route. */
  readonly overrides = new Map<Route, { status: number; body: unknown; headers?: Record<string, string> }>()
  private server: Server | null = null
  base = ''

  constructor(readonly token: string) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res) })
    await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.base
  }

  async close(): Promise<void> {
    await new Promise<void>(r => (this.server ? this.server.close(() => r()) : r()))
  }

  count(method: string, prefix: string): number {
    return this.seen.filter(s => s.method === method && s.path.startsWith(prefix)).length
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = '<<not json>>' }
    const url = new URL(req.url ?? '/', this.base)
    this.seen.push({ method: req.method ?? '', path: url.pathname + url.search, headers: req.headers, body })

    const prefix = '/api/growth/engines/aeo'
    if (!url.pathname.startsWith(prefix)) return this.send(res, 404, { error: 'not_found' })
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.send(res, 401, { error: 'unauthorized' })
    const rest = url.pathname.slice(prefix.length)
    const route: Route | null = rest === '/attempts' ? 'attempts' : rest === '/directive' ? 'directive' : rest === '/reports' ? 'reports' : rest.startsWith('/reports/') ? 'readback' : rest === '/decisions' ? 'decisions' : null
    if (!route) return this.send(res, 404, { error: 'not_found' })
    const forced = this.overrides.get(route)
    if (forced) return this.send(res, forced.status, forced.body, forced.headers)

    if (route === 'attempts' && req.method === 'POST') {
      const a = body as Attempt
      if (!a || typeof a.attempt_id !== 'string' || !['started', 'succeeded', 'failed', 'unknown'].includes(a.status)) return this.send(res, 400, { error: 'invalid_attempt' })
      if (a.status === 'failed' && !/^[a-z][a-z0-9_]{0,63}$/.test(String(a.error_code))) return this.send(res, 400, { error: 'invalid_attempt', field: 'error_code' })
      if (a.status !== 'started' && !a.finished_at) return this.send(res, 400, { error: 'invalid_attempt', field: 'finished_at' })
      const list = this.attempts.get(a.attempt_id) ?? []
      const done = list.find(x => x.status !== 'started')
      if (done) {
        if (JSON.stringify(done) === JSON.stringify(a)) return this.send(res, 200, { ok: true, attempt: a, replayed: true })
        return this.send(res, 409, { error: 'attempt_terminal' })
      }
      list.push(a)
      this.attempts.set(a.attempt_id, list)
      return this.send(res, 200, { ok: true, attempt: a })
    }
    if (route === 'directive' && req.method === 'GET') return this.send(res, 200, { ok: true, chosen_by: 'rule', directive: this.directive })
    if (route === 'reports' && req.method === 'POST') {
      const r = body as Record<string, unknown>
      if (req.headers['idempotency-key'] !== r?.run_id) return this.send(res, 400, { error: 'idempotency_key' })
      const v = validateReport(r)
      if (!v.ok) return this.send(res, 400, { error: 'invalid_report', errors: v.errors })
      if (r.engine_id !== 'aeo-engine' || r.product_slug !== 'mindmake') return this.send(res, 403, { error: 'forbidden' })
      const sha = reportDigest(r)
      const prior = this.reports.get(String(r.run_id))
      if (prior) {
        if (prior.payload_sha256 === sha) return this.send(res, 200, { accepted: true, run_id: r.run_id, payload_sha256: sha, replayed: true })
        return this.send(res, 409, { error: 'conflict' })
      }
      this.reports.set(String(r.run_id), { payload_sha256: sha, mode: String(r.mode), accepted_at: new Date().toISOString(), report: r })
      return this.send(res, 200, { accepted: true, run_id: r.run_id, payload_sha256: sha, replayed: false })
    }
    if (route === 'readback' && req.method === 'GET') {
      const id = decodeURIComponent(rest.slice('/reports/'.length))
      const s = this.reports.get(id)
      if (!s) return this.send(res, 404, { error: 'not_found' })
      return this.send(res, 200, { accepted: true, run_id: id, ...s })
    }
    if (route === 'decisions' && req.method === 'GET') return this.send(res, 200, { ok: true, decisions: this.decisions })
    return this.send(res, 405, { error: 'method' })
  }
}

/** Collects everything written to stderr while fn runs (log() writes there). */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const real = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = ((chunk: string | Uint8Array) => { text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true }) as typeof process.stderr.write
  try {
    return { result: await fn(), text }
  } finally {
    process.stderr.write = real
  }
}
