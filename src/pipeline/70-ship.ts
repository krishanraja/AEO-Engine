/**
 * Stage 70: ship. Validate, then POST to Control Center, or on a dry run
 * write the packet to disk. An invalid packet never leaves the machine.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ControlCenterClient, IngestResult } from '../clients/types.js'
import { log } from '../lib/log.js'
import { validatePacket, type AeoPacket } from '../schema/packet.js'

export interface ShipResult { mode: 'posted' | 'written' | 'held'; path?: string; ingest?: IngestResult }

export function writePacket(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n')
}

export async function ship(cc: ControlCenterClient, packet: AeoPacket, opts: { dry: boolean; outPath: string | null }): Promise<ShipResult> {
  const v = validatePacket(packet)
  if (!v.ok) throw new Error(`packet invalid for ${packet.subject.slug}: ${v.errors.slice(0, 12).join('; ')}`)
  if (opts.dry) {
    if (!opts.outPath) return { mode: 'held' }
    writePacket(opts.outPath, packet)
    log('packet_written', { subject: packet.subject.slug, path: opts.outPath })
    return { mode: 'written', path: opts.outPath }
  }
  const ingest = await cc.postIngest(packet)
  if (!ingest.ok) throw new Error(`ingest rejected ${packet.subject.slug}: ${ingest.error ?? ''} ${(ingest.errors ?? []).slice(0, 12).join('; ')}`.trim())
  log('packet_posted', { subject: packet.subject.slug, deduped: ingest.deduped ?? null, replaced: ingest.replaced ?? null })
  return { mode: 'posted', ingest }
}
