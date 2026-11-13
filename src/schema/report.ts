/**
 * The growth engine protocol as this engine speaks it: 1.0.0 reports, and
 * 1.20.0 reports when the directive serves the engine's state (priorities,
 * obsessions, next steps and Krish's instruction acks); the report envelope
 * (docs/control-center/engine-report.schema.json), the attempt, and the parts
 * of the directive the engine reads. Control Center refuses a field it does
 * not know, so the validator below refuses one too, at every depth, before
 * anything leaves the machine.
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

/** 1.1.0: an autonomous engine's steps. A plan sits behind a wall; a go-live is a send, post or spend naming its plan; a check-in is a strategy call naming its plan. */
export type ProposalStage = 'plan' | 'go_live' | 'check_in'
export const PROPOSAL_STAGES: readonly ProposalStage[] = ['plan', 'go_live', 'check_in']

export interface Proposal {
  /** 1.1.0, optional. Absent or null: not an autonomous step. */
  stage?: ProposalStage | null
  /** 1.1.0: the plan a go-live carries out or a check-in reports on. Required on both. */
  parent_proposal_id?: string | null
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

/**
 * The versions this engine sends: 1.0.0; 1.1.0 when a proposal carries a
 * stage (plan, go-live, check-in); 1.20.0 when a report carries the
 * engine's state; 1.22.0 when it also says which venture requests it asked.
 */
export type SchemaVersion = '1.0.0' | '1.1.0' | '1.20.0' | '1.22.0'
export const STAGES_VERSION = '1.1.0'
export const STATE_VERSION = '1.20.0'
/** 1.22.0: AEO-Engine is the one AI-answers specialist every venture's engine calls (Ruling, Krish, 2026-11-12). */
export const ANSWERS_VERSION = '1.22.0'
export const ANSWERS_SERVED_MAX = 50

/** 1.20.0: what the engine is chasing, most important first (at most 5). */
export interface EnginePriority { rank: number; line: string; objective_key: string | null }
/** 1.20.0: Krish's own aims, quoted from this repository's docs (at most 3). */
export interface EngineObsession { line: string; since: string | null }
export type WaitsOn = 'engine' | 'krish' | 'other'
/** 1.20.0: what the engine does next, and who each step waits on (at most 5). */
export interface EngineNextStep { line: string; waits_on: WaitsOn; when: string | null }
export type AckState = 'received' | 'started' | 'done' | 'blocked'
/** 1.20.0: what the engine did with one of Krish's instructions, by id only (at most 5). */
export interface InstructionAck { instruction_id: string; state: AckState; line: string; at: string; evidence_url: string | null }

/** The engine's state on a 1.20.0 report. A field it has no source for is left out, never filled. */
export interface EngineState {
  priorities?: EnginePriority[]
  obsessions?: EngineObsession[]
  next_steps?: EngineNextStep[]
  instruction_acks?: InstructionAck[]
}

export const PRIORITIES_MAX = 5
export const OBSESSIONS_MAX = 3
export const NEXT_STEPS_MAX = 5
export const INSTRUCTION_ACKS_MAX = 5
export const STATE_LINE_MAX = 200
export const ACK_LINE_MAX = 280
/** An instruction's id as Control Center makes it: ki_ and 24 hex characters. */
export const INSTRUCTION_ID_RE = /^ki_[0-9a-f]{24}$/
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
// Control Center's own guards on a state or ack line (src/lib/growthEngines.ts,
// lineCarriesContact): an address, or a run of ten digits or more, refuses the
// whole report there, so it is refused here first.
const CONTROL_RE = /[\u0000-\u001f\u007f]/
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i
const PHONE_RUN = /\+?\d[\d\s().-]{8,}\d/g

/** Whether a line may go out as a priority, obsession, next step or ack line: one plain line, no address, no number. */
export function stateLineOk(v: unknown, max: number): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (!t || t !== v || v.length > max) return false
  if (CONTROL_RE.test(v) || EM_DASH_RE.test(v) || EMAIL_IN_TEXT.test(v)) return false
  return !(v.match(PHONE_RUN) ?? []).some(r => r.replace(/\D/g, '').length >= 10)
}

