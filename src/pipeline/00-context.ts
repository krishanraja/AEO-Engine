/**
 * Stage 00: the context. One read of Control Center for every subject, then
 * the subset this run is for. The classification stage needs every active
 * subject even when the run is for one, so the read is always "all".
 */
import type { ControlCenterClient } from '../clients/types.js'
import type { AeoContext, ContextSubject } from '../schema/context.js'

export async function loadContext(cc: ControlCenterClient, subjectArg: string): Promise<{ ctx: AeoContext; selected: ContextSubject[] }> {
  const ctx = await cc.getContext('all')
  const all = Array.isArray(ctx.subjects) ? ctx.subjects : []
  if (subjectArg === 'all') return { ctx, selected: all }
  const selected = all.filter(s => s.slug === subjectArg || s.id === subjectArg)
  if (!selected.length) throw new Error(`no subject "${subjectArg}"; known slugs: ${all.map(s => s.slug).join(', ') || 'none'}`)
  return { ctx, selected }
}

/**
 * Whose domains count as "us" in an answer. For a venture or an aspiration
 * it is the subject's own domains. For a prospect it is Mindmake and Krish:
 * the question is whether the prospect's leaders would see Mindmake in the
 * answers their assistants give them.
 */
export function krishHitsDomains(ctx: AeoContext, subject: ContextSubject): string[] {
  const own = Array.isArray(subject.domains) ? subject.domains : []
  const krish = Array.isArray(ctx.krish?.domains) ? ctx.krish.domains : []
  const list = subject.kind === 'prospect' ? krish : own
  return [...new Set(list.map(d => String(d).toLowerCase().trim()).filter(Boolean))]
}
