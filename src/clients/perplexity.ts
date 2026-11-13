/**
 * Perplexity chat completions, model sonar. A port of askPerplexity in
 * Control Center's geo-probe.
 *
 * Sonar always searches. Its answer cites sources with [n] markers that point
 * into the `citations` list (1-based), so the inline citations are the
 * sources in the order the text first cites them, each once; a marker with no
 * source behind it is skipped. An answer with no marker at all falls back to
 * the list's own order. `retrieved` is every source the search returned:
 * search_results when present, else the citations list.
 */
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
    return parseCompletion(j)
  }
}

const urls = (v: unknown): string[] => asArray(v).filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
const unique = (list: readonly string[]): string[] => list.filter((u, i) => list.indexOf(u) === i)

/** The 1-based source numbers the text cites, in order of first appearance: [1], [2][3] and [1, 4] all count. */
export function markerOrder(text: string): number[] {
  const out: number[] = []
  for (const m of String(text ?? '').matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    for (const n of m[1].split(',').map(x => Number(x.trim()))) if (n >= 1 && !out.includes(n)) out.push(n)
  }
  return out
}

/** A chat completions body to an answer. Pure; exported for the tests. */
export function parseCompletion(body: unknown): EngineAnswer {
  const j = asRecord(body)
  const first = asRecord(asArray(j.choices)[0])
  const text = asString(asRecord(first.message).content)
  const results = asArray(j.search_results).map(s => asRecord(s).url).filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
  // The markers point into `citations`; search_results is the same list in
  // the newer shape, so it stands in when `citations` is absent or empty.
  const listed = urls(j.citations)
  const sources = listed.length ? listed : results
  const markers = markerOrder(text).filter(n => n <= sources.length)
  const citations = markers.length ? unique(markers.map(n => sources[n - 1])) : unique(sources)
  const out: EngineAnswer = { text, citations, retrieved: unique(results.length ? results : sources), searched: true }
  if (j.usage !== undefined) out.usage = j.usage
  return out
}