/**
 * Krish's instruction as this engine keeps it (directive `krish_instruction`,
 * protocol 1.20.0). His words are checked and then dropped at the client:
 * this repository and its Actions logs are public, and no run here reads
 * them (the daily run reads and reports only, and the research run probes
 * Control Center's subject list). Only the id goes anywhere.
 */
export interface InstructionRef { id: string; given_at: string; supersedes: string | null }

/**
 * What the directive serves (1.20.0; answer_requests 1.22.0). Absent before
 * 1.20.0, which means: send nothing new. Two flags Control Center is asked
 * for in docs/briefs/2026-11-13-aeo-specialist.md, section E, read only when
 * true: `answer_requests_v2` (a request carries mode, targets as pages and
 * shipped pages) and `aeo_kits_delivered` (the venture engines carry the win
 * kits, so AEO stops proposing kit plans itself and keeps its check-ins).
 */
export interface DirectiveFeatures { engine_state: boolean; krish_instruction: boolean; answer_requests?: boolean; answer_requests_v2?: boolean; aeo_kits_delivered?: boolean }

/**
 * 1.22.0: a venture engine's open request to this specialist (directive
 * `answer_requests`): its own product's buyer questions, asked verbatim
 * under that product's subject at the next research run.
 */
export interface AnswerRequest {
  request_id: string
  engine_id: string
  product_slug: string
  subject_slug: string
  questions: string[]
  requested_at: string
  /** The venture engine's note on the request, at most 400 characters. Kept, never logged. */
  note?: string
  /** How the venture asked it to be served, as it said; only when present. */
  mode?: string
  /** What the venture named as targets, as it said; only when present. */
  targets?: string[]
  /**
   * features.answer_requests_v2: the page the venture means to win each named
   * question with. A kit for that question takes it as its target page.
   */
  target_urls?: Array<{ question: string; url: string }>
  /** features.answer_requests_v2: the pages the venture shipped, by question or query_id. They are probed first, after the requests. */
  shipped?: Array<{ question?: string; query_id?: string; url: string; shipped_at: string | null }>
}

