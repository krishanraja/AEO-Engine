/**
 * Gemini, the fourth answer engine, inside its free tier: the Gemini API's
 * generateContent with Google Search grounding.
 *
 * The key travels in the x-goog-api-key header, never in the URL, so it never
 * reaches a log line, a proxy's access log or an error message.
 *
 * Read from candidates[0]:
 *   content.parts[].text                         the answer, joined
 *   groundingMetadata.webSearchQueries           fan_out; searched when any
 *   groundingMetadata.groundingChunks[].web      each source the search grounded on:
 *                                                uri, a grounding redirect, goes to
 *                                                retrieved; title is usually the
 *                                                source's domain
 *   groundingMetadata.groundingSupports          the answer's inline citations: the
 *                                                supports sorted by segment.startIndex,
 *                                                each mapped to its chunk indices, each
 *                                                chunk once
 *
 * A grounding redirect does not show the source's host, so a cited chunk is
 * represented by its title when the title is a hostname (https://<title>/).
 * Only the first inline citation, and any chunk whose title is one of our
 * domains, is resolved to its real URL: one GET with redirects not followed,
 * reading only the Location header, ten seconds, at most
 * CAPS.GEMINI_MAX_RESOLUTIONS_PER_PROBE a probe. The source page itself is
 * never fetched.
 *
 * The free tier is counted in grounding queries (webSearchQueries). One
 * client lives for one research job's process, and only the job's first
 * attempt asks Gemini (resolveEngines, AEO_ATTEMPT), so a retry never starts
 * a second share. The client stops before an answer could carry it past
 * CAPS.GEMINI_MAX_QUERIES_PER_JOB: when the queries used plus the most any
 * one answer has used (at least one) would pass the cap, it is exhausted, the
 * probe stage asks and charges it nothing more, and the skipped probes are
 * counted. Only an answer that runs more searches than every answer before
 * it can pass the cap, by that difference.
 *
 * Gemini is a gated engine (src/schema/packet.ts): its probes are counted in
 * the sealed summary and stay out of the packet until the context opens it.
 */
import { CAPS, MODELS } from '../config/run.js'
import { hostMatches, splitDomain } from '../lib/domains.js'
import { asArray, asRecord, asString, requireOk } from './http.js'
import { FreeTierExhausted, type AskContext, type EngineAnswer, type EngineClient } from './types.js'

export { FreeTierExhausted }

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
/** One probe's deadline. A grounded answer is one request; it does not page like a search turn. */
export const GEMINI_PROBE_TIMEOUT_MS = 120_000
/** One redirect read's deadline. */
export const RESOLVE_TIMEOUT_MS = 10_000
/** The host Gemini's grounding redirects live on. Only these are ever resolved. */
export const REDIRECT_HOST = 'vertexaisearch.cloud.google.com'

/** Reads a grounding redirect's target from its Location header, or null. */
export type Resolver = (uri: string) => Promise<string | null>

export interface GroundingChunk { uri: string; title: string }

/** One generateContent response, read. Pure data. */
export interface ParsedGemini {
  text: string
  fanOut: string[]
  chunks: GroundingChunk[]
  /** Chunk indices in the order the answer cites them, each once. */
  order: number[]
  usage?: unknown
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** A chunk title read as a host, lower-cased without www, or null when it is not one. */
export function hostLike(title: string): string | null {
  const t = String(title ?? '').trim().toLowerCase().replace(/^www\./, '')
  return HOSTNAME_RE.test(t) ? t : null
}

export function isRedirect(uri: string): boolean {
  try { return new URL(uri).hostname.toLowerCase() === REDIRECT_HOST } catch { return false }
}

/** A generateContent body to its text, searches, sources and inline order. Throws when there is no candidate. Pure. */
export function parseGemini(body: unknown): ParsedGemini {
  const candidates = asArray(asRecord(body).candidates)
  if (!candidates.length) throw new Error('gemini_no_candidate')
  const c = asRecord(candidates[0])
  const text = asArray(asRecord(c.content).parts).map(p => asString(asRecord(p).text)).join('').trim()
  const g = asRecord(c.groundingMetadata)
  const fanOut = asArray(g.webSearchQueries).map(q => asString(q).trim()).filter(Boolean)
  const chunks = asArray(g.groundingChunks).map(ch => {
    const web = asRecord(asRecord(ch).web)
    return { uri: asString(web.uri).trim(), title: asString(web.title).trim() }
  })
  const supports = asArray(g.groundingSupports)
    .map((s, i) => ({ s: asRecord(s), i }))
    .map(({ s, i }) => ({ start: Number(asRecord(s.segment).startIndex) || 0, i, idx: asArray(s.groundingChunkIndices) }))
    .sort((a, b) => a.start - b.start || a.i - b.i)
  const order: number[] = []
  for (const s of supports) {
    for (const n of s.idx) {
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < chunks.length && !order.includes(n)) order.push(n)
    }
  }
  const out: ParsedGemini = { text, fanOut, chunks, order }
  const usage = asRecord(body).usageMetadata
  if (usage !== undefined) out.usage = usage
  return out
}

