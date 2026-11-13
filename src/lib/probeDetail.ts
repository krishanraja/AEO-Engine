/**
 * What one probe measured about us, read from the answer as the engine gave
 * it, before any cleaning.
 *
 * The packet's probe carries the CLEANED citation list: a URL that holds an
 * email address or an @handle (medium.com/@someone) is dropped there, because
 * the packet refuses one. Reading "first citation" off that list would
 * promote the answer's second source to first whenever its first was such a
 * URL. So the measurement is taken here, from the raw inline citations, and
 * travels beside the packet (never in it: the packet's shape is shared with
 * Control Center and closed) into the sealed run summary, where
 * queries_cited_first is counted.
 *
 * Counts and flags only. No URL, no answer text, no question.
 */
import type { ProbeEngine } from '../schema/packet.js'
import { ourHits, ourPosition, urlMatchesDomain } from './domains.js'

export interface ProbeDetail {
  query_id: string
  /** A gated engine's detail (gemini) is kept and counted in the summary, and never counted toward queries_cited_first while gated. */
  engine: ProbeEngine
  /** The answer's first inline citation is on one of our domains. */
  first_host_ours: boolean
  /** 1-based position of our first inline citation, or null when none is ours. */
  our_position: number | null
  /** Our domain is named in the answer text or in any inline citation. */
  cited_any: boolean
  /** The engine searched the web for this answer (as the engine reports it). */
  searched: boolean
  /** The answer cited no source in its text. */
  zero_citation: boolean
  /**
   * Any URL the engine's search returned (its retrieved list, cited or not) is
   * on one of our domains. False when the engine does not say what it
   * retrieved. The diagnosis reads it (src/pipeline/52-diagnose.ts): a page
   * of ours that is retrieved and not cited is a different miss from one
   * that is never retrieved.
   */
  retrieved_ours: boolean
}

export interface RawAnswer { text: string; citations: readonly string[]; searched?: boolean; retrieved?: readonly string[] }

/**
 * The detail of one probe, from the answer's raw inline citations. When an
 * engine does not say whether it searched, a cited source is taken as the
 * sign that it did.
 */
export function probeDetail(queryId: string, engine: ProbeEngine, a: RawAnswer, domains: readonly string[]): ProbeDetail {
  const citations = a.citations.filter(c => typeof c === 'string' && c.trim().length > 0)
  const position = ourPosition(citations, domains)
  return {
    query_id: queryId,
    engine,
    first_host_ours: position === 1,
    our_position: position,
    cited_any: ourHits(a.text, citations, domains).length > 0,
    searched: typeof a.searched === 'boolean' ? a.searched : citations.length > 0,
    zero_citation: citations.length === 0,
    retrieved_ours: (a.retrieved ?? []).some(u => typeof u === 'string' && domains.some(d => urlMatchesDomain(u, d))),
  }
}
