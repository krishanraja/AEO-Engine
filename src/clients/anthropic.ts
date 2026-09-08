/**
 * Anthropic Messages API over raw fetch (this repo has no runtime
 * dependencies). Two jobs: a web-searching answer engine for probes, and the
 * JSON writer behind classification, proposal and the digest.
 *
 * The JSON calls run with thinking disabled: they are bounded extraction and
 * rewriting over evidence we hand them, and a fixed, cheap turn is what a
 * cron with a spend cap wants. The web search tool type is the dynamic
 * filtering variant the current models take; older models need the basic
 * variant, so if the model id changes, check this type with it.
 */
import { MODELS } from '../config/run.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient, ModelClient, ModelRequest } from './types.js'

const URL = 'https://api.anthropic.com/v1/messages'
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 5 }

export class AnthropicClient implements EngineClient {
  readonly engine = 'claude' as const
  readonly model = MODELS.anthropic

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
  }

  /** A probe: ask the question with web search on, collect text and every cited URL. */
  async ask(question: string): Promise<EngineAnswer> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: question }]
    const texts: string[] = []
    const citations: string[] = []
    const add = (u: unknown) => { const s = asString(u); if (s && !citations.includes(s)) citations.push(s) }
    // A search turn can pause; continue it a bounded number of times.
    for (let turn = 0; turn < 3; turn++) {
      const j = asRecord(await requireOk('anthropic', URL, {
        method: 'POST',
        headers: this.headers(),
        body: { model: this.model, max_tokens: 4000, tools: [WEB_SEARCH_TOOL], messages },
      }))
      const content = asArray(j.content)
      for (const block of content) {
        const b = asRecord(block)
        if (b.type === 'text') {
          texts.push(asString(b.text))
          for (const c of asArray(b.citations)) {
            const cit = asRecord(c)
            if (cit.type === 'web_search_result_location') add(cit.url)
          }
        } else if (b.type === 'web_search_tool_result') {
          for (const r of asArray(b.content)) add(asRecord(r).url)
        }
      }
      if (j.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content })
    }
    return { text: texts.join('\n').trim(), citations }
  }

  private async text(system: string, user: string, maxTokens: number): Promise<string> {
    const j = asRecord(await requireOk('anthropic', URL, {
      method: 'POST',
      headers: this.headers(),
      body: {
        model: this.model,
        max_tokens: maxTokens,
        thinking: { type: 'disabled' },
        system,
        messages: [{ role: 'user', content: user }],
      },
    }))
    if (j.stop_reason === 'refusal') throw new Error('anthropic_refusal')
    for (const block of asArray(j.content)) {
      const b = asRecord(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
    return ''
  }

  /** A short JSON verdict: which subject a transcript belongs to. */
  classify(system: string, user: string, maxTokens: number): Promise<string> {
    return this.text(system, user, maxTokens)
  }

  /** A JSON document written from evidence: themes, a query proposal, the digest. */
  writeJson(system: string, user: string, maxTokens: number): Promise<string> {
    return this.text(system, user, maxTokens)
  }

  /** The pipeline-facing shape; the stage and key are for the offline twin and are ignored here. */
  asModelClient(): ModelClient {
    return {
      classify: (r: ModelRequest) => this.classify(r.system, r.user, r.maxTokens),
      writeJson: (r: ModelRequest) => this.writeJson(r.system, r.user, r.maxTokens),
    }
  }
}
