/**
 * Stage 40: ask the engines. The most valuable questions first, every engine
 * for each, until the per-subject cap or the USD cap. A failed engine call
 * writes nothing for that pair and is counted; nothing is ever invented.
 */
import { CAPS } from '../config/run.js'
import type { EngineClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { ourHits } from '../lib/domains.js'
import { errText, log } from '../lib/log.js'
import { CLEAN, EMAIL_RE, HANDLE_RE, scrubPII } from '../lib/text.js'
import type { Probe, QuerySource } from '../schema/packet.js'
import type { ProposedQuery } from './30-propose.js'

export interface ProbeOutcome {
  probesByQuery: Map<string, Probe[]>
  probes: number
  probes_failed: number
  probes_skipped_cap: number
}

const SOURCE_RANK: Record<QuerySource, number> = { gap: 0, transcript: 1, room_signal: 2, striking_distance: 3, watch_carry: 4, seed: 5 }

/** Prior demand first, then gap, transcript, room signal, then the rest. Stable. */
export function orderForProbing(queries: readonly ProposedQuery[]): ProposedQuery[] {
  return queries
    .map((q, i) => ({ q, i }))
    .sort((a, b) => {
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
): Promise<ProbeOutcome> {
  const out: ProbeOutcome = { probesByQuery: new Map(), probes: 0, probes_failed: 0, probes_skipped_cap: 0 }
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
    for (const engine of engines) {
      if (capHit || !ledger.canAfford(engine.engine)) {
        if (!capHit) log('cap_reached', { at_usd: ledger.total, cap_usd: ledger.capUsd })
        capHit = true
        out.probes_skipped_cap++
        continue
      }
      affordable.push(engine)
    }
    if (!affordable.length) continue

    const charged = affordable.map(engine => ({ engine, cost: ledger.charge(engine.engine, `probe ${engine.engine}`) }))
    const settled = await Promise.all(charged.map(async ({ engine, cost }): Promise<Probe | null> => {
      try {
        const a = await engine.ask(q.query)
        const citations = a.citations.map(cleanCitation).filter((c): c is string => !!c).slice(0, CAPS.MAX_CITATIONS)
        return {
          engine: engine.engine,
          model: engine.model.slice(0, 80),
          question: q.query,
          answer_snapshot: scrubPII(CLEAN(a.text, CAPS.ANSWER_SNAPSHOT_CHARS), neverSay),
          we_cited: ourHits(a.text, a.citations, krishHitsDomains).length > 0,
          citations,
          cost_usd: cost,
        }
      } catch (e) {
        log('probe_failed', { engine: engine.engine, query_id: q.query_id, error: errText(e) })
        return null
      }
    }))

    // Engine order is preserved, so a packet does not change shape with the
    // weather. A failed call writes nothing and is counted, as before.
    const rows = settled.filter((r): r is Probe => r !== null)
    out.probes += rows.length
    out.probes_failed += settled.length - rows.length
    if (rows.length) out.probesByQuery.set(q.query_id, rows)
  }
  log('probed', { queries: ordered.length, probes: out.probes, failed: out.probes_failed, skipped_cap: out.probes_skipped_cap })
  return out
}
