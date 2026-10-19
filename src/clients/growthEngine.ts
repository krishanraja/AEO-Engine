/**
 * Control Center's growth engine protocol, as this engine's bearer opens it:
 * attempts, the directive, reports with their readback, and decisions, all
 * under {CONTROL_CENTER_URL}/api/growth/engines/aeo/. It sits beside the
 * packet client (controlCenter.ts), which it does not touch: the packet
 * ingest keeps its own routes and its own secret.
 *
 * HTTPS only (plain http is allowed to a loopback host, which is how the
 * tests' stand-in server runs), no redirect followed, twenty seconds a call,
 * JSON only. The bearer lives in one private field and goes into one header;
 * no error, log line or return value ever carries it. A failure surfaces as
 * a ProtocolError holding a lower_snake code and the HTTP status, never the
 * body: a code is what an attempt records.
 */
import { asArray, asRecord, asString, requestJson, type HttpResult } from './http.js'
import { ENGINE, type Attempt, type Decision, type Directive, type EngineReport } from '../schema/report.js'

export class ProtocolError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code)
    this.name = 'ProtocolError'
  }
}

export interface StoredReport { run_id: string; payload_sha256: string; mode: string; accepted_at: string; report: Record<string, unknown> }

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Throws ProtocolError url_missing or url_insecure; returns the base without a trailing slash. */
export function protocolBase(raw: string | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s) throw new ProtocolError('url_missing', 0)
  let u: URL
  try { u = new URL(s) } catch { throw new ProtocolError('url_invalid', 0) }
  if (u.protocol === 'https:') return s.replace(/\/+$/, '')
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return s.replace(/\/+$/, '')
  throw new ProtocolError('url_insecure', 0)
}

/** The lower_snake code for a non-2xx answer on one route. */
export function codeFor(what: string, r: Pick<HttpResult, 'status' | 'json'>): string {
  const s = r.status
  if (s >= 300 && s < 400) return 'redirect_refused'
  if (s === 400) return `${what}_refused`
  if (s === 401) return 'unauthorized'
  if (s === 403) return 'forbidden'
  if (s === 404) return `${what}_not_found`
  if (s === 409) return asString(asRecord(r.json).error) === 'engine_inactive' ? 'engine_inactive' : `${what}_conflict`
  if (s === 413) return `${what}_too_large`
  if (s === 429) return 'rate_limited'
  if (s >= 500) return `${what}_server_error`
  return `${what}_http_${s}`
}

export class GrowthEngineHttp {
  private readonly base: string
  readonly #token: string

  constructor(baseUrl: string | undefined, token: string | undefined, private readonly timeoutMs = 20_000) {
    this.base = `${protocolBase(baseUrl)}/api/growth/engines/${ENGINE.slug}`
    if (!token) throw new ProtocolError('token_missing', 0)
    this.#token = token
  }

  private async call(what: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<HttpResult> {
    try {
      return await requestJson(`growth_${what}`, `${this.base}${path}`, {
        method: init.method,
        body: init.body,
        headers: { authorization: `Bearer ${this.#token}`, ...(init.headers ?? {}) },
        timeoutMs: this.timeoutMs,
        redirect: 'manual',
      })
    } catch (e) {
      // HttpError with status 0: the deadline or the network. The message is
      // not carried on, only which of the two it was.
      throw new ProtocolError(/timeout/.test(String((e as Error)?.message)) ? `${what}_timeout` : `${what}_network_error`, 0)
    }
  }

  async postAttempt(a: Attempt): Promise<{ replayed: boolean }> {
    const r = await this.call('attempt', '/attempts', { method: 'POST', body: a })
    if (!r.ok) throw new ProtocolError(codeFor('attempt', r), r.status)
    return { replayed: asRecord(r.json).replayed === true }
  }

  async getDirective(date?: string): Promise<{ chosen_by: string; directive: Directive }> {
    const r = await this.call('directive', `/directive${date ? `?date=${encodeURIComponent(date)}` : ''}`)
    if (!r.ok) throw new ProtocolError(codeFor('directive', r), r.status)
    const j = asRecord(r.json)
    const d = asRecord(j.directive)
    if (j.ok !== true || typeof d.directive_id !== 'string') throw new ProtocolError('directive_invalid', r.status)
    return { chosen_by: asString(j.chosen_by), directive: d as unknown as Directive }
  }

  /** One POST, never retried here. A 409 is report_conflict: the caller reads back before deciding anything. */
  async postReport(report: EngineReport): Promise<{ replayed: boolean; payload_sha256: string }> {
    const r = await this.call('report', '/reports', { method: 'POST', body: report, headers: { 'idempotency-key': report.run_id } })
    if (!r.ok) throw new ProtocolError(codeFor('report', r), r.status)
    const j = asRecord(r.json)
    if (j.accepted !== true) throw new ProtocolError('report_not_accepted', r.status)
    return { replayed: j.replayed === true, payload_sha256: asString(j.payload_sha256) }
  }

  /** The stored report for a run, or null when Control Center has none. */
  async getReport(runId: string): Promise<StoredReport | null> {
    const r = await this.call('readback', `/reports/${encodeURIComponent(runId)}`)
    if (r.status === 404) return null
    if (!r.ok) throw new ProtocolError(codeFor('readback', r), r.status)
    const j = asRecord(r.json)
    if (j.accepted !== true || typeof j.payload_sha256 !== 'string') throw new ProtocolError('readback_invalid', r.status)
    return { run_id: asString(j.run_id), payload_sha256: j.payload_sha256, mode: asString(j.mode), accepted_at: asString(j.accepted_at), report: asRecord(j.report) }
  }

  async getDecisions(since: string): Promise<Decision[]> {
    const r = await this.call('decisions', `/decisions?since=${encodeURIComponent(since)}`)
    if (!r.ok) throw new ProtocolError(codeFor('decisions', r), r.status)
    const j = asRecord(r.json)
    if (j.ok !== true) throw new ProtocolError('decisions_invalid', r.status)
    return asArray(j.decisions).map(asRecord).filter(d => typeof d.proposal_id === 'string').map(d => ({
      proposal_id: d.proposal_id as string,
      decision: d.decision as Decision['decision'],
      decided_at: asString(d.decided_at),
      payload_sha256: typeof d.payload_sha256 === 'string' ? d.payload_sha256 : null,
    }))
  }
}
