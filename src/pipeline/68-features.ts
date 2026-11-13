/**
 * Stage 68: the gated packet fields. Pure. Control Center's packet shape is
 * closed, so each optional field goes into the packet only when the context
 * lists its feature in `packet_features` (src/schema/packet.ts,
 * PACKET_FEATURES); with none listed the packet is exactly the v1 shape.
 *
 * Everything here was measured this run and is cleaned like the rest of the
 * packet: a retrieved URL or a search query that carries an email or a handle
 * is dropped, an em dash in a URL is percent-encoded, and a kit that would
 * break a packet rule (a repeated kit_id among them) is left out on its own,
 * so it can never stop the packet shipping. A packet question this run did
 * not ask carries the panel Control Center served for it, unchanged. A kit's
 * off-site mention fields go only with the cited_pages feature.
 */
import type { ProbeDetail } from '../lib/probeDetail.js'
import { CLEAN, EMAIL_RE, HANDLE_RE, scrubPII } from '../lib/text.js'
import type { Kit } from '../schema/kit.js'
import { CITED_PAGES_MAX, citedPageErrors, FAN_OUT_CHARS, FAN_OUT_MAX, KITS_MAX, kitErrors, RETRIEVED_MAX, type AeoPacket, type PacketDiagnosis, type PacketOutcome, type PacketQuery, type Probe, type RunKind } from '../schema/packet.js'
import type { CitedPageRow } from '../schema/citedPages.js'
import type { Panel } from '../schema/panel.js'
import type { HostAudit } from './15-site.js'
import { cleanCitation, type ProbeEvidence } from './40-probe.js'
import type { Diagnosis } from './52-diagnose.js'

export interface FeatureInput {
  /** The features the context lists. */
  features: readonly string[]
  /** The packet engines' details and evidence per question. */
  details: ReadonlyMap<string, readonly ProbeDetail[]>
  evidence: ReadonlyMap<string, readonly ProbeEvidence[]>
  panels?: ReadonlyMap<string, Panel>
  diagnoses?: ReadonlyMap<string, Diagnosis>
  kits?: readonly Kit[]
  /** Our hosts' audit, for a subject that was diagnosed. */
  hosts?: readonly HostAudit[] | null
  neverSay?: readonly string[]
  /** Each tracked answer page's outcome, by question (src/pipeline/63-outcomes.ts). */
  outcomes?: ReadonlyMap<string, PacketOutcome>
  /** The venture's cited-pages sheet (src/pipeline/48-cited-pages.ts). */
  citedPages?: readonly CitedPageRow[] | null
  /** What kind of run made the packet: research, or verify (src/pipeline/verify.ts). */
  runKind?: RunKind
}

/** What the engine's search returned, as the packet may carry it: cleaned, each once, at most RETRIEVED_MAX. */
export function retrievedFor(ev: ProbeEvidence | undefined): string[] {
  const out: string[] = []
  for (const u of ev?.retrieved ?? []) {
    const c = cleanCitation(u)
    if (!c || out.includes(c)) continue
    out.push(c)
    if (out.length >= RETRIEVED_MAX) break
  }
  return out
}

/** The engine's own search queries: no name, address or handle, no em dash, each once, at most FAN_OUT_MAX of FAN_OUT_CHARS. */
export function fanOutFor(ev: ProbeEvidence | undefined, neverSay: readonly string[] = []): string[] {
  const out: string[] = []
  for (const raw of ev?.fan_out ?? []) {
    const t = CLEAN(scrubPII(CLEAN(raw, FAN_OUT_CHARS * 2), neverSay), FAN_OUT_CHARS)
    EMAIL_RE.lastIndex = 0
    HANDLE_RE.lastIndex = 0
    if (!t || EMAIL_RE.test(t) || HANDLE_RE.test(t) || out.includes(t)) continue
    out.push(t)
    if (out.length >= FAN_OUT_MAX) break
  }
  return out
}

