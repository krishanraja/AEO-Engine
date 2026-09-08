/**
 * Control Center as the engine sees it: one read (context), one write
 * (ingest) and one status patch. Bearer AEO_ENGINE_SECRET on every call.
 */
import type { AeoContext } from '../schema/context.js'
import type { AeoPacket } from '../schema/packet.js'
import { HttpError, asArray, asRecord, asString, requestJson } from './http.js'
import type { CommandPatch, ControlCenterClient, IngestResult } from './types.js'

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class ControlCenterHttp implements ControlCenterClient {
  private readonly base: string

  constructor(baseUrl: string, private readonly secret: string, private readonly sleep: (ms: number) => Promise<void> = sleepMs) {
    if (!baseUrl) throw new Error('CONTROL_CENTER_URL is not set')
    if (!secret) throw new Error('AEO_ENGINE_SECRET is not set')
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.secret}` }
  }

  async getContext(subject: string): Promise<AeoContext> {
    const url = `${this.base}/api/aeo/context?subject=${encodeURIComponent(subject)}`
    const r = await requestJson('control_center', url, { headers: this.headers(), timeoutMs: 60_000 })
    if (!r.ok) throw new HttpError('control_center_context', r.status, r.text)
    const j = asRecord(r.json)
    if (j.ok !== true || !Array.isArray(j.subjects)) throw new HttpError('control_center_context', r.status, 'body is not an ok context')
    return j as unknown as AeoContext
  }

  /** 200 and 400 come back as results; 401 and anything else throw. A 429 is retried once after Retry-After. */
  async postIngest(packet: AeoPacket): Promise<IngestResult> {
    const url = `${this.base}/api/aeo/ingest`
    let r = await requestJson('control_center_ingest', url, { method: 'POST', headers: this.headers(), body: packet, timeoutMs: 120_000 })
    if (r.status === 429) {
      const after = Number(r.headers.get('retry-after')) || 30
      await this.sleep(Math.min(after, 300) * 1000)
      r = await requestJson('control_center_ingest', url, { method: 'POST', headers: this.headers(), body: packet, timeoutMs: 120_000 })
    }
    const j = asRecord(r.json)
    if (r.status === 200) return { ...j, ok: true, status: 200 }
    if (r.status === 400) {
      return { ok: false, status: 400, error: asString(j.error) || 'bad request', errors: asArray(j.errors).map(String) }
    }
    if (r.status === 401) throw new HttpError('control_center_ingest', 401, 'unauthorized: check AEO_ENGINE_SECRET')
    throw new HttpError('control_center_ingest', r.status, r.text)
  }

  async patchCommand(body: CommandPatch): Promise<void> {
    const r = await requestJson('control_center_run', `${this.base}/api/aeo/run`, { method: 'PATCH', headers: this.headers(), body, timeoutMs: 30_000 })
    if (!r.ok) throw new HttpError('control_center_run', r.status, r.text)
  }
}
