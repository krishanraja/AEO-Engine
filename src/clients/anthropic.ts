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
import { CAPS, MODELS } from '../config/run.js'
import type { UsageMeter } from '../lib/usage.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient, ModelClient, ModelRequest } from './types.js'

const URL = 'https://api.anthropic.com/v1/messages'
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: CAPS.CLAUDE_API_SEARCH_MAX_USES }

/**
 * Deadline for ONE probe turn, which is a search turn and not a model turn.
 *
 * http.ts defaults every request to 120s, and the probe path inherited it. On
 * the 2026-09-20 run that cost six probes on `circle` and seven on `ctrl`, all
 * of them "anthropic_0: timeout after 120000ms". Not auth, not the spend cap:
 * the same key wrote every digest in the same run. A turn here may run several
 * web searches (max_uses above, five then, two since 2026-11-13) and then
 * compose an answer over what they returned, and that does not reliably fit
 * in two minutes.
 *
 * It applies to the PROBE path only. The JSON writer below keeps the 120s
 * default deliberately: it is bounded extraction with thinking disabled over
 * evidence already in hand, so a slow one there is a fault rather than a long
 * search, and a digest that hangs for four minutes is worse than one that
 * fails and falls back.
 *
 * Budget: ask() continues a paused turn at most three times, so the worst case
 * per probe moves from 6 to 12 minutes. The slowest subject on 2026-09-20 took
 * 24 minutes for twenty questions; a subject with a venture request may probe
 * thirty since 2026-11-13 (about 39 minutes at that rate), and the research job
 * allows 120 so an attempt, a wait and a retry still fit (aeo-weekly.yml). If a
 * subject ever approaches the job timeout, cut max_uses before raising this
 * again: waiting longer for the same searches is not the lever that fixes a
 * slow probe.
 */
const PROBE_TIMEOUT_MS = 240_000

export class AnthropicClient implements EngineClient {
  readonly engine = 'claude' as const
  readonly model = MODELS.anthropic

  /**
   * `meter` is optional and off in the offline twin. Every response carries a
   * `usage` object and this client dropped all of them, which is why the only
   * cost figure the engine could report was the per-call estimate in
   * lib/cost.ts. Reading it here means every call is measured exactly once, at
   * the single place they all pass through.
   */
  constructor(private readonly apiKey: string, private readonly meter?: UsageMeter) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
  }

  /**
   * A probe: ask the question with web search on.
   *
   * Until 2026-11-13 the citations were every URL in content-block order, and
   * the search result blocks come before the text, so the "first citation"
   * was the first raw search hit, cited or not. Now, across every turn of a
   * paused search:
   *   citations  only the web_search_result_location citations on text
   *              blocks, in order of appearance, each URL once;
   *   retrieved  the URLs of the web_search_result items the searches returned;
   *   fan_out    the query of each web_search server_tool_use, in order;
   *   searched   at least one web_search server_tool_use, or the usage
   *              reporting a billed web search request (dynamic filtering
   *              can run its searches from code).
   */
  async ask(question: string): Promise<EngineAnswer> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: question }]
    const turns: unknown[] = []
    // A search turn can pause; continue it a bounded number of times.
    for (let turn = 0; turn < 3; turn++) {
      const j = asRecord(await requireOk('anthropic', URL, {
        method: 'POST',
        headers: this.headers(),
        body: { model: this.model, max_tokens: 4000, tools: [WEB_SEARCH_TOOL], messages },
        timeoutMs: PROBE_TIMEOUT_MS,
      }))
      // Each turn of a paused search is its own billed request, so each one is
      // recorded. Metering only the last would under-report exactly the probes
      // that searched the hardest.
      this.meter?.record('aeo-probe', this.model, j.usage)
      turns.push(j)
      if (j.stop_reason !== 'pause_turn') break
      messages.push({ role: 'assistant', content: asArray(j.content) })
    }
    return parseTurns(turns)
  }

  private async text(system: string, user: string, maxTokens: number, agent = 'aeo-write'): Promise<string> {
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
    // Before the throw below: a refusal is billed for the tokens it read.
    this.meter?.record(agent, this.model, j.usage, j.stop_reason === 'refusal')
    if (j.stop_reason === 'refusal') throw new Error('anthropic_refusal')
    for (const block of asArray(j.content)) {
      const b = asRecord(block)
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
    return ''
  }

  /** A short JSON verdict: which subject a transcript belongs to. */
  classify(system: string, user: string, maxTokens: number, agent?: string): Promise<string> {
    return this.text(system, user, maxTokens, agent)
  }

  /** A JSON document written from evidence: themes, a query proposal, the digest. */
  writeJson(system: string, user: string, maxTokens: number, agent?: string): Promise<string> {
    return this.text(system, user, maxTokens, agent)
  }

  /**
   * The pipeline-facing shape. The key is for the offline twin and is ignored
   * here; the STAGE is not, any more. It becomes the meter's unit key, so the
   * four writing stages rank separately. The digest is the expensive one and
   * a single "aeo-engine" row could never have said so.
   */
  asModelClient(): ModelClient {
    return {
      classify: (r: ModelRequest) => this.classify(r.system, r.user, r.maxTokens, `aeo-${r.stage}`),
      writeJson: (r: ModelRequest) => this.writeJson(r.system, r.user, r.maxTokens, `aeo-${r.stage}`),
    }
  }
}

const pushOnce = (list: string[], v: unknown) => {
  const s = asString(v).trim()
  if (s && !list.includes(s)) list.push(s)
}
/** Fan-out keeps one entry per search the engine ran, repeats included. */
const pushQuery = (list: string[], v: unknown) => {
  const s = asString(v).trim()
  if (s) list.push(s)
}

/** The search requests a response's usage says were billed, or 0. */
export function webSearchRequests(usage: unknown): number {
  const n = asRecord(asRecord(usage).server_tool_use).web_search_requests
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0
}

/** One probe's turns (a paused search continues in the next) to an answer. Pure; exported for the tests. */
export function parseTurns(turns: readonly unknown[]): EngineAnswer {
  const texts: string[] = []
  const citations: string[] = []
  const retrieved: string[] = []
  const fanOut: string[] = []
  let searched = false
  let requests = 0
  const usage: unknown[] = []
  for (const t of turns) {
    const j = asRecord(t)
    if (j.usage !== undefined) usage.push(j.usage)
    requests += webSearchRequests(j.usage)
    for (const block of asArray(j.content)) {
      const b = asRecord(block)
      if (b.type === 'text') {
        texts.push(asString(b.text))
        for (const c of asArray(b.citations)) {
          const cit = asRecord(c)
          if (cit.type === 'web_search_result_location') pushOnce(citations, cit.url)
        }
      } else if (b.type === 'server_tool_use' && b.name === 'web_search') {
        searched = true
        pushQuery(fanOut, asRecord(b.input).query)
      } else if (b.type === 'web_search_tool_result') {
        // A failed search carries an error object here, not a list: nothing to read.
        for (const r of asArray(b.content)) {
          const item = asRecord(r)
          if (item.type === undefined || item.type === 'web_search_result') pushOnce(retrieved, item.url)
        }
      }
    }
  }
  const out: EngineAnswer = { text: texts.join('\n').trim(), citations, retrieved, searched: searched || requests > 0, fan_out: fanOut }
  if (usage.length) out.usage = usage.length === 1 ? usage[0] : usage
  return out
}