export const REQUEST_NOTE_MAX = 400
const REQUEST_URL_RE = /^https?:\/\/[^\s"'<>@]+$/i
const QUERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const requestUrl = (v: unknown): string | null => (typeof v === 'string' && v.trim().length <= 500 && REQUEST_URL_RE.test(v.trim()) ? v.trim() : null)
const requestQuestion = (v: unknown): string | null => (typeof v === 'string' && v.trim().length >= 8 && v.length <= 300 ? v.trim() : null)

const REQUEST_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Reads `answer_requests` loosely: a request that is not the shape 1.22.0
 * says is dropped, never guessed at; absent or not a list is none. A question
 * is kept only when it is 8 to 300 characters.
 */
export function parseAnswerRequests(raw: unknown, opts: { v2?: boolean } = {}): AnswerRequest[] {
  if (!Array.isArray(raw)) return []
  const out: AnswerRequest[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const r = x as Record<string, unknown>
    if (typeof r.request_id !== 'string' || !REQUEST_ID_RE.test(r.request_id)) continue
    if (typeof r.product_slug !== 'string' || typeof r.engine_id !== 'string') continue
    const questions = Array.isArray(r.questions) ? r.questions.filter((q): q is string => typeof q === 'string' && q.trim().length >= 8 && q.length <= 300).map(q => q.trim()) : []
    if (!questions.length) continue
    const req: AnswerRequest = { request_id: r.request_id.toLowerCase(), engine_id: r.engine_id, product_slug: r.product_slug, subject_slug: typeof r.subject_slug === 'string' ? r.subject_slug : r.product_slug, questions: questions.slice(0, 25), requested_at: typeof r.requested_at === 'string' ? r.requested_at : '' }
    // Kept rather than dropped (protocol 1.22.0 as Control Center serves it):
    // a note of at most 400 characters, and mode and targets only when present.
    if (typeof r.note === 'string' && r.note.trim()) req.note = r.note.trim().slice(0, REQUEST_NOTE_MAX)
    if (typeof r.mode === 'string' && r.mode.trim()) req.mode = r.mode.trim().slice(0, 40)
    if (Array.isArray(r.targets)) {
      const targets = r.targets.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim().slice(0, 200)).slice(0, 25)
      if (targets.length) req.targets = targets
    }
    // features.answer_requests_v2 (brief section E): targets as {question, url}
    // and shipped pages, each read loosely; a misshapen entry is dropped.
    if (opts.v2) {
      if (Array.isArray(r.targets)) {
        const urls: Array<{ question: string; url: string }> = []
        for (const t of r.targets) {
          if (!t || typeof t !== 'object' || Array.isArray(t)) continue
          const question = requestQuestion((t as Record<string, unknown>).question)
          const url = requestUrl((t as Record<string, unknown>).url)
          if (question && url) urls.push({ question, url })
          if (urls.length >= 25) break
        }
        if (urls.length) req.target_urls = urls
      }
      if (Array.isArray(r.shipped)) {
        const shipped: NonNullable<AnswerRequest['shipped']> = []
        for (const x of r.shipped) {
          if (!x || typeof x !== 'object' || Array.isArray(x)) continue
          const e = x as Record<string, unknown>
          const url = requestUrl(e.url)
          const question = requestQuestion(e.question)
          const queryId = typeof e.query_id === 'string' && QUERY_ID_RE.test(e.query_id.toLowerCase()) ? e.query_id.toLowerCase() : null
          if (!url || (!question && !queryId)) continue
          const at = typeof e.shipped_at === 'string' && !Number.isNaN(Date.parse(e.shipped_at)) ? e.shipped_at : null
          shipped.push({ ...(question ? { question } : {}), ...(queryId ? { query_id: queryId } : {}), url, shipped_at: at })
          if (shipped.length >= 25) break
        }
        if (shipped.length) req.shipped = shipped
      }
    }
    out.push(req)
  }
  return out
}

/**
 * Reads `krish_instruction` loosely: null for absent, null, or not the shape
 * 1.20.0 says (an id that is not Control Center's, no words, a bad time).
 * Never keeps the words.
 */
export function parseInstruction(raw: unknown): InstructionRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const k = raw as Record<string, unknown>
  if (typeof k.id !== 'string' || !INSTRUCTION_ID_RE.test(k.id)) return null
  if (typeof k.words !== 'string' || !k.words.trim()) return null
  if (typeof k.given_at !== 'string' || Number.isNaN(Date.parse(k.given_at))) return null
  const supersedes = typeof k.supersedes === 'string' && INSTRUCTION_ID_RE.test(k.supersedes) ? k.supersedes : null
  return { id: k.id, given_at: k.given_at, supersedes }
}

/** Reads `features` loosely: null unless both flags are booleans. */
export function parseFeatures(raw: unknown): DirectiveFeatures | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const f = raw as Record<string, unknown>
  if (typeof f.engine_state !== 'boolean' || typeof f.krish_instruction !== 'boolean') return null
  return {
    engine_state: f.engine_state,
    krish_instruction: f.krish_instruction,
    ...(f.answer_requests === true ? { answer_requests: true } : {}),
    ...(f.answer_requests_v2 === true ? { answer_requests_v2: true } : {}),
    ...(f.aeo_kits_delivered === true ? { aeo_kits_delivered: true } : {}),
  }
}

