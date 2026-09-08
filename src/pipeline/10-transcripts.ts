/**
 * Stage 10: the week's calls. List the last seven days, fetch each, attribute
 * each transcript to one subject with one model call, then write five to ten
 * themes per subject with paraphrase-only evidence. Nothing that identifies a
 * participant survives this stage: speakers are renumbered before the model
 * sees them and every output string is scrubbed.
 */
import { CAPS } from '../config/run.js'
import type { FirefliesClient, ModelClient, Transcript } from '../clients/types.js'
import { FirefliesUnavailable } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import { CLEAN, callRef, robustJson, scrubPII } from '../lib/text.js'
import { YMD, ymdOf } from '../lib/week.js'
import type { ContextSubject } from '../schema/context.js'
import type { Evidence, Theme, ThemesStatus } from '../schema/packet.js'
import { asArray, asRecord, asString } from '../clients/http.js'

export interface Gathered { status: 'ok' | 'unavailable'; transcripts: Transcript[]; error?: string }

export async function gatherTranscripts(fireflies: FirefliesClient | null, now: Date, days = CAPS.TRANSCRIPT_WINDOW_DAYS): Promise<Gathered> {
  if (!fireflies) return { status: 'unavailable', transcripts: [], error: 'FIREFLIES_API_KEY is not set' }
  const to = now.toISOString()
  const from = new Date(now.getTime() - days * 86_400_000).toISOString()
  try {
    const list = await fireflies.listTranscripts(from, to)
    const transcripts: Transcript[] = []
    for (const t of list) transcripts.push(await fireflies.getTranscript(t.id))
    log('transcripts_gathered', { window_from: from, window_to: to, count: transcripts.length })
    return { status: 'ok', transcripts }
  } catch (e) {
    const msg = e instanceof FirefliesUnavailable ? e.message : `unexpected: ${errText(e)}`
    log('transcripts_unavailable', { error: msg })
    return { status: 'unavailable', transcripts: [], error: msg }
  }
}

/** The transcript as the model may see it: speakers renumbered, PII scrubbed, capped. */
export function excerptOf(t: Transcript, maxChars = 6000): string {
  const speakers = new Map<string, string>()
  const lines: string[] = []
  const head = [`Title: ${scrubPII(t.title)}`, `Date: ${ymdOf(t.date)}`]
  if (t.summary) {
    if (t.summary.overview) head.push(`Overview: ${scrubPII(t.summary.overview)}`)
    if (t.summary.keywords.length) head.push(`Keywords: ${t.summary.keywords.map(k => scrubPII(k)).join(', ')}`)
  }
  for (const s of t.sentences) {
    const key = s.speaker_name || 'unknown'
    if (!speakers.has(key)) speakers.set(key, `Speaker ${speakers.size + 1}`)
    lines.push(`${speakers.get(key)}: ${scrubPII(s.text)}`)
  }
  const body = lines.join('\n')
  return `${head.join('\n')}\n\n${body.length > maxChars ? body.slice(0, maxChars) + '\n[transcript trimmed]' : body}`
}

export interface Attribution { subject_id: string | null; confidence: number; reason: string }

const CLASSIFY_SYSTEM = [
  'You classify one call transcript against a list of subjects for a weekly research run.',
  'A venture subject fits when the call is with or about a buyer or user of that product. A prospect subject fits when the call is with people from that company or about selling to it. An aspiration subject fits when the call is mainly about that company as a model to learn from.',
  'Respond with ONLY a JSON object: {"subject_id": string or null, "confidence": number from 0 to 1, "reason": string under 160 characters}. Use null when no subject fits.',
  'Never write a person\'s name, email address or handle in the reason. No em dashes anywhere, and no ASCII stand-ins for one: use a comma or a full stop.',
].join('\n\n')

export async function classifyTranscripts(model: ModelClient, transcripts: Transcript[], subjects: ContextSubject[], ledger: Ledger): Promise<Map<string, Attribution>> {
  const out = new Map<string, Attribution>()
  const ids = new Set(subjects.map(s => s.id))
  const roster = subjects.map(s => ({ id: s.id, kind: s.kind, name: s.name, icp_line: s.icp_line, seed_topics: s.seed_topics }))
  for (const t of transcripts) {
    try {
      ledger.charge('classify', `classify ${callRef(t.id)}`)
      const raw = await model.classify({
        stage: 'classify',
        key: t.id,
        system: CLASSIFY_SYSTEM,
        user: `Subjects:\n${JSON.stringify(roster, null, 1)}\n\nTranscript:\n${excerptOf(t)}\n\nClassify it.`,
        maxTokens: 300,
      })
      const j = asRecord(robustJson(raw))
      const sid = typeof j.subject_id === 'string' && ids.has(j.subject_id) ? j.subject_id : null
      const conf = typeof j.confidence === 'number' && Number.isFinite(j.confidence) ? Math.max(0, Math.min(1, j.confidence)) : 0
      out.set(t.id, { subject_id: sid, confidence: sid ? conf : 0, reason: scrubPII(CLEAN(j.reason, 160)) })
    } catch (e) {
      log('classify_failed', { call_ref: callRef(t.id), error: errText(e) })
      out.set(t.id, { subject_id: null, confidence: 0, reason: 'classifier failed' })
    }
  }
  log('transcripts_classified', { count: transcripts.length, attributed: [...out.values()].filter(a => a.subject_id && a.confidence >= CAPS.MIN_ATTRIBUTION_CONFIDENCE).length })
  return out
}

