/**
 * One URL rule for the cited-pages sheet and the outcome joins: the fragment
 * and every utm_* parameter out, the host lower-cased without a leading www,
 * the path kept as written. Null for anything that is not an http(s) URL.
 */
export function normaliseUrl(raw: string): string | null {
  let u: URL
  try { u = new URL(String(raw ?? '').trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (!host) return null
  let search = u.search
  const tracked = [...u.searchParams.keys()].filter(k => /^utm_/i.test(k))
  if (tracked.length) {
    for (const k of tracked) u.searchParams.delete(k)
    const rest = u.searchParams.toString()
    search = rest ? `?${rest}` : ''
  }
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}${u.pathname}${search}`.slice(0, 500)
}

/**
 * The key two readings of one page are joined on: normaliseUrl, then the
 * scheme and a trailing slash dropped, so http and https, and /a and /a/, meet.
 */
export function pageKey(raw: string): string | null {
  const n = normaliseUrl(raw)
  if (!n) return null
  return n.replace(/^https?:\/\//, '').replace(/\/+(\?|$)/, '$1')
}
