/**
 * Stage 65: Krish's approved voice rules applied to the words the digest
 * drafted, and to nothing else.
 *
 * The digest (stage 60) is one call that both judges (what to recommend, what
 * is a wall, the strongest signal) and writes. The approved rules (directive
 * `taste`, protocol 1.5.0) govern how words are written and must never reach a
 * call that judges, scores or ranks. So the digest decides with no taste, and
 * this separate wording-only pass rewords what it already wrote: the
 * recommendation titles and angles, the watch-list why lines and the prospect
 * approach hook. It cannot add, drop, reorder or re-decide anything:
 *
 * - it sees only the drafted words with their ids, never the evidence, scores
 *   or walls;
 * - its answer must keep exactly the same ids in the same order, and the hook
 *   stays null when it was null;
 * - a rewrite may not carry a number the original line did not;
 * - any mismatch, failure or cap keeps the digest's own wording, whole.
 *
 * It runs only when he has approved at least one rule and the digest was
 * written by the model. Unknown (no taste) and none approved (an empty list)
 * make no call and change nothing: there is nothing to apply, and no rule is
 * ever invented.
 */
import { asArray, asRecord, asString } from '../clients/http.js'
import type { ModelClient } from '../clients/types.js'
import { CapReached, type Ledger } from '../lib/cost.js'
import { log } from '../lib/log.js'
import { CLEAN, robustJson, scrubPII } from '../lib/text.js'
import type { ContextSubject } from '../schema/context.js'
import type { Taste } from '../schema/report.js'
import type { DigestResult } from './60-digest.js'

/** Krish's approved rules as a labelled block. Empty says none and forbids inventing one; null sends nothing. */
export function tasteBlock(taste: Taste | null | undefined): string {
  if (!taste) return ''
  const head = [
    'KRISH\'S APPROVED VOICE RULES (from Control Center\'s directive; approved or reworded by Krish only).',
    'Follow these for HOW the words are written. Never use them to change what a line is about or what it claims.',
  ]
  if (taste.rule) head.push(`Control Center's rule for them: ${taste.rule}`)
  if (!taste.approved_voice_rules.length) {
    head.push('He has approved none yet. Do not invent a voice rule.')
    return head.join('\n')
  }
  const lines = taste.approved_voice_rules.map(r => {
    const parts = [`- ${r.layer ? `[${r.layer}] ` : ''}${r.rule}`]
    if (r.what_it_means) parts.push(`  What it means: ${r.what_it_means}`)
    if (r.his_words) parts.push(`  His words: "${r.his_words}"`)
    return parts.join('\n')
  })
  return [...head, 'These are the only approved rules; do not add to them.', ...lines].join('\n')
}

export function voiceSystem(taste: Taste): string {
  return [
    'You reword lines already written for Krish Raja\'s weekly digest so they follow his approved voice rules. You change wording only.',
    'ABSOLUTE RULE: keep every item, its id and its order exactly. Do not add, drop, merge or reorder anything. Keep what each line says and claims; change only how it is said.',
    'ABSOLUTE RULE: never add a number, a name, a host or a fact that the line did not already carry.',
    'Respond with ONLY a JSON object of exactly the shape you were given: {"recommendations": [{"query_id": string, "title": string under 200 characters, "angle": string under 600 characters}], "watch_list": [{"query_id": string, "why": string under 240 characters}], "approach_hook": string under 300 characters or null (null exactly when it was null)}.',
    'No em dashes anywhere, and no ASCII stand-ins for one. Never write a person\'s name, email address or handle.',
    tasteBlock(taste),
  ].join('\n\n')
}

const NUM_RE = /\d+(?:[.,]\d+)?/g
/** True when every number in `next` already appears in `prev`. */
function numbersHeld(prev: string, next: string): boolean {
  const had = new Set(prev.match(NUM_RE) ?? [])
  return (next.match(NUM_RE) ?? []).every(n => had.has(n))
}

export async function applyVoice(model: ModelClient, ledger: Ledger, subject: ContextSubject, taste: Taste | null | undefined, draft: DigestResult): Promise<DigestResult> {
  if (!taste || !taste.approved_voice_rules.length) return draft
  if (draft.digest_writer !== 'claude') return draft
  if (!draft.recommendations.length && !draft.watch_list.length && !draft.approach_hook) return draft

  const given = {
    recommendations: draft.recommendations.map(r => ({ query_id: r.query_id, title: r.title, angle: r.angle })),
    watch_list: draft.watch_list.map(w => ({ query_id: w.query_id, why: w.why })),
    approach_hook: draft.approach_hook,
  }
  const neverSay = subject.never_say ?? []
  const clean = (v: unknown, max: number) => scrubPII(CLEAN(v, max), neverSay)
  const keep = (reason: string): DigestResult => { log('voice_kept_draft', { subject: subject.slug, reason }); return draft }

  let j: Record<string, unknown>
  try {
    ledger.charge('voice', `voice ${subject.slug}`)
    const raw = await model.writeJson({
      stage: 'voice',
      key: subject.id,
      system: voiceSystem(taste),
      user: `Reword these lines. Same items, same ids, same order.\n\n${JSON.stringify(given, null, 1)}`,
      maxTokens: 3000,
    })
    const parsed = robustJson(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return keep('not_an_object')
    j = parsed as Record<string, unknown>
  } catch (e) {
    return keep(e instanceof CapReached ? 'cap' : 'call_failed')
  }

  const recs = asArray(j.recommendations).map(asRecord)
  const watch = asArray(j.watch_list).map(asRecord)
  if (recs.length !== given.recommendations.length || recs.some((r, i) => asString(r.query_id) !== given.recommendations[i].query_id)) return keep('recommendations_changed')
  if (watch.length !== given.watch_list.length || watch.some((w, i) => asString(w.query_id) !== given.watch_list[i].query_id)) return keep('watch_list_changed')

  const recommendations = draft.recommendations.map((r, i) => ({ ...r, title: clean(recs[i].title, 200), angle: clean(recs[i].angle, 600) }))
  const watch_list = draft.watch_list.map((w, i) => ({ ...w, why: clean(watch[i].why, 240) }))
  let approach_hook = draft.approach_hook
  if (draft.approach_hook !== null) {
    approach_hook = clean(j.approach_hook, 300)
    if (!approach_hook || !numbersHeld(draft.approach_hook, approach_hook)) return keep('hook_invalid')
  } else if (j.approach_hook !== null && j.approach_hook !== undefined) return keep('hook_added')

  for (let i = 0; i < recommendations.length; i++) {
    const a = draft.recommendations[i], b = recommendations[i]
    if (!b.title || !b.angle || !numbersHeld(a.title, b.title) || !numbersHeld(a.angle, b.angle)) return keep('recommendation_invalid')
  }
  for (let i = 0; i < watch_list.length; i++) {
    if (!watch_list[i].why || !numbersHeld(draft.watch_list[i].why, watch_list[i].why)) return keep('watch_invalid')
  }
  log('voice_applied', { subject: subject.slug, rules: taste.approved_voice_rules.length, recommendations: recommendations.length, watch: watch_list.length })
  return { ...draft, recommendations, watch_list, approach_hook }
}
