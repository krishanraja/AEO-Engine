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
import { CAPS, SUBSCRIPTION_KINDS, type CostKind } from '../config/run.js'
import { REDIRECT_HOST } from '../clients/gemini.js'
import { FreeTierExhausted, SubscriptionLimit, type EngineAnswer, type EngineClient } from '../clients/types.js'
import { emptyCompare, tallyCompare, type CompareCounts } from '../lib/compare.js'
import type { Ledger } from '../lib/cost.js'
import { ourHits } from '../lib/domains.js'
import { errText, log } from '../lib/log.js'
import { nameMentioned } from '../lib/names.js'
import { probeDetail, type ProbeDetail } from '../lib/probeDetail.js'
import { CLEAN, EMAIL_RE, HANDLE_RE, scrubPII } from '../lib/text.js'
import { inPacket, type Engine, type GatedEngine, type Probe, type ProbeEngine, type QuerySource } from '../schema/packet.js'
import type { ProposedQuery } from './30-propose.js'

/**
 * What one answer said about where it looked, kept in memory for the
 * diagnosis and the win kits (src/pipeline/45-pages.ts, 62-kits.ts) and never
 * written to the packet, a log or the summary: its inline citations as the
 * engine gave them (raw order, before cleaning), what its search retrieved,
 * and the search queries it ran.
 */
export interface ProbeEvidence { engine: ProbeEngine; citations: string[]; retrieved: string[]; fan_out: string[] }

export interface ProbeOutcome {
  probesByQuery: Map<string, Probe[]>
  /** Per probed question, each answer's raw citations, retrieved URLs and fan-out, in engine order, gated engines included. In memory only. */
  evidenceByQuery?: Map<string, ProbeEvidence[]>
  /** Per probed question, what each answer measured about us, in engine order, gated engines included. Never in the packet. */
  detailsByQuery?: Map<string, ProbeDetail[]>
  /** The packet's engines only: these three are the packet's stats. */
  probes: number
  probes_failed: number
  probes_skipped_cap: number
  /**
   * Probes the Claude Code subscription's limit stopped and nothing recovered,
   * including those whose API fallback then failed. Each is also a failed probe.
   */
  probes_skipped_limit?: number
  /** Answered probes during which the subscription passed a warning threshold and still served (allowed_warning). */
  probes_limit_warning?: number
  /** code_then_api: probes the subscription's limit handed to the API lane, which answered them. */
  probes_fallback?: number
  /** Gemini probes not asked because the job reached its free-tier share. Not a failure, and never charged. */
  probes_skipped_free_tier?: number
  /** A gated engine's failed calls and cap skips, kept out of the packet's stats. */
  gated_failed?: number
  gated_skipped_cap?: number
  /** URLs answers typed that no search returned (the Claude Code lane), dropped from citations. */
  typed_urls_dropped?: number
  /** compare mode: the two Claude lanes side by side, counts only. */
  compare?: CompareCounts
  /** The questions put to at least one engine (charged and asked), answered or not: the panel's "asked". */
  asked?: Set<string>
  /**
   * The asked questions a packet engine did not answer: the spend cap or its
   * free tier stopped it, or its call failed. The panel reads such a reading
   * as too short to record a loss (src/pipeline/55-panel.ts, panelFor).
   */
  partial?: Set<string>
}

export interface ProbeOptions {
  /** The gated engines the context's packet_features opened: their probes go into the packet too. */
  open?: readonly GatedEngine[]
  /**
   * compare mode: the API lane, asked beside the main engines on the first
   * `questions` questions. Charged to the ledger like any probe, tallied
   * against the main engine of the same name, and never in the packet.
   */
  shadow?: { client: EngineClient; questions: number }
  /**
   * The questions are already in the panel's order (src/pipeline/55-panel.ts,
   * selectPanel): probe them as given, the first `maxQueries`, rather than
   * reorder them here.
   */
  preordered?: boolean
  /** The subject's distinctive names: each answer's name_mentioned is read against them (null without). */
  brandNames?: readonly string[]
}

/** The ledger kind a probe on this engine is charged to. */
export const costKindOf = (e: EngineClient): CostKind => e.costKind ?? e.engine

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

/**
 * A Gemini grounding redirect that was neither resolved nor representable by
 * its title. It names no source (its host is Google's redirect service, and
 * its token expires), so it never reaches a packet, where it would read as a
 * competitor's host. The measurement beside the packet reads it before
 * cleaning, as an unknown host that is not ours, so dropping it here never
 * promotes a later source to first.
 */
export function isGroundingRedirect(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase() === REDIRECT_HOST } catch { return false }
}

/**
 * A citation as the packet may carry it: trimmed and cut, or null when it
 * holds an email, a handle or a grounding redirect. An em dash in a URL is
 * percent-encoded, as a browser sends it, since the packet refuses any string
 * that holds one: a raw search result must never stop the packet shipping.
 */