/**
 * The answer from a parsed response: citations in inline order, the first
 * and any of ours resolved within the cap, the rest as https://<title>/ when
 * the title is a hostname, else the redirect as it came.
 */
export async function answerFrom(p: ParsedGemini, domains: readonly string[], resolve: Resolver, maxResolutions: number = CAPS.GEMINI_MAX_RESOLUTIONS_PER_PROBE): Promise<EngineAnswer & { resolutions: number }> {
  const ourHosts = domains.map(d => splitDomain(d).host).filter(Boolean)
  const citations: string[] = []
  let resolutions = 0
  for (const idx of p.order) {
    const chunk = p.chunks[idx]
    if (!chunk || !chunk.uri) continue
    const host = hostLike(chunk.title)
    const first = citations.length === 0
    const ours = host !== null && ourHosts.some(d => hostMatches(host, d))
    let url: string | null = isRedirect(chunk.uri) ? null : chunk.uri
    if (!url && (first || ours) && resolutions < maxResolutions) {
      resolutions++
      url = await resolve(chunk.uri).catch(() => null)
    }
    if (!url) url = host ? `https://${host}/` : chunk.uri
    if (!citations.includes(url)) citations.push(url)
  }
  const answer: EngineAnswer & { resolutions: number } = {
    text: p.text,
    citations,
    retrieved: [...new Set(p.chunks.map(c => c.uri).filter(Boolean))],
    searched: p.fanOut.length > 0,
    fan_out: [...p.fanOut],
    resolutions,
  }
  if (p.usage !== undefined) answer.usage = p.usage
  return answer
}

/**
 * One grounding redirect's target, read from its Location header. Redirects
 * are not followed and the body is cancelled unread, so the source page is
 * never fetched. Anything but a redirect host, a 3xx and an http(s)
 * Location is null.
 */
export async function resolveRedirect(uri: string, timeoutMs: number = RESOLVE_TIMEOUT_MS): Promise<string | null> {
  if (!isRedirect(uri)) return null
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(uri, { method: 'GET', redirect: 'manual', signal: ctrl.signal })
    try { await r.body?.cancel() } catch { /* nothing to read */ }
    const loc = r.headers.get('location') ?? ''
    return r.status >= 300 && r.status < 400 && /^https?:\/\//i.test(loc) ? loc.slice(0, 500) : null
  } catch {
    return null
  } finally {
    clearTimeout(tid)
  }
}

export interface GeminiOptions {
  maxQueries?: number
  maxResolutions?: number
  resolve?: Resolver
}

export class GeminiClient implements EngineClient {
  readonly engine = 'gemini' as const
  readonly model = MODELS.gemini
  private used = 0
  /** The most grounding queries any one answer has used this job: the margin kept below the cap. */
  private mostInOneAnswer = 0
  private readonly maxQueries: number
  private readonly maxResolutions: number
  private readonly resolve: Resolver

  constructor(private readonly apiKey: string, opts: GeminiOptions = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
    this.maxQueries = opts.maxQueries ?? CAPS.GEMINI_MAX_QUERIES_PER_JOB
    this.maxResolutions = opts.maxResolutions ?? CAPS.GEMINI_MAX_RESOLUTIONS_PER_PROBE
    this.resolve = opts.resolve ?? (uri => resolveRedirect(uri))
  }

  /** Grounding queries this job has used of its free-tier share. */
  get groundingQueries(): number { return this.used }

  /** True once one more answer, as large as the largest so far, would pass the job's share. */
  get exhausted(): boolean { return this.used + Math.max(1, this.mostInOneAnswer) > this.maxQueries }

  async ask(question: string, ctx: AskContext = {}): Promise<EngineAnswer> {
    if (this.exhausted) throw new FreeTierExhausted(this.used, this.maxQueries)
    const j = await requireOk('gemini', `${GEMINI_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey },
      body: { contents: [{ role: 'user', parts: [{ text: question }] }], tools: [{ google_search: {} }] },
      timeoutMs: GEMINI_PROBE_TIMEOUT_MS,
    })
    const parsed = parseGemini(j)
    this.used += parsed.fanOut.length
    this.mostInOneAnswer = Math.max(this.mostInOneAnswer, parsed.fanOut.length)
    const { resolutions: _r, ...answer } = await answerFrom(parsed, ctx.domains ?? [], this.resolve, this.maxResolutions)
    return answer
  }
}
