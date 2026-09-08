/** One JSON request helper over global fetch, with a deadline. Secrets travel in headers only and are never logged. */
export class HttpError extends Error {
  constructor(public readonly service: string, public readonly status: number, body: string) {
    super(`${service}_${status}: ${body.slice(0, 160)}`)
    this.name = 'HttpError'
  }
}

export interface HttpResult { status: number; ok: boolean; json: unknown; text: string; headers: Headers }

export async function requestJson(
  service: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<HttpResult> {
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000)
  try {
    const r = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    })
    const text = await r.text().catch(() => '')
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: r.status, ok: r.ok, json, text, headers: r.headers }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new HttpError(service, 0, `timeout after ${init.timeoutMs ?? 120_000}ms`)
    throw new HttpError(service, 0, (e as Error)?.message || String(e))
  } finally {
    clearTimeout(tid)
  }
}

/** Throws HttpError unless the response is 2xx; returns the parsed body. */
export async function requireOk(service: string, url: string, init: Parameters<typeof requestJson>[2]): Promise<unknown> {
  const r = await requestJson(service, url, init)
  if (!r.ok) throw new HttpError(service, r.status, r.text)
  return r.json
}

export const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
