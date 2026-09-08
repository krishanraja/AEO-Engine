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

/** True when host is domain or a subdomain of it. A domain with a path (linkedin.com/in/x) matches on the host part only here. */
export function hostMatches(host: string, domain: string): boolean {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '').split('/')[0]
  const h = String(host || '').toLowerCase().replace(/^www\./, '')
  return !!d && !!h && (h === d || h.endsWith('.' + d))
}

/**
 * Which of our domains the answer text or its citations actually mention.
 * Same test as Control Center's geo-probe: a domain string in the answer or
 * a citation host on our list is a citation for us.
 */
export function ourHits(text: string, citations: readonly string[], domains: readonly string[]): string[] {
  const blob = `${text} ${citations.join(' ')}`.toLowerCase()
  const hosts = citations.map(hostOf)
  return domains.filter(d => {
    const dl = d.toLowerCase()
    // A domain in the text must start on its own: "notmindmake.co" is not "mindmake.co".
    const inText = new RegExp(`(^|[^a-z0-9.-])${dl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`).test(blob)
    return inText || hosts.some(h => hostMatches(h, dl))
  })
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