export interface EngineReport extends EngineState {
  /** 1.22.0: the venture requests this research run asked (AnswerRequest.request_id). */
  answers_served?: string[]
  schema_version: SchemaVersion
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

export type CarriedOut = 'draft' | 'message' | 'submit' | 'tapped'
const CARRIED_OUT: readonly CarriedOut[] = ['draft', 'message', 'submit', 'tapped']

/**
 * One of Krish's decisions, as GET decisions and the directive's
 * decisions_since give it. 1.1.0 adds the stage it was made on and, when he
 * amended it, his version (exact_payload, amount_usd) and its digest; 1.6.0
 * adds how he carried it out and his reason code on a No. Each is optional:
 * absent means not said, and an engine acting on an amended decision acts on
 * his version, never its own.
 */
export interface Decision {
  proposal_id: string
  decision: 'approved' | 'declined' | 'done'
  decided_at: string
  payload_sha256: string | null
  stage?: ProposalStage | null
  amended?: boolean
  amended_sha256?: string
  exact_payload?: string | null
  amount_usd?: number | null
  carried_out?: CarriedOut
  reason_code?: string
}

/**
 * Reads one decision loosely: unknown fields are ignored and never fatal; a
 * field of the wrong shape is left out rather than guessed at. Null when it
 * names no proposal or no decision this engine knows.
 */
export function parseDecision(raw: unknown): Decision | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const d = raw as Record<string, unknown>
  if (typeof d.proposal_id !== 'string' || !d.proposal_id) return null
  if (d.decision !== 'approved' && d.decision !== 'declined' && d.decision !== 'done') return null
  const out: Decision = {
    proposal_id: d.proposal_id,
    decision: d.decision,
    decided_at: typeof d.decided_at === 'string' ? d.decided_at : '',
    payload_sha256: typeof d.payload_sha256 === 'string' ? d.payload_sha256 : null,
  }
  if (d.stage === null || PROPOSAL_STAGES.includes(d.stage as ProposalStage)) out.stage = d.stage as ProposalStage | null
  if (typeof d.amended === 'boolean') out.amended = d.amended
  if (typeof d.amended_sha256 === 'string' && /^[0-9a-f]{64}$/.test(d.amended_sha256)) out.amended_sha256 = d.amended_sha256
  if (d.exact_payload === null || typeof d.exact_payload === 'string') out.exact_payload = d.exact_payload as string | null
  if (d.amount_usd === null || (typeof d.amount_usd === 'number' && Number.isFinite(d.amount_usd) && d.amount_usd >= 0)) out.amount_usd = d.amount_usd as number | null
  if (CARRIED_OUT.includes(d.carried_out as CarriedOut)) out.carried_out = d.carried_out as CarriedOut
  if (typeof d.reason_code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(d.reason_code)) out.reason_code = d.reason_code
  return out
}

/** A list of decisions, each read loosely; anything that is not one is dropped. */
export function parseDecisions(raw: unknown): Decision[] {
  return Array.isArray(raw) ? raw.map(parseDecision).filter((d): d is Decision => d !== null) : []
}

export interface Directive {
  schema_version: string
  directive_id: string
  engine_id: string
  for_date: string
  aim: string | null
  objectives: Array<{ key: string; target: number | null; latest: number | null; availability: string }>
  next_action: { proposal_id: string | null; instruction: string; why: string; close_condition: { event: string; reference?: string | null } | null }
  decisions_since: Decision[]
  constraints: { walls: string; spend_cap_usd: number; max_actions: number }
  in_house?: unknown
  /** 1.5.0, optional. Undefined: unknown today. An empty list: none approved yet. See parseTaste. */
  taste?: Taste
  /** 1.20.0, optional: Krish's open instruction, its words already dropped (parseInstruction). Null or undefined: none. */
  krish_instruction?: InstructionRef | null
  /** 1.20.0: what the directive serves. Undefined: before 1.20.0, so nothing new is sent. */
  features?: DirectiveFeatures
  /** 1.22.0, optional: the venture engines' open requests (parseAnswerRequests). Undefined or empty: none. */
  answer_requests?: AnswerRequest[]
}

