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
import { hostMatches } from '../lib/domains.js'
import type { AeoContext, ContextSubject } from '../schema/context.js'
import type { CompetitorGap, DigestWriter, Engine, NotWorthChasing, PacketQuery, PlaybookEntry, Recommendation, WatchItem } from '../schema/packet.js'
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
  not_worth_chasing: NotWorthChasing[]
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
  'ABSOLUTE RULE: absence is not opportunity. A question we are missing from because a large general platform or publisher owns the answer is a wall, not a gap. Recommend only what can be won, and say plainly what cannot.',
  'Respond with ONLY a JSON object:',
  '{"strongest_signal": string under 240 characters or null (the one measured fact that matters most this week),',
  ' "recommendations": [{"query_id": string (one of the evidence rows with status recommend), "title": string under 200 characters (the piece or page to make), "angle": string under 600 characters (what it argues and why it would be cited), "why_you_can_win": string under 300 characters or null (the specific reason Krish can win THIS answer when the sites cited today structurally cannot; null when you cannot name one, and never a generality such as "he knows a lot about this"), "evidence": [string under 300 characters] (2 to 4 lines, each citing something measured: a score, an engine we are absent on, a competitor host, a call theme)}] (up to 5, one per recommend row that can be won, most demand first),',
  ' "not_worth_chasing": [{"query_id": string (any row in the evidence), "owned_by": [string] (the hosts that own the answer now, taken from the evidence), "why_not": string under 300 characters (one plain sentence on why he will not displace them)}] (at most 6, the probed questions he should not try to win; a query_id here must not also appear in recommendations),',
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

/** How many characters of the business canon to carry. The whole file runs to
 *  about fifteen thousand; the opening is where the positioning, what is sold
 *  and exactly who the buyer is live, and those are the three things the
 *  winnability judgement needs. */
const CANON_CHARS = 7000

/** The winnability rules, appended only when there is a canon to ground them in. */
const WINNABILITY = [
  'WINNABILITY. Absence is not opportunity. Being missing from an answer that LinkedIn, a video platform, a national business title or a big consultancy owns is a wall, not a gap: recommending it costs Krish a week and wins nothing. Run these five rules over every question before you write a recommendation.',
  '1. Decide who owns the answer now, from the hosts cited in the evidence. Large general platforms and publishers (a social network, a video platform, a national business title, a big consultancy) won those answers with format and reach, not with an argument, and one piece will not displace them. Niche specialists won theirs with an argument, and an argument can be beaten.',
  '2. A recommendation must name what Krish has that the sites cited today structurally cannot have, taken from the canon below: the positioning, the specific buyer, the proof, the product. That sentence is why_you_can_win. "He knows a lot about this" is not a reason. If you cannot name one, it is not a recommendation.',
  '3. The person asking must be the buyer the canon describes, someone who can move a decision on their own. A question asked mostly by people who cannot buy is not worth winning even if he would rank for it.',
  '4. A question that fails any of these goes in not_worth_chasing, with the hosts that own it in owned_by and one plain sentence in why_not. Say it plainly and do not hedge: he would rather be told to skip something than be handed a recommendation that costs him a week.',
  '5. Prefer the specific over the category. A broad category term belongs to whoever has the most links. A specific question a real buyer asked belongs to whoever answers it best.',
].join('\n')

/**
 * The system prompt for one run. Krish told the OS how he writes and whose
 * moves he rates once, on the Content side; Control Center sends both here
 * (`krish.voice_block`, `krish.voices_he_rates`), so a title and an angle
 * land in his register instead of generic marketing prose. It sends the
 * business canon too (`krish.canon`), which is what turns "we are absent
 * here" into "we could win here". All three are optional: an older Control
 * Center, or a failed read, gives a plain digest rather than one written in a
 * voice the machine invented or a judgement it had no grounds for.
 */
export function digestSystem(krish?: AeoContext['krish']): string {
  const parts = [DIGEST_SYSTEM]
  const canon = (krish?.canon || '').trim()
  if (canon) {
    parts.push(WINNABILITY)
    parts.push(
      'THE CANON. This is the business you are deciding for: the positioning, what is sold, who the buyer is, what the business believes and what it refuses to say. Rules 2 and 3 are answered from here and nowhere else. It carries no measurements, so never take a number from it.\n\n'
      + canon.slice(0, CANON_CHARS),
    )
  }
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

/**
 * Hosts that own an answer by reach and format rather than by argument: social
 * networks, video platforms, encyclopaedias and answer aggregators, national
 * business titles, and the big consultancies. One piece does not displace any
 * of them, so a question they own is a wall and not a gap. The list is
 * deliberately short and deliberately obvious; it exists so the deterministic
 * fallback can answer "who owns this now" without a model, and it never
 * decides anything on its own beyond that one question.
 */
export const GENERAL_PLATFORMS: readonly string[] = [
  'linkedin.com', 'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com',
  'reddit.com', 'quora.com', 'medium.com', 'wikipedia.org', 'pinterest.com',
  'forbes.com', 'hbr.org', 'inc.com', 'entrepreneur.com', 'fastcompany.com', 'businessinsider.com',
  'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com', 'economist.com', 'nytimes.com', 'techcrunch.com',
  'wired.com', 'theverge.com', 'gartner.com',
  'mckinsey.com', 'bcg.com', 'bain.com', 'deloitte.com', 'accenture.com', 'pwc.com', 'ey.com', 'kpmg.com', 'ibm.com',
]

/** Which of these cited hosts are large general platforms, in the order given. */
export function generalPlatformsAmong(hosts: readonly string[]): string[] {
  return hosts.filter(h => GENERAL_PLATFORMS.some(p => hostMatches(String(h), p)))
}

/**
 * Rule one of the winnability judgement, made deterministically: the answer is
 * owned when more than half the hosts cited on it are large general platforms.
 * A majority rather than a single hit, because one social link beside two
 * specialists is still a question a specialist won and a specialist can take.
 */
export function ownedByPlatforms(hosts: readonly string[]): string[] {
  const owners = generalPlatformsAmong(hosts)
  return owners.length * 2 > hosts.length ? owners : []
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
    // Never invented here. The fallback can see who is cited; it cannot see
    // what Krish has that they do not, so it says nothing and the null is what
    // the reader gets, along with digest_writer: fallback.
    why_you_can_win: null,
  }
}

