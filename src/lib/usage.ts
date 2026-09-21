/**
 * What the run actually spent, as opposed to what it estimated.
 *
 * lib/cost.ts is a CAP, not a bill. It charges PRICE_USD_PER_CALL before each
 * call so a map that grows to 200 questions cannot quietly become a 200-call
 * invoice, and its own comment says those numbers are estimates to be tuned
 * from real ledgers. That makes it exactly the wrong thing to report as spend:
 * a flat per-call figure has no idea that one probe composed an answer over
 * five web searches and the next returned in two sentences.
 *
 * This is the other half. It reads the `usage` object off every Anthropic
 * response and adds it up per stage and model. It deliberately does NOT turn
 * tokens into dollars: Control Center's _prices.ts is the one price table in
 * the fleet, and a second one here would be a second thing to keep in step,
 * which is the failure that table was built to end. Tokens travel; pricing
 * happens once, at the other end.
 *
 * The accumulated shape is Anthropic's own, field for field, so the receiving
 * end parses it with the same readUsage() it uses for a live call, including
 * the cache fields, which are all zero today and will not be forever.
 */

/** Anthropic's usage shape, summed. Field names are the wire's, not ours. */
export interface SummedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
}

export interface UsageRow {
  /** The meter's unit key: which part of the run spent this. */
  agent: string
  model: string
  usage: SummedUsage
  calls: number
  failed: number
}

const zero = (): SummedUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
})

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export class UsageMeter {
  private readonly cells = new Map<string, UsageRow>()

  /**
   * Record one response.
   *
   * A call that errored after tokens were produced still cost money, so a
   * failure is counted rather than dropped: a run that burned its budget on
   * refusals must not read as a cheap run.
   */
  record(agent: string, model: string, usage: unknown, failed = false): void {
    const u = (usage || {}) as Record<string, unknown>
    const key = `${agent}|${model}`
    let cell = this.cells.get(key)
    if (!cell) {
      cell = { agent, model, usage: zero(), calls: 0, failed: 0 }
      this.cells.set(key, cell)
    }
    const creation = (u.cache_creation || {}) as Record<string, unknown>
    cell.usage.input_tokens += num(u.input_tokens)
    cell.usage.output_tokens += num(u.output_tokens)
    cell.usage.cache_read_input_tokens += num(u.cache_read_input_tokens)
    cell.usage.cache_creation_input_tokens += num(u.cache_creation_input_tokens)
    cell.usage.cache_creation.ephemeral_5m_input_tokens += num(creation.ephemeral_5m_input_tokens)
    cell.usage.cache_creation.ephemeral_1h_input_tokens += num(creation.ephemeral_1h_input_tokens)
    cell.calls += 1
    if (failed) cell.failed += 1
  }

  /** Rows with no tokens at all are dropped: nothing was measured, so there is
   *  nothing to report, and a zero row is indistinguishable from a cheap one. */
  rows(): UsageRow[] {
    return [...this.cells.values()].filter(r => r.usage.input_tokens + r.usage.output_tokens > 0)
  }

  get calls(): number {
    return [...this.cells.values()].reduce((s, r) => s + r.calls, 0)
  }

  get tokens(): number {
    return this.rows().reduce((s, r) => s + r.usage.input_tokens + r.usage.output_tokens, 0)
  }
}
