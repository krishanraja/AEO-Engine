/**
 * The offline twins. Each reads a fixture keyed by a short hash of the
 * request and throws MissingFixture, naming the path, when it is absent.
 * Fixture layout (under tests/fixtures by default):
 *
 *   context.all.json                       the context for every subject
 *   fireflies.transcripts.json             the list for the window
 *   fireflies.transcript.<id>.json         one transcript
 *   engines/<engine>.<sha8(question)>.json { text, citations } or { error }
 *   model/<stage>.<sha8(key)>.json         the JSON the model would return
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha8 } from '../lib/text.js'
import type { AeoContext } from '../schema/context.js'
import type { AeoPacket, Engine } from '../schema/packet.js'
import { asArray, asRecord, asString } from './http.js'
import {
  MissingFixture,
  type CommandPatch,
  type ControlCenterClient,
  type EngineAnswer,
  type EngineClient,
  type FirefliesClient,
  type IngestResult,
  type ModelClient,
  type ModelRequest,
  type Transcript,
  type TranscriptSummary,
} from './types.js'

function readFixture(dir: string, rel: string, hint: string): unknown {
  const path = join(dir, rel)
  if (!existsSync(path)) throw new MissingFixture(path, hint)
  return JSON.parse(readFileSync(path, 'utf8'))
}

export class OfflineEngine implements EngineClient {
  constructor(readonly engine: Engine, readonly model: string, private readonly dir: string) {}

  async ask(question: string): Promise<EngineAnswer> {
    const j = asRecord(readFixture(this.dir, join('engines', `${this.engine}.${sha8(question)}.json`), `${this.engine} answer to "${question}"`))
    if (typeof j.error === 'string') throw new Error(`${this.engine}_fixture_error: ${j.error}`)
    return { text: asString(j.text), citations: asArray(j.citations).map(String) }
  }
}

export class OfflineModel implements ModelClient {
  constructor(private readonly dir: string) {}

  private read(req: ModelRequest): string {
    const j = readFixture(this.dir, join('model', `${req.stage}.${sha8(req.key)}.json`), `${req.stage} for key "${req.key}"`)
    return JSON.stringify(j)
  }

  async classify(req: ModelRequest): Promise<string> { return this.read(req) }
  async writeJson(req: ModelRequest): Promise<string> { return this.read(req) }
}

export class OfflineFireflies implements FirefliesClient {
  constructor(private readonly dir: string) {}

  async listTranscripts(): Promise<TranscriptSummary[]> {
    return asArray(readFixture(this.dir, 'fireflies.transcripts.json', 'the transcript list')).map(t => {
      const r = asRecord(t)
      return { id: asString(r.id), title: asString(r.title), date: asString(r.date), participants: asArray(r.participants).map(String) }
    })
  }

  async getTranscript(id: string): Promise<Transcript> {
    const t = asRecord(readFixture(this.dir, `fireflies.transcript.${id}.json`, `transcript ${id}`))
    const s = asRecord(t.summary)
    return {
      id: asString(t.id),
      title: asString(t.title),
      date: asString(t.date),
      sentences: asArray(t.sentences).map(x => ({ text: asString(asRecord(x).text), speaker_name: asString(asRecord(x).speaker_name) })),
      summary: t.summary ? { overview: asString(s.overview), keywords: asArray(s.keywords).map(String), action_items: asArray(s.action_items).map(String) } : null,
    }
  }
}

export class OfflineControlCenter implements ControlCenterClient {
  readonly ingested: AeoPacket[] = []
  readonly patches: CommandPatch[] = []

  constructor(private readonly dir: string) {}

  async getContext(): Promise<AeoContext> {
    return readFixture(this.dir, 'context.all.json', 'the context') as AeoContext
  }

  async postIngest(packet: AeoPacket): Promise<IngestResult> {
    this.ingested.push(packet)
    return { ok: true, status: 200, deduped: false, replaced: false, offline: true }
  }

  async patchCommand(body: CommandPatch): Promise<void> {
    this.patches.push(body)
  }
}
