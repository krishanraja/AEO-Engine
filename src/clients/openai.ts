/**
 * OpenAI Responses API with the hosted web_search tool.
 *
 * The search is forced. With the tool merely offered, the model answered from
 * memory: most ChatGPT probes from September to 13 November came back with no
 * citation at all, so they measured what the model remembered rather than
 * what a buyer's assistant would find. tool_choice 'required' makes it call a
 * tool, and web_search is its only tool, so every probe searches. The
 * include asks for the sources each search returned, cited or not.
 *
 * Read from the output, defensively (an item or field of another shape is
 * skipped, never guessed at):
 *   web_search_call  action.queries (or, in the older shape, action.query)
 *                    go to fan_out, in order;
 *                    action.sources[].url (and the page an open_page or
 *                    find_in_page action read) go to retrieved; any such item
 *                    means the probe searched.
 *   message          output_text parts give the text; their url_citation
 *                    annotations, ordered by start_index within each part and
 *                    the parts in order, give the inline citations, each URL
 *                    once, at its first appearance.
 *   usage            carried as the provider wrote it.
 */
import { MODELS } from '../config/run.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import type { EngineAnswer, EngineClient } from './types.js'

/**
 * Deadline for one probe, which is now always a search turn.
 *
 * http.ts defaults every request to 120s. On 2026-11-08, when about seven in
 * eight ChatGPT probes did not search at all, some still timed out at 120s
 * (docs/STATE.md, Live). With the search required, every probe searches, and
 * the probes that searched hardest would be the ones a 120s deadline drops, so
 * the probe path takes the same four minutes Claude's does (anthropic.ts,
 * PROBE_TIMEOUT_MS, which says why). The question's engines run together, so
 * this adds nothing to a question that Claude's deadline did not already allow.
 */
export const PROBE_TIMEOUT_MS = 240_000

export class OpenAIClient implements EngineClient {
  readonly engine = 'chatgpt' as const
  readonly model = MODELS.openai

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  }

  async ask(question: string): Promise<EngineAnswer> {
    const j = asRecord(await requireOk('openai', 'https://api.openai.com/v1/responses', {
      method: 'POST',
      timeoutMs: PROBE_TIMEOUT_MS,
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {
        model: this.model,
        input: question,
        tools: [{ type: 'web_search' }],
        tool_choice: 'required',
        include: ['web_search_call.action.sources'],
      },
    }))
    return parseResponse(j)
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

/** A Responses API body to an answer. Pure; exported for the tests. */
export function parseResponse(body: unknown): EngineAnswer {
  const j = asRecord(body)
  const texts: string[] = []
  const citations: string[] = []
  const retrieved: string[] = []
  const fanOut: string[] = []
  let searched = false
  let searchCalls = 0
  for (const item of asArray(j.output)) {
    const it = asRecord(item)
    if (it.type === 'web_search_call') {
      searched = true
      // Each web_search_call item is one billed tool call (OpenAI bills web
      // search per call, beside the tokens), whatever its action.
      searchCalls++
      const action = asRecord(it.action)
      // The newer shape lists every query in `queries`; the older one has `query` alone.
      const queries = asArray(action.queries).filter(q => asString(q).trim())
      if (queries.length) for (const q of queries) pushQuery(fanOut, q)
      else pushQuery(fanOut, action.query)
      for (const s of asArray(action.sources)) pushOnce(retrieved, asRecord(s).url)
      if (action.type === 'open_page' || action.type === 'find_in_page' || action.type === 'find') pushOnce(retrieved, action.url)
      continue
    }
    if (it.type !== 'message') continue
    for (const part of asArray(it.content)) {
      const p = asRecord(part)
      if (p.type !== undefined && p.type !== 'output_text') continue
      const text = asString(p.text)
      if (text) texts.push(text)
      const anns = asArray(p.annotations)
        .map((a, i) => ({ a: asRecord(a), i }))
        .filter(x => x.a.type === 'url_citation' && asString(x.a.url))
        .sort((x, y) => startOf(x.a, x.i) - startOf(y.a, y.i) || x.i - y.i)
      for (const { a } of anns) pushOnce(citations, a.url)
    }
  }
  const out: EngineAnswer = { text: texts.join('\n'), citations, retrieved, searched, fan_out: fanOut, search_calls: searchCalls }
  if (j.usage !== undefined) out.usage = j.usage
  return out
}

/** An annotation's start_index, or its place in the list when it carries none. */
function startOf(a: Record<string, unknown>, i: number): number {
  return typeof a.start_index === 'number' && Number.isFinite(a.start_index) ? a.start_index : Number.MAX_SAFE_INTEGER - 1000 + i
}