/**
 * The three winnability questions as the deterministic fallback can answer
 * them. It can answer the first one from the cited hosts, so a question the
 * big platforms own is moved out of the recommendations and named as a wall.
 * It cannot answer the second (what Krish has that they cannot) or the third
 * (whether the asker can buy) without the canon and a model, so it never
 * writes a why_you_can_win, and the surviving recommendations carry null.
 */
function fallbackNotWorthChasing(q: PacketQuery, owners: readonly string[]): NotWorthChasing {
  const owned = owners.slice(0, 8)
  const why = `The answer is owned by ${owned.slice(0, 3).join(', ')}, won on reach and format rather than on argument, and one piece will not displace that. The writing pass was unavailable this week, so nothing beyond who is cited was judged.`
  return { query_id: q.query_id, query: CLEAN(q.query, 400), owned_by: owned.map(h => CLEAN(h, 120)), why_not: CLEAN(why, 300) }
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

  // What NOT to chase, decided before anything is recommended: a question the
  // model (or, when the model is gone, the platform list) says is owned cannot
  // also be the thing to make this week.
  const not_worth_chasing: NotWorthChasing[] = []
  const walled = new Set<string>()
  const addWall = (entry: NotWorthChasing): void => {
    if (walled.has(entry.query_id) || not_worth_chasing.length >= 6 || !entry.why_not) return
    walled.add(entry.query_id)
    not_worth_chasing.push(entry)
  }
  if (parsed) {
    for (const item of asArray(parsed.not_worth_chasing)) {
      const r = asRecord(item)
      const q = byId.get(asString(r.query_id))
      if (!q) continue
      const hosts = asArray(r.owned_by).map(x => clean(x, 120)).filter(Boolean).slice(0, 8)
      addWall({
        query_id: q.query_id,
        query: CLEAN(q.query, 400),
        owned_by: hosts.length ? hosts : q.gap.competitor_domains.slice(0, 8).map(h => CLEAN(h, 120)),
        why_not: clean(r.why_not, 300),
      })
    }
  } else {
    for (const q of recommend.slice(0, 5)) {
      const owners = ownedByPlatforms(q.gap.competitor_domains)
      if (owners.length) addWall(fallbackNotWorthChasing(q, owners))
    }
  }

  // Recommendations: the model's prose for the recommend rows it did not wall
  // off, most demand first; fallback prose for any it missed. A recommendation
  // the model wrote no why_you_can_win for is carried with null rather than
  // dropped, so the reader sees that the judgement was not made.
  const recs: Recommendation[] = []
  const written = new Map<string, Record<string, unknown>>()
  for (const item of asArray(parsed?.recommendations)) {
    const r = asRecord(item)
    const id = asString(r.query_id)
    if (byId.get(id)?.status === 'recommend' && !written.has(id)) written.set(id, r)
  }
  for (const q of recommend.slice(0, 5)) {
    if (walled.has(q.query_id)) continue
    const n = recs.length + 1
    const r = written.get(q.query_id)
    const fb = fallbackRecommendation(q, n, neverSay)
    if (!r) { recs.push(fb); continue }
    const title = clean(r.title, 200)
    const angle = clean(r.angle, 600)
    const win = clean(r.why_you_can_win, 300)
    const lines = asArray(r.evidence).map(x => clean(x, 300)).filter(Boolean).slice(0, 6)
    recs.push({ ...fb, title: title || fb.title, angle: angle || fb.angle, why_you_can_win: win || null, evidence: lines.length ? lines : fb.evidence })
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
  const unjustified = recs.filter(r => r.why_you_can_win === null).length
  log('digest_written', { subject: subject.slug, writer: digest_writer, recommendations: recs.length, unjustified, not_worth_chasing: not_worth_chasing.length, watch: watch_list.length })
  // A recommendation with no reason to win is a bug in the digest, not a
  // finding. Say so in the log; the packet still carries the null so the
  // reader can see which one it was.
  if (unjustified) log('digest_unjustified', { subject: subject.slug, writer: digest_writer, count: unjustified, canon: !!(input.ctx.krish?.canon || '').trim() })
  return { strongest_signal, recommendations: recs, not_worth_chasing, watch_list, competitor_gap, playbook, approach_hook, digest_writer }
}
