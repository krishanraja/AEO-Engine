/**
 * robots.txt, read the way RFC 9309 says a crawler reads it, to answer one
 * question per bot: may this bot read this path? The reader fetches the file
 * as itself (src/clients/site.ts, an honest User-Agent) and resolves the rules
 * for each token; it never poses as the bot.
 *
 * - A group is one or more User-agent lines followed by its rules. Every group
 *   whose user-agent equals the token (case-insensitive, product token only)
 *   applies, merged; with none, the * groups apply; with neither, all is allowed.
 * - The longest matching rule wins; on a tie, Allow wins. * matches any run of
 *   characters and a trailing $ anchors the end.
 * - A missing file (any 4xx) means everything is allowed; /robots.txt itself
 *   is always allowed.
 */

/** The bots whose verdicts the site audit records: search crawlers, and the fetchers an assistant sends for a user. */
export const SEARCH_BOTS = ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Googlebot', 'Bingbot', 'Applebot'] as const
export const USER_BOTS = ['ChatGPT-User', 'Claude-User', 'Perplexity-User'] as const
export const BOT_TOKENS = [...SEARCH_BOTS, ...USER_BOTS] as const
export type BotToken = (typeof BOT_TOKENS)[number]

export interface RobotsRule { allow: boolean; path: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface Robots { groups: RobotsGroup[]; sitemaps: string[] }

export const EMPTY_ROBOTS: Robots = { groups: [], sitemaps: [] }

/** Parses the file. Unknown lines are ignored; a rule before any User-agent line belongs to no group and is dropped. */
export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = []
  const sitemaps: string[] = []
  let current: RobotsGroup | null = null
  let lastWasAgent = false
  for (const raw of String(text ?? '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current) }
      current.agents.push(value.split('/')[0].trim().toLowerCase())
      lastWasAgent = true
      continue
    }
    if (key === 'sitemap') { if (value && !sitemaps.includes(value)) sitemaps.push(value); continue }
    lastWasAgent = false
    if (!current) continue
    if (key === 'allow' || key === 'disallow') current.rules.push({ allow: key === 'allow', path: value })
  }
  return { groups, sitemaps }
}

function ruleRegex(path: string): RegExp {
  const anchored = path.endsWith('$')
  const body = (anchored ? path.slice(0, -1) : path).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${body}${anchored ? '$' : ''}`)
}

/** The rules that apply to one token: its own groups merged, else the * groups, else none. */
export function rulesFor(robots: Robots, token: string): RobotsRule[] {
  const t = token.toLowerCase()
  const own = robots.groups.filter(g => g.agents.includes(t))
  const groups = own.length ? own : robots.groups.filter(g => g.agents.includes('*'))
  return groups.flatMap(g => g.rules)
}

/** May this token read this path (with its query)? Longest match wins, Allow on a tie; an empty Disallow allows. */
export function isAllowed(robots: Robots, token: string, path: string): boolean {
  const p = path.startsWith('/') ? path : `/${path}`
  if (p === '/robots.txt') return true
  let best: RobotsRule | null = null
  for (const r of rulesFor(robots, token)) {
    if (!r.path) continue
    if (!ruleRegex(r.path).test(p)) continue
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow && !best.allow)) best = r
  }
  return best ? best.allow : true
}

/** Each bot's verdict for one path. */
export function verdicts(robots: Robots, path = '/'): Record<BotToken, boolean> {
  const out = {} as Record<BotToken, boolean>
  for (const t of BOT_TOKENS) out[t] = isAllowed(robots, t, path)
  return out
}