export interface ThemesResult { themes_status: ThemesStatus; themes: Theme[]; calls: { considered: number; attributed: number } }

const THEMES_SYSTEM = [
  'You extract the buyer themes from one subject\'s calls this week for a weekly research run. A theme is a question, worry or job the people on the calls kept coming back to, written as the buyer would put it.',
  'Respond with ONLY a JSON object: {"themes": [{"theme": string under 200 characters, "evidence": [{"call_ref": string, "date": "YYYY-MM-DD", "paraphrase": string under 200 characters}]}]}. Write 5 to 10 themes. Each theme carries 1 to 6 evidence items.',
  'ABSOLUTE RULE: every paraphrase is a paraphrase, never a verbatim quote, and never names a person, a participant\'s company, an email address or a handle.',
  'ABSOLUTE RULE: call_ref and date are copied from the calls you are given; never invent one.',
  'No em dashes anywhere, and no ASCII stand-ins for one: use a comma or a full stop.',
].join('\n\n')

function attributedTo(subject: ContextSubject, gathered: Gathered, attribution: Map<string, Attribution>): Transcript[] {
  return gathered.transcripts.filter(t => {
    const a = attribution.get(t.id)
    return !!a && a.subject_id === subject.id && a.confidence >= CAPS.MIN_ATTRIBUTION_CONFIDENCE
  })
}

export async function themesForSubject(model: ModelClient, subject: ContextSubject, gathered: Gathered, attribution: Map<string, Attribution>, ledger: Ledger): Promise<ThemesResult> {
  const considered = gathered.status === 'ok' ? gathered.transcripts.length : 0
  const mine = attributedTo(subject, gathered, attribution)
  const calls = { considered, attributed: mine.length }
  if (subject.kind === 'aspiration') return { themes_status: 'not_applicable', themes: [], calls }
  if (gathered.status !== 'ok') return { themes_status: 'fireflies_unavailable', themes: [], calls: { considered: 0, attributed: 0 } }
  if (!considered) return { themes_status: 'no_calls', themes: [], calls }
  if (!mine.length) return { themes_status: 'no_attributed_calls', themes: [], calls }

  const refs = new Map(mine.map(t => [callRef(t.id), ymdOf(t.date)]))
  const callsText = mine.map(t => `--- call_ref ${callRef(t.id)}, date ${ymdOf(t.date)} ---\n${excerptOf(t, 5000)}`).join('\n\n')
  ledger.charge('themes', `themes ${subject.slug}`)
  const raw = await model.writeJson({
    stage: 'themes',
    key: subject.id,
    system: THEMES_SYSTEM,
    user: `Subject: ${subject.name} (${subject.kind}). ICP: ${subject.icp_line}\n\nCalls:\n${callsText}\n\nWrite the themes.`,
    maxTokens: 3000,
  })
  const j = asRecord(robustJson(raw))
  const themes: Theme[] = []
  for (const item of asArray(j.themes)) {
    const r = asRecord(item)
    const theme = scrubPII(CLEAN(r.theme, 200), subject.never_say)
    if (!theme) continue
    const evidence: Evidence[] = []
    for (const e of asArray(r.evidence)) {
      const er = asRecord(e)
      const ref = asString(er.call_ref)
      if (!refs.has(ref)) continue
      const paraphrase = scrubPII(CLEAN(er.paraphrase, 200), subject.never_say)
      if (!paraphrase) continue
      // The date is the call's own date, whatever the model wrote back.
      const date = refs.get(ref) ?? ''
      if (!YMD.test(date)) continue
      evidence.push({ call_ref: ref, date, paraphrase })
      if (evidence.length >= 6) break
    }
    const distinct = new Set(evidence.map(e => e.call_ref)).size
    themes.push({ theme, calls: Math.max(1, distinct), evidence })
    if (themes.length >= 10) break
  }
  if (!themes.length) throw new Error(`themes: model returned no usable themes for ${subject.slug}`)
  log('themes_written', { subject: subject.slug, themes: themes.length, attributed: mine.length })
  return { themes_status: 'ok', themes, calls }
}
