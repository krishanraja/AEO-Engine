/**
 * Stage 60: the digest. One model call that writes prose over the score
 * table and nothing else; every number the packet carries is computed here,
 * and the model supplies the sentences. If the model fails or writes
 * something the evidence does not hold, the deterministic fallback builds
 * the same fields from the score table and says so in digest_writer.
 */
import { asArray, asRecord, asString } from '../clients/http.js'
import type { ModelClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import { CLEAN, robustJson, scrubPII } from '../lib/text.js'
import type { AeoContext, ContextSubject } from '../schema/context.js'
import type { CompetitorGap, DigestWriter, Engine, PacketQuery, PlaybookEntry, Recommendation, WatchItem } from '../schema/packet.js'
import type { ThemesResult } from './10-transcripts.js'
import { competitorGapFrom, tallyHosts, theyCitedFrom, type GapResult, type ProbeLike, type TheyCited } from './20-gap.js'

export interface DigestInput {
  subject: ContextSubject
  ctx: AeoContext
  weekStart: string
  engines: readonly Engine[]
  queries: PacketQuery[]
  themes: ThemesResult
  gap: GapResult
  krishHitsDomains: readonly string[]
}

export interface DigestResult {
  strongest_signal: string | null
  recommendations: Recommendation[]
  watch_list: WatchItem[]
  competitor_gap: CompetitorGap
  playbook: PlaybookEntry[] | null
  approach_hook: string | null
  digest_writer: DigestWriter
}

const DIGEST_SYSTEM = [
  'You write the weekly answer-engine digest for one subject in Krish Raja\'s mind/make OS. Krish reads it on Monday and acts on it the same week.',
  'ABSOLUTE RULE: every number you write must appear in the evidence JSON you are given. You may not estimate, extrapolate, round for effect, or infer demand that is not measured.',
  'ABSOLUTE RULE: the evidence carries an `unknowns` array. Each entry there stays unknown in what you write. Never convert an unknown into a zero. "No calls attributed" is not "no demand".',
  'Tone: blunt, specific, structural. Name the gap and the competitor, not the mood. No hedging, no encouragement, no summary of the summary.',
  'Respond with ONLY a JSON object:',
  '{"strongest_signal": string under 240 characters or null (the one measured fact that matters most this week),',
  ' "recommendations": [{"query_id": string (one of the evidence rows with status recommend), "title": string under 200 characters (the piece or page to make), "angle": string under 600 characters (what it argues and why it would be cited), "evidence": [string under 300 characters] (2 to 4 lines, each citing something measured: a score, an engine we are absent on, a competitor host, a call theme)}] (3 to 5, one per recommend row, most demand first),',
  ' "watch_list": [{"query_id": string (a row with status watch), "why": string under 240 characters}],',
  ' "approach_hook": string under 300 characters or null (prospects only: one sentence Krish could open a conversation with, grounded in a cited answer their leaders would see; null when nothing measured supports one),',
  ' "playbook": [{"url": string (from playbook_groups), "why": string under 300 characters (why the engines cite this page shape)}] (aspirations only, else [])}',
  'No prose outside the JSON. No em dashes anywhere in any string, and no ASCII stand-ins for one either: never write "--" or a spaced hyphen as a dash. Use a comma, a full stop, or parentheses. Never write a person\'s name, email address or handle.',
].join('\n\n')

/** How many characters of the krish-voice body to carry. The whole block is
 *  tens of thousands of characters and most of it governs drafting a finished
 *  piece; a digest writes titles and angles, so the opening, which carries
 *  the register and the kill list, is the part that earns its tokens. */
const VOICE_CHARS = 6000

/**
 * The system prompt for one run. Krish told the OS how he writes and whose
 * moves he rates once, on the Content side; Control Center sends both here
 * (`krish.voice_block`, `krish.voices_he_rates`), so a title and an angle
 * land in his register instead of generic marketing prose. Both are optional:
 * an older Control Center, or a failed read, gives a plain digest rather than
 * one written in a voice the machine invented.
 */
export function digestSystem(krish?: AeoContext['krish']): string {
  const parts = [DIGEST_SYSTEM]
  const voice = (krish?.voice_block || '').trim()
  if (voice) {
    parts.push(
      'HOW KRISH WRITES. The titles and angles you write are read in his voice, so hold them to this. It governs register and word choice only; it never overrides the two ABSOLUTE RULES above, and a rule here that asks for a longer form does not apply to a title or an angle.\n\n'
      + voice.slice(0, VOICE_CHARS),
    )
  }
  const rated = (krish?.voices_he_rates || []).filter(v => v && v.name && v.why)
  if (rated.length) {
    parts.push(
      'THE MOVES HE RATES. These are writers Krish admires and the specific move he admires each for. Reach for a move on this list when a recommendation calls for one. Never name any of these people in what you write, and never imitate one closely enough that the piece reads as theirs rather than his.\n'
      + rated.map(v => `- ${v.why}`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

function absentEngines(q: PacketQuery): Engine[] {
  return [...new Set(q.probes.filter(p => !p.we_cited).map(p => p.engine))]
}

function citedEngines(q: PacketQuery): Engine[] {
  return [...new Set(q.probes.filter(p => p.we_cited).map(p => p.engine))]
}

interface PlaybookGroup { url: string; host: string; path_pattern: string; times_cited: number; questions: string[] }

/** Group the aspiration's cited pages by host and path shape; the most cited URL stands for the group. */
export function playbookGroups(rows: readonly TheyCited[]): PlaybookGroup[] {
  const groups = new Map<string, PlaybookGroup & { best: number }>()
  for (const r of rows) {
    const key = `${r.host}${r.path_pattern}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { url: r.url, host: r.host, path_pattern: r.path_pattern, times_cited: r.times, questions: [...r.questions], best: r.times })
      continue
    }
    g.times_cited += r.times
    for (const q of r.questions) if (!g.questions.includes(q)) g.questions.push(q)
    if (r.times > g.best) { g.best = r.times; g.url = r.url }
  }
  return [...groups.values()]
    .sort((a, b) => b.times_cited - a.times_cited || a.url.localeCompare(b.url))
    .slice(0, 12)
    .map(({ best: _best, ...g }) => g)
}

function thisWeekProbes(queries: readonly PacketQuery[]): ProbeLike[] {
  return queries.flatMap(q => q.probes.map(p => ({ question: p.question, engine: p.engine, we_cited: p.we_cited, citations: p.citations })))
}

export function computeCompetitorGap(input: DigestInput): CompetitorGap {
  const fourWeeks = (input.subject.probes_4w ?? []).map(r => ({ question: r.question, engine: r.engine, we_cited: !!r.we_cited, citations: r.competitors_cited ?? [] }))
  const competitorDomains = input.subject.competitor_domains ?? []
  return competitorGapFrom(tallyHosts([...fourWeeks, ...thisWeekProbes(input.queries)], input.krishHitsDomains, competitorDomains))
}

function fallbackRecommendation(q: PacketQuery, n: number, neverSay: readonly string[]): Recommendation {
  const absent = absentEngines(q)
  const competitors = q.gap.competitor_domains.slice(0, 3)
  const b = q.demand_basis
  const angle = [
    `We are not cited on ${absent.join(', ') || 'any probed engine'} for this question.`,
    competitors.length ? `Cited instead: ${competitors.join(', ')}.` : 'No competitor host was cited either.',
    q.call_evidence.length ? `${q.call_evidence.length} call evidence item${q.call_evidence.length === 1 ? '' : 's'} carry the same theme.` : 'No call this week carried the theme.',
  ].join(' ')
  const evidence = [
    `demand ${q.demand_score}: llm ${b.llm_demand}, transcript ${b.transcript_evidence}, volume ${b.rising_volume}`,
    `absent on ${absent.join(', ') || 'none probed'}; cited on ${citedEngines(q).join(', ') || 'none'}`,
  ]
  if (competitors.length) evidence.push(`competitors cited: ${competitors.join(', ')}`)
  return {
    n,
    title: scrubPII(CLEAN(`Answer "${q.query}"`, 200), neverSay),
    target_query: q.query,
    query_id: q.query_id,
    angle: scrubPII(CLEAN(angle, 600), neverSay),
    evidence: evidence.map(e => CLEAN(e, 300)),
    engines: absent,
    demand: q.demand_score,
  }
}

function fallbackWhy(q: PacketQuery): string {
  const probed = new Set(q.probes.map(p => p.engine)).size
  return CLEAN(`demand ${q.demand_score}, ${q.trend}; cited on ${citedEngines(q).length} of ${probed} probed engine${probed === 1 ? '' : 's'}`, 240)
}

function fallbackSignal(queries: readonly PacketQuery[], recommend: readonly PacketQuery[]): string | null {
  const top = recommend[0] ?? queries[0]
  if (!top) return null
  const absent = absentEngines(top)
  const line = absent.length
    ? `"${top.query}" scored ${top.demand_score} and we are absent on ${absent.join(', ')}`
    : `"${top.query}" leads at ${top.demand_score}; cited on ${citedEngines(top).length} of ${new Set(top.probes.map(p => p.engine)).size} probed engines`
  return CLEAN(line, 240)
}

function fallbackHook(recommend: readonly PacketQuery[], gap: CompetitorGap): string | null {
  const top = recommend[0]
  if (!top) return null
  const host = top.gap.competitor_domains[0] ?? gap.domain
  return CLEAN(`When your team asks an AI assistant "${top.query}", the answer cites ${host ?? 'other sources'} and does not mention Mindmake.`, 300)
}

export async function writeDigest(model: ModelClient, ledger: Ledger, input: DigestInput): Promise<DigestResult> {
  const { subject, queries } = input
  const neverSay = subject.never_say ?? []
  const recommend = queries.filter(q => q.status === 'recommend')
  const watch = queries.filter(q => q.status === 'watch')
  const competitor_gap = computeCompetitorGap(input)
  const groups = subject.kind === 'aspiration'
    ? playbookGroups([...input.gap.they_cited, ...theyCitedFrom(thisWeekProbes(queries), subject.domains ?? [])])
    : []
  const byId = new Map(queries.map(q => [q.query_id, q]))

  const unknowns: string[] = []
  if (input.themes.themes_status !== 'ok') unknowns.push(`call themes: ${input.themes.themes_status}`)
  if (!queries.some(q => q.probes.length)) unknowns.push('no engine answers this week')
  if (!(subject.striking_distance ?? []).length) unknowns.push('no Google volume rows for this subject')
  if (!subject.prior) unknowns.push('no prior week to compare against')

  const evidence = {
    subject: { name: subject.name, kind: subject.kind, icp_line: subject.icp_line },
    week_start: input.weekStart,
    engines: input.engines,
    themes: input.themes.themes.map(t => ({ theme: t.theme, calls: t.calls })),
    queries: queries.map(q => ({
      query_id: q.query_id,
      query: q.query,
      status: q.status,
      demand: q.demand_score,
      basis: q.demand_basis,
      trend: q.trend,
      absent_on: absentEngines(q),
      cited_on: citedEngines(q),
      competitor_domains: q.gap.competitor_domains,
      call_evidence: q.call_evidence.length,
      probes: q.probes.map(p => ({ engine: p.engine, we_cited: p.we_cited, hosts: p.citations.slice(0, 5), snippet: p.answer_snapshot.slice(0, 300) })),
    })),
    competitor_gap,
    room_target: subject.kind === 'prospect' && subject.room_target ? { title: subject.room_target.title, why_face: subject.room_target.why_face, trigger_signal: subject.room_target.trigger_signal } : null,
    playbook_groups: groups,
    unknowns,
  }

  let parsed: Record<string, unknown> | null = null
  try {
    ledger.charge('digest', `digest ${subject.slug}`)
    const raw = await model.writeJson({
      stage: 'digest',
      key: subject.id,
      system: digestSystem(input.ctx.krish),
      user: `Subject: ${subject.name} (${subject.kind}). Week starting ${input.weekStart} (Monday).\n\nEvidence (this is the entire factual basis you have; anything not here is unknown):\n${JSON.stringify(evidence, null, 1)}\n\nWrite the digest.`,
      maxTokens: 6000,
    })
    const j = robustJson(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('digest returned non-object')
    parsed = j as Record<string, unknown>
  } catch (e) {
    log('digest_fallback', { subject: subject.slug, error: errText(e) })
  }

  const clean = (v: unknown, max: number) => scrubPII(CLEAN(v, max), neverSay)

  // Recommendations: the model's prose for the recommend rows, most demand first; fallback prose for any it missed.
  const recs: Recommendation[] = []
  const written = new Map<string, Record<string, unknown>>()
  for (const item of asArray(parsed?.recommendations)) {
    const r = asRecord(item)
    const id = asString(r.query_id)
    if (byId.get(id)?.status === 'recommend' && !written.has(id)) written.set(id, r)
  }
  for (const q of recommend.slice(0, 5)) {
    const n = recs.length + 1
    const r = written.get(q.query_id)
    const fb = fallbackRecommendation(q, n, neverSay)
    if (!r) { recs.push(fb); continue }
    const title = clean(r.title, 200)
    const angle = clean(r.angle, 600)
    const lines = asArray(r.evidence).map(x => clean(x, 300)).filter(Boolean).slice(0, 6)
    recs.push({ ...fb, title: title || fb.title, angle: angle || fb.angle, evidence: lines.length ? lines : fb.evidence })
  }

  const whys = new Map<string, string>()
  for (const item of asArray(parsed?.watch_list)) {
    const r = asRecord(item)
    const id = asString(r.query_id)
    const why = clean(r.why, 240)
    if (byId.get(id)?.status === 'watch' && why) whys.set(id, why)
  }
  const watch_list: WatchItem[] = watch.slice(0, 15).map(q => ({ query_id: q.query_id, query: q.query, why: whys.get(q.query_id) ?? fallbackWhy(q) }))

  const modelSignal = parsed ? clean(parsed.strongest_signal, 240) : ''
  const strongest_signal = modelSignal || fallbackSignal(queries, recommend)

  let approach_hook: string | null = null
  if (subject.kind === 'prospect') {
    const modelHook = parsed ? clean(parsed.approach_hook, 300) : ''
    approach_hook = parsed ? modelHook || null : fallbackHook(recommend, competitor_gap)
  }

  let playbook: PlaybookEntry[] | null = null
  if (subject.kind === 'aspiration') {
    const modelWhy = new Map<string, string>()
    for (const item of asArray(parsed?.playbook)) {
      const r = asRecord(item)
      const why = clean(r.why, 300)
      if (asString(r.url) && why) modelWhy.set(asString(r.url), why)
    }
    playbook = groups.map(g => ({
      url: g.url.slice(0, 500),
      host: g.host.slice(0, 120),
      path_pattern: g.path_pattern.slice(0, 120),
      times_cited: g.times_cited,
      why: modelWhy.get(g.url) ?? clean(`Cited ${g.times_cited} time${g.times_cited === 1 ? '' : 's'}, for example on "${g.questions[0] ?? ''}"`, 300),
    }))
  }

  const digest_writer: DigestWriter = parsed ? 'claude' : 'fallback'
  log('digest_written', { subject: subject.slug, writer: digest_writer, recommendations: recs.length, watch: watch_list.length })
  return { strongest_signal, recommendations: recs, watch_list, competitor_gap, playbook, approach_hook, digest_writer }
}
