/**
 * Stage 30: the questions to ask this week. One model call over everything
 * the context knows (themes, the gap, the map's buyer questions, Google
 * striking-distance rows, last week's list, and for a prospect the room
 * signal), then a deterministic dedupe against itself and against last week
 * so a query keeps its id from one week to the next.
 */
import { CAPS } from '../config/run.js'
import { asArray, asRecord, asString } from '../clients/http.js'
import type { ModelClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import { CLEAN, normaliseQuery, questionsFrom, robustJson, scrubPII, toQuestion } from '../lib/text.js'
import type { AeoContext, ContextSubject, PriorQuery } from '../schema/context.js'
import { QUERY_SOURCES, UUID_RE, type QuerySource, type Theme } from '../schema/packet.js'
import type { GapResult } from './20-gap.js'

export interface ProposedQuery {
  query_id: string
  query: string
  source: QuerySource
  touchpoint_id: string | null
  prior: PriorQuery | null
  norm: string
}

const PROPOSE_SYSTEM = [
  'You propose the questions a weekly answer-engine study will ask AI assistants for one subject. Each question is what a real person types into an assistant, in their words, about their own problem.',
  'Respond with ONLY a JSON object: {"queries": [{"query": string, "source": "transcript" | "gap" | "seed" | "striking_distance" | "watch_carry" | "room_signal", "touchpoint_id": string or null}]}. Write 20 to 40 queries. source says where the query came from: transcript (a call theme), gap (a question a competitor is cited on), seed (a map touchpoint or seed topic; copy its touchpoint_id when there is one), striking_distance (a Google query we nearly rank for), watch_carry (carried from last week\'s watch list), room_signal (a prospect\'s trigger).',
  'Cover every input at least once. Prefer questions that begin "how do I", "should I", "what is the best way to", "which". No brand names in a query unless the input already carries them. No two queries that mean the same thing.',
  'For a prospect subject: a query is what THAT company\'s senior leaders would ask an AI assistant about their own strategic problem, never a question about Mindmake or about buying advice.',
  'Never write a person\'s name, email address or handle. No em dashes anywhere, and no ASCII stand-ins for one: use a comma or a full stop.',
].join('\n\n')

interface Candidate { query: string; source: QuerySource; touchpoint_id: string | null }

/** The inputs a proposal can be built from without a model, in priority order. */
export function deterministicCandidates(subject: ContextSubject, gap: GapResult): Candidate[] {
  const out: Candidate[] = []
  for (const o of gap.outranked) out.push({ query: CLEAN(o.question, 400), source: 'gap', touchpoint_id: null })
  for (const row of subject.striking_distance ?? []) out.push({ query: toQuestion(row.query), source: 'striking_distance', touchpoint_id: null })
  for (const w of subject.prior?.watch_list ?? []) out.push({ query: CLEAN(w.query, 400), source: 'watch_carry', touchpoint_id: null })
  for (const tp of subject.touchpoints ?? []) for (const q of questionsFrom(tp.icp_trigger)) out.push({ query: q, source: 'seed', touchpoint_id: tp.id })
  return out.filter(c => c.query.length >= 3)
}

function buildUser(subject: ContextSubject, ctx: AeoContext, themes: Theme[], gap: GapResult): string {
  const touchpoints = (subject.touchpoints ?? []).map(tp => ({ touchpoint_id: tp.id, questions: questionsFrom(tp.icp_trigger), watering_hole: tp.watering_hole }))
  const striking = (subject.striking_distance ?? []).map(r => ({ query: r.query, search_volume: r.search_volume, current_position: r.current_position, previous_position: r.previous_position }))
  const prior = subject.prior
    ? {
        week_start: subject.prior.week_start,
        watch_list: subject.prior.watch_list.map(w => w.query),
        queries: subject.prior.queries.map(q => ({ query: q.query, demand_score: q.demand_score, status: q.status })),
      }
    : null
  const room = subject.kind === 'prospect' && subject.room_target
    ? {
        title: subject.room_target.title,
        why_face: subject.room_target.why_face,
        trigger_signal: subject.room_target.trigger_signal,
        room_face_icp: ctx.icp?.room_face?.who ?? '',
      }
    : null
  const input = {
    subject: { name: subject.name, kind: subject.kind, icp_line: subject.icp_line, seed_topics: subject.seed_topics, domains: subject.domains },
    themes: themes.map(t => ({ theme: t.theme, calls: t.calls })),
    outranked: gap.outranked.map(o => ({ question: o.question, competitor_domains: o.competitor_domains, engines: o.engines })),
    touchpoints,
    striking_distance: striking,
    prior_week: prior,
    room_target: room,
  }
  return `Inputs:\n${JSON.stringify(input, null, 1)}\n\nWrite the queries.`
}

export async function proposeQueries(
  model: ModelClient,
  ledger: Ledger,
  subject: ContextSubject,
  ctx: AeoContext,
  themes: Theme[],
  gap: GapResult,
  mintId: (key: string) => string,
): Promise<ProposedQuery[]> {
  const touchpointIds = new Set((subject.touchpoints ?? []).map(t => t.id))
  const touchpointByNorm = new Map<string, string>()
  for (const tp of subject.touchpoints ?? []) for (const q of questionsFrom(tp.icp_trigger)) touchpointByNorm.set(normaliseQuery(q), tp.id)
  const priorByNorm = new Map<string, PriorQuery>()
  for (const q of subject.prior?.queries ?? []) if (UUID_RE.test(q.query_id)) priorByNorm.set(normaliseQuery(q.query), q)

  let candidates: Candidate[] = []
  try {
    ledger.charge('propose', `propose ${subject.slug}`)
    const raw = await model.writeJson({ stage: 'propose', key: subject.id, system: PROPOSE_SYSTEM, user: buildUser(subject, ctx, themes, gap), maxTokens: 4000 })
    for (const item of asArray(asRecord(robustJson(raw)).queries)) {
      const r = asRecord(item)
      const source = QUERY_SOURCES.includes(r.source as QuerySource) ? (r.source as QuerySource) : 'seed'
      const tid = asString(r.touchpoint_id)
      candidates.push({ query: scrubPII(CLEAN(r.query, 400), subject.never_say), source, touchpoint_id: touchpointIds.has(tid) ? tid : null })
    }
    if (!candidates.length) throw new Error('model returned no queries')
  } catch (e) {
    log('propose_fallback', { subject: subject.slug, error: errText(e) })
    candidates = []
  }
  // Pad from the deterministic inputs when the model came up short or failed.
  if (candidates.length < CAPS.MIN_PROPOSED_QUERIES) candidates.push(...deterministicCandidates(subject, gap))

  const out: ProposedQuery[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    const norm = normaliseQuery(c.query)
    if (c.query.length < 3 || norm.split(' ').length < 2 || seen.has(norm)) continue
    seen.add(norm)
    const prior = priorByNorm.get(norm) ?? null
    out.push({
      query_id: prior ? prior.query_id : mintId(`${subject.id}|${norm}`),
      query: c.query,
      source: c.source,
      touchpoint_id: c.touchpoint_id ?? touchpointByNorm.get(norm) ?? null,
      prior,
      norm,
    })
    if (out.length >= CAPS.MAX_PROPOSED_QUERIES) break
  }
  if (out.length < CAPS.MIN_PROPOSED_QUERIES) log('propose_short', { subject: subject.slug, queries: out.length, min: CAPS.MIN_PROPOSED_QUERIES })
  log('queries_proposed', { subject: subject.slug, queries: out.length, carried: out.filter(q => q.prior).length })
  return out
}
