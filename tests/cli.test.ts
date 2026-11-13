import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { validatePacket, type AeoPacket } from '../src/schema/packet.js'
import { readSharedAudit } from '../src/site.js'
import { ROOT, readJson } from './helpers.js'

const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

/**
 * The week the expected packet was captured in.
 *
 * `week_start` is `mondayOf(now)`, so an offline run that names no week
 * produces a DIFFERENT packet every Monday. The golden comparison below was
 * written in the week of 2026-09-07 and passed inside it; from 2026-09-14
 * onward it failed on this one field, forever, while every other byte of the
 * packet still matched. CI last ran here on 2026-09-08, inside that week, so
 * nothing said so for a fortnight.
 *
 * The run is deterministic in every other respect offline, which is what makes
 * the golden file worth having. Pinning the week restores that: the comparison
 * still covers the whole packet, and it no longer expires.
 */
const EXPECTED_WEEK = '2026-09-07'

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
  const r = run(['--offline', '--dry', '--subject', 'all', '--week', EXPECTED_WEEK, '--out', 'out/test.json'])
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
  // A second pinned packet, for a prospect: the diagnosis reads Mindmake's pages
  // for it, and its digest is the deterministic fallback.
  assert.deepEqual(strip(prospect), strip(readJson('expected/packet.sample-media.json') as AeoPacket))
  const aspiration = packets.find(p => p.subject.slug === 'sample-studio')!
  assert.equal(ctrl.stats.digest_writer, 'claude')
  assert.equal(prospect.stats.digest_writer, 'fallback')
  assert.equal(prospect.themes_status, 'no_attributed_calls')
  assert.equal(typeof prospect.approach_hook, 'string')
  assert.equal(aspiration.themes_status, 'not_applicable')
  assert.ok(Array.isArray(aspiration.playbook) && aspiration.playbook.length > 0)

  // The winnability gate, end to end. The venture's digest walled off a
  // category term and recommended four questions it could name a reason for.
  assert.equal(ctrl.recommendations.length, 4)
  assert.ok(ctrl.recommendations.every(r => typeof r.why_you_can_win === 'string' && r.why_you_can_win.length > 0))
  // Three walls since the limit rose to 25 (2026-11-13): the newly probed
  // executive question is owned by a business title and a consultancy.
  assert.equal(ctrl.not_worth_chasing.length, 3)
  // The prospect fell back, so it named no reason to win anything and walled
  // off only what it could see: the question the big platforms are cited on.
  assert.ok(prospect.recommendations.every(r => r.why_you_can_win === null))
  assert.equal(prospect.not_worth_chasing.length, 1)
  assert.deepEqual(prospect.not_worth_chasing[0].owned_by, ['forbes.com', 'hbr.org', 'mckinsey.com', 'youtube.com'])
  assert.ok(prospect.queries.some(q => q.query_id === prospect.not_worth_chasing[0].query_id))
  // A recommendation the model wrote no reason for is carried with null, not hidden.
  assert.ok(aspiration.recommendations.some(r => r.why_you_can_win === null))
  for (const p of packets) for (const w of p.not_worth_chasing) assert.ok(p.queries.some(q => q.query_id === w.query_id), `${p.subject.slug}: ${w.query_id}`)
  const report = JSON.parse(r.stdout)
  // Repeat samples (stage 41) are charged like any probe: the ventures' and
  // prospects' contested questions, asked twice more on each engine.
  const resampled = r.stderr.split('\n').filter(l => l.includes('"event":"resampled"')).map(l => JSON.parse(l) as { asks: number; questions: number })
  const sampleAsks = resampled.reduce((n, x) => n + x.asks, 0)
  assert.ok(sampleAsks > 0, 'the venture\'s contested questions were re-asked')
  assert.ok(resampled.every(x => x.questions <= 8), 'at most eight questions a subject')
  assert.equal(report.ledger.calls, ctrl.stats.probes + prospect.stats.probes + aspiration.stats.probes + ctrl.stats.probes_failed + 2 + 1 + 3 + 3 + sampleAsks)
})

test('the usd cap stops probing and counts every unprobed pair', () => {
  const out = join(ROOT, 'out', 'test-cap.json')
  const r = run(['--offline', '--dry', '--subject', 'ctrl', '--out', 'out/test-cap.json', '--cap-usd', '0.5'])
  assert.equal(r.status, 0, r.stderr)
  const p = JSON.parse(readFileSync(out, 'utf8')) as AeoPacket
  assert.equal(validatePacket(p).ok, true)
  assert.ok(p.stats.probes_skipped_cap > 0)
  // Every probed question times every engine: 24 questions (all of ctrl's, within the limit of 25) on 3 assistants.
  assert.ok(p.stats.probes + p.stats.probes_failed + p.stats.probes_skipped_cap === 72)
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

test('site job: our hosts are read once for the run, sealed to it, and a subject job given the file makes the same packet with no request of its own', () => {
  const env = { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_ENGINE_SECRET: 'synthetic-secret-for-the-seal', GITHUB_RUN_ID: '4242' }
  const audit = join(ROOT, 'out', 'site-test.json')
  rmSync(audit, { force: true })
  const site = spawnSync(TSX, ['src/site.ts', '--offline', '--subjects', '["ctrl","sample-media","sample-studio"]', '--out', 'out/site-test.json'], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(site.status, 0, site.stderr)
  assert.match(site.stderr, /"event":"site_run_audit","hosts":4,/)
  assert.ok(!/https?:\/\//.test(site.stderr), 'counts only in the log')
  const sealed = readFileSync(audit, 'utf8')
  assert.ok(!sealed.includes('mindmake.co'), 'sealed')
  assert.equal(readSharedAudit(audit, { ...env, GITHUB_RUN_ID: '9999' }).size, 0, 'another run cannot open it')

  const out = join(ROOT, 'out', 'test-shared.json')
  rmSync(out, { force: true })
  const r = spawnSync(TSX, ['src/index.ts', '--offline', '--dry', '--subject', 'ctrl', '--week', EXPECTED_WEEK, '--out', 'out/test-shared.json', '--site-in', 'out/site-test.json'], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /"event":"shared_site_audit","state":"read","hosts":4/)
  assert.match(r.stderr, /"event":"site_audit","subject":"ctrl","hosts":2,"pages":\d+,"requests":0,"errors":0,"shared":true/)
  const ctrl = JSON.parse(readFileSync(out, 'utf8')) as AeoPacket
  assert.deepEqual(strip(ctrl), strip(readJson('expected/packet.ctrl.json') as AeoPacket))

  // No file (the site job failed): no audit, and no page of ours is read in its place.
  const none = spawnSync(TSX, ['src/index.ts', '--offline', '--dry', '--subject', 'ctrl', '--week', EXPECTED_WEEK, '--out', 'out/test-shared.json', '--site-in', 'out/no-such-audit.json'], { cwd: ROOT, encoding: 'utf8', env })
  assert.equal(none.status, 0, none.stderr)
  assert.match(none.stderr, /"event":"shared_site_audit","state":"missing"/)
  assert.match(none.stderr, /"event":"site_audit","subject":"ctrl","hosts":0,"pages":0,"requests":0/)
})
