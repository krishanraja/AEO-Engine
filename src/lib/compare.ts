/**
 * The two Claude lanes side by side, in `compare` mode (src/config/run.ts,
 * CLAUDE_LANES): the Claude Code lane answers every question, and the API
 * lane answers the first few of each subject beside it. Only the code lane's
 * answer enters the packet; this tally is what the API lane is read against,
 * and it travels in the sealed run summary as counts only. No URL, no host,
 * no answer text.
 *
 *   per lane         answered, searched, inline citations, answers citing nothing
 *   first host       of the questions both lanes cited a source on, how often
 *                    their first cited hosts agree
 *   retrieved hosts  summed over questions both lanes answered, the hosts both
 *                    lanes' searches returned and the hosts either returned
 */
import type { EngineAnswer } from '../clients/types.js'
import { hostOf } from './domains.js'

export interface LaneCounts { answered: number; searched: number; inline_citations: number; zero_citation: number }

export interface CompareCounts {
  /** Questions both lanes were asked. */
  questions: number
  code: LaneCounts
  api: LaneCounts
  code_failed: number
  api_failed: number
  /** Questions where both lanes cited at least one source in their text. */
  both_cited: number
  /** Of those, how many share the first cited host. */
  first_host_agree: number
  retrieved_hosts_shared: number
  retrieved_hosts_union: number
}

const lane = (): LaneCounts => ({ answered: 0, searched: 0, inline_citations: 0, zero_citation: 0 })

export function emptyCompare(): CompareCounts {
  return { questions: 0, code: lane(), api: lane(), code_failed: 0, api_failed: 0, both_cited: 0, first_host_agree: 0, retrieved_hosts_shared: 0, retrieved_hosts_union: 0 }
}

function countLane(c: LaneCounts, a: EngineAnswer): void {
  const citations = a.citations.filter(Boolean)
  c.answered++
  if (a.searched === true || (a.searched === undefined && citations.length > 0)) c.searched++
  c.inline_citations += citations.length
  if (!citations.length) c.zero_citation++
}

const hosts = (urls: readonly string[] | undefined) => new Set((urls ?? []).map(hostOf).filter(Boolean))

/** Adds one question's pair to the tally. A lane that failed is null. Mutates `t`. */
export function tallyCompare(t: CompareCounts, code: EngineAnswer | null, api: EngineAnswer | null): void {
  t.questions++
  if (code) countLane(t.code, code)
  else t.code_failed++
  if (api) countLane(t.api, api)
  else t.api_failed++
  if (!code || !api) return
  const cf = hostOf(code.citations[0] ?? '')
  const af = hostOf(api.citations[0] ?? '')
  if (cf && af) {
    t.both_cited++
    if (cf === af) t.first_host_agree++
  }
  const ch = hosts(code.retrieved)
  const ah = hosts(api.retrieved)
  for (const h of ch) if (ah.has(h)) t.retrieved_hosts_shared++
  t.retrieved_hosts_union += new Set([...ch, ...ah]).size
}
