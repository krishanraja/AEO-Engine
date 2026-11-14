/**
 * The ingest rehearsal: proves that production's ingest accepts a packet,
 * every field of it, without writing a row.
 *
 * Content-engine's POST /api/aeo/ingest validates the whole packet against
 * the contract BEFORE it reads the subject (api/aeo/ingest.ts): an invalid
 * field is a 400 with the errors, and a valid packet whose subject id is not
 * in growth_aeo_subjects is a 404 `unknown_subject`, with nothing written to
 * a probe, query, digest, idea or cited-page table. So a copy of the packet
 * with its subject id replaced by one that can never be a subject's is the
 * honest dry check: 404 `unknown_subject` means "every field accepted".
 * The route still records one content_engine_runs ledger row (aeo_ingest,
 * failed, unknown_subject) for each rehearsal, which is the only trace.
 *
 * The synthetic id is derived from a fixed key, so it is the same every time
 * and is never minted for a real subject (those come from Control Center).
 */
import { createHash } from 'node:crypto'
import type { AeoPacket } from '../schema/packet.js'
import type { ControlCenterClient } from '../clients/types.js'
import { HttpError } from '../clients/http.js'

const REHEARSAL_KEY = 'aeo-engine:rehearsal:never-a-subject'

function uuidOf(key: string): string {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const REHEARSAL_SUBJECT_ID = uuidOf(REHEARSAL_KEY)

export type RehearsalVerdict =
  | { verdict: 'accepted' }
  | { verdict: 'rejected'; errors: string[] }
  | { verdict: 'unexpected'; status: number; detail: string }

/** The packet as the rehearsal sends it: a deep copy with the synthetic subject id. */
export function rehearsalPacket(packet: AeoPacket): AeoPacket {
  const copy = structuredClone(packet)
  copy.subject = { ...copy.subject, id: REHEARSAL_SUBJECT_ID }
  return copy
}

/**
 * POST the rehearsal copy and read the answer. Never throws on an HTTP
 * answer; the caller decides what a verdict means. A 200 is `unexpected`:
 * it would mean the synthetic id is a real subject, and is said loudly.
 */
export async function rehearseIngest(cc: Pick<ControlCenterClient, 'postIngest'>, packet: AeoPacket): Promise<RehearsalVerdict> {
  try {
    const r = await cc.postIngest(rehearsalPacket(packet))
    if (r.status === 400) return { verdict: 'rejected', errors: r.errors?.length ? r.errors : [r.error ?? 'invalid_packet'] }
    return { verdict: 'unexpected', status: r.status, detail: 'the ingest answered ok: the rehearsal subject id exists, so a rehearsal may have written rows' }
  } catch (e) {
    if (e instanceof HttpError && e.status === 404 && e.message.includes('unknown_subject')) return { verdict: 'accepted' }
    if (e instanceof HttpError) return { verdict: 'unexpected', status: e.status, detail: e.message.slice(0, 200) }
    return { verdict: 'unexpected', status: 0, detail: String((e as Error)?.message ?? e).slice(0, 200) }
  }
}