/** One of Krish's approved voice rules, as the directive carries it (protocol 1.5.0). */
export interface VoiceRule { layer: string | null; rule: string; his_words: string | null; what_it_means: string }

/**
 * Krish's approved voice rules (directive `taste`, protocol 1.5.0). They say
 * how drafted words are written, never what they are about, and they never
 * reach a judge, a scorer, a ranker or a measurement: in this engine only the
 * wording-only voice pass reads them (src/pipeline/65-voice.ts).
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
  const stateKeys = ['priorities', 'obsessions', 'next_steps', 'instruction_acks']
  if (!closed('report', r, [...top, ...stateKeys, 'answers_served'], top, errs)) return { ok: false, errors: errs }
  if (!SENT_VERSIONS.includes(r.schema_version as SchemaVersion)) errs.push(`report.schema_version: ${SENT_VERSIONS.join(', ')}`)
  const v = typeof r.schema_version === 'string' ? r.schema_version : '1.0.0'
  if (versionBefore(v, STATE_VERSION)) for (const k of stateKeys) if (k in r) errs.push(`report.${k}: needs schema_version ${STATE_VERSION}`)
  if ('answers_served' in r) {
    if (r.schema_version !== ANSWERS_VERSION) errs.push(`report.answers_served: needs schema_version ${ANSWERS_VERSION}`)
    list('report.answers_served', r.answers_served, ANSWERS_SERVED_MAX, errs).forEach((x, i) => { if (typeof x !== 'string' || !REQUEST_ID_RE.test(x)) errs.push(`report.answers_served[${i}]: a request id`) })
  }
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
    const keys = ['proposal_id', 'title', 'why', 'kind', 'wall', 'amount_usd', 'channel', 'objective_key', 'exact_payload', 'payload_sha256', 'evidence', 'close_condition', 'expires_at', 'stage', 'parent_proposal_id']
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
    stageErrors(p, x, v, errs)
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

  stateErrors(r, errs)

  str('report.payload_sha256', r.payload_sha256, errs, { re: SHA_RE })
  if (typeof r.payload_sha256 === 'string' && r.payload_sha256 !== reportDigest(r)) errs.push('report.payload_sha256: does not match the canonical digest')
  return errs.length ? { ok: false, errors: errs } : { ok: true }
}

/** Every version this engine may send. */
export const SENT_VERSIONS: readonly SchemaVersion[] = ['1.0.0', STAGES_VERSION, STATE_VERSION, ANSWERS_VERSION]

/** True when version a is older than b (both x.y.z). */
export function versionBefore(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}

/**
 * 1.1.0's stage and parent_proposal_id on a proposal, as the protocol's
 * Autonomy section says: refused before 1.1.0; a plan sits behind a wall; a
 * go-live is a send, post or spend naming its plan; a check-in is a strategy
 * call naming its plan.
 */
function stageErrors(p: string, x: Record<string, unknown>, version: string, errs: Errs): void {
  const hasStage = 'stage' in x
  const hasParent = 'parent_proposal_id' in x
  if (!hasStage && !hasParent) return
  if (versionBefore(version, STAGES_VERSION)) {
    if (hasStage) errs.push(`${p}.stage: needs schema_version ${STAGES_VERSION}`)
    if (hasParent) errs.push(`${p}.parent_proposal_id: needs schema_version ${STAGES_VERSION}`)
    return
  }
  const stage = x.stage ?? null
  if (stage !== null && !PROPOSAL_STAGES.includes(stage as ProposalStage)) { errs.push(`${p}.stage: plan, go_live, check_in or null`); return }
  str(`${p}.parent_proposal_id`, x.parent_proposal_id ?? null, errs, { re: ID_RE, nullable: true })
  const parent = typeof x.parent_proposal_id === 'string' && x.parent_proposal_id ? x.parent_proposal_id : null
  if (stage === 'plan' && x.wall === 'none') errs.push(`${p}: a plan sits behind a wall`)
  if (stage === 'go_live') {
    if (!['send', 'post', 'spend'].includes(x.wall as string)) errs.push(`${p}: a go-live is a send, post or spend`)
    if (!parent) errs.push(`${p}.parent_proposal_id: required on a go-live`)
  }
  if (stage === 'check_in') {
    if (x.wall !== 'strategy') errs.push(`${p}: a check-in sits behind strategy`)
    if (!parent) errs.push(`${p}.parent_proposal_id: required on a check-in`)
  }
}