export function cleanCitation(u: string): string | null {
  const s = String(u).trim().replace(/\u2014/g, '%E2%80%94').slice(0, 500)
  EMAIL_RE.lastIndex = 0
  HANDLE_RE.lastIndex = 0
  if (!s || EMAIL_RE.test(s) || HANDLE_RE.test(s) || isGroundingRedirect(s)) return null
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
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const out: ProbeOutcome = {
    probesByQuery: new Map(), detailsByQuery: new Map(), evidenceByQuery: new Map(), probes: 0, probes_failed: 0, probes_skipped_cap: 0,
    probes_skipped_limit: 0, probes_limit_warning: 0, probes_fallback: 0, probes_skipped_free_tier: 0, gated_failed: 0, gated_skipped_cap: 0, typed_urls_dropped: 0,
    asked: new Set(), partial: new Set(),
  }
  const asked = out.asked as Set<string>
  const partial = out.partial as Set<string>
  const details = out.detailsByQuery as Map<string, ProbeDetail[]>
  const evidence = out.evidenceByQuery as Map<string, ProbeEvidence[]>
  const open = opts.open ?? []
  const counted = (e: EngineClient) => inPacket(e.engine, open)
  const shadow = opts.shadow && opts.shadow.questions > 0 ? opts.shadow : null
  if (shadow) out.compare = emptyCompare()
  const ordered = (opts.preordered ? [...proposed] : orderForProbing(proposed)).slice(0, maxQueries)
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
  for (const [qi, q] of ordered.entries()) {
    const affordable: EngineClient[] = []
    // A question's engines are charged together below, so each is checked
    // against the cap with the ones before it already counted.
    let pending = 0
    // Set when a packet engine is not asked or does not answer this question.
    let short = false
    for (const engine of engines) {
      // An engine past its free-tier share asks nothing more this job: it is
      // counted as skipped and never charged for a probe it will not make.
      if (engine.exhausted === true) {
        out.probes_skipped_free_tier = (out.probes_skipped_free_tier ?? 0) + 1
        if (counted(engine)) short = true
        continue
      }
      const kind = costKindOf(engine)
      // A subscription lane spends no dollar, so the cap never stops it.
      const free = SUBSCRIPTION_KINDS.includes(kind)
      if ((capHit && !free) || !ledger.canAfford(kind, pending + reserveUsd)) {
        if (!capHit) log('cap_reached', { at_usd: ledger.total, cap_usd: ledger.capUsd })
        capHit = true
        if (counted(engine)) { out.probes_skipped_cap++; short = true }
        else out.gated_skipped_cap = (out.gated_skipped_cap ?? 0) + 1
        continue
      }
      affordable.push(engine)
      pending += free ? 0 : ledger.priceOf(kind)
    }
    // compare: the API lane beside the main ones on the subject's first questions, inside the same cap.
    let shadowAsked = false
    if (shadow && qi < shadow.questions && affordable.some(e => e.engine === shadow.client.engine)) {
      const kind = costKindOf(shadow.client)
      if (!capHit && ledger.canAfford(kind, pending + reserveUsd)) {
        shadowAsked = true
        pending += ledger.priceOf(kind)
      }
    }
    if (!affordable.length) continue
    asked.add(q.query_id)

    const charged = affordable.map(engine => ({ engine, cost: ledger.charge(costKindOf(engine), `probe ${engine.engine}`) }))
    if (shadowAsked && shadow) ledger.charge(costKindOf(shadow.client), `probe ${shadow.client.engine} compare`)
    const ctx = { domains: krishHitsDomains }
    const shadowAnswer: Promise<EngineAnswer | null> = shadowAsked && shadow
      ? shadow.client.ask(q.query, ctx).catch(e => { log('probe_failed', { engine: shadow.client.engine, lane: 'compare', query_id: q.query_id, error: errText(e) }); return null })
      : Promise.resolve(null)
    const settled = await Promise.all(charged.map(async ({ engine, cost }): Promise<Settled> => {
      let used: EngineClient = engine
      let usd = cost
      // Set when the subscription's limit stopped this probe, so it is counted
      // as stopped by the limit even when the API fallback then fails too.
      let limitHit = false
      try {
        let a: EngineAnswer
        try {
          a = await engine.ask(q.query, ctx)
          if (a.limit_warning === true) out.probes_limit_warning = (out.probes_limit_warning ?? 0) + 1
        } catch (e) {
          if (e instanceof SubscriptionLimit) limitHit = true
          // code_then_api: the subscription's limit hands this probe to the
          // fallback lane, charged at its own kind and inside the same cap.
          const fb = engine.fallback
          if (!(e instanceof SubscriptionLimit) || !fb || capHit || !ledger.canAfford(costKindOf(fb), reserveUsd)) throw e
          usd = ledger.charge(costKindOf(fb), `probe ${fb.engine} fallback`)
          used = fb
          a = await fb.ask(q.query, ctx)
          out.probes_fallback = (out.probes_fallback ?? 0) + 1
        }
        const raw = Array.isArray(a.citations) ? a.citations.map(String) : []
        if (typeof a.typed_urls_dropped === 'number' && a.typed_urls_dropped > 0) out.typed_urls_dropped = (out.typed_urls_dropped ?? 0) + a.typed_urls_dropped
        // Measured before cleaning: cleaning drops a URL that carries an
        // email or a handle, which would promote a later source to first.
        const detail: ProbeDetail = {
          ...probeDetail(q.query_id, engine.engine, { text: a.text, citations: raw, searched: a.searched, retrieved: Array.isArray(a.retrieved) ? a.retrieved.map(String) : [] }, krishHitsDomains),
          name_mentioned: nameMentioned(a.text, opts.brandNames ?? []),
        }
        const citations = raw.map(cleanCitation).filter((c): c is string => !!c).slice(0, CAPS.MAX_CITATIONS)
        const probe: Probe = {
          // A gated engine reaches the packet only once the context opened it,
          // which is when Control Center's engine enum carries it too.
          engine: engine.engine as Engine,
          model: used.model.slice(0, 80),
          question: q.query,
          answer_snapshot: scrubPII(CLEAN(a.text, CAPS.ANSWER_SNAPSHOT_CHARS), neverSay),
          // From the text and the INLINE citations: a search result the
          // answer read and did not cite is not a citation for us.
          we_cited: ourHits(a.text, raw, krishHitsDomains).length > 0,
          citations,
          cost_usd: usd,
        }
        const ev: ProbeEvidence = {
          engine: engine.engine,
          citations: raw.filter(c => c.trim().length > 0).map(c => c.trim().slice(0, 500)),
          retrieved: Array.isArray(a.retrieved) ? a.retrieved.map(String).filter(Boolean).slice(0, 50).map(c => c.slice(0, 500)) : [],
          fan_out: Array.isArray(a.fan_out) ? a.fan_out.map(String).filter(Boolean).slice(0, 20).map(c => c.slice(0, 300)) : [],
        }
        return { engine, ok: { probe, detail, answer: a, evidence: ev } }
      } catch (e) {
        if (e instanceof FreeTierExhausted) {
          // Not asked, so not paid for: the charge made before the ask is taken back.
          ledger.refund(costKindOf(engine), `probe ${engine.engine}`)
          return { engine, skippedFreeTier: true }
        }
        if (limitHit) out.probes_skipped_limit = (out.probes_skipped_limit ?? 0) + 1
        log('probe_failed', { engine: engine.engine, query_id: q.query_id, error: errText(e) })
        return { engine }
      }
    }))

    if (shadowAsked && out.compare && shadow) {
      const main = settled.find(r => r.engine.engine === shadow.client.engine)
      tallyCompare(out.compare, main?.ok?.answer ?? null, await shadowAnswer)
    }
    // Engine order is preserved, so a packet does not change shape with the
    // weather. A failed call writes nothing and is counted, as before. A gated
    // engine's answer is measured and counted in the summary only.
    const rows: Array<{ probe: Probe; detail: ProbeDetail }> = []
    const qDetails: ProbeDetail[] = []
    const qEvidence: ProbeEvidence[] = []
    for (const r of settled) {
      const inP = counted(r.engine)
      if (r.skippedFreeTier) { out.probes_skipped_free_tier = (out.probes_skipped_free_tier ?? 0) + 1; if (inP) short = true; continue }
      if (!r.ok) {
        if (inP) { out.probes_failed++; short = true }
        else out.gated_failed = (out.gated_failed ?? 0) + 1
        continue
      }
      qDetails.push(r.ok.detail)
      qEvidence.push(r.ok.evidence)
      if (inP) rows.push(r.ok)
    }
    out.probes += rows.length
    if (rows.length) out.probesByQuery.set(q.query_id, rows.map(r => r.probe))
    if (qDetails.length) details.set(q.query_id, qDetails)
    if (qEvidence.length) evidence.set(q.query_id, qEvidence)
    if (short) partial.add(q.query_id)
  }
  const all = [...details.values()].flat()
  // `requested` counts the requested questions an assistant actually answered,
  // not those inside the limit: the spend cap or a failed call can stop one.
  log('probed', {
    queries: ordered.length, requested: ordered.filter(q => q.requested && out.probesByQuery.has(q.query_id)).length, requested_total: proposed.filter(q => q.requested).length,
    probes: out.probes, failed: out.probes_failed, skipped_cap: out.probes_skipped_cap,
    skipped_limit: out.probes_skipped_limit, limit_warning: out.probes_limit_warning, fallback: out.probes_fallback, skipped_free_tier: out.probes_skipped_free_tier, gated_failed: out.gated_failed,
    searched: all.filter(d => d.searched).length, zero_citation: all.filter(d => d.zero_citation).length,
    ...(out.compare ? { compared: out.compare.questions } : {}),
  })
  return out
}

interface Settled {
  engine: EngineClient
  ok?: { probe: Probe; detail: ProbeDetail; answer: EngineAnswer; evidence: ProbeEvidence }
  skippedFreeTier?: boolean
}

