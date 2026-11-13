/**
 * Hosts that own an answer by reach and format rather than by argument: social
 * networks, video platforms, encyclopaedias and answer aggregators, national
 * business titles, and the big consultancies. One piece does not displace any
 * of them, so a question they own is a wall and not a gap. The list is
 * deliberately short and deliberately obvious; it exists so the deterministic
 * fallback can answer "who owns this now" without a model, and it never
 * decides anything on its own beyond that one question.
 *
 * Kept here, not in the digest (src/pipeline/60-digest.ts re-exports it), so
 * the diagnosis (52-diagnose.ts) and the site reader (15-site.ts) read the
 * same list without importing the digest.
 */
import { hostMatches } from './domains.js'

export const GENERAL_PLATFORMS: readonly string[] = [
  'linkedin.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com',
  'reddit.com', 'quora.com', 'medium.com', 'wikipedia.org', 'pinterest.com',
  'forbes.com', 'hbr.org', 'inc.com', 'entrepreneur.com', 'fastcompany.com', 'businessinsider.com',
  'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'economist.com', 'nytimes.com', 'techcrunch.com',
  'wired.com', 'theverge.com', 'gartner.com',
  'mckinsey.com', 'bcg.com', 'bain.com', 'deloitte.com', 'accenture.com', 'pwc.com', 'ey.com', 'kpmg.com', 'ibm.com',
]

/** True when the host is one of the general platforms, or a subdomain of one. */
export function isGeneralPlatform(host: string): boolean {
  return GENERAL_PLATFORMS.some(p => hostMatches(String(host), p))
}

/** Which of these cited hosts are large general platforms, in the order given. */
export function generalPlatformsAmong(hosts: readonly string[]): string[] {
  return hosts.filter(h => isGeneralPlatform(h))
}

/**
 * Rule one of the winnability judgement, made deterministically: the answer is
 * owned when more than half the hosts cited on it are large general platforms.
 * A majority rather than a single hit, because one social link beside two
 * specialists is still a question a specialist won and a specialist can take.
 */
export function ownedByPlatforms(hosts: readonly string[]): string[] {
  const owners = generalPlatformsAmong(hosts)
  return owners.length * 2 > hosts.length ? owners : []
}
