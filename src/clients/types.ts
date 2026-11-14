/**
 * The interfaces the pipeline talks to. Live and offline implementations
 * satisfy the same shapes, so no stage ever knows which one it has.
 */
import type { CostKind } from '../config/run.js'
import type { BillingRow, UsageRow } from '../lib/usage.js'
import type { AeoContext } from '../schema/context.js'
import type { AeoPacket, ProbeEngine } from '../schema/packet.js'

/**
 * One engine's answer to one question.
 *
 * `citations` are the sources the answer cites IN ITS TEXT, in the order it
 * first cites them, each URL once: Claude's web_search_result_location
 * citations on its text blocks, ChatGPT's url_citation annotations by
 * position, Perplexity's [n] markers mapped to its source list. Index 0 is the
 * answer's first citation, which is what queries_cited_first reads. The rest
 * is what the engine reports about how it got there, each optional because
 * not every engine says:
 *
 *   retrieved  every source its search returned, cited or not
 *   searched   whether it searched the web for this answer at all
 *   fan_out    the search queries it ran, in order
 *   usage      the provider's own usage object, untouched
 */
export interface EngineAnswer {
  text: string
  citations: string[]
  retrieved?: string[]
  searched?: boolean
  fan_out?: string[]
  usage?: unknown
  /**
   * Hosted search tool calls the provider bills per call and does not put in
   * its usage object (OpenAI's web_search_call items). Read by the meter
   * (providerSearchCalls in src/lib/usage.ts); absent elsewhere.
   */
  search_calls?: number
  /**
   * URLs the answer's text carried that its searches never returned, dropped
   * from `citations` (the Claude Code lane, whose answer is plain text). A
   * count; absent where the engine's citations are structured.
   */
  typed_urls_dropped?: number
  /**
   * The Claude Code subscription passed a warning threshold while this answer
   * was written (rate_limit_event status allowed_warning) and still served
   * it. Counted as probes_limit_warning; absent otherwise.
   */
  limit_warning?: boolean
}

/** What a probe may tell an engine beyond the question. Nothing here ever reaches the engine's prompt. */
export interface AskContext {
  /** The domains that count as ours for this subject (Gemini resolves a grounding redirect only for the first citation and for these). */
  domains?: readonly string[]
}

export interface EngineClient {
  readonly engine: ProbeEngine
  readonly model: string
  /** What the ledger charges a probe to. Absent: the engine itself. */
  readonly costKind?: CostKind
  /**
   * Asked instead when this engine stops on its subscription's limit
   * (SubscriptionLimit), charged at its own cost kind. The Claude Code lane
   * carries the API lane here in `code_then_api` mode.
   */
  readonly fallback?: EngineClient
  /**
   * True when this engine will ask nothing more this job (Gemini past its
   * free-tier share). The probe stage reads it before charging, so a probe
   * that would be skipped is never charged. Absent: never exhausted.
   */
  readonly exhausted?: boolean
  ask(question: string, ctx?: AskContext): Promise<EngineAnswer>
}

/**
 * The Claude Code subscription stopped a probe on its rate limit: a
 * rate_limit_event whose status is rejected (or one the CLI does not
 * declare), or whose isUsingOverage is true, which means paid extra usage
 * would carry on. allowed_warning is not a limit (EngineAnswer.limit_warning).
 * The probe is failed and counted in probes_skipped_limit; no paid call
 * replaces it unless the lane says so.
 */
export class SubscriptionLimit extends Error {
  constructor(public readonly status: string, public readonly limitType: string) {
    super(`subscription_limit: ${status}${limitType ? ` (${limitType})` : ''}`)
    this.name = 'SubscriptionLimit'
  }
}

/**
 * Gemini's grounding queries for this job reached CAPS.GEMINI_MAX_QUERIES_PER_JOB,
 * the job's share of the free tier. The probe is skipped, never paid for, and
 * counted in probes_skipped_free_tier.
 */
export class FreeTierExhausted extends Error {
  constructor(public readonly used: number, public readonly cap: number) {
    super(`free_tier_exhausted: ${used} of ${cap} grounding queries`)
    this.name = 'FreeTierExhausted'
  }
}

export type ModelStage = 'classify' | 'themes' | 'propose' | 'digest' | 'voice'

export interface ModelRequest {
  stage: ModelStage
  /** A stable key for this request (a transcript id, a subject id). The offline client hashes it to find its fixture. */
  key: string
  system: string
  user: string
  maxTokens: number
}

export interface ModelClient {
  classify(req: ModelRequest): Promise<string>
  writeJson(req: ModelRequest): Promise<string>
}

export interface TranscriptSummary { id: string; title: string; date: string; participants: string[] }
export interface TranscriptSentence { text: string; speaker_name: string }
export interface Transcript {
  id: string
  title: string
  date: string
  sentences: TranscriptSentence[]
  summary: { overview: string; keywords: string[]; action_items: string[] } | null
}

export interface FirefliesClient {
  listTranscripts(fromISO: string, toISO: string): Promise<TranscriptSummary[]>
  getTranscript(id: string): Promise<Transcript>
}

/** Any Fireflies failure. Surfaces as themes_status fireflies_unavailable, never as "no calls". */
export class FirefliesUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FirefliesUnavailable'
  }
}

export interface IngestResult {
  ok: boolean
  status: number
  deduped?: boolean
  replaced?: boolean
  error?: string
  errors?: string[]
  [k: string]: unknown
}

export interface CommandPatch { command_id: number; state: 'running' | 'failed'; error?: string }

export interface ControlCenterClient {
  getContext(subject: string): Promise<AeoContext>
  postIngest(packet: AeoPacket): Promise<IngestResult>
  patchCommand(body: CommandPatch): Promise<void>
  /** Measured token counts for the usage meter. Returns its failure rather
   *  than throwing: reporting the spend must never cost us the run. */
  postUsage(rows: UsageRow[] | BillingRow[], run: string): Promise<{ ok: boolean; error: string | null }>
}

/** Thrown by an offline client when the fixture a request maps to is absent. */
export class MissingFixture extends Error {
  constructor(public readonly path: string, hint: string) {
    super(`missing fixture ${path} (${hint})`)
    this.name = 'MissingFixture'
  }
}
