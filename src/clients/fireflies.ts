/**
 * Fireflies over GraphQL. Every failure, including a missing key, is a
 * FirefliesUnavailable: the packet then says fireflies_unavailable, which is
 * a different fact from "no calls this week".
 */
import { asArray, asRecord, asString, requestJson } from './http.js'
import { FirefliesUnavailable, type FirefliesClient, type Transcript, type TranscriptSummary } from './types.js'

const URL = 'https://api.fireflies.ai/graphql'

const LIST_QUERY = `query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int) {
  transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit) { id title date participants }
}`

const GET_QUERY = `query Transcript($id: String!) {
  transcript(id: $id) {
    id title date
    sentences { text speaker_name }
    summary { overview keywords action_items }
  }
}`

/** Fireflies returns date as an epoch in milliseconds on some fields and an ISO string on others. */
export function isoDate(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString()
  if (typeof v === 'string') {
    const n = Number(v)
    const d = Number.isFinite(n) && v.trim() !== '' ? new Date(n) : new Date(v)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString()
  }
  return ''
}

export class FirefliesHttp implements FirefliesClient {
  constructor(private readonly apiKey: string | undefined) {}

  private async gql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new FirefliesUnavailable('FIREFLIES_API_KEY is not set')
    let r
    try {
      r = await requestJson('fireflies', URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: { query, variables },
        timeoutMs: 60_000,
      })
    } catch (e) {
      throw new FirefliesUnavailable((e as Error).message)
    }
    if (!r.ok) throw new FirefliesUnavailable(`fireflies_${r.status}: ${r.text.slice(0, 160)}`)
    const j = asRecord(r.json)
    const errors = asArray(j.errors)
    if (errors.length) throw new FirefliesUnavailable(`graphql: ${asString(asRecord(errors[0]).message) || 'error'}`)
    return asRecord(j.data)
  }

  async listTranscripts(fromISO: string, toISO: string): Promise<TranscriptSummary[]> {
    const data = await this.gql(LIST_QUERY, { fromDate: fromISO, toDate: toISO, limit: 50 })
    return asArray(data.transcripts).map(t => {
      const r = asRecord(t)
      return { id: asString(r.id), title: asString(r.title), date: isoDate(r.date), participants: asArray(r.participants).map(String) }
    }).filter(t => t.id)
  }

  async getTranscript(id: string): Promise<Transcript> {
    const data = await this.gql(GET_QUERY, { id })
    const t = asRecord(data.transcript)
    if (!t.id) throw new FirefliesUnavailable(`transcript ${id} came back empty`)
    const s = asRecord(t.summary)
    const items = s.action_items
    return {
      id: asString(t.id),
      title: asString(t.title),
      date: isoDate(t.date),
      sentences: asArray(t.sentences).map(x => {
        const r = asRecord(x)
        return { text: asString(r.text), speaker_name: asString(r.speaker_name) }
      }),
      summary: t.summary
        ? {
            overview: asString(s.overview),
            keywords: asArray(s.keywords).map(String),
            action_items: Array.isArray(items) ? items.map(String) : items ? [String(items)] : [],
          }
        : null,
    }
  }
}
