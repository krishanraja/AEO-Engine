/**
 * AeoPacket v1, the JSON this engine POSTs to Control Center.
 *
 * The types mirror docs/packet.schema.json exactly; validatePacket is the
 * hand-written check the pipeline runs before anything leaves the machine.
 * No schema library: the contract is small, the rules are few, and a
 * validator with no dependencies cannot be the reason a Sunday run fails.
 */
import { SOURCE_TYPES, type SourceType } from '../lib/sourceType.js'
import { EMAIL_RE, EM_DASH_RE, HANDLE_RE } from '../lib/text.js'
import { mondayOf } from '../lib/week.js'
import { GAP_CLASSES, HOST_GATES, TARGET_KINDS, type GapClass, type HostGate, type Kit } from './kit.js'
import { PANEL_STATES, SAMPLES_PER_CONTESTED, type Panel, type SampleCounts } from './panel.js'
import { MENTIONS, type CitedPageRow } from './citedPages.js'

/** Control Center refuses a packet carrying more probes than this in total. */
export const MAX_PROBES_PER_PACKET = 600

export const ENGINES_ALL = ['perplexity', 'chatgpt', 'claude', 'grok'] as const
export type Engine = (typeof ENGINES_ALL)[number]

/**
 * Engines this engine can ask that the packet's engine enum does not carry.
 * That enum is joint with Control Center and closed, so a gated engine's
 * probes stay out of the packet (and out of queries_cited_first) until the
 * context lists the engine's feature in `packet_features`. Until then its
 * answers are counted only in the sealed run summary (docs/PACKET.md).
 */
export const GATED_ENGINES = ['gemini'] as const
export type GatedEngine = (typeof GATED_ENGINES)[number]
/** Any engine a probe can be put to: the packet's own, and the gated ones. */
export type ProbeEngine = Engine | GatedEngine
/** The context feature that opens each gated engine's way into the packet. */
export const GATE_FEATURE: Record<GatedEngine, string> = { gemini: 'engine_gemini' }

export function isGatedEngine(e: string): e is GatedEngine {
  return (GATED_ENGINES as readonly string[]).includes(e)
}

/** The gated engines a context's packet_features have opened. Absent or misshapen features open none. */
export function openGatedEngines(packetFeatures: unknown): GatedEngine[] {
  const features = Array.isArray(packetFeatures) ? packetFeatures.filter((f): f is string => typeof f === 'string') : []
  return GATED_ENGINES.filter(e => features.includes(GATE_FEATURE[e]))
}

/** Whether an engine's probes go into the packet: always for the enum's own, for a gated one only once its feature is open. */
export function inPacket(e: ProbeEngine, open: readonly GatedEngine[] = []): boolean {
  return (ENGINES_ALL as readonly string[]).includes(e) || (isGatedEngine(e) && open.includes(e))
}

/**
 * The optional packet fields this engine can send, each under the feature
 * name Control Center lists in the context's `packet_features` once its
 * ingest accepts it (docs/briefs/2026-11-13-aeo-specialist.md, section D).
 * A field whose feature is not listed is never sent, and validatePacket
 * refuses it: Control Center's packet shape is closed.
 *
 *   probe_detail   probes[] retrieved, searched, fan_out, our_position
 *   name_mentions  probes[] name_mentioned
 *   samples        probes[] samples
 *   panel          queries[] panel
 *   diagnosis      queries[] diagnosis
 *   kits           kits[]
 *   site           site
 *   run_kind       run_kind
 *   engine_gemini  gemini in the engines enum (GATED_ENGINES)
 *   outcome        queries[] outcome: Search Console, Bing and AI-referral
 *                  readings for the page a kit targets or a venture shipped
 *   cited_pages    cited_pages[]: the venture's cited-pages sheet, and a
 *                  kit's off_site mention and mention_ok
 */
export const PACKET_FEATURES = ['probe_detail', 'name_mentions', 'samples', 'panel', 'diagnosis', 'kits', 'site', 'run_kind', 'engine_gemini', 'outcome', 'cited_pages'] as const
export type PacketFeature = (typeof PACKET_FEATURES)[number]

/** The packet features a context lists that this engine knows, each once. Absent or misshapen: none. */
export function packetFeatures(raw: unknown): PacketFeature[] {
  const list = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : []
  return PACKET_FEATURES.filter(f => list.includes(f))
}

export const RETRIEVED_MAX = 20
export const FAN_OUT_MAX = 8
export const FAN_OUT_CHARS = 200
export const KITS_MAX = 10
export const SITE_HOSTS_MAX = 10
export const RUN_KINDS = ['research', 'verify'] as const
export type RunKind = (typeof RUN_KINDS)[number]
/** The cited-pages sheet a packet carries: at most this many rows (CAPS.CITED_PAGES_PER_SUBJECT). */
export const CITED_PAGES_MAX = 50

export const SUBJECT_KINDS = ['venture', 'prospect', 'aspiration'] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

/** A venture's product. heartside, legibility and publication since 2026-11-12: a venture's engine asks this specialist for its own product's AI answers (protocol 1.22.0). */
export const PRODUCT_SLUGS = ['ctrl', 'circle', 'pulse', 'full-time', 'mindmake', 'heartside', 'legibility', 'publication'] as const
export type ProductSlug = (typeof PRODUCT_SLUGS)[number]

export const THEMES_STATUSES = ['ok', 'no_calls', 'no_attributed_calls', 'fireflies_unavailable', 'not_applicable'] as const
export type ThemesStatus = (typeof THEMES_STATUSES)[number]

export const QUERY_SOURCES = ['transcript', 'gap', 'seed', 'striking_distance', 'watch_carry', 'room_signal'] as const
export type QuerySource = (typeof QUERY_SOURCES)[number]

export const TRENDS = ['new', 'up', 'flat', 'down'] as const
export type Trend = (typeof TRENDS)[number]

export const QUERY_STATUSES = ['watch', 'recommend', 'drop'] as const
export type QueryStatus = (typeof QUERY_STATUSES)[number]

export const DIGEST_WRITERS = ['claude', 'fallback'] as const
export type DigestWriter = (typeof DIGEST_WRITERS)[number]

