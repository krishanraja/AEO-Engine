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
 *
 * Hosted web searches are billed per request, beside the tokens, and a probe
 * response says how many it made (usage.server_tool_use.web_search_requests).
 * The meter counts them (`searches`, `searchesBy`) and, once the context lists
 * `meter_billing`, posts them on their row as `search_calls`.
 *
 * Billing. A call is billed to the API (the default) or to a subscription:
 * the Claude Code lane's probes run on the Claude Code subscription token
 * (src/clients/claudeCode.ts) and cost no API dollar. Their tokens are
 * recorded here with billing `subscription` and kept apart: rows() returns
 * the API rows only, because the meter's POST is priced at the other end at
 * API rates, and a subscription row priced that way would report a spend
 * that never happened.
 *
 * Billing rows (AEO brief, section F). Once the context lists `meter_billing`
 * (acceptBilling), Control Center's meter reads each row's provider, billing,
 * tokens and search calls, and postRows() sends every row: the Anthropic API
 * rows as before plus their search calls, the subscription's as tokens with
 * no dollar amount (Ruling, Krish, 2026-11-13), and the other providers'
 * probes (OpenAI, Perplexity, Google, xAI, recordProvider) as input and
 * output tokens, priced, or shown unpriced, at the other end. Until then
 * postRows() is rows(), exactly the shape the meter always took.
 */
export type Billing = 'api' | 'subscription'

/** Anthropic's usage shape, summed. Field names are the wire's, not ours. */
export interface SummedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }
}

/** A provider other than Anthropic whose probe tokens are metered (recordProvider). */
export type OtherProvider = 'openai' | 'perplexity' | 'google' | 'xai'

/**
 * A row as Control Center's meter reads it once the context lists
 * `meter_billing`: the provider and billing, then Anthropic's own usage object
 * or plain input and output tokens.
 */
export type BillingRow =
  | { provider: 'anthropic'; billing: 'api'; agent: string; model: string; usage: SummedUsage; calls: number; failed: number; search_calls: number }
  | { provider: 'anthropic' | OtherProvider; billing: 'api' | 'subscription'; agent: string; model: string; input_tokens: number; output_tokens: number; calls: number; failed: number }

/** Input and output tokens out of any provider's usage object: OpenAI's Responses, Perplexity's and xAI's chat, Gemini's usageMetadata. */
export function tokensOf(usage: unknown): { input: number; output: number } {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>
  const input = num(u.input_tokens) || num(u.prompt_tokens) || num(u.promptTokenCount)
  const output = num(u.output_tokens) || num(u.completion_tokens) || (num(u.candidatesTokenCount) + num(u.thoughtsTokenCount))
  return { input, output }
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
  /** The same rows for calls billed to a subscription. Never posted (see Billing). */
  private readonly subscriptionCells = new Map<string, UsageRow>()
  /** Web search requests by agent and model, from usage.server_tool_use. Posted as search_calls once billing rows are. */
  private readonly searchCells = new Map<string, number>()
  /** Other providers' probe tokens by provider, agent and model (recordProvider). Posted once billing rows are. */
  private readonly providerCells = new Map<string, { provider: OtherProvider; agent: string; model: string; input: number; output: number; calls: number; failed: number }>()
  private billing = false

  /**
   * Record one response.
   *
   * A call that errored after tokens were produced still cost money, so a
   * failure is counted rather than dropped: a run that burned its budget on
   * refusals must not read as a cheap run.
   */
  record(agent: string, model: string, usage: unknown, failed = false, billing: Billing = 'api'): void {
    const u = (usage || {}) as Record<string, unknown>
    const key = `${agent}|${model}`
    const cells = billing === 'subscription' ? this.subscriptionCells : this.cells
    let cell = cells.get(key)
    if (!cell) {
      cell = { agent, model, usage: zero(), calls: 0, failed: 0 }
      cells.set(key, cell)
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
    // Searches billed per request are an API cost; a subscription's are not.
    if (billing === 'subscription') return
    const searches = num(((u.server_tool_use || {}) as Record<string, unknown>).web_search_requests)
    if (searches > 0) this.searchCells.set(key, (this.searchCells.get(key) ?? 0) + searches)
  }

  /**
   * Record one probe from a provider other than Anthropic: its input and
   * output tokens read out of its own usage shape (tokensOf), and a failure
   * counted even when it produced nothing.
   */
  recordProvider(provider: OtherProvider, agent: string, model: string, usage: unknown, failed = false): void {
    const key = `${provider}|${agent}|${model}`
    let cell = this.providerCells.get(key)
    if (!cell) {
      cell = { provider, agent, model, input: 0, output: 0, calls: 0, failed: 0 }
      this.providerCells.set(key, cell)
    }
    const t = tokensOf(usage)
    cell.input += t.input
    cell.output += t.output
    cell.calls += 1
    if (failed) cell.failed += 1
  }

  /**
   * Whether Control Center's meter reads billing rows: the context lists
   * `meter_billing` in packet_features. Absent or misshapen: it does not.
   */
  acceptBilling(packetFeatures: unknown): void {
    this.billing = Array.isArray(packetFeatures) && packetFeatures.includes('meter_billing')
  }

  get billingAccepted(): boolean {
    return this.billing
  }

  /**
   * The rows to post. The meter's first shape (rows()) until the context lists
   * `meter_billing`; then every row with its provider and billing. A row with
   * neither a token nor a failure is left out: nothing was measured.
   */
  postRows(): UsageRow[] | BillingRow[] {
    if (!this.billing) return this.rows()
    const out: BillingRow[] = this.rows().map(r => ({
      provider: 'anthropic' as const, billing: 'api' as const, agent: r.agent, model: r.model, usage: r.usage,
      calls: r.calls, failed: r.failed, search_calls: this.searchCells.get(`${r.agent}|${r.model}`) ?? 0,
    }))
    for (const r of this.subscriptionRows()) {
      out.push({ provider: 'anthropic', billing: 'subscription', agent: r.agent, model: r.model, input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens, calls: r.calls, failed: r.failed })
    }
    for (const c of this.providerCells.values()) {
      if (c.input + c.output === 0 && c.failed === 0) continue
      out.push({ provider: c.provider, billing: 'api', agent: c.agent, model: c.model, input_tokens: c.input, output_tokens: c.output, calls: c.calls, failed: c.failed })
    }
    return out
  }

  /** Probe calls to the other providers, tokens or not. */
  get providerCalls(): number {
    return [...this.providerCells.values()].reduce((s, c) => s + c.calls, 0)
  }

  /** Web search requests the responses reported, all units. */
  get searches(): number {
    return [...this.searchCells.values()].reduce((s, n) => s + n, 0)
  }

  /** Web search requests the responses reported for one unit (aeo-probe, say), every model. */
  searchesBy(agent: string): number {
    let n = 0
    for (const [k, v] of this.searchCells) if (k.startsWith(`${agent}|`)) n += v
    return n
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

  /** The rows billed to a subscription, with tokens. Counted, never posted. */
  subscriptionRows(): UsageRow[] {
    return [...this.subscriptionCells.values()].filter(r => r.usage.input_tokens + r.usage.output_tokens > 0)
  }

  /** Calls billed to a subscription, tokens or not. */
  get subscriptionCalls(): number {
    return [...this.subscriptionCells.values()].reduce((s, r) => s + r.calls, 0)
  }

  /** Input and output tokens billed to a subscription. */
  get subscriptionTokens(): number {
    return this.subscriptionRows().reduce((s, r) => s + r.usage.input_tokens + r.usage.output_tokens, 0)
  }
}
