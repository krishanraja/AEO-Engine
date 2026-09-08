/** Perplexity chat completions, model sonar. A port of askPerplexity in Control Center's geo-probe. */
import { MODELS } from '../config/run.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient } from './types.js'

export class PerplexityClient implements EngineClient {
  readonly engine = 'perplexity' as const
  readonly model = MODELS.perplexity

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('PERPLEXITY_API_KEY is not set')
  }

  async ask(question: string): Promise<EngineAnswer> {
    const j = asRecord(await requireOk('perplexity', 'https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, messages: [{ role: 'user', content: question }] },
    }))
    const first = asRecord(asArray(j.choices)[0])
    const text = asString(asRecord(first.message).content)
    const citations = Array.isArray(j.citations)
      ? j.citations.filter((c): c is string => typeof c === 'string')
      : asArray(j.search_results).map(s => asRecord(s).url).filter((u): u is string => typeof u === 'string')
    return { text, citations }
  }
}