/** The diagnosis as the packet carries it. */
export function packetDiagnosis(d: Diagnosis): PacketDiagnosis {
  return {
    gap_class: d.gap_class,
    our_best_url: d.our_best_url ? d.our_best_url.slice(0, 500) : null,
    alignment: Math.round(Math.max(0, Math.min(1, d.alignment)) * 1000) / 1000,
    first_cited_host: d.first_cited?.host ? d.first_cited.host.slice(0, 120) : null,
    first_cited_type: d.first_cited?.source_type ?? null,
  }
}

function probeWith(p: Probe, d: ProbeDetail | undefined, ev: ProbeEvidence | undefined, has: (f: string) => boolean, neverSay: readonly string[]): Probe {
  if (!d) return p
  return {
    ...p,
    ...(has('probe_detail') ? { retrieved: retrievedFor(ev), searched: d.searched, fan_out: fanOutFor(ev, neverSay), our_position: d.our_position } : {}),
    ...(has('name_mentions') ? { name_mentioned: d.name_mentioned ?? null } : {}),
    ...(has('samples') ? { samples: d.samples ? { ...d.samples } : null } : {}),
  }
}

/** The packet with each listed feature's fields attached, and how many kits were left out for breaking a packet rule. */
export function attachFeatures(packet: AeoPacket, i: FeatureInput): { packet: AeoPacket; kitsDropped: number; rowsDropped?: number } {
  const listed = new Set(i.features)
  const has = (f: string) => listed.has(f)
  const neverSay = i.neverSay ?? []
  const queries: PacketQuery[] = packet.queries.map(q => {
    const details = i.details.get(q.query_id) ?? []
    const evidence = i.evidence.get(q.query_id) ?? []
    const probes = q.probes.map(p => probeWith(p, details.find(d => d.engine === p.engine), evidence.find(e => e.engine === p.engine), has, neverSay))
    const panel = has('panel') ? i.panels?.get(q.query_id) : undefined
    const diagnosis = has('diagnosis') ? i.diagnoses?.get(q.query_id) : undefined
    const outcome = has('outcome') ? i.outcomes?.get(q.query_id) : undefined
    return { ...q, probes, ...(panel ? { panel: { ...panel } } : {}), ...(diagnosis ? { diagnosis: packetDiagnosis(diagnosis) } : {}), ...(outcome ? { outcome: structuredClone(outcome) } : {}) }
  })
  let kitsDropped = 0
  const out: AeoPacket = { ...packet, queries }
  if (has('kits') && i.kits) {
    const ids = new Set(queries.map(q => q.query_id))
    // kit_id is the product and the first 8 characters of the query_id, so two
    // kitted questions can share one; the packet refuses a repeat, so only the
    // first (the higher priority, in the kits' order) goes.
    const kitIds = new Set<string>()
    // A kit's off-site mention fields go only with the cited_pages feature.
    const shaped = i.kits.map(k => (has('cited_pages') ? k : { ...k, off_site: k.off_site.map(({ mention: _m, mention_ok: _o, ...o }) => o) }))
    const kits = shaped.filter(k => {
      const ok = kitErrors(k, ids, packet.engines, [...listed]).length === 0 && !kitIds.has(k.kit_id)
      if (!ok) kitsDropped++
      else kitIds.add(k.kit_id)
      return ok
    })
    out.kits = kits.slice(0, KITS_MAX)
  }
  if (has('site') && i.hosts) out.site = { hosts: i.hosts.map(h => ({ host: h.host, gates: h.gates.map(g => ({ gate: g.gate, pass: g.pass })) })) }
  if (has('run_kind')) out.run_kind = i.runKind ?? 'research'
  let rowsDropped = 0
  if (has('cited_pages') && i.citedPages) {
    // A row that would break a packet rule is left out on its own, like a kit.
    const rows = i.citedPages.slice(0, CITED_PAGES_MAX).map(r => ({ ...r, engines: [...r.engines] }))
    out.cited_pages = rows.filter(r => citedPageErrors(r, packet.engines).length === 0)
    rowsDropped = rows.length - out.cited_pages.length
  }
  return { packet: out, kitsDropped, rowsDropped }
}