export interface Evidence {
  /** An opaque short hash of the transcript id. Never the id itself. */
  call_ref: string
  date: string
  paraphrase: string
}

export interface Probe {
  engine: Engine
  model: string
  question: string
  answer_snapshot: string
  we_cited: boolean
  citations: string[]
  cost_usd: number
  /** probe_detail: what the engine's search returned, cited or not, cleaned like citations, at most 20. */
  retrieved?: string[]
  /** probe_detail: whether the engine searched the web for this answer. */
  searched?: boolean
  /** probe_detail: the engine's own search queries, at most 8 of at most 200 characters. */
  fan_out?: string[]
  /** probe_detail: 1-based position of our first inline citation, or null. */
  our_position?: number | null
  /** name_mentions: the answer names the subject outside any URL; null when the subject has no distinctive name. */
  name_mentioned?: boolean | null
  /** samples: a contested question's repeat samples on this engine, this answer included; null when asked once. */
  samples?: SampleCounts | null
}

/** diagnosis: why the question is not won (src/pipeline/52-diagnose.ts). */
export interface PacketDiagnosis {
  gap_class: GapClass
  our_best_url: string | null
  alignment: number
  first_cited_host: string | null
  first_cited_type: SourceType | null
}

/** One window of Search Console readings for a page: its queries' impressions and clicks summed, position averaged by impressions (null with none). */
export interface GscWindow { impressions: number; clicks: number; position: number | null; from: string; to: string }

/**
 * outcome (src/pipeline/63-outcomes.ts): what the search signals Control
 * Center serves say about the page a kit targets or a venture shipped. Each
 * part is null when its signal was not served: unknown, never zero. AI
 * referrals from GA4 and from Clarity are kept apart, never summed.
 */
export interface PacketOutcome {
  url: string
  gsc: (GscWindow & { before: GscWindow | null }) | null
  bing: { indexed: boolean | null; last_crawled: string | null } | null
  ai_referrals: { from: string; to: string; ga4: number | null; clarity: number | null } | null
}

/** site: each of our hosts' gates, pass or fail (src/pipeline/15-site.ts). */
export interface PacketSite { hosts: Array<{ host: string; gates: Array<{ gate: HostGate; pass: boolean }> }> }

export interface DemandBasis {
  llm_demand: number
  transcript_evidence: number
  rising_volume: number
  labels: string[]
}

export interface QueryGap {
  we_cited_engines: Engine[]
  competitor_domains: string[]
}

export interface PacketQuery {
  query_id: string
  query: string
  source: QuerySource
  demand_score: number
  demand_basis: DemandBasis
  call_evidence: Evidence[]
  gap: QueryGap
  trend: Trend
  status: QueryStatus
  touchpoint_id: string | null
  probes: Probe[]
  /** panel: where the question stands, run after run (src/schema/panel.ts). */
  panel?: Panel
  /** diagnosis: why it is not won. */
  diagnosis?: PacketDiagnosis
  /** outcome: the search signals for the page shipped or targeted for it. */
  outcome?: PacketOutcome
}

export interface Theme {
  theme: string
  calls: number
  evidence: Evidence[]
}

export interface Recommendation {
  n: number
  title: string
  target_query: string
  query_id: string
  angle: string
  evidence: string[]
  engines: Engine[]
  demand: number
  /**
   * The specific reason this owner can win THIS answer when the sites cited
   * today structurally cannot, drawn from the business canon or from measured
   * evidence. Never a generality. Null when the digest could not justify one,
   * which is a bug in the digest and not a licence to recommend anyway: the
   * null is carried so the reader sees the judgement was not made.
   */
  why_you_can_win: string | null
}

/**
 * A question that was probed and scored and that he should NOT try to win.
 * Worth more than a bad recommendation, because it stops him spending a week
 * on an answer a social network, a video platform, a national business title
 * or a big consultancy already owns.
 */
export interface NotWorthChasing {
  query_id: string
  query: string
  /** The hosts that own the answer now, most cited first. */
  owned_by: string[]
  /** One plain sentence saying why he will not displace them. No hedging. */
  why_not: string
}

export interface WatchItem {
  query_id: string
  query: string
  why: string
}

export interface CompetitorGap {
  domain: string | null
  times_cited: number
  questions: string[]
}

export interface PlaybookEntry {
  url: string
  host: string
  path_pattern: string
  times_cited: number
  why: string
}

export interface PacketStats {
  queries: number
  probes: number
  probes_failed: number
  probes_skipped_cap: number
  cost_usd: number
  engines: number
  transcripts: number
  digest_writer: DigestWriter
}

export interface PacketSubject {
  id: string
  kind: SubjectKind
  slug: string
  product_slug: ProductSlug | null
}

export interface AeoPacket {
  schema_version: 1
  run_id: string
  command_id: number | null
  subject: PacketSubject
  /** The Monday that owns the week, UTC. Same rule as api/_growth.ts mondayOf. */
  week_start: string
  generated_at: string
  engines: Engine[]
  themes_status: ThemesStatus
  themes: Theme[]
  calls: { considered: number; attributed: number }
  queries: PacketQuery[]
  strongest_signal: string | null
  recommendations: Recommendation[]
  /** At most six. Additive in v1: an older packet that omits it still validates. */
  not_worth_chasing: NotWorthChasing[]
  watch_list: WatchItem[]
  competitor_gap: CompetitorGap
  /** Aspirations only. Null for the other kinds. */
  playbook: PlaybookEntry[] | null
  /** Prospects only. Null for the other kinds. */
  approach_hook: string | null
  stats: PacketStats
  /** kits: the venture's win kits, highest priority first, at most 10. */
  kits?: Kit[]
  /** site: our hosts' gates. */
  site?: PacketSite
  /** run_kind: a research run, or a verify run that never counts toward the share. */
  run_kind?: RunKind
  /** cited_pages: the venture's cited-pages sheet, at most 50 rows. */
  cited_pages?: CitedPageRow[]
}

export type ValidationResult = { ok: true; packet: AeoPacket } | { ok: false; errors: string[] }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const CALL_REF_RE = /^[0-9a-f]{8}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

