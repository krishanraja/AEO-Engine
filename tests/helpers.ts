import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngineAnswer, EngineClient, ModelClient, ModelRequest } from '../src/clients/types.js'
import type { AeoContext, ContextSubject } from '../src/schema/context.js'
import type { Engine } from '../src/schema/packet.js'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const FIXTURES = join(ROOT, 'tests', 'fixtures')

export function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, rel), 'utf8'))
}

export function fixtureContext(): AeoContext {
  return readJson('context.all.json') as AeoContext
}

export function subject(slug: string): ContextSubject {
  const s = fixtureContext().subjects.find(x => x.slug === slug)
  if (!s) throw new Error(`no fixture subject ${slug}`)
  return s
}

/** A model that answers every request with one canned string, and records what it was asked. */
export class StubModel implements ModelClient {
  requests: ModelRequest[] = []
  constructor(private readonly answer: string | ((req: ModelRequest) => string)) {}
  private reply(req: ModelRequest): string {
    this.requests.push(req)
    const a = typeof this.answer === 'function' ? this.answer(req) : this.answer
    if (a === 'THROW') throw new Error('stub model failure')
    return a
  }
  async classify(req: ModelRequest): Promise<string> { return this.reply(req) }
  async writeJson(req: ModelRequest): Promise<string> { return this.reply(req) }
}

export class StubEngine implements EngineClient {
  asked: string[] = []
  constructor(readonly engine: Engine, private readonly answer: (q: string) => EngineAnswer, readonly model = `${engine}-stub`) {}
  async ask(question: string): Promise<EngineAnswer> {
    this.asked.push(question)
    return this.answer(question)
  }
}

export const sha8Key = (s: string) => s
