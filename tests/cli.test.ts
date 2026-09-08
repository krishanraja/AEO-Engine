import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { ROOT, readJson } from './helpers.js'

const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

function run(args: string[]) {
  return spawnSync(TSX, ['src/index.ts', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '' } })
}

function strip(p: AeoPacket): Omit<AeoPacket, 'run_id' | 'generated_at'> {
  const { run_id: _r, generated_at: _g, ...rest } = p
  return rest
}

test('offline dry run writes packets that validate and ctrl matches the expected packet', () => {
  const out = join(ROOT, 'out', 'test.json')
  rmSync(out, { force: true })
  const r = run(['--offline', '--dry', '--subject', 'all', '--out', 'out/test.json'])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(out))
  const packets = JSON.parse(readFileSync(out, 'utf8')) as AeoPacket[]
  assert.equal(packets.length, 3)
  for (const p of packets) {
    const v = validatePacket(p)
    assert.equal(v.ok, true, `${p.subject.slug}: ${JSON.stringify(v)}`)
  }
  const ctrl = packets.find(p => p.subject.slug === 'ctrl')!
  const expected = readJson('expected/packet.ctrl.json') as AeoPacket
  assert.deepEqual(strip(ctrl), strip(expected))
  assert.match(ctrl.run_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.ok(!Number.isNaN(Date.parse(ctrl.generated_at)))

  const prospect = packets.find(p => p.subject.slug === 'sample-media')!
  const aspiration = packets.find(p => p.subject.slug === 'sample-studio')!
  assert.equal(ctrl.stats.digest_writer, 'claude')
  assert.equal(prospect.stats.digest_writer, 'fallback')
  assert.equal(prospect.themes_status, 'no_attributed_calls')
  assert.equal(typeof prospect.approach_hook, 'string')
  assert.equal(aspiration.themes_status, 'not_applicable')
  assert.ok(Array.isArray(aspiration.playbook) && aspiration.playbook.length > 0)
  const report = JSON.parse(r.stdout)
  assert.equal(report.ledger.calls, ctrl.stats.probes + prospect.stats.probes + aspiration.stats.probes + ctrl.stats.probes_failed + 2 + 1 + 3 + 3)
})

test('the usd cap stops probing and counts every unprobed pair', () => {
  const out = join(ROOT, 'out', 'test-cap.json')
  const r = run(['--offline', '--dry', '--subject', 'ctrl', '--out', 'out/test-cap.json', '--cap-usd', '0.5'])
  assert.equal(r.status, 0, r.stderr)
  const p = JSON.parse(readFileSync(out, 'utf8')) as AeoPacket
  assert.equal(validatePacket(p).ok, true)
  assert.ok(p.stats.probes_skipped_cap > 0)
  assert.ok(p.stats.probes + p.stats.probes_failed + p.stats.probes_skipped_cap === 60)
  assert.ok(p.stats.cost_usd <= 0.5)
})

test('a subject that does not exist fails the run', () => {
  const r = run(['--offline', '--dry', '--subject', 'nope', '--out', 'out/test-nope.json'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /known slugs: ctrl, sample-media, sample-studio/)
})

test('a subject can be named by uuid, as repository_dispatch does', () => {
  const r = run(['--offline', '--dry', '--subject', '3d9b5e40-6c7f-4ea1-9a3b-4c5d6e7f8091', '--out', 'out/test-uuid.json'])
  assert.equal(r.status, 0, r.stderr)
  const p = JSON.parse(readFileSync(join(ROOT, 'out', 'test-uuid.json'), 'utf8')) as AeoPacket
  assert.equal(p.subject.slug, 'sample-studio')
})
