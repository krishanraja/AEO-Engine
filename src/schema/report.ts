/**
 * The growth engine protocol 1.0.0 as this engine speaks it: the report
 * envelope (docs/control-center/engine-report.schema.json), the attempt, and
 * the parts of the directive the engine reads. Control Center refuses a field
 * it does not know, so the validator below refuses one too, at every depth,
 * before anything leaves the machine.
 */
import { reportDigest } from '../lib/canonical.js'
import { EMAIL_RE, EM_DASH_RE } from '../lib/text.js'

export const ENGINE = { slug: 'aeo', engine_id: 'aeo-engine', product_slug: 'mindmake' } as const
export const OBJECTIVE_KEY = 'queries_cited_first'

export type Availability = 'measured' | 'missing' | 'stale'
export type ReportStatus = 'ready' | 'held' | 'degraded'
export type Wall = 'none' | 'spend' | 'send' | 'post' | 'strategy'
export type ProposalKind = 'advice' | 'prepared' | 'autonomous'

export interface ObjectiveReading {
  key: string
  value: number | null
  unit: string
  window_start: string | null
  window_end: string | null
  timezone: string | null
  availability: Availability
  reason: string | null
}

export interface ActivityLine { line: string; evidence_url: string | null }

export interface Proposal {
  proposal_id: string
  title: string
  why: string
  kind: ProposalKind
  wall: Wall
  amount_usd: number | null
  channel: string | null
  objective_key: string | null
  exact_payload: string | null
  payload_sha256: string
  evidence: Array<{ label: string; url: string | null }>
  close_condition: { event: string; reference: string | null }
  expires_at: string | null
}

export interface ReportEvent { event: string; proposal_id: string | null; at: string; evidence_url: string | null }
export interface Hold { reason: string; detail: string | null }

export interface EngineReport {
  schema_version: '1.0.0'
  engine_id: string
  product_slug: string
  run_id: string
  mode: 'live' | 'synthetic'
  observed_at: string
  source: { revision: string; captured_at: string }
  status: ReportStatus
  objectives: ObjectiveReading[]
  activity: ActivityLine[]
  proposals: Proposal[]
  events: ReportEvent[]
  holds: Hold[]
  payload_sha256: string
}

export type AttemptStatus = 'started' | 'succeeded' | 'failed' | 'unknown'

export interface Attempt {
  attempt_id: string
  command: string
  run_id: string | null
  status: AttemptStatus
  phase: string
  error_code: string | null
  started_at: string
  finished_at?: string
}

export interface Decision { proposal_id: string; decision: 'approved' | 'declined' | 'done'; decided_at: string; payload_sha256: string | null }

export interface Directive {
  schema_version: string
  directive_id: string
  engine_id: string
  for_date: string
  aim: string | null
  objectives: Array<{ key: string; target: number | null; latest: number | null; availability: string }>
  next_action: { proposal_id: string | null; instruction: string; why: string; close_condition: { event: string; reference?: string | null } | null }
  decisions_since: Array<{ proposal_id: string; decision: 'approved' | 'declined'; decided_at: string; payload_sha256: string | null }>
  constraints: { walls: string; spend_cap_usd: number; max_actions: number }
  in_house?: unknown
  /** 1.5.0, optional. Undefined: unknown today. An empty list: none approved yet. See parseTaste. */
  taste?: Taste
}

/** One of Krish's approved voice rules, as the directive carries it (protocol 1.5.0). */
export interface VoiceRule { layer: string | null; rule: string; his_words: string | null; what_it_means: string }

/**
 * Krish's approved voice rules (directive `taste`, protocol 1.5.0). They say
 * how drafted words are written, never what they are about, and they never
 * reach a judge, a scorer, a ranker or a measurement: in this engine only the
 * digest's drafting prompt reads them (src/pipeline/60-digest.ts).
 */
export interface Taste { rule: string; approved_voice_rules: VoiceRule[] }

const TASTE_MAX_RULES = 40
const TASTE_MAX_CHARS = 1000

/**
 * Reads the directive's `taste` loosely: unknown fields are ignored, a rule
 * entry without its `rule` text is dropped, every string is cut to a bound.
 * Null means unknown (absent, or not the shape 1.5.0 says), which is not the
 * same as an empty list (none approved yet), and neither is ever filled in.
 */
export function parseTaste(raw: unknown): Taste | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const t = raw as Record<string, unknown>
  if (!Array.isArray(t.approved_voice_rules)) return null
  const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim().slice(0, TASTE_MAX_CHARS) : null
  const rules: VoiceRule[] = []
  for (const item of t.approved_voice_rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const r = item as Record<string, unknown>
    const rule = text(r.rule)
    if (!rule) continue
    rules.push({ layer: text(r.layer), rule, his_words: text(r.his_words), what_it_means: text(r.what_it_means) ?? '' })
    if (rules.length >= TASTE_MAX_RULES) break
  }
  return { rule: text(t.rule) ?? '', approved_voice_rules: rules }
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/
export const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
const SHA_RE = /^[0-9a-f]{64}$/
const HTTPS_RE = /^https:\/\/\S+$/

