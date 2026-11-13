/** Host of a URL, lower-cased, without a leading www. Empty when the URL does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The first two path segments with runs of digits replaced by n, so
 * /blog/2026/09/why-ai and /blog/2025/03/pricing both read as /blog/n. This is
 * what the aspiration playbook groups on: the shape of a page, not the page.
 */
export function pathPatternOf(url: string): string {
  try {
    const segs = new URL(String(url)).pathname.split('/').filter(Boolean).slice(0, 2)
    if (!segs.length) return '/'
    return '/' + segs.map(s => s.toLowerCase().replace(/\d+/g, 'n')).join('/')
  } catch {
    return '/'
  }
}

/** True when host is domain or a subdomain of it. A domain with a path (linkedin.com/in/x) matches on the host part only here; urlMatchesDomain honours the path. */
export function hostMatches(host: string, domain: string): boolean {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '').split('/')[0]
  const h = String(host || '').toLowerCase().replace(/^www\./, '')
  return !!d && !!h && (h === d || h.endsWith('.' + d))
}

/**
 * A domain entry as Control Center or config/own-domains.json writes it, split
 * into its host and an optional path prefix: lower-cased, no scheme, no
 * leading www, no query, no trailing slash. "linkedin.com/in/krishraja"
 * is host linkedin.com, path /in/krishraja; "mindmake.co" has no path.
 */
export function splitDomain(domain: string): { host: string; path: string } {
  const d = String(domain || '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
  const i = d.indexOf('/')
  return i < 0 ? { host: d, path: '' } : { host: d.slice(0, i), path: d.slice(i) }
}

/**
 * True when the URL is on the domain. A bare host matches that host or any
 * subdomain of it. A domain with a path matches only that path prefix on that
 * host or its subdomains: "linkedin.com/in/krishraja" matches
 * linkedin.com/in/krishraja/details and uk.linkedin.com/in/krishraja, never
 * linkedin.com/in/krishrajapal or linkedin.com/pulse/anything. A URL without
 * a scheme is read as https; one that still does not parse matches nothing.
 */
export function urlMatchesDomain(url: string, domain: string): boolean {
  const { host, path } = splitDomain(domain)
  if (!host) return false
  const raw = String(url ?? '').trim()
  let u: URL
  try { u = new URL(raw) } catch {
    // A citation written without its scheme (mindmake.co/ctrl) still names a host.
    try { u = new URL(`https://${raw}`) } catch { return false }
  }
  if (!hostMatches(u.hostname, host)) return false
  if (!path) return true
  const p = u.pathname.toLowerCase().replace(/\/+$/, '')
  return p === path || p.startsWith(path + '/')
}

/** 1-based position of the first URL on any of the domains, or null when none is. */
export function ourPosition(urls: readonly string[], domains: readonly string[]): number | null {
  const i = urls.findIndex(u => domains.some(d => urlMatchesDomain(u, d)))
  return i < 0 ? null : i + 1
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * True when the domain is written in the text as a domain of its own. It must
 * start on its own ("notmindmake.co" is not "mindmake.co"; a leading www. is
 * fine) and end on its own ("mindmake.com" is not "mindmake.co", and
 * "linkedin.com/in/krishrajapal" is not "linkedin.com/in/krishraja"); a path
 * after a bare host is fine.
 */
export function mentionsDomain(text: string, domain: string): boolean {
  const { host, path } = splitDomain(domain)
  if (!host) return false
  return new RegExp(`(^|[^a-z0-9.-])(www\\.)?${escapeRe(host + path)}(?![a-z0-9_-]|\\.[a-z0-9])`).test(String(text ?? '').toLowerCase())
}

/**
 * Which of our domains the answer names, in its text or in the sources it
 * cites: a domain written in the answer text (mentionsDomain), or a cited URL
 * on the domain (urlMatchesDomain), is a citation for us. Control Center's
 * geo-probe started this test; since 2026-11-13 it honours a domain's path
 * here and reads the text and the citations apart, so a domain inside some
 * other URL's query string no longer counts. Pass the answer's inline
 * citations, never the raw search results it read and did not cite.
 */
export function ourHits(text: string, citations: readonly string[], domains: readonly string[]): string[] {
  return domains.filter(d => mentionsDomain(text, d) || citations.some(c => urlMatchesDomain(c, d)))
}

/** Unique hosts across a citation list, in first-seen order. */
export function citedHosts(citations: readonly string[]): string[] {
  const out: string[] = []
  for (const c of citations) {
    const h = hostOf(c)
    if (h && !out.includes(h)) out.push(h)
  }
  return out
}
