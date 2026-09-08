/**
 * AeoPacket v1, the JSON this engine POSTs to Control Center.
 *
 * The types mirror docs/packet.schema.json exactly; validatePacket is the
 * hand-written check the pipeline runs before anything leaves the machine.
 * No schema library: the contract is small, the rules are few, and a
 * validator with no dependencies cannot be the reason a Sunday run fails.
 */
import { EMAIL_RE, EM_DASH_RE, HANDLE_RE } from '../lib/text.js'
import { mondayOf } from '../lib/week.js'

/** Control Center refuses a packet carrying more probes than this in total. */
export const MAX_PROBES_PER_PACKET = 600

export const ENGINES_ALL = ['perplexity', 'chatgpt', 'claude', 'grok'] as const
export type Engine = (typeof ENGINES_ALL)[number]

export const SUBJECT_KINDS = ['venture', 'prospect', 'aspiration'] as const
export type SubjectKind = (typeof SUBJECT_KINDS)[number]

export const PRODUCT_SLUGS = ['ctrl', 'circle', 'pulse', 'full-time', 'mindmake'] as const
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
}

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
}

export type ValidationResult = { ok: true; packet: AeoPacket } | { ok: false; errors: string[] }

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const CALL_REF_RE = /^[0-9a-f]{8}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

type Rec = Record<string, unknown>

class Checker {
  errors: string[] = []

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
  if (!c.obj(path, v, ['engine', 'model', 'question', 'answer_snapshot', 'we_cited', 'citations', 'cost_usd'])) return
  c.oneOf(`${path}.engine`, v.engine, ENGINES_ALL)
  c.str(`${path}.model`, v.model, { max: 80 })
  c.str(`${path}.question`, v.question, { min: 1, max: 400 })
  c.str(`${path}.answer_snapshot`, v.answer_snapshot, { max: 1800 })
  c.bool(`${path}.we_cited`, v.we_cited)
  if (c.arr(`${path}.citations`, v.citations, { max: 8 })) {
    v.citations.forEach((x, i) => c.str(`${path}.citations[${i}]`, x, { max: 500 }))
  }
  c.num(`${path}.cost_usd`, v.cost_usd, { min: 0 })
}

function checkQuery(c: Checker, path: string, v: unknown): void {
  if (!c.obj(path, v, ['query_id', 'query', 'source', 'demand_score', 'demand_basis', 'call_evidence', 'gap', 'trend', 'status', 'touchpoint_id', 'probes'])) return
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
    if (c.arr(`${path}.gap.we_cited_engines`, g.we_cited_engines)) g.we_cited_engines.forEach((x, i) => c.oneOf(`${path}.gap.we_cited_engines[${i}]`, x, ENGINES_ALL))
    if (c.arr(`${path}.gap.competitor_domains`, g.competitor_domains, { max: 12 })) g.competitor_domains.forEach((x, i) => c.str(`${path}.gap.competitor_domains[${i}]`, x, { max: 120 }))
  }
  c.oneOf(`${path}.trend`, v.trend, TRENDS)
  c.oneOf(`${path}.status`, v.status, QUERY_STATUSES)
  if (v.touchpoint_id !== null) c.str(`${path}.touchpoint_id`, v.touchpoint_id, { re: UUID_RE })
  if (c.arr(`${path}.probes`, v.probes, { max: 8 })) v.probes.forEach((x, i) => checkProbe(c, `${path}.probes[${i}]`, x))
}

/** Every string anywhere in the value, with its path, for the content rules. */
function walkStrings(v: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof v === 'string') out.push([path, v])
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Rec)) walkStrings(x, path ? `${path}.${k}` : k, out)
}

export function validatePacket(value: unknown): ValidationResult {
  const c = new Checker()
  const top = [
    'schema_version', 'run_id', 'command_id', 'subject', 'week_start', 'generated_at', 'engines', 'themes_status', 'themes',
    'calls', 'queries', 'strongest_signal', 'recommendations', 'watch_list', 'competitor_gap', 'playbook', 'approach_hook', 'stats',
  ]
  // Additive in v1: this engine always writes not_worth_chasing, and a packet
  // written before the winnability gate existed still validates without it.
  const topOptional = ['not_worth_chasing']
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

  if (c.arr('engines', p.engines, { min: 1, unique: true })) p.engines.forEach((x, i) => c.oneOf(`engines[${i}]`, x, ENGINES_ALL))
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
      if (c.arr(`${path}.engines`, r.engines)) r.engines.forEach((x, j) => c.oneOf(`${path}.engines[${j}]`, x, ENGINES_ALL))
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
