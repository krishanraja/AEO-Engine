import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { OfflineControlCenter } from '../src/clients/offline.js'
import type { ControlCenterClient } from '../src/clients/types.js'
import { ship } from '../src/pipeline/70-ship.js'
import type { AeoPacket } from '../src/schema/packet.js'
import { FIXTURES, ROOT, readJson } from './helpers.js'

const packet = () => structuredClone(readJson('expected/packet.ctrl.json')) as AeoPacket

test('a dry run validates then writes; no POST', async () => {
  const cc = new OfflineControlCenter(FIXTURES)
  const path = join(ROOT, 'out', 'ship-test.json')
  rmSync(path, { force: true })
  const r = await ship(cc, packet(), { dry: true, outPath: 'out/ship-test.json' })
  assert.equal(r.mode, 'written')
  assert.ok(existsSync(path))
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).subject.slug, 'ctrl')
  assert.equal(cc.ingested.length, 0)
  assert.equal((await ship(cc, packet(), { dry: true, outPath: null })).mode, 'held')
})

test('an invalid packet never leaves the machine', async () => {
  const cc = new OfflineControlCenter(FIXTURES)
  const p = packet()
  p.strongest_signal = 'bad \u2014 dash'
  await assert.rejects(ship(cc, p, { dry: false, outPath: null }), /packet invalid for ctrl/)
  assert.equal(cc.ingested.length, 0)
})

test('a live ship posts, and a rejection is an error', async () => {
  const cc = new OfflineControlCenter(FIXTURES)
  const r = await ship(cc, packet(), { dry: false, outPath: null })
  assert.equal(r.mode, 'posted')
  assert.equal(cc.ingested.length, 1)
  const rejecting: ControlCenterClient = { ...cc, getContext: cc.getContext.bind(cc), patchCommand: cc.patchCommand.bind(cc), postIngest: async () => ({ ok: false, status: 400, error: 'invalid_packet', errors: ['packet.x: bad'] }) }
  await assert.rejects(ship(rejecting, packet(), { dry: false, outPath: null }), /ingest rejected ctrl: invalid_packet packet.x: bad/)
})
