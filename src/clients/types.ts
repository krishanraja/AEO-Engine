/**
 * The interfaces the pipeline talks to. Live and offline implementations
 * satisfy the same shapes, so no stage ever knows which one it has.
 */
import type { UsageRow } from '../lib/usage.js'
import type { AeoContext } from '../schema/context.js'
import type { AeoPacket, Engine } from '../schema/packet.js'

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
}

export interface EngineClient {
  readonly engine: Engine
  readonly model: string
  ask(question: string): Promise<EngineAnswer>
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
  postUsage(rows: UsageRow[], run: string): Promise<{ ok: boolean; error: string | null }>
}

/** Thrown by an offline client when the fixture a request maps to is absent. */
export class MissingFixture extends Error {
  constructor(public readonly path: string, hint: string) {
    super(`missing fixture ${path} (${hint})`)
    this.name = 'MissingFixture'
  }
}
