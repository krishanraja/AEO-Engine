/**
 * Stage 40: ask the engines. A venture's requested questions first, then the
 * most valuable of the rest, every engine for each, until the per-subject
 * limit or the USD cap. A failed engine call writes nothing for that pair and
 * is counted; nothing is ever invented.
 *
 * What each answer measured about us (first citation, position, cited
 * anywhere, searched) is read here from its raw inline citations, before the
 * packet's cleaning can drop or reorder one, and kept beside the packet as a
 * ProbeDetail (src/lib/probeDetail.ts).
 */
import { CAPS } from '../config/run.js'
import type { EngineClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { ourHits } from '../lib/domains.js'
import { errText, log } from '../lib/log.js'
import { probeDetail, type ProbeDetail } from '../lib/probeDetail.js'
import { CLEAN, EMAIL_RE, HANDLE_RE, scrubPII } from '../lib/text.js'
import type { Probe, QuerySource } from '../schema/packet.js'
import type { ProposedQuery } from './30-propose.js'

export interface ProbeOutcome {
  probesByQuery: Map<string, Probe[]>
  /** Per probed question, what each answer measured about us, in engine order. Never in the packet. */
  detailsByQuery?: Map<string, ProbeDetail[]>
  probes: number
  probes_failed: number
  probes_skipped_cap: number
}

const SOURCE_RANK: Record<QuerySource, number> = { gap: 0, transcript: 1, room_signal: 2, striking_distance: 3, watch_carry: 4, seed: 5 }

/**
 * How many of one subject's questions are probed: the usual limit, raised so
 * every requested question is asked with MIN_EXPLORATION_QUERIES of the
 * engine's own beside them, and never above MAX_PROBED_QUERIES_HARD.
 */
export function probeLimitFor(requestedCount: number): number {
  return Math.min(CAPS.MAX_PROBED_QUERIES_HARD, Math.max(CAPS.MAX_PROBED_QUERIES_PER_SUBJECT, requestedCount + CAPS.MIN_EXPLORATION_QUERIES))
}

/**
 * Requested questions first, in the order they were requested; then prior
 * demand; then gap, transcript, room signal, striking distance, watch carry,
 * seed. Stable.
 */
export function orderForProbing(queries: readonly ProposedQuery[]): ProposedQuery[] {
  return queries
    .map((q, i) => ({ q, i }))
    .sort((a, b) => {
      const qa = a.q.requested === true ? 0 : 1
      const qb = b.q.requested === true ? 0 : 1
      if (qa !== qb) return qa - qb
      if (qa === 0) return a.i - b.i
      const pa = a.q.prior?.demand_score ?? -1
      const pb = b.q.prior?.demand_score ?? -1
      if (pa !== pb) return pb - pa
      const ra = SOURCE_RANK[a.q.source] ?? 9
      const rb = SOURCE_RANK[b.q.source] ?? 9
      return ra - rb || a.i - b.i
    })
    .map(x => x.q)
}

function cleanCitation(u: string): string | null {
  const s = String(u).trim().slice(0, 500)
  EMAIL_RE.lastIndex = 0
  HANDLE_RE.lastIndex = 0
  if (!s || EMAIL_RE.test(s) || HANDLE_RE.test(s)) return null
  return s
}

export async function probeQueries(
  engines: readonly EngineClient[],
  proposed: readonly ProposedQuery[],
  krishHitsDomains: readonly string[],
  ledger: Ledger,
  neverSay: readonly string[] = [],
  maxQueries: number = CAPS.MAX_PROBED_QUERIES_PER_SUBJECT,
  /**
   * USD of the subject's share held back for the calls made after the probes
   * (the digest, and the voice pass when Krish has approved a rule). Without
   * it a subject asking thirty questions spent its whole share on probes and
   * its digest fell back every run, because the digest is charged last.
   */
  reserveUsd = 0,
): Promise<ProbeOutcome> {
  const out: ProbeOutcome = { probesByQuery: new Map(), detailsByQuery: new Map(), probes: 0, probes_failed: 0, probes_skipped_cap: 0 }
  const details = out.detailsByQuery as Map<string, ProbeDetail[]>
  const ordered = orderForProbing(proposed).slice(0, maxQueries)
  let capHit = false
  // One question at a time, its engines together.
  //
  // The first live run asked five subjects x twenty questions x three
  // assistants one after another and was still going at fifty minutes, so the
  // job's own timeout killed it before anything shipped. A hosted web search
  // takes seconds, and the three assistants have nothing to say to each
  // other, so they run together. The questions stay sequential on purpose:
  // the spend cap is checked and charged before a question is asked, and
  // keeping that decision on one thread is what makes the cap exact rather
  // than approximate.
  for (const q of ordered) {
    const affordable: EngineClient[] = []
    // A question's engines are charged together below, so each is checked
    // against the cap with the ones before it already counted.
    let pending = 0
    for (const engine of engines) {
      if (capHit || !ledger.canAfford(engine.engine, pending + reserveUsd)) {
        if (!capHit) log('cap_reached', { at_usd: ledger.total, cap_usd: ledger.capUsd })
        capHit = true
        out.probes_skipped_cap++
        continue
      }
      affordable.push(engine)
      pending += ledger.priceOf(engine.engine)
    }
    if (!affordable.length) continue

    const charged = affordable.map(engine => ({ engine, cost: ledger.charge(engine.engine, `probe ${engine.engine}`) }))
    const settled = await Promise.all(charged.map(async ({ engine, cost }): Promise<{ probe: Probe; detail: ProbeDetail } | null> => {
      try {
        const a = await engine.ask(q.query)
        const raw = Array.isArray(a.citations) ? a.citations.map(String) : []
        // Measured before cleaning: cleaning drops a URL that carries an
        // email or a handle, which would promote a later source to first.
        const detail = probeDetail(q.query_id, engine.engine, { text: a.text, citations: raw, searched: a.searched }, krishHitsDomains)
        const citations = raw.map(cleanCitation).filter((c): c is string => !!c).slice(0, CAPS.MAX_CITATIONS)
        const probe: Probe = {
          engine: engine.engine,
          model: engine.model.slice(0, 80),
          question: q.query,
          answer_snapshot: scrubPII(CLEAN(a.text, CAPS.ANSWER_SNAPSHOT_CHARS), neverSay),
          // From the text and the INLINE citations: a search result the
          // answer read and did not cite is not a citation for us.
          we_cited: ourHits(a.text, raw, krishHitsDomains).length > 0,
          citations,
          cost_usd: cost,
        }
        return { probe, detail }
      } catch (e) {
        log('probe_failed', { engine: engine.engine, query_id: q.query_id, error: errText(e) })
        return null
      }
    }))

    // Engine order is preserved, so a packet does not change shape with the
    // weather. A failed call writes nothing and is counted, as before.
    const rows = settled.filter((r): r is { probe: Probe; detail: ProbeDetail } => r !== null)
    out.probes += rows.length
    out.probes_failed += settled.length - rows.length
    if (rows.length) {
      out.probesByQuery.set(q.query_id, rows.map(r => r.probe))
      details.set(q.query_id, rows.map(r => r.detail))
    }
  }
  const all = [...details.values()].flat()
  // `requested` counts the requested questions an assistant actually answered,
  // not those inside the limit: the spend cap or a failed call can stop one.
  log('probed', {
    queries: ordered.length, requested: ordered.filter(q => q.requested && out.probesByQuery.has(q.query_id)).length, requested_total: proposed.filter(q => q.requested).length,
    probes: out.probes, failed: out.probes_failed, skipped_cap: out.probes_skipped_cap,
    searched: all.filter(d => d.searched).length, zero_citation: all.filter(d => d.zero_citation).length,
  })
  return out
}
