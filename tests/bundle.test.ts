import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bundleDigest, bundleDir, bundleProblems, protocolCopyState, readBundle, servedBundle } from '../src/protocol/bundle.js'
import { protocolCopyOf, type Client } from '../src/protocol/loop.js'
import { buildDirectiveReport } from '../src/protocol/reports.js'
import { ProtocolError } from '../src/clients/growthEngine.js'

// Protocol 1.28.0, "Keep one copy of this protocol": docs/control-center/ is
// Control Center's protocol-bundle copied verbatim.

test('the copy is whole: each file matches its sha256 and bundle_sha256 matches the files', () => {
  assert.deepEqual(bundleProblems(), [])
  const b = readBundle()!
  assert.deepEqual(Object.keys(b.files).sort(), ['ENGINE-PROTOCOL.md', 'engine-directive.schema.json', 'engine-report.example.json', 'engine-report.schema.json'])
  for (const [name, want] of Object.entries(b.files)) {
    assert.equal(createHash('sha256').update(readFileSync(join(bundleDir(), name))).digest('hex'), want, name)
  }
  const line = `version ${b.version}\n${Object.keys(b.files).sort().map(n => `${n} ${b.files[n]}\n`).join('')}`
  assert.equal(createHash('sha256').update(line).digest('hex'), b.bundle_sha256)
  assert.equal(bundleDigest(b.version, b.files), b.bundle_sha256)
})

test('the copy holds no email address (this repository is public)', () => {
  const b = readBundle()!
  for (const name of Object.keys(b.files)) assert.doesNotMatch(readFileSync(join(bundleDir(), name), 'utf8'), /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, name)
})

test('a changed byte is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aeo-bundle-')) + '/'
  cpSync(bundleDir(), dir, { recursive: true })
  writeFileSync(`${dir}ENGINE-PROTOCOL.md`, readFileSync(`${dir}ENGINE-PROTOCOL.md`, 'utf8') + ' ')
  assert.deepEqual(bundleProblems(dir), ['ENGINE-PROTOCOL.md does not match its sha256'])
})

test('protocol_copy: current, behind <version>, or unknown', () => {
  const local = readBundle()!
  assert.equal(protocolCopyState(local, { version: local.version, bundle_sha256: local.bundle_sha256 }), 'current')
  assert.equal(protocolCopyState(local, { version: '1.99.0', bundle_sha256: 'a'.repeat(64) }), 'behind 1.99.0')
  assert.equal(protocolCopyState(local, null), 'unknown')
  assert.equal(protocolCopyState(null, { version: local.version, bundle_sha256: local.bundle_sha256 }), 'unknown')
  assert.equal(servedBundle({ protocol_bundle: { version: '1.28.0', bundle_sha256: 'not hex' } }), null)
  assert.equal(servedBundle({}), null)
})

test('each run reads capabilities, never holds, and the report carries one counted line', async () => {
  const local = readBundle()!
  const base = {} as unknown as Client
  const current = { ...base, getCapabilities: async () => ({ schema_version: '1.28.0', protocol_bundle: { version: local.version, bundle_sha256: local.bundle_sha256 } }) } as Client
  const ahead = { ...base, getCapabilities: async () => ({ protocol_bundle: { version: '1.30.0', bundle_sha256: 'b'.repeat(64) } }) } as Client
  const down = { ...base, getCapabilities: async () => { throw new ProtocolError('capabilities_timeout', 0) } } as Client
  assert.equal(await protocolCopyOf(current), 'current')
  assert.equal(await protocolCopyOf(ahead), 'behind 1.30.0')
  assert.equal(await protocolCopyOf(down), 'unknown')
  assert.equal(await protocolCopyOf(base), 'unknown', 'a client with no capabilities read')

  const at = new Date('2026-12-08T05:12:00Z')
  const report = buildDirectiveReport({ runId: 'aeo:2026-12-08:directive', mode: 'synthetic', observedAt: at, revision: 'abc', capturedAt: at, protocolCopy: 'behind 1.30.0', directive: { directive_id: 'aeo:2026-12-08', chosen_by: 'rule', decisions_since: [] }, directiveError: null, last: null, lastError: null, decisions: [] })
  assert.equal(report.activity.filter(a => a.line.startsWith('protocol_copy: ')).length, 1)
  assert.ok(report.activity.some(a => a.line === 'protocol_copy: behind 1.30.0'))
  assert.ok(report.activity.length <= 40)
  assert.equal(report.holds.length, 0, 'a copy behind is never a hold')
})
