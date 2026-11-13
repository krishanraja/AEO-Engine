/**
 * What kind of page a cited source is, from its host and path (and its title
 * when one was read), by a fixed table and a few patterns. No fetch, no
 * model. It tells a kit what it is up against: a listicle can be pitched for
 * a place, a forum thread answered, a review site listed on, a vendor page
 * only out-argued.
 */
import { hostMatches, hostOf } from './domains.js'

export const SOURCE_TYPES = ['listicle', 'forum', 'video', 'review', 'news', 'directory', 'reference', 'vendor', 'unknown'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

const FORUM = ['reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'news.ycombinator.com', 'superuser.com', 'serverfault.com', 'discord.com']
const VIDEO = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'loom.com', 'wistia.com']
const REVIEW = ['g2.com', 'capterra.com', 'trustpilot.com', 'getapp.com', 'softwareadvice.com', 'trustradius.com', 'producthunt.com/products', 'sitejabber.com']
const REFERENCE = ['wikipedia.org', 'wikihow.com', 'britannica.com', 'investopedia.com', 'developer.mozilla.org', 'merriam-webster.com', 'dictionary.com']
const NEWS = [
  'forbes.com', 'hbr.org', 'inc.com', 'entrepreneur.com', 'fastcompany.com', 'businessinsider.com', 'bloomberg.com', 'ft.com', 'wsj.com',
  'cnbc.com', 'economist.com', 'nytimes.com', 'techcrunch.com', 'wired.com', 'theverge.com', 'reuters.com', 'apnews.com', 'bbc.co.uk',
  'bbc.com', 'theguardian.com', 'axios.com', 'venturebeat.com', 'zdnet.com', 'cnn.com', 'washingtonpost.com', 'theatlantic.com', 'time.com',
]
const DIRECTORY = ['crunchbase.com', 'producthunt.com', 'clutch.co', 'yelp.com', 'alternativeto.net', 'linkedin.com', 'saasworthy.com', 'theresanaiforthat.com', 'futurepedia.io']

/** "best-", "top-10", "7 best", "x vs y", "alternatives", "compared": the shapes of a ranked list or a comparison. */
const LISTICLE_PATH = /(^|[/_-])(best|top)([/_-]|\d|$)|(^|[/_-])\d+[_-](best|top)([/_-]|$)|[/_-]vs[/_.-]|(^|[/_-])versus([/_-]|$)|alternatives?([/_.-]|$)|(^|[/_-])compar(e|ed|ison)([/_.-]|$)/i
const LISTICLE_TITLE = /\b(best|top)\s+\d*\s*\w+|\b\d+\s+(best|top)\b|\bvs\.?\s|\bversus\b|\balternatives?\b|\bcompared\b/i

/** A company's own page: its product, pricing, features, solutions, docs, blog or home page. */
const VENDOR_PATH = /^\/($|(pricing|features?|products?|solutions?|platform|integrations?|demo|customers?|blog|resources?|guides?|learn|help|docs?|about)(\/|$))/i

const on = (url: string, list: readonly string[]): boolean => {
  const h = hostOf(url)
  if (!h) return false
  let path = '/'
  try { path = new URL(url).pathname.toLowerCase() } catch { /* host only */ }
  return list.some(entry => {
    const i = entry.indexOf('/')
    const host = i < 0 ? entry : entry.slice(0, i)
    const prefix = i < 0 ? '' : entry.slice(i)
    return hostMatches(h, host) && (!prefix || path.startsWith(prefix))
  })
}

/** The source type of a cited URL. `title` is the page's own title when it was read. */
export function classifySource(url: string, title?: string | null): SourceType {
  const h = hostOf(url)
  if (!h) return 'unknown'
  let path = '/'
  try { path = new URL(url).pathname } catch { /* keep / */ }
  if (on(url, FORUM) || /^(community|forum|forums|discuss)\./.test(h) || /^\/(t|forum|forums|community|discussions?|threads?)\//i.test(path)) return 'forum'
  if (on(url, VIDEO)) return 'video'
  if (on(url, REVIEW)) return 'review'
  if (on(url, REFERENCE) || /^(docs|developer|developers|kb|support|help)\./.test(h) || /^\/(docs|documentation|wiki|reference)(\/|$)/i.test(path)) return 'reference'
  if (LISTICLE_PATH.test(path) || (title && LISTICLE_TITLE.test(title))) return 'listicle'
  if (on(url, NEWS)) return 'news'
  if (on(url, DIRECTORY)) return 'directory'
  if (VENDOR_PATH.test(path)) return 'vendor'
  return 'unknown'
}