/** Seals a report: computes payload_sha256 over everything else. */
export function sealReport(body: Omit<EngineReport, 'payload_sha256'>): EngineReport {
  const draft = { ...body } as Record<string, unknown>
  return { ...body, payload_sha256: reportDigest(draft) }
}

type Errs = string[]

function closed(path: string, v: unknown, allowed: readonly string[], required: readonly string[], errs: Errs): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errs.push(`${path}: not an object`); return false }
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errs.push(`${path}.${k}: unknown field`)
  for (const k of required) if (!(k in v)) errs.push(`${path}.${k}: required`)
  return true
}

function str(path: string, v: unknown, errs: Errs, o: { max?: number; re?: RegExp; nullable?: boolean } = {}): void {
  if (v === null && o.nullable) return
  if (typeof v !== 'string') { errs.push(`${path}: not a string`); return }
  if (o.max !== undefined && v.length > o.max) errs.push(`${path}: longer than ${o.max}`)
  if (o.re && !o.re.test(v)) errs.push(`${path}: does not match ${o.re}`)
  if (EM_DASH_RE.test(v)) errs.push(`${path}: em dash`)
  EMAIL_RE.lastIndex = 0
  if (EMAIL_RE.test(v)) errs.push(`${path}: carries an email address`)
}

function time(path: string, v: unknown, errs: Errs, nullable = false): void {
  if (v === null && nullable) return
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/T/.test(v)) errs.push(`${path}: not a date-time`)
}

function list(path: string, v: unknown, max: number, errs: Errs): unknown[] {
  if (!Array.isArray(v)) { errs.push(`${path}: not an array`); return [] }
  if (v.length > max) errs.push(`${path}: more than ${max} items`)
  return v
}

/**
 * Every rule of engine-report.schema.json, every object closed (the server
 * refuses unknown fields), plus the protocol's prose rules: unknown is null
 * with a reason, spend carries an amount, send and post carry exact words,
 * nothing autonomous sits behind a wall, and the digest is right.
 */