type Rec = Record<string, unknown>

class Checker {
  errors: string[] = []

  /**
   * The engines a probe, a gap or a recommendation may name: the enum, plus
   * any gated engine whose feature is open; and the packet features listed.
   */
  constructor(readonly engines: readonly string[] = ENGINES_ALL, readonly features: ReadonlySet<string> = new Set()) {}

  has(f: PacketFeature): boolean { return this.features.has(f) }

  ymd(path: string, v: unknown, nullable = false): void {
    if (v === null && nullable) return
    if (!this.str(path, v, { re: YMD_RE })) return
    if (Number.isNaN(Date.parse(`${v}T00:00:00Z`))) this.fail(path, 'not a date')
  }

  fail(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`)
  }

  /** Object with exactly the allowed keys present (required ones must exist). */
  obj(path: string, v: unknown, required: readonly string[], optional: readonly string[] = []): v is Rec {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { this.fail(path, 'must be an object'); return false }
    const keys = Object.keys(v as Rec)
    for (const k of required) if (!(k in (v as Rec))) this.fail(path, `missing required key "${k}"`)
    const allowed = new Set([...required, ...optional])
    for (const k of keys) if (!allowed.has(k)) this.fail(path, `unexpected key "${k}"`)
    return true
  }

  str(path: string, v: unknown, o: { min?: number; max?: number; re?: RegExp } = {}): v is string {
    if (typeof v !== 'string') { this.fail(path, 'must be a string'); return false }
    if (o.min !== undefined && v.length < o.min) this.fail(path, `shorter than ${o.min}`)
    if (o.max !== undefined && v.length > o.max) this.fail(path, `longer than ${o.max}`)
    if (o.re && !o.re.test(v)) this.fail(path, `does not match ${o.re}`)
    return true
  }

  int(path: string, v: unknown, o: { min?: number; max?: number } = {}): v is number {
    if (typeof v !== 'number' || !Number.isInteger(v)) { this.fail(path, 'must be an integer'); return false }
    if (o.min !== undefined && v < o.min) this.fail(path, `below ${o.min}`)
    if (o.max !== undefined && v > o.max) this.fail(path, `above ${o.max}`)
    return true
  }

  num(path: string, v: unknown, o: { min?: number } = {}): v is number {
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(path, 'must be a number'); return false }
    if (o.min !== undefined && v < o.min) this.fail(path, `below ${o.min}`)
    return true
  }

  bool(path: string, v: unknown): v is boolean {
    if (typeof v !== 'boolean') { this.fail(path, 'must be a boolean'); return false }
    return true
  }

  oneOf<T extends string>(path: string, v: unknown, values: readonly T[]): v is T {
    if (typeof v !== 'string' || !values.includes(v as T)) { this.fail(path, `must be one of ${values.join(' | ')}`); return false }
    return true
  }

  arr(path: string, v: unknown, o: { max?: number; min?: number; unique?: boolean } = {}): v is unknown[] {
    if (!Array.isArray(v)) { this.fail(path, 'must be an array'); return false }
    if (o.max !== undefined && v.length > o.max) this.fail(path, `more than ${o.max} items`)
    if (o.min !== undefined && v.length < o.min) this.fail(path, `fewer than ${o.min} items`)
    if (o.unique && new Set(v.map(x => JSON.stringify(x))).size !== v.length) this.fail(path, 'items must be unique')
    return true
  }

  nullable<T>(path: string, v: unknown, check: (p: string, x: unknown) => x is T): v is T | null {
    if (v === null) return true
    return check(path, v)
  }
}

function checkEvidence(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['call_ref', 'date', 'paraphrase'])) return
  c.str(`${path}.call_ref`, v.call_ref, { re: CALL_REF_RE })
  c.str(`${path}.date`, v.date, { re: YMD_RE })
  c.str(`${path}.paraphrase`, v.paraphrase, { min: 1, max: 200 })
}

function checkProbe(c: Checker, path: string, v: unknown): void {
  const optional = [
    ...(c.has('probe_detail') ? ['retrieved', 'searched', 'fan_out', 'our_position'] : []),
    ...(c.has('name_mentions') ? ['name_mentioned'] : []),
    ...(c.has('samples') ? ['samples'] : []),
  ]
  if (!c.obj(path, v, ['engine', 'model', 'question', 'answer_snapshot', 'we_cited', 'citations', 'cost_usd'], optional)) return
  c.oneOf(`${path}.engine`, v.engine, c.engines)
  c.str(`${path}.model`, v.model, { max: 80 })
  c.str(`${path}.question`, v.question, { min: 1, max: 400 })
  c.str(`${path}.answer_snapshot`, v.answer_snapshot, { max: 1800 })
  c.bool(`${path}.we_cited`, v.we_cited)
  if (c.arr(`${path}.citations`, v.citations, { max: 8 })) {
    v.citations.forEach((x, i) => c.str(`${path}.citations[${i}]`, x, { max: 500 }))
  }
  c.num(`${path}.cost_usd`, v.cost_usd, { min: 0 })
  if ('retrieved' in v && c.arr(`${path}.retrieved`, v.retrieved, { max: RETRIEVED_MAX })) v.retrieved.forEach((x, i) => c.str(`${path}.retrieved[${i}]`, x, { min: 1, max: 500 }))
  if ('searched' in v) c.bool(`${path}.searched`, v.searched)
  if ('fan_out' in v && c.arr(`${path}.fan_out`, v.fan_out, { max: FAN_OUT_MAX })) v.fan_out.forEach((x, i) => c.str(`${path}.fan_out[${i}]`, x, { min: 1, max: FAN_OUT_CHARS }))
  if ('our_position' in v && v.our_position !== null) c.int(`${path}.our_position`, v.our_position, { min: 1 })
  if ('name_mentioned' in v && v.name_mentioned !== null) c.bool(`${path}.name_mentioned`, v.name_mentioned)
  if ('samples' in v && v.samples !== null && c.obj(`${path}.samples`, v.samples, ['n', 'first', 'cited'])) {
    const sm = v.samples
    if (c.int(`${path}.samples.n`, sm.n, { min: 1, max: SAMPLES_PER_CONTESTED })) {
      c.int(`${path}.samples.first`, sm.first, { min: 0, max: sm.n as number })
      c.int(`${path}.samples.cited`, sm.cited, { min: 0, max: sm.n as number })
    }
  }
}

function checkPanel(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['state', 'first_seen', 'last_asked', 'won_at', 'lost_at', 'streak'])) return
  c.oneOf(`${path}.state`, v.state, PANEL_STATES)
  c.ymd(`${path}.first_seen`, v.first_seen, true)
  c.ymd(`${path}.last_asked`, v.last_asked)
  c.ymd(`${path}.won_at`, v.won_at, true)
  c.ymd(`${path}.lost_at`, v.lost_at, true)
  if (v.streak !== null) c.int(`${path}.streak`, v.streak, { min: 1 })
}

function checkDiagnosis(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['gap_class', 'our_best_url', 'alignment', 'first_cited_host', 'first_cited_type'])) return
  c.oneOf(`${path}.gap_class`, v.gap_class, GAP_CLASSES)
  if (v.our_best_url !== null) c.str(`${path}.our_best_url`, v.our_best_url, { min: 1, max: 500 })
  if (c.num(`${path}.alignment`, v.alignment, { min: 0 }) && (v.alignment as number) > 1) c.fail(`${path}.alignment`, 'above 1')
  if (v.first_cited_host !== null) c.str(`${path}.first_cited_host`, v.first_cited_host, { min: 1, max: 120 })
  if (v.first_cited_type !== null) c.oneOf(`${path}.first_cited_type`, v.first_cited_type, SOURCE_TYPES)
}

const KIT_ID_RE = /^kit:[a-z0-9-]{1,40}:[0-9a-f]{8}$/

function checkCitedFeatures(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['url', 'host', 'source_type', 'read', 'title_matches_question', 'answer_first_words', 'words', 'h2_count', 'dated', 'server_rendered'])) return
  if (v.url !== null) c.str(`${path}.url`, v.url, { min: 1, max: 500 })
  c.str(`${path}.host`, v.host, { max: 120 })
  c.oneOf(`${path}.source_type`, v.source_type, SOURCE_TYPES)
  c.bool(`${path}.read`, v.read)
  for (const k of ['title_matches_question', 'dated', 'server_rendered'] as const) if (v[k] !== null) c.bool(`${path}.${k}`, v[k])
  for (const k of ['answer_first_words', 'words', 'h2_count'] as const) if (v[k] !== null) c.int(`${path}.${k}`, v[k], { min: 0 })
}

/** One win kit, the shape src/schema/kit.ts names. `queryIds`: the packet's questions, one of which it must be for. */
function checkKit(c: Checker, path: string, v: unknown, queryIds: ReadonlySet<string>): void {
  const keys = ['kit_id', 'v', 'product_slug', 'query_id', 'question', 'gap_class', 'priority', 'owned_by_platform', 'target', 'title', 'capsule', 'h2s', 'beat', 'site_fixes', 'off_site', 'verify', 'evidence']
  if (!c.obj(path, v, keys)) return
  c.str(`${path}.kit_id`, v.kit_id, { re: KIT_ID_RE })
  if (v.v !== 1) c.fail(`${path}.v`, 'must be 1')
  c.oneOf(`${path}.product_slug`, v.product_slug, PRODUCT_SLUGS)
  if (c.str(`${path}.query_id`, v.query_id, { re: UUID_RE }) && !queryIds.has(v.query_id)) c.fail(`${path}.query_id`, 'not one of the packet\'s queries')
  c.str(`${path}.question`, v.question, { min: 1, max: 400 })
  c.oneOf(`${path}.gap_class`, v.gap_class, GAP_CLASSES)
  c.num(`${path}.priority`, v.priority, { min: 0 })
  c.bool(`${path}.owned_by_platform`, v.owned_by_platform)
  if (c.obj(`${path}.target`, v.target, ['kind', 'url', 'host', 'suggested_path'])) {
    const t = v.target
    c.oneOf(`${path}.target.kind`, t.kind, TARGET_KINDS)
    if (t.url !== null) c.str(`${path}.target.url`, t.url, { min: 1, max: 500 })
    c.str(`${path}.target.host`, t.host, { max: 120 })
    if (t.suggested_path !== null) c.str(`${path}.target.suggested_path`, t.suggested_path, { min: 1, max: 120 })
  }
  c.str(`${path}.title`, v.title, { min: 1, max: 120 })
  if (c.obj(`${path}.capsule`, v.capsule, ['rules', 'must_cover'])) {
    if (c.arr(`${path}.capsule.rules`, v.capsule.rules, { max: 10 })) v.capsule.rules.forEach((x, i) => c.str(`${path}.capsule.rules[${i}]`, x, { min: 1, max: 200 }))
    if (v.capsule.must_cover !== null && c.arr(`${path}.capsule.must_cover`, v.capsule.must_cover, { max: 10 })) v.capsule.must_cover.forEach((x, i) => c.str(`${path}.capsule.must_cover[${i}]`, x, { min: 1, max: 200 }))
  }
  if (c.arr(`${path}.h2s`, v.h2s, { max: 6 })) v.h2s.forEach((x, i) => c.str(`${path}.h2s[${i}]`, x, { min: 1, max: 120 }))
  if (c.arr(`${path}.beat`, v.beat, { max: 3 })) v.beat.forEach((b, i) => {
    const p = `${path}.beat[${i}]`
    if (!c.obj(p, b, ['url', 'host', 'engine', 'position', 'features'])) return
    if (b.url !== null) c.str(`${p}.url`, b.url, { min: 1, max: 500 })
    c.str(`${p}.host`, b.host, { min: 1, max: 120 })
    c.oneOf(`${p}.engine`, b.engine, c.engines)
    c.int(`${p}.position`, b.position, { min: 1 })
    checkCitedFeatures(c, `${p}.features`, b.features)
  })
  if (c.arr(`${path}.site_fixes`, v.site_fixes, { max: 12 })) v.site_fixes.forEach((f, i) => {
    const p = `${path}.site_fixes[${i}]`
    if (!c.obj(p, f, ['gate', 'host', 'url', 'fix', 'owner_repo'])) return
    c.str(`${p}.gate`, f.gate, { min: 1, max: 60 })
    c.str(`${p}.host`, f.host, { max: 120 })
    if (f.url !== null) c.str(`${p}.url`, f.url, { min: 1, max: 500 })
    c.str(`${p}.fix`, f.fix, { min: 1, max: 400 })
    if (f.owner_repo !== null) c.str(`${p}.owner_repo`, f.owner_repo, { min: 1, max: 120 })
  })
  if (c.arr(`${path}.off_site`, v.off_site, { max: 5 })) v.off_site.forEach((o, i) => {
    const p = `${path}.off_site[${i}]`
    if (!c.obj(p, o, ['host', 'source_type', 'engines'], c.has('cited_pages') ? ['mention', 'mention_ok'] : [])) return
    c.str(`${p}.host`, o.host, { min: 1, max: 120 })
    c.oneOf(`${p}.source_type`, o.source_type, SOURCE_TYPES)
    if (c.arr(`${p}.engines`, o.engines, { max: 8 })) o.engines.forEach((e, j) => c.oneOf(`${p}.engines[${j}]`, e, c.engines))
    if ('mention' in o) c.oneOf(`${p}.mention`, o.mention, MENTIONS)
    if ('mention_ok' in o && o.mention_ok !== null) c.bool(`${p}.mention_ok`, o.mention_ok)
  })
  if (c.obj(`${path}.verify`, v.verify, ['engines', 'samples', 'success', 'recheck', 'baseline'])) {
    const vf = v.verify
    if (c.arr(`${path}.verify.engines`, vf.engines, { max: 8 })) vf.engines.forEach((e, j) => c.oneOf(`${path}.verify.engines[${j}]`, e, c.engines))
    if (vf.samples !== SAMPLES_PER_CONTESTED) c.fail(`${path}.verify.samples`, `must be ${SAMPLES_PER_CONTESTED}`)
    c.str(`${path}.verify.success`, vf.success, { min: 1, max: 200 })
    c.str(`${path}.verify.recheck`, vf.recheck, { min: 1, max: 120 })
    c.oneOf(`${path}.verify.baseline`, vf.baseline, GAP_CLASSES)
  }
  if (c.arr(`${path}.evidence`, v.evidence, { max: 6 })) v.evidence.forEach((x, i) => c.str(`${path}.evidence[${i}]`, x, { min: 1, max: 200 }))
}

function checkSite(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['hosts'])) return
  if (!c.arr(`${path}.hosts`, v.hosts, { max: SITE_HOSTS_MAX })) return
  v.hosts.forEach((h, i) => {
    const p = `${path}.hosts[${i}]`
    if (!c.obj(p, h, ['host', 'gates'])) return
    c.str(`${p}.host`, h.host, { min: 1, max: 120 })
    if (c.arr(`${p}.gates`, h.gates, { max: 12 })) h.gates.forEach((g, j) => {
      if (!c.obj(`${p}.gates[${j}]`, g, ['gate', 'pass'])) return
      c.oneOf(`${p}.gates[${j}].gate`, g.gate, HOST_GATES)
      c.bool(`${p}.gates[${j}].pass`, g.pass)
    })
  })
}

function checkGscWindow(c: Checker, path: string, v: unknown, before: boolean): void {
  if (!c.obj(path, v, ['impressions', 'clicks', 'position', 'from', 'to', ...(before ? ['before'] : [])])) return
  c.int(`${path}.impressions`, v.impressions, { min: 0 })
  c.int(`${path}.clicks`, v.clicks, { min: 0 })
  if (v.position !== null) c.num(`${path}.position`, v.position, { min: 0 })
  c.ymd(`${path}.from`, v.from)
  c.ymd(`${path}.to`, v.to)
  if (before && v.before !== null) checkGscWindow(c, `${path}.before`, v.before, false)
}

function checkOutcome(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['url', 'gsc', 'bing', 'ai_referrals'])) return
  c.str(`${path}.url`, v.url, { min: 1, max: 500 })
  if (v.gsc !== null) checkGscWindow(c, `${path}.gsc`, v.gsc, true)
  if (v.bing !== null && c.obj(`${path}.bing`, v.bing, ['indexed', 'last_crawled'])) {
    if (v.bing.indexed !== null) c.bool(`${path}.bing.indexed`, v.bing.indexed)
    c.ymd(`${path}.bing.last_crawled`, v.bing.last_crawled, true)
  }
  if (v.ai_referrals !== null && c.obj(`${path}.ai_referrals`, v.ai_referrals, ['from', 'to', 'ga4', 'clarity'])) {
    const a = v.ai_referrals
    c.ymd(`${path}.ai_referrals.from`, a.from)
    c.ymd(`${path}.ai_referrals.to`, a.to)
    for (const k of ['ga4', 'clarity'] as const) if (a[k] !== null) c.int(`${path}.ai_referrals.${k}`, a[k], { min: 0 })
  }
}

function checkCitedPage(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['url', 'host', 'page_type', 'questions', 'engines', 'times_cited', 'times_first', 'mention', 'mention_ok', 'checked_at', 'platform', 'own'])) return
  c.str(`${path}.url`, v.url, { min: 1, max: 500 })
  c.str(`${path}.host`, v.host, { min: 1, max: 120 })
  c.oneOf(`${path}.page_type`, v.page_type, SOURCE_TYPES)
  c.int(`${path}.questions`, v.questions, { min: 0 })
  if (c.arr(`${path}.engines`, v.engines, { max: 8, unique: true })) v.engines.forEach((e, j) => c.oneOf(`${path}.engines[${j}]`, e, c.engines))
  c.int(`${path}.times_cited`, v.times_cited, { min: 0 })
  c.int(`${path}.times_first`, v.times_first, { min: 0 })
  c.oneOf(`${path}.mention`, v.mention, MENTIONS)
  if (v.mention_ok !== null) c.bool(`${path}.mention_ok`, v.mention_ok)
  c.ymd(`${path}.checked_at`, v.checked_at, true)
  c.bool(`${path}.platform`, v.platform)
  c.bool(`${path}.own`, v.own)
}

function checkQuery(c: Checker, path: string, v: unknown): void {
  const optional = [...(c.has('panel') ? ['panel'] : []), ...(c.has('diagnosis') ? ['diagnosis'] : []), ...(c.has('outcome') ? ['outcome'] : [])]
  if (!c.obj(path, v, ['query_id', 'query', 'source', 'demand_score', 'demand_basis', 'call_evidence', 'gap', 'trend', 'status', 'touchpoint_id', 'probes'], optional)) return
  c.str(`${path}.query_id`, v.query_id, { re: UUID_RE })
  c.str(`${path}.query`, v.query, { min: 3, max: 400 })
  c.oneOf(`${path}.source`, v.source, QUERY_SOURCES)
  c.int(`${path}.demand_score`, v.demand_score, { min: 0, max: 100 })
  const b = v.demand_basis
  if (c.obj(`${path}.demand_basis`, b, ['llm_demand', 'transcript_evidence', 'rising_volume', 'labels'])) {
    c.int(`${path}.demand_basis.llm_demand`, b.llm_demand, { min: 0, max: 40 })
    c.int(`${path}.demand_basis.transcript_evidence`, b.transcript_evidence, { min: 0, max: 30 })
    c.int(`${path}.demand_basis.rising_volume`, b.rising_volume, { min: 0, max: 30 })
    if (c.arr(`${path}.demand_basis.labels`, b.labels)) b.labels.forEach((x, i) => c.str(`${path}.demand_basis.labels[${i}]`, x, { max: 120 }))
  }
  if (c.arr(`${path}.call_evidence`, v.call_evidence, { max: 10 })) v.call_evidence.forEach((x, i) => checkEvidence(c, `${path}.call_evidence[${i}]`, x))
  const g = v.gap
  if (c.obj(`${path}.gap`, g, ['we_cited_engines', 'competitor_domains'])) {
    if (c.arr(`${path}.gap.we_cited_engines`, g.we_cited_engines)) g.we_cited_engines.forEach((x, i) => c.oneOf(`${path}.gap.we_cited_engines[${i}]`, x, c.engines))
    if (c.arr(`${path}.gap.competitor_domains`, g.competitor_domains, { max: 12 })) g.competitor_domains.forEach((x, i) => c.str(`${path}.gap.competitor_domains[${i}]`, x, { max: 120 }))
  }
  c.oneOf(`${path}.trend`, v.trend, TRENDS)
  c.oneOf(`${path}.status`, v.status, QUERY_STATUSES)
  if (v.touchpoint_id !== null) c.str(`${path}.touchpoint_id`, v.touchpoint_id, { re: UUID_RE })
  if (c.arr(`${path}.probes`, v.probes, { max: 8 })) v.probes.forEach((x, i) => checkProbe(c, `${path}.probes[${i}]`, x))
  if ('panel' in v) checkPanel(c, `${path}.panel`, v.panel)
  if ('diagnosis' in v) checkDiagnosis(c, `${path}.diagnosis`, v.diagnosis)
  if ('outcome' in v) checkOutcome(c, `${path}.outcome`, v.outcome)
}

/** Every string anywhere in the value, with its path, for the content rules. */
function walkStrings(v: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof v === 'string') out.push([path, v])
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Rec)) walkStrings(x, path ? `${path}.${k}` : k, out)
}

export interface ValidateOptions {
  /**
   * The packet features the context lists (packet_features). Each optional
   * field is accepted only when its feature is listed; `engine_gemini` opens
   * gemini in the engines enum. Absent: none, the closed v1 shape alone.
   */
  features?: readonly string[]
}

/**
 * Validates a packet against the shape Control Center accepts today: the
 * closed v1 fields, plus only the optional ones whose feature its context
 * lists. A field it has not listed is refused here before anything leaves
 * the machine. The older form, a list of open gated engines, still reads.
 */
export function validatePacket(value: unknown, opts: ValidateOptions | readonly GatedEngine[] = {}): ValidationResult {
  const features: readonly string[] = Array.isArray(opts) ? (opts as readonly GatedEngine[]).map(e => GATE_FEATURE[e]) : (opts as ValidateOptions).features ?? []
  const open = openGatedEngines(features)
  const c = new Checker([...ENGINES_ALL, ...open], new Set(packetFeatures(features)))
  const top = [
    'schema_version', 'run_id', 'command_id', 'subject', 'week_start', 'generated_at', 'engines', 'themes_status', 'themes',
    'calls', 'queries', 'strongest_signal', 'recommendations', 'watch_list', 'competitor_gap', 'playbook', 'approach_hook', 'stats',
  ]
  // Additive in v1: this engine always writes not_worth_chasing, and a packet
  // written before the winnability gate existed still validates without it.
  // The rest only when Control Center lists their feature.
  const topOptional = ['not_worth_chasing', ...(c.has('kits') ? ['kits'] : []), ...(c.has('site') ? ['site'] : []), ...(c.has('run_kind') ? ['run_kind'] : []), ...(c.has('cited_pages') ? ['cited_pages'] : [])]
  if (!c.obj('packet', value, top, topOptional)) return { ok: false, errors: c.errors }
  const p = value

  if (p.schema_version !== 1) c.fail('schema_version', 'must be 1')
  c.str('run_id', p.run_id, { re: UUID_RE })
  if (p.command_id !== null) c.int('command_id', p.command_id, { min: 1 })

  if (c.obj('subject', p.subject, ['id', 'kind', 'slug', 'product_slug'])) {
    c.str('subject.id', p.subject.id, { re: UUID_RE })
    c.oneOf('subject.kind', p.subject.kind, SUBJECT_KINDS)
    c.str('subject.slug', p.subject.slug, { re: SLUG_RE })
    if (p.subject.product_slug !== null) c.oneOf('subject.product_slug', p.subject.product_slug, PRODUCT_SLUGS)
    // Rules Control Center's ingest enforces beyond the JSON schema.
    if (p.subject.kind === 'venture' && p.subject.product_slug === null) c.fail('subject.product_slug', 'a venture must name its product slug')
    if (p.subject.kind !== 'venture' && p.subject.product_slug !== null) c.fail('subject.product_slug', 'only a venture carries a product slug')
    if (p.subject.kind !== 'aspiration' && p.playbook !== null) c.fail('playbook', 'only an aspiration carries a playbook')
    if (p.subject.kind !== 'prospect' && p.approach_hook !== null) c.fail('approach_hook', 'only a prospect carries an approach hook')
  }

  if (c.str('week_start', p.week_start, { re: YMD_RE }) && YMD_RE.test(p.week_start) && !Number.isNaN(Date.parse(`${p.week_start}T00:00:00Z`)) && mondayOf(new Date(`${p.week_start}T00:00:00Z`)) !== p.week_start) c.fail('week_start', 'must be a Monday (UTC)')
  if (c.str('generated_at', p.generated_at)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(p.generated_at) || Number.isNaN(Date.parse(p.generated_at))) c.fail('generated_at', 'must be an ISO date-time')
  }

  if (c.arr('engines', p.engines, { min: 1, unique: true })) p.engines.forEach((x, i) => c.oneOf(`engines[${i}]`, x, c.engines))
  c.oneOf('themes_status', p.themes_status, THEMES_STATUSES)

  if (c.arr('themes', p.themes, { max: 10 })) {
    if (p.themes_status !== 'ok' && p.themes.length) c.fail('themes', 'must be empty unless themes_status is ok')
    p.themes.forEach((t, i) => {
      const path = `themes[${i}]`
      if (!c.obj(path, t, ['theme', 'calls', 'evidence'])) return
      c.str(`${path}.theme`, t.theme, { min: 1, max: 200 })
      c.int(`${path}.calls`, t.calls, { min: 1 })
      if (c.arr(`${path}.evidence`, t.evidence, { max: 6 })) t.evidence.forEach((e, j) => checkEvidence(c, `${path}.evidence[${j}]`, e))
    })
  }

  if (c.obj('calls', p.calls, ['considered', 'attributed'])) {
    c.int('calls.considered', p.calls.considered, { min: 0 })
    c.int('calls.attributed', p.calls.attributed, { min: 0 })
  }

  const queryIds = new Set<string>()
  let probeCount = 0
  if (c.arr('queries', p.queries, { max: 60 })) {
    p.queries.forEach((q, i) => {
      checkQuery(c, `queries[${i}]`, q)
      const id = (q as Rec)?.query_id
      if (typeof id === 'string') {
        if (queryIds.has(id)) c.fail(`queries[${i}].query_id`, 'repeated')
        queryIds.add(id)
      }
      const probes = (q as Rec)?.probes
      if (Array.isArray(probes)) probeCount += probes.length
    })
    if (probeCount > MAX_PROBES_PER_PACKET) c.fail('queries', `${probeCount} probes is over the ${MAX_PROBES_PER_PACKET} cap`)
  }

  if (p.strongest_signal !== null) c.str('strongest_signal', p.strongest_signal, { min: 1, max: 240 })

  if (c.arr('recommendations', p.recommendations, { max: 5 })) {
    p.recommendations.forEach((r, i) => {
      const path = `recommendations[${i}]`
      if (!c.obj(path, r, ['n', 'title', 'target_query', 'query_id', 'angle', 'evidence', 'engines', 'demand'], ['why_you_can_win'])) return
      c.int(`${path}.n`, r.n, { min: 1, max: 5 })
      c.str(`${path}.title`, r.title, { min: 1, max: 200 })
      c.str(`${path}.target_query`, r.target_query, { min: 1, max: 400 })
      if (c.str(`${path}.query_id`, r.query_id, { re: UUID_RE }) && !queryIds.has(r.query_id)) c.fail(`${path}.query_id`, 'not one of the packet\'s queries')
      c.str(`${path}.angle`, r.angle, { min: 1, max: 600 })
      if (c.arr(`${path}.evidence`, r.evidence, { max: 6 })) r.evidence.forEach((x, j) => c.str(`${path}.evidence[${j}]`, x, { max: 300 }))
      if (c.arr(`${path}.engines`, r.engines)) r.engines.forEach((x, j) => c.oneOf(`${path}.engines[${j}]`, x, c.engines))
      c.int(`${path}.demand`, r.demand, { min: 0, max: 100 })
      // Null is allowed and means the digest could not justify the recommendation.
      // Absent means the packet predates the winnability gate.
      if ('why_you_can_win' in r && r.why_you_can_win !== null) c.str(`${path}.why_you_can_win`, r.why_you_can_win, { min: 1, max: 300 })
    })
  }

  // What NOT to chase. Every entry names a question the packet actually carries,
  // so Control Center can put the verdict next to the row it belongs to.
  if ('not_worth_chasing' in p && c.arr('not_worth_chasing', p.not_worth_chasing, { max: 6 })) {
    const seen = new Set<string>()
    p.not_worth_chasing.forEach((w, i) => {
      const path = `not_worth_chasing[${i}]`
      if (!c.obj(path, w, ['query_id', 'query', 'owned_by', 'why_not'])) return
      if (c.str(`${path}.query_id`, w.query_id, { re: UUID_RE })) {
        if (!queryIds.has(w.query_id)) c.fail(`${path}.query_id`, 'not one of the packet\'s queries')
        if (seen.has(w.query_id)) c.fail(`${path}.query_id`, 'repeated')
        seen.add(w.query_id)
      }
      c.str(`${path}.query`, w.query, { min: 1, max: 400 })
      if (c.arr(`${path}.owned_by`, w.owned_by, { max: 8 })) w.owned_by.forEach((x, j) => c.str(`${path}.owned_by[${j}]`, x, { min: 1, max: 120 }))
      c.str(`${path}.why_not`, w.why_not, { min: 1, max: 300 })
    })
    // A question cannot be both the thing to make and the thing to skip.
    if (Array.isArray(p.recommendations)) {
      for (const r of p.recommendations) {
        const id = (r as Rec)?.query_id
        if (typeof id === 'string' && seen.has(id)) c.fail('not_worth_chasing', `query_id ${id} is also a recommendation`)
      }
    }
  }

  if (c.arr('watch_list', p.watch_list, { max: 15 })) {
    p.watch_list.forEach((w, i) => {
      const path = `watch_list[${i}]`
      if (!c.obj(path, w, ['query_id', 'query', 'why'])) return
      c.str(`${path}.query_id`, w.query_id, { re: UUID_RE })
      c.str(`${path}.query`, w.query, { max: 400 })
      c.str(`${path}.why`, w.why, { max: 240 })
    })
  }

  if (c.obj('competitor_gap', p.competitor_gap, ['domain', 'times_cited', 'questions'])) {
    if (p.competitor_gap.domain !== null) c.str('competitor_gap.domain', p.competitor_gap.domain, { max: 120 })
    c.int('competitor_gap.times_cited', p.competitor_gap.times_cited, { min: 0 })
    if (c.arr('competitor_gap.questions', p.competitor_gap.questions, { max: 10 })) p.competitor_gap.questions.forEach((x, i) => c.str(`competitor_gap.questions[${i}]`, x, { max: 400 }))
  }

  if (p.playbook !== null && c.arr('playbook', p.playbook, { max: 12 })) {
    p.playbook.forEach((e, i) => {
      const path = `playbook[${i}]`
      if (!c.obj(path, e, ['url', 'host', 'path_pattern', 'times_cited', 'why'])) return
      c.str(`${path}.url`, e.url, { max: 500 })
      c.str(`${path}.host`, e.host, { max: 120 })
      c.str(`${path}.path_pattern`, e.path_pattern, { max: 120 })
      c.int(`${path}.times_cited`, e.times_cited, { min: 1 })
      c.str(`${path}.why`, e.why, { max: 300 })
    })
  }

  if (p.approach_hook !== null) c.str('approach_hook', p.approach_hook, { min: 1, max: 300 })

  if (c.obj('stats', p.stats, ['queries', 'probes', 'probes_failed', 'probes_skipped_cap', 'cost_usd', 'engines', 'transcripts', 'digest_writer'])) {
    for (const k of ['queries', 'probes', 'probes_failed', 'probes_skipped_cap', 'engines', 'transcripts'] as const) c.int(`stats.${k}`, p.stats[k], { min: 0 })
    c.num('stats.cost_usd', p.stats.cost_usd, { min: 0 })
    c.oneOf('stats.digest_writer', p.stats.digest_writer, DIGEST_WRITERS)
  }

  if ('kits' in p && c.arr('kits', p.kits, { max: KITS_MAX })) {
    const ids = new Set<string>()
    p.kits.forEach((k, i) => {
      checkKit(c, `kits[${i}]`, k, queryIds)
      const id = (k as Rec)?.kit_id
      if (typeof id === 'string') { if (ids.has(id)) c.fail(`kits[${i}].kit_id`, 'repeated'); ids.add(id) }
    })
  }
  if ('site' in p) checkSite(c, 'site', p.site)
  if ('run_kind' in p) c.oneOf('run_kind', p.run_kind, RUN_KINDS)
  if ('cited_pages' in p && c.arr('cited_pages', p.cited_pages, { max: CITED_PAGES_MAX })) {
    const urls = new Set<string>()
    p.cited_pages.forEach((r, i) => {
      checkCitedPage(c, `cited_pages[${i}]`, r)
      const u = (r as Rec)?.url
      if (typeof u === 'string') { if (urls.has(u)) c.fail(`cited_pages[${i}].url`, 'repeated'); urls.add(u) }
    })
  }

  // Content rules that hold for every string in the packet, whatever its field.
  const strings: Array<[string, string]> = []
  walkStrings(value, '', strings)
  for (const [path, s] of strings) {
    if (EM_DASH_RE.test(s)) c.fail(path, 'contains an em dash')
    EMAIL_RE.lastIndex = 0
    if (EMAIL_RE.test(s)) c.fail(path, 'contains an email address')
    HANDLE_RE.lastIndex = 0
    if (HANDLE_RE.test(s)) c.fail(path, 'contains an @handle')
  }

  if (c.errors.length) return { ok: false, errors: c.errors }
  return { ok: true, packet: value as unknown as AeoPacket }
}

/**
 * One kit as the packet's `kits` feature would carry it: its shape and the
 * content rules every packet string obeys, on its own, so a kit a page or an
 * answer made unsendable is dropped rather than refusing the whole packet.
 */
export function kitErrors(kit: unknown, queryIds: ReadonlySet<string>, engines: readonly string[] = ENGINES_ALL, features: readonly string[] = ['kits']): string[] {
  const c = new Checker(engines, new Set(['kits', ...packetFeatures(features)]))
  checkKit(c, 'kit', kit, queryIds)
  const strings: Array<[string, string]> = []
  walkStrings(kit, 'kit', strings)
  for (const [path, s] of strings) {
    if (EM_DASH_RE.test(s)) c.fail(path, 'contains an em dash')
    EMAIL_RE.lastIndex = 0
    if (EMAIL_RE.test(s)) c.fail(path, 'contains an email address')
    HANDLE_RE.lastIndex = 0
    if (HANDLE_RE.test(s)) c.fail(path, 'contains an @handle')
  }
  return c.errors
}

/**
 * One cited-pages row as the packet's `cited_pages` feature would carry it:
 * its shape and the content rules, on its own, so a row a page's URL made
 * unsendable is dropped rather than refusing the whole packet.
 */
export function citedPageErrors(row: unknown, engines: readonly string[] = ENGINES_ALL): string[] {
  const c = new Checker(engines, new Set(['cited_pages']))
  checkCitedPage(c, 'cited_page', row)
  const strings: Array<[string, string]> = []
  walkStrings(row, 'cited_page', strings)
  for (const [path, s] of strings) {
    if (EM_DASH_RE.test(s)) c.fail(path, 'contains an em dash')
    EMAIL_RE.lastIndex = 0
    if (EMAIL_RE.test(s)) c.fail(path, 'contains an email address')
    HANDLE_RE.lastIndex = 0
    if (HANDLE_RE.test(s)) c.fail(path, 'contains an @handle')
  }
  return c.errors
}
