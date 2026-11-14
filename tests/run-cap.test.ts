/**
 * The research run's hard spend ceiling (Ruling, Krish, 2026-11-14: a per-run
 * cap of $25 to $30 for the 22 November run). Nothing a variable, a dispatch
 * or a flag says can lift one run above HARD_MAX_USD_PER_RUN, a ledger never
 * holds a cap above it, and a run stops charging when the next call would
 * cross its cap.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_MAX_USD_PER_RUN, HARD_MAX_USD_PER_RUN, perSubjectCapUsd, runCapUsd } from '../src/config/run.js'
import { parseArgs } from '../src/index.js'
import { CapReached, Ledger } from '../src/lib/cost.js'

const ROOT = join(import.meta.dirname, '..')
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx')

// Ruling (Krish, 2026-11-14): the per-run cap for 22 November is 30, the top
// of his 25 to 30, built in so it holds whether or not the variable is set.
test('the hard ceiling is 30 and so is the default, so the cap holds with the variable unset', () => {
  assert.equal(HARD_MAX_USD_PER_RUN, 30)
  assert.equal(DEFAULT_MAX_USD_PER_RUN, 30)
})

test('AEO_MAX_USD_PER_RUN is read, and clamped to the hard ceiling', () => {
  assert.equal(runCapUsd(undefined), 30)
  assert.equal(runCapUsd(''), 30)
  assert.equal(runCapUsd('0'), 30)
  assert.equal(runCapUsd('-4'), 30)
  assert.equal(runCapUsd('nonsense'), 30)
  assert.equal(runCapUsd('12.5'), 12.5)
  assert.equal(runCapUsd('30'), 30)
  assert.equal(runCapUsd('31'), 30)
  assert.equal(runCapUsd('1000'), 30)
})

test('--cap-usd can lower a run\'s cap and never raise it past the hard ceiling', () => {
  assert.equal(parseArgs(['--cap-usd', '3']).capUsd, 3)
  assert.equal(parseArgs(['--cap-usd', '30']).capUsd, 30)
  assert.equal(parseArgs(['--cap-usd', '45']).capUsd, 30)
})

test('a ledger never holds a cap above the hard ceiling', () => {
  assert.equal(new Ledger(100).capUsd, 30)
  assert.equal(new Ledger(4.29).capUsd, 4.29)
})

test('each subject\'s share is floored to the cent, so the shares never add up past the run\'s cap', () => {
  for (const [total, n] of [[30, 7], [25, 3], [30, 11], [3, 1], [25, 9], [29.99, 13]] as const) {
    const share = perSubjectCapUsd(total, n)
    assert.ok(share > 0)
    assert.ok(share * n <= Math.min(total, HARD_MAX_USD_PER_RUN) + 1e-9, `${total} over ${n}: ${share} each`)
  }
  assert.equal(perSubjectCapUsd(30, 7), 4.28)
  assert.equal(perSubjectCapUsd(100, 1), 30)
})

test('a run at the hard ceiling charges up to it and stops before the call that would cross it', () => {
  const prices = { perplexity: 0.5, chatgpt: 0.5, claude: 0.5, grok: 0.5, gemini: 0.5, claude_code: 0, classify: 0, themes: 0, propose: 0, digest: 0, voice: 0 }
  const l = new Ledger(1000, prices)
  let calls = 0
  let stopped: unknown = null
  try {
    for (;;) { l.charge('perplexity'); calls++ }
  } catch (e) { stopped = e }
  assert.ok(stopped instanceof CapReached)
  assert.equal(calls, 60)
  assert.equal(l.total, 30)
  assert.equal(l.canAfford('chatgpt'), false)
})

test('the offline run reports the clamped cap when the variable asks for more', () => {
  const r = spawnSync(TSX, ['src/index.ts', '--offline', '--dry', '--subject', 'ctrl', '--out', 'out/test-hardcap.json'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '500' },
  })
  assert.equal(r.status, 0, r.stderr)
  const start = r.stderr.split('\n').find(l => l.includes('"event":"run_start"'))
  assert.ok(start)
  assert.equal(JSON.parse(start).cap_usd, 30)
  const report = JSON.parse(r.stdout) as { ledger: { cap_usd: number; total_usd: number } }
  assert.equal(report.ledger.cap_usd, 30)
  assert.ok(report.ledger.total_usd <= 30)
})

test('the research workflow clamps the run\'s total to the hard ceiling and floors each share', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'aeo-weekly.yml'), 'utf8')
  assert.match(wf, /HARD_MAX_USD_PER_RUN=30\b/)
  assert.match(wf, /Math\.min\(Number\(process\.argv\[1\]\),\s*Number\(process\.argv\[2\]\)\)/)
  assert.match(wf, /Math\.floor\(Number\(process\.argv\[1\]\)\s*\/\s*Number\(process\.argv\[2\]\)\s*\*\s*100\)\s*\/\s*100/)
})

// The paid rehearsal of 14 November (AEO weekly run 43622644403, one subject)
// proved two holes: the subject step's retry ran a second process with a
// fresh ledger at the full share, and Control Center's meter priced the
// probes above their estimates. Its figures stay in Control Center
// (docs/NEVER-PUBLISH.md: spend is Krish's to disclose); the estimates were
// raised above what the meter read.

test('the price table holds the estimates raised after the paid rehearsal', async () => {
  const { PRICE_USD_PER_CALL } = await import('../src/config/run.js')
  assert.equal(PRICE_USD_PER_CALL.chatgpt, 0.10)
  assert.equal(PRICE_USD_PER_CALL.claude, 0.15)
  assert.equal(PRICE_USD_PER_CALL.gemini, 0.015)
  assert.equal(PRICE_USD_PER_CALL.digest, 0.14)
  assert.equal(PRICE_USD_PER_CALL.perplexity, 0.01)
})

test('the research workflow falls back to 30, never to 25', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'aeo-weekly.yml'), 'utf8')
  assert.doesNotMatch(wf, /AEO_MAX_USD_PER_RUN:-25|\|\| '25'|total=25\b/)
  assert.match(wf, /total="\$\{AEO_MAX_USD_PER_RUN:-30\}"/)
  assert.match(wf, /vars\.AEO_MAX_USD_PER_RUN \|\| '30'/)
})

test('a run writes what its ledger charged to AEO_SPENT_FILE, on success and on failure', async () => {
  const { mkdtempSync, readFileSync: read } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'aeo-spent-'))
  const ok = spawnSync(TSX, ['src/index.ts', '--offline', '--dry', '--subject', 'ctrl', '--out', 'out/test-spent.json', '--cap-usd', '0.5'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_SPENT_FILE: join(dir, 'ok') },
  })
  assert.equal(ok.status, 0, ok.stderr)
  const report = JSON.parse(ok.stdout) as { ledger: { total_usd: number } }
  assert.equal(Number(read(join(dir, 'ok'), 'utf8')), report.ledger.total_usd)
  assert.ok(report.ledger.total_usd > 0)
  const bad = spawnSync(TSX, ['src/index.ts', '--offline', '--dry', '--subject', 'nope', '--out', 'out/test-spent-bad.json'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, XAI_API_KEY: '', AEO_MAX_USD_PER_RUN: '', AEO_SPENT_FILE: join(dir, 'bad') },
  })
  assert.notEqual(bad.status, 0)
  assert.ok(Number(read(join(dir, 'bad'), 'utf8')) >= 0)
})

test('the subject step\'s retry gets only what the first attempt left of the share, and none below 0.50', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'aeo-weekly.yml'), 'utf8')
  assert.match(wf, /AEO_SPENT_FILE="\$spent_file"/)
  assert.match(wf, /left=\$\(node -e/)
  assert.match(wf, /--cap-usd "\$left"/)
  assert.match(wf, /no budget left for a retry/)
})