/** 1.20.0's four fields, each optional, each as Control Center's parseEngineState takes it. */
function stateErrors(r: Record<string, unknown>, errs: Errs): void {
  const line = (path: string, v: unknown, max: number) => { if (!stateLineOk(v, max)) errs.push(`${path}: one plain line of at most ${max}, with no address, number or em dash`) }
  const ymd = (path: string, v: unknown) => { if (v !== null && v !== undefined && !(typeof v === 'string' && YMD_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) errs.push(`${path}: YYYY-MM-DD or null`) }

  if ('priorities' in r) list('report.priorities', r.priorities, PRIORITIES_MAX, errs).forEach((x, i) => {
    const p = `report.priorities[${i}]`
    if (!closed(p, x, ['rank', 'line', 'objective_key'], ['rank', 'line'], errs)) return
    if (!Number.isInteger(x.rank) || (x.rank as number) < 1 || (x.rank as number) > PRIORITIES_MAX) errs.push(`${p}.rank: a whole number from 1 to ${PRIORITIES_MAX}`)
    line(`${p}.line`, x.line, STATE_LINE_MAX)
    str(`${p}.objective_key`, x.objective_key ?? null, errs, { re: KEY_RE, nullable: true })
  })

  if ('obsessions' in r) list('report.obsessions', r.obsessions, OBSESSIONS_MAX, errs).forEach((x, i) => {
    const p = `report.obsessions[${i}]`
    if (!closed(p, x, ['line', 'since'], ['line'], errs)) return
    line(`${p}.line`, x.line, STATE_LINE_MAX)
    ymd(`${p}.since`, x.since)
  })

  if ('next_steps' in r) list('report.next_steps', r.next_steps, NEXT_STEPS_MAX, errs).forEach((x, i) => {
    const p = `report.next_steps[${i}]`
    if (!closed(p, x, ['line', 'waits_on', 'when'], ['line', 'waits_on'], errs)) return
    line(`${p}.line`, x.line, STATE_LINE_MAX)
    if (!['engine', 'krish', 'other'].includes(x.waits_on as string)) errs.push(`${p}.waits_on: engine, krish or other`)
    ymd(`${p}.when`, x.when)
  })

  if ('instruction_acks' in r) list('report.instruction_acks', r.instruction_acks, INSTRUCTION_ACKS_MAX, errs).forEach((x, i) => {
    const p = `report.instruction_acks[${i}]`
    if (!closed(p, x, ['instruction_id', 'state', 'line', 'at', 'evidence_url'], ['instruction_id', 'state', 'line', 'at'], errs)) return
    str(`${p}.instruction_id`, x.instruction_id, errs, { re: INSTRUCTION_ID_RE })
    if (!['received', 'started', 'done', 'blocked'].includes(x.state as string)) errs.push(`${p}.state: received, started, done or blocked`)
    line(`${p}.line`, x.line, ACK_LINE_MAX)
    time(`${p}.at`, x.at, errs)
    str(`${p}.evidence_url`, x.evidence_url ?? null, errs, { re: HTTPS_RE, nullable: true })
  })
}