export function validateReport(r: unknown): { ok: true } | { ok: false; errors: string[] } {
  const errs: Errs = []
  const top = ['schema_version', 'engine_id', 'product_slug', 'run_id', 'mode', 'observed_at', 'source', 'status', 'objectives', 'activity', 'proposals', 'events', 'holds', 'payload_sha256']
  if (!closed('report', r, top, top, errs)) return { ok: false, errors: errs }
  if (r.schema_version !== '1.0.0') errs.push('report.schema_version: must be 1.0.0')
  str('report.engine_id', r.engine_id, errs, { max: 64 })
  str('report.product_slug', r.product_slug, errs, { max: 64 })
  str('report.run_id', r.run_id, errs, { re: ID_RE })
  if (r.mode !== 'live' && r.mode !== 'synthetic') errs.push('report.mode: live or synthetic')
  time('report.observed_at', r.observed_at, errs)
  if (closed('report.source', r.source, ['revision', 'captured_at'], ['revision', 'captured_at'], errs)) {
    str('report.source.revision', r.source.revision, errs, { max: 128 })
    time('report.source.captured_at', r.source.captured_at, errs)
  }
  if (!['ready', 'held', 'degraded'].includes(r.status as string)) errs.push('report.status: ready, held or degraded')

  list('report.objectives', r.objectives, 20, errs).forEach((o, i) => {
    const p = `report.objectives[${i}]`
    const keys = ['key', 'value', 'unit', 'window_start', 'window_end', 'timezone', 'availability', 'reason']
    if (!closed(p, o, keys, ['key', 'value', 'unit', 'availability'], errs)) return
    str(`${p}.key`, o.key, errs, { re: KEY_RE })
    if (o.value !== null && (typeof o.value !== 'number' || !Number.isFinite(o.value))) errs.push(`${p}.value: number or null`)
    str(`${p}.unit`, o.unit, errs, { max: 40 })
    time(`${p}.window_start`, o.window_start ?? null, errs, true)
    time(`${p}.window_end`, o.window_end ?? null, errs, true)
    str(`${p}.timezone`, o.timezone ?? null, errs, { nullable: true })
    if (!['measured', 'missing', 'stale'].includes(o.availability as string)) errs.push(`${p}.availability: measured, missing or stale`)
    str(`${p}.reason`, o.reason ?? null, errs, { max: 500, nullable: true })
    if (o.availability !== 'measured' && !(typeof o.reason === 'string' && o.reason.trim())) errs.push(`${p}.reason: required when not measured`)
    if (o.availability === 'missing' && o.value !== null) errs.push(`${p}.value: unknown is null, never a number`)
    if (o.availability === 'measured' && o.value === null) errs.push(`${p}.value: measured needs a number`)
  })

  list('report.activity', r.activity, 40, errs).forEach((a, i) => {
    const p = `report.activity[${i}]`
    if (!closed(p, a, ['line', 'evidence_url'], ['line'], errs)) return
    str(`${p}.line`, a.line, errs, { max: 500 })
    str(`${p}.evidence_url`, a.evidence_url ?? null, errs, { re: HTTPS_RE, nullable: true })
  })

  list('report.proposals', r.proposals, 10, errs).forEach((x, i) => {
    const p = `report.proposals[${i}]`
    const keys = ['proposal_id', 'title', 'why', 'kind', 'wall', 'amount_usd', 'channel', 'objective_key', 'exact_payload', 'payload_sha256', 'evidence', 'close_condition', 'expires_at']
    if (!closed(p, x, keys, ['proposal_id', 'title', 'why', 'kind', 'wall', 'payload_sha256', 'close_condition'], errs)) return
    str(`${p}.proposal_id`, x.proposal_id, errs, { re: ID_RE })
    str(`${p}.title`, x.title, errs, { max: 160 })
    str(`${p}.why`, x.why, errs, { max: 1000 })
    if (!['advice', 'prepared', 'autonomous'].includes(x.kind as string)) errs.push(`${p}.kind: advice, prepared or autonomous`)
    if (!['none', 'spend', 'send', 'post', 'strategy'].includes(x.wall as string)) errs.push(`${p}.wall: unknown wall`)
    if (x.amount_usd !== undefined && x.amount_usd !== null && !(typeof x.amount_usd === 'number' && x.amount_usd >= 0)) errs.push(`${p}.amount_usd: a number of 0 or more`)
    str(`${p}.channel`, x.channel ?? null, errs, { max: 60, nullable: true })
    str(`${p}.objective_key`, x.objective_key ?? null, errs, { re: KEY_RE, nullable: true })
    str(`${p}.exact_payload`, x.exact_payload ?? null, errs, { max: 8000, nullable: true })
    str(`${p}.payload_sha256`, x.payload_sha256, errs, { re: SHA_RE })
    list(`${p}.evidence`, x.evidence ?? [], 12, errs).forEach((e, j) => {
      if (!closed(`${p}.evidence[${j}]`, e, ['label', 'url'], ['label', 'url'], errs)) return
      str(`${p}.evidence[${j}].label`, e.label, errs, { max: 500 })
      str(`${p}.evidence[${j}].url`, e.url, errs, { re: HTTPS_RE, nullable: true })
    })
    if (closed(`${p}.close_condition`, x.close_condition, ['event', 'reference'], ['event'], errs)) {
      str(`${p}.close_condition.event`, x.close_condition.event, errs, { re: KEY_RE })
      str(`${p}.close_condition.reference`, x.close_condition.reference ?? null, errs, { max: 500, nullable: true })
    }
    time(`${p}.expires_at`, x.expires_at ?? null, errs, true)
    if (x.wall === 'spend' && typeof x.amount_usd !== 'number') errs.push(`${p}.amount_usd: required for spend`)
    if ((x.wall === 'send' || x.wall === 'post') && !(typeof x.exact_payload === 'string' && x.exact_payload && typeof x.channel === 'string' && x.channel)) errs.push(`${p}: send and post need exact_payload and channel`)
    if (x.kind === 'autonomous' && x.wall !== 'none') errs.push(`${p}: an autonomous proposal cannot sit behind a wall`)
    for (const k of Object.keys(x)) if (/^(send|post|publish|schedule|spend|pay)_/.test(k)) errs.push(`${p}.${k}: a proposal never asks Control Center to act`)
  })

  list('report.events', r.events, 40, errs).forEach((e, i) => {
    const p = `report.events[${i}]`
    if (!closed(p, e, ['event', 'proposal_id', 'at', 'evidence_url'], ['event', 'at'], errs)) return
    str(`${p}.event`, e.event, errs, { re: KEY_RE })
    str(`${p}.proposal_id`, e.proposal_id ?? null, errs, { nullable: true })
    time(`${p}.at`, e.at, errs)
    str(`${p}.evidence_url`, e.evidence_url ?? null, errs, { re: HTTPS_RE, nullable: true })
  })

  list('report.holds', r.holds, 40, errs).forEach((h, i) => {
    const p = `report.holds[${i}]`
    if (!closed(p, h, ['reason', 'detail'], ['reason'], errs)) return
    str(`${p}.reason`, h.reason, errs, { max: 200 })
    str(`${p}.detail`, h.detail ?? null, errs, { max: 1000, nullable: true })
  })

  str('report.payload_sha256', r.payload_sha256, errs, { re: SHA_RE })
  if (typeof r.payload_sha256 === 'string' && r.payload_sha256 !== reportDigest(r)) errs.push('report.payload_sha256: does not match the canonical digest')
  return errs.length ? { ok: false, errors: errs } : { ok: true }
}
