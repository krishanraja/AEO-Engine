/**
 * A host's page inventory from its sitemaps: the ones robots.txt declares,
 * else /sitemap.xml. A sitemap index is followed two levels deep (index, its
 * children, their children), and no more. At most 200 page URLs a host, each
 * on that host, each once. Read through the site fetcher, so every sitemap
 * request counts against the host's budget.
 */
import { registrableDomain, type SiteFetcher } from '../clients/site.js'
import { CAPS } from '../config/run.js'
import { decodeEntities } from './html.js'

export interface SitemapParse { kind: 'urlset' | 'index' | 'unknown'; locs: string[] }

/** The <loc> entries of a sitemap or a sitemap index. Tolerant: a missing close tag ends the entry at the next tag. */
export function parseSitemap(xml: string): SitemapParse {
  const s = String(xml ?? '')
  const kind: SitemapParse['kind'] = /<sitemapindex\b/i.test(s) ? 'index' : /<urlset\b/i.test(s) ? 'urlset' : 'unknown'
  const locs: string[] = []
  for (const m of s.matchAll(/<loc\b[^<>]*>([\s\S]*?)(?:<\/loc\s*>|(?=<(?!!\[CDATA\[))|$)/gi)) {
    const v = decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim()
    if (v && !locs.includes(v)) locs.push(v)
  }
  return { kind, locs }
}

export interface SitemapInventory {
  /** A sitemap was read and parsed (urlset or index). */
  present: boolean
  urls: string[]
  /** Sitemap files requested. */
  files: number
  /** Sitemap files not requested because `allowed` (robots.txt) closed them. */
  refused: number
}

const sameHost = (u: string, host: string): boolean => {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') === host.replace(/^www\./, '') } catch { return false }
}

/**
 * Reads the inventory. `declared` is robots.txt's Sitemap lines; empty means
 * /sitemap.xml. Two levels below the first file, at most `maxFiles` files and
 * `maxUrls` URLs. `allowed`, when given, is asked before each file is
 * requested (robots.txt for this reader); a file it closes is never read.
 */
export async function readSitemaps(host: string, declared: readonly string[], fetcher: SiteFetcher, o: { maxUrls?: number; maxFiles?: number; maxDepth?: number; allowed?: (url: URL) => boolean } = {}): Promise<SitemapInventory> {
  const maxUrls = o.maxUrls ?? CAPS.SITE_MAX_SITEMAP_URLS_PER_HOST
  const maxFiles = o.maxFiles ?? CAPS.SITE_MAX_SITEMAPS_PER_HOST
  const maxDepth = o.maxDepth ?? 2
  const queue: Array<{ url: string; depth: number }> = (declared.length ? [...declared] : [`https://${host}/sitemap.xml`]).map(url => ({ url, depth: 0 }))
  const seen = new Set<string>()
  const urls: string[] = []
  let present = false
  let files = 0
  let refused = 0
  while (queue.length && files < maxFiles && urls.length < maxUrls) {
    const { url, depth } = queue.shift()!
    if (seen.has(url)) continue
    seen.add(url)
    let parsed: URL
    try { parsed = new URL(url) } catch { continue }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue
    // A sitemap on another domain is that domain's, and is never read for this host.
    if (registrableDomain(parsed.hostname) !== registrableDomain(host)) continue
    if (o.allowed && !o.allowed(parsed)) { refused++; continue }
    files++
    const r = await fetcher.get(url)
    if (!r || r.status < 200 || r.status >= 300) continue
    const sm = parseSitemap(r.text)
    if (sm.kind === 'unknown') continue
    present = true
    if (sm.kind === 'index') {
      if (depth < maxDepth) for (const loc of sm.locs) queue.push({ url: loc, depth: depth + 1 })
      continue
    }
    for (const loc of sm.locs) {
      if (urls.length >= maxUrls) break
      if (sameHost(loc, host) && !urls.includes(loc)) urls.push(loc)
    }
  }
  return { present, urls, files, refused }
}
