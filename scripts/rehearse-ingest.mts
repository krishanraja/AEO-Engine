/**
 * npm run rehearse: the free half of the rehearsal. No model, no probe, no
 * paid key: two reads and two validations against production.
 *
 * 1. The context: which packet features production lists today, against the
 *    ones this engine can send (PACKET_FEATURES, plus meter_billing).
 * 2. The ingest: the synthetic full-feature fixture packet
 *    (tests/fixtures/expected/packet.ctrl.features.json) and the v1 packet
 *    (packet.ctrl.json), each sent under a subject id that is never a
 *    subject's (src/lib/rehearse.ts). Production validates every field before
 *    it reads the subject, so 404 unknown_subject means accepted, and no row
 *    is written apart from one aeo_ingest ledger row each.
 *
 * Prints counts and verdicts only. Exit 1 when anything is not accepted.
 * Needs CONTROL_CENTER_URL and AEO_ENGINE_SECRET (the research job's pair).
 */
import { readFileSync } from 'node:fs'
import { ControlCenterHttp } from '../src/clients/controlCenter.js'
import { REHEARSAL_SUBJECT_ID, rehearseIngest } from '../src/lib/rehearse.js'
import { PACKET_FEATURES, validatePacket, type AeoPacket } from '../src/schema/packet.js'

const cc = new ControlCenterHttp(process.env.CONTROL_CENTER_URL ?? '', process.env.AEO_ENGINE_SECRET ?? '')
let failed = 0
const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + '\n')

const ctx = await cc.getContext('all')
const listed = Array.isArray(ctx.packet_features) ? ctx.packet_features.map(String) : []
const wanted = [...PACKET_FEATURES, 'meter_billing']
const missing = wanted.filter(f => !listed.includes(f))
out({ step: 'context', subjects: ctx.subjects.length, packet_features: listed.length, missing })
if (missing.length) failed++

for (const name of ['packet.ctrl.features.json', 'packet.ctrl.json']) {
  const packet = JSON.parse(readFileSync(`tests/fixtures/expected/${name}`, 'utf8')) as AeoPacket
  const local = validatePacket(packet, { features: listed })
  if (!local.ok) { out({ step: 'ingest', fixture: name, verdict: 'invalid_here', errors: local.errors.slice(0, 12) }); failed++; continue }
  const r = await rehearseIngest(cc, packet)
  out({ step: 'ingest', fixture: name, subject_id: REHEARSAL_SUBJECT_ID, verdict: r.verdict, fields: Object.keys(packet).length, ...(r.verdict === 'rejected' ? { errors: r.errors.slice(0, 12) } : {}), ...(r.verdict === 'unexpected' ? { status: r.status, detail: r.detail } : {}) })
  if (r.verdict !== 'accepted') failed++
}
process.exit(failed ? 1 : 0)
