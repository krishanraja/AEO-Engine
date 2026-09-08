/** xAI chat completions with live search on; citations come back as a list of URLs. */
import { MODELS } from '../config/run.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient } from './types.js'

export class XaiClient implements EngineClient {
  readonly engine = 'grok' as const
  readonly model = MODELS.xai

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('XAI_API_KEY is not set')
  }

  async ask(question: string): Promise<EngineAnswer> {
    const j = asRecord(await requireOk('xai', 'https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        messages: [{ role: 'user', content: question }],
        search_parameters: { mode: 'auto', return_citations: true },
      },
    }))
    const first = asRecord(asArray(j.choices)[0])
    const text = asString(asRecord(first.message).content)
    const citations = asArray(j.citations).filter((c): c is string => typeof c === 'string')
    return { text, citations }
  }
}
