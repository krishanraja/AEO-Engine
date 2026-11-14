import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpError } from '../src/clients/http.js'
import type { ControlCenterClient, IngestResult } from '../src/clients/types.js'
import { parseArgs } from '../src/index.js'
import { ship } from '../src/pipeline/70-ship.js'
import { REHEARSAL_SUBJECT_ID, rehearsalPacket, rehearseIngest } from '../src/lib/rehearse.js'
import type { AeoPacket } from '../src/schema/packet.js'
import { readJson } from './helpers.js'

const packet = () => structuredClone(readJson('expected/packet.ctrl.features.json')) as AeoPacket

/** A stand-in for production's ingest: validates first, then reads the subject. */
function ingest(answer: 'unknown_subject' | 'invalid' | 'ok'): ControlCenterClient & { sent: AeoPacket[] } {
  const sent: AeoPacket[] = []
  return {
    sent,
    async getContext() { throw new Error('unused') },
    async postIngest(p: AeoPacket): Promise<IngestResult> {
      sent.push(p)
      if (answer === 'invalid') return { ok: false, status: 400, error: 'invalid_packet', errors: ['queries[0].panel: bad'] }
      if (answer === 'ok') return { ok: true, status: 200 }
      throw new HttpError('control_center_ingest', 404, '{"ok":false,"error":"unknown_subject"}')
    },
    async patchCommand() { throw new Error('a rehearsal patches no command') },
    async postUsage() { return { ok: true, error: null } },
  }
}

test('the rehearsal copy carries the synthetic subject id and leaves the packet untouched', () => {
  const p = packet()
  const copy = rehearsalPacket(p)
  assert.equal(copy.subject.id, REHEARSAL_SUBJECT_ID)
  assert.notEqual(p.subject.id, REHEARSAL_SUBJECT_ID)
  assert.deepEqual({ ...copy, subject: p.subject }, p)
  assert.match(REHEARSAL_SUBJECT_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('404 unknown_subject is accepted; 400 lists the errors; 200 is unexpected', async () => {
  assert.deepEqual(await rehearseIngest(ingest('unknown_subject'), packet()), { verdict: 'accepted' })
  assert.deepEqual(await rehearseIngest(ingest('invalid'), packet()), { verdict: 'rejected', errors: ['queries[0].panel: bad'] })
  const ok = await rehearseIngest(ingest('ok'), packet())
  assert.equal(ok.verdict, 'unexpected')
})

test('a dry rehearsal sends the copy, never the real subject, and writes nothing', async () => {
  const cc = ingest('unknown_subject')
  const r = await ship(cc, packet(), { dry: true, outPath: null, rehearse: true, features: ['probe_detail', 'name_mentions', 'samples', 'panel', 'diagnosis', 'kits', 'site', 'run_kind', 'outcome', 'cited_pages'] })
  assert.equal(r.mode, 'held')
  assert.equal(r.rehearsal, 'accepted')
  assert.equal(cc.sent.length, 1)
  assert.equal(cc.sent[0].subject.id, REHEARSAL_SUBJECT_ID)
})

test('a rejected or unexpected rehearsal fails the run', async () => {
  const features = ['probe_detail', 'name_mentions', 'samples', 'panel', 'diagnosis', 'kits', 'site', 'run_kind', 'outcome', 'cited_pages']
  await assert.rejects(ship(ingest('invalid'), packet(), { dry: true, outPath: null, rehearse: true, features }), /rehearsal: ingest rejected ctrl/)
  await assert.rejects(ship(ingest('ok'), packet(), { dry: true, outPath: null, rehearse: true, features }), /rehearsal: unexpected ingest answer/)
})

test('without --rehearse a dry run sends nothing', async () => {
  const cc = ingest('unknown_subject')
  await ship(cc, packet(), { dry: true, outPath: null, features: ['probe_detail', 'name_mentions', 'samples', 'panel', 'diagnosis', 'kits', 'site', 'run_kind', 'outcome', 'cited_pages'] })
  assert.equal(cc.sent.length, 0)
})

test('--rehearse implies --dry and is refused for a verify run', () => {
  const a = parseArgs(['--rehearse', '--subject', 'mindmake'])
  assert.equal(a.rehearse, true)
  assert.equal(a.dry, true)
  assert.throws(() => parseArgs(['--rehearse', '--mode', 'verify', '--verify-payload', 'x.json']), /--rehearse is for a research run/)
})
