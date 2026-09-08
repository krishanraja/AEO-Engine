/**
 * OpenAI Responses API with the hosted web_search tool. Text comes from
 * output items of type message; citations from url_citation annotations.
 */
import { MODELS } from '../config/run.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient } from './types.js'

export class OpenAIClient implements EngineClient {
  readonly engine = 'chatgpt' as const
  readonly model = MODELS.openai

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  }

  async ask(question: string): Promise<EngineAnswer> {
    const j = asRecord(await requireOk('openai', 'https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: { model: this.model, input: question, tools: [{ type: 'web_search' }] },
    }))
    const texts: string[] = []
    const citations: string[] = []
    for (const item of asArray(j.output)) {
      const it = asRecord(item)
      if (it.type !== 'message') continue
      for (const part of asArray(it.content)) {
        const p = asRecord(part)
        const text = asString(p.text)
        if (text) texts.push(text)
        for (const a of asArray(p.annotations)) {
          const ann = asRecord(a)
          const url = asString(ann.url)
          if (ann.type === 'url_citation' && url && !citations.includes(url)) citations.push(url)
        }
      }
    }
    return { text: texts.join('\n'), citations }
  }
}
