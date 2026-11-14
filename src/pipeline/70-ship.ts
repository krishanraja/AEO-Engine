/**
 * Stage 70: ship. Validate, then POST to Control Center, or on a dry run
 * write the packet to disk. An invalid packet never leaves the machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ControlCenterClient, IngestResult } from '../clients/types.js'
import { log } from '../lib/log.js'
import { validatePacket, type AeoPacket, type GatedEngine } from '../schema/packet.js'
import { rehearseIngest } from '../lib/rehearse.js'

export interface ShipResult { mode: 'posted' | 'written' | 'held'; path?: string; ingest?: IngestResult; rehearsal?: 'accepted' }

export function writePacket(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
}

/**
 * `features`: the packet features the context lists (validatePacket); each
 * optional field, gemini included, is accepted only when listed. `open`, the
 * older form, names only the gated engines and is read when `features` is absent.
 */
export async function ship(cc: ControlCenterClient, packet: AeoPacket, opts: { dry: boolean; outPath: string | null; open?: readonly GatedEngine[]; features?: readonly string[]; rehearse?: boolean }): Promise<ShipResult> {
  const v = opts.features ? validatePacket(packet, { features: opts.features }) : validatePacket(packet, opts.open ?? [])
  if (!v.ok) throw new Error(`packet invalid for ${packet.subject.slug}: ${v.errors.slice(0, 12).join('; ')}`)
  if (opts.dry) {
    // A rehearsal (dry only): production's ingest validates this packet under
    // a subject id that is never a subject's, so it writes nothing and a 404
    // unknown_subject means every field was accepted (src/lib/rehearse.ts).
    let rehearsal: 'accepted' | undefined
    if (opts.rehearse) {
      const r = await rehearseIngest(cc, packet)
      if (r.verdict === 'rejected') {
        log('rehearsal_ingest', { subject: packet.subject.slug, verdict: 'rejected', errors: r.errors.length })
        throw new Error(`rehearsal: ingest rejected ${packet.subject.slug}: ${r.errors.slice(0, 12).join('; ')}`)
      }
      if (r.verdict === 'unexpected') {
        log('rehearsal_ingest', { subject: packet.subject.slug, verdict: 'unexpected', status: r.status })
        throw new Error(`rehearsal: unexpected ingest answer for ${packet.subject.slug}: ${r.status} ${r.detail}`)
      }
      log('rehearsal_ingest', { subject: packet.subject.slug, verdict: 'accepted', fields: Object.keys(packet).length, queries: packet.queries.length, kits: packet.kits?.length ?? null, cited_pages: packet.cited_pages?.length ?? null })
      rehearsal = 'accepted'
    }
    if (!opts.outPath) return { mode: 'held', ...(rehearsal ? { rehearsal } : {}) }
    writePacket(opts.outPath, packet)
    log('packet_written', { subject: packet.subject.slug, path: opts.outPath })
    return { mode: 'written', path: opts.outPath, ...(rehearsal ? { rehearsal } : {}) }
  }
  const ingest = await cc.postIngest(packet)
  if (!ingest.ok) throw new Error(`ingest rejected ${packet.subject.slug}: ${ingest.error ?? ''} ${(ingest.errors ?? []).slice(0, 12).join('; ')}`.trim())
  log('packet_posted', { subject: packet.subject.slug, deduped: ingest.deduped ?? null, replaced: ingest.replaced ?? null })
  return { mode: 'posted', ingest }
}
