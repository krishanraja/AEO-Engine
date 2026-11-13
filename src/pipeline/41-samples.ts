/**
 * Repeat samples, after the first pass (stage 40). One answer can look like a
 * win and be noise, so a contested question is asked twice more on every
 * engine that answered it, and the panel's win rule (src/schema/panel.ts)
 * reads all three: first citation ours on 2 of 3 samples on at least one
 * engine.
 *
 * Contested, for this purpose (src/pipeline/55-panel.ts, sampleSet): a
 * question cited anywhere this run, won last run, or one a venture shipped a
 * page for or Krish approved a kit plan on; at most
 * CAPS.MAX_SAMPLED_QUESTIONS_PER_SUBJECT a subject.
 *
 * Every re-ask is charged to the ledger before it is made, inside the cap and
 * the subject's reserve, exactly as a first-pass probe (the Claude Code lane
 * is free). A re-ask the cap stops is counted, never made, and the panel
 * reads a question so cut short as one no engine can win on a single answer
 * (src/schema/panel.ts, engineWon). Only the counts are kept, on the first answer's ProbeDetail as
 * `samples`: the first sample's own fields are never changed, so
 * queries_cited_first, the diagnosis and the packet's probes stay on sample
 * one and stay comparable with every earlier run.
 */
import { SUBSCRIPTION_KINDS } from '../config/run.js'
import { FreeTierExhausted, SubscriptionLimit, type EngineAnswer, type EngineClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import { probeDetail, type ProbeDetail } from '../lib/probeDetail.js'
import { inPacket, type GatedEngine } from '../schema/packet.js'
import { SAMPLES_PER_CONTESTED } from '../schema/panel.js'
import { costKindOf, type ProbeOutcome } from './40-probe.js'

export interface SampleOutcome {
  /** Questions re-asked: at least one re-ask made (one the cap stopped every re-ask of is not counted). */
  questions: number
  /** Re-asks charged and made, and those that answered. */
  asks: number
  answers: number
  failed: number
  /** Re-asks the cap stopped. */
  skipped_cap: number
}

export interface SampleOptions {
  /** The gated engines the context opened: only the packet's engines are re-asked, since only they decide a win. */
  open?: readonly GatedEngine[]
  /** Extra asks per question, after the first: SAMPLES_PER_CONTESTED - 1. */
  rounds?: number
}

/** The samples a detail starts from: its own first answer. */
function firstSample(d: ProbeDetail): NonNullable<ProbeDetail['samples']> {
  return { n: 1, first: d.first_host_ours ? 1 : 0, cited: d.cited_any ? 1 : 0 }
}

export async function resample(
  engines: readonly EngineClient[],
  outcome: ProbeOutcome,
  questions: ReadonlyArray<{ query_id: string; query: string }>,
  domains: readonly string[],
  ledger: Ledger,
  reserveUsd = 0,
  opts: SampleOptions = {},
): Promise<SampleOutcome> {
  const out: SampleOutcome = { questions: 0, asks: 0, answers: 0, failed: 0, skipped_cap: 0 }
  const rounds = Math.max(0, opts.rounds ?? SAMPLES_PER_CONTESTED - 1)
  const open = opts.open ?? []
  let capHit = false
  for (const q of questions) {
    const details = outcome.detailsByQuery?.get(q.query_id) ?? []
    // Only an engine that answered the first pass, and only the packet's.
    const asking = engines.filter(e => inPacket(e.engine, open) && details.some(d => d.engine === e.engine))
    if (!asking.length) continue
    let made = 0
    for (const d of details) if (asking.some(e => e.engine === d.engine)) d.samples = firstSample(d)
    for (let round = 0; round < rounds; round++) {
      const affordable: EngineClient[] = []
      let pending = 0
      let stopped = 0
      for (const engine of asking) {
        if (engine.exhausted === true) continue
        const kind = costKindOf(engine)
        const free = SUBSCRIPTION_KINDS.includes(kind)
        if ((capHit && !free) || !ledger.canAfford(kind, pending + reserveUsd)) {
          if (!capHit) log('cap_reached', { at_usd: ledger.total, cap_usd: ledger.capUsd, stage: 'samples' })
          capHit = true
          stopped++
          continue
        }
        affordable.push(engine)
        pending += free ? 0 : ledger.priceOf(kind)
      }
      out.skipped_cap += stopped
      // Nothing affordable: the rounds left are stopped by the cap too, and counted.
      if (!affordable.length) { out.skipped_cap += stopped * (rounds - round - 1); break }
      const charged = affordable.map(engine => { ledger.charge(costKindOf(engine), `sample ${engine.engine}`); return engine })
      out.asks += charged.length
      made += charged.length
      const answers = await Promise.all(charged.map(async (engine): Promise<{ engine: EngineClient; a: EngineAnswer | null }> => {
        try {
          try {
            return { engine, a: await engine.ask(q.query, { domains }) }
          } catch (e) {
            // code_then_api: the subscription's limit hands the re-ask to the paid lane, inside the same cap.
            const fb = engine.fallback
            if (!(e instanceof SubscriptionLimit) || !fb || capHit || !ledger.canAfford(costKindOf(fb), reserveUsd)) throw e
            ledger.charge(costKindOf(fb), `sample ${fb.engine} fallback`)
            return { engine, a: await fb.ask(q.query, { domains }) }
          }
        } catch (e) {
          if (e instanceof FreeTierExhausted) {
            ledger.refund(costKindOf(engine), `sample ${engine.engine}`)
            out.asks--
            made--
            return { engine, a: null }
          }
          out.failed++
          log('sample_failed', { engine: engine.engine, query_id: q.query_id, error: errText(e) })
          return { engine, a: null }
        }
      }))
      for (const { engine, a } of answers) {
        if (!a) continue
        const d = details.find(x => x.engine === engine.engine)
        if (!d?.samples) continue
        const raw = Array.isArray(a.citations) ? a.citations.map(String) : []
        const s = probeDetail(q.query_id, engine.engine, { text: a.text, citations: raw, searched: a.searched, retrieved: Array.isArray(a.retrieved) ? a.retrieved.map(String) : [] }, domains)
        d.samples = { n: d.samples.n + 1, first: d.samples.first + (s.first_host_ours ? 1 : 0), cited: d.samples.cited + (s.cited_any ? 1 : 0) }
        out.answers++
      }
    }
    if (made > 0) out.questions++
  }
  log('resampled', { ...out })
  return out
}
