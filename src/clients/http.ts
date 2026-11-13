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
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; redirect?: RequestRedirect },
): Promise<HttpResult> {
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000)
  try {
    const r = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
      // 'manual' hands a 3xx back to the caller instead of following it, so a
      // bearer is never carried to a host the caller did not name.
      redirect: init.redirect ?? 'follow',
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

/**
 * The content types the site reader takes: HTML, XML, plain text, Markdown and
 * JSON (JSON-LD included). Anything else (an image, a script, a stylesheet, a
 * PDF, a font) is never read.
 */
export function isTextType(contentType: string | null | undefined): boolean {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (!t) return false
  return t === 'text/html' || t === 'application/xhtml+xml' || t === 'text/xml' || t === 'application/xml'
    || t.endsWith('+xml') || t === 'text/plain' || t === 'text/markdown' || t === 'text/x-markdown'
    || t === 'application/json' || t === 'application/ld+json'
}

export interface TextResult { status: number; headers: Headers; text: string; url: string; truncated: boolean }

/**
 * One GET for a text resource, with a deadline (the requestJson pattern) and a
 * body cap. It never follows a redirect: `redirect: 'manual'` hands a 3xx
 * back with its Location, so the caller decides whether the next hop is
 * allowed, and it never throws on a 3xx, a 4xx or a 5xx. A body whose type is
 * not text is not read at all (text is empty); a text body is read up to
 * maxBytes and cut there. Only a network failure or the deadline throws.
 */
export async function requestText(url: string, init: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {}): Promise<TextResult> {
  const timeoutMs = init.timeoutMs ?? 15_000
  const maxBytes = init.maxBytes ?? 512 * 1024
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await (init.fetchImpl ?? fetch)(url, { method: 'GET', headers: { ...(init.headers ?? {}) }, signal: ctrl.signal, redirect: 'manual' })
    let text = ''
    let truncated = false
    if (r.body && isTextType(r.headers.get('content-type'))) {
      const reader = r.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
      }
      if (total >= maxBytes) { truncated = true; await reader.cancel().catch(() => undefined) }
      const all = new Uint8Array(Math.min(total, maxBytes))
      let at = 0
      for (const c of chunks) {
        if (at >= all.length) break
        const part = c.subarray(0, all.length - at)
        all.set(part, at)
        at += part.byteLength
      }
      text = new TextDecoder('utf-8', { fatal: false }).decode(all)
    } else if (r.body) {
      await r.body.cancel().catch(() => undefined)
    }
    return { status: r.status, headers: r.headers, text, url, truncated }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new HttpError('site', 0, `timeout after ${timeoutMs}ms`)
    throw new HttpError('site', 0, (e as Error)?.name || 'fetch_failed')
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
