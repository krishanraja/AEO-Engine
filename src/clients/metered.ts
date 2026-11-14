/**
 * A probe engine from a provider other than Anthropic, with its tokens
 * metered (AEO brief, section F). OpenAI, Perplexity, Google and xAI report
 * usage in their own shapes; each answer's usage goes to the one UsageMeter
 * (recordProvider), which reads input and output tokens out of it, and a call
 * that throws is counted as a failed call with no tokens. Control Center prices
 * the tokens, or shows them unpriced, once its meter reads billing rows; this
 * engine never prices a call itself.
 *
 * Everything else is the wrapped engine's own: its engine, model, cost kind,
 * fallback and whether it is exhausted are read through, so a stage cannot
 * tell the two apart.
 */
import { providerSearchCalls, type OtherProvider, type UsageMeter } from '../lib/usage.js'
import type { AskContext, EngineAnswer, EngineClient } from './types.js'

export class MeteredEngine implements EngineClient {
  constructor(private readonly inner: EngineClient, private readonly provider: OtherProvider, private readonly meter: UsageMeter) {}

  /** The wrapped engine itself. */
  get client(): EngineClient { return this.inner }
  get engine() { return this.inner.engine }
  get model() { return this.inner.model }
  get costKind() { return this.inner.costKind }
  get fallback() { return this.inner.fallback }
  get exhausted() { return this.inner.exhausted }

  async ask(question: string, ctx?: AskContext): Promise<EngineAnswer> {
    let answer: EngineAnswer
    try {
      answer = await this.inner.ask(question, ctx)
    } catch (e) {
      this.meter.recordProvider(this.provider, 'aeo-probe', this.inner.model, undefined, true)
      throw e
    }
    this.meter.recordProvider(this.provider, 'aeo-probe', this.inner.model, answer.usage, false, providerSearchCalls(this.provider, answer))
    return answer
  }
}
