/**
 * The interfaces the pipeline talks to. Live and offline implementations
 * satisfy the same shapes, so no stage ever knows which one it has.
 */
import type { AeoContext } from '../schema/context.js'
import type { AeoPacket, Engine } from '../schema/packet.js'

export interface EngineAnswer { text: string; citations: string[] }

export interface EngineClient {
  readonly engine: Engine
  readonly model: string
  ask(question: string): Promise<EngineAnswer>
}

export type ModelStage = 'classify' | 'themes' | 'propose' | 'digest'

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
}

/** Thrown by an offline client when the fixture a request maps to is absent. */
export class MissingFixture extends Error {
  constructor(public readonly path: string, hint: string) {
    super(`missing fixture ${path} (${hint})`)
    this.name = 'MissingFixture'
  }
}
