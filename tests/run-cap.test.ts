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

test('the hard ceiling is 30 and the default is 25, inside Krish\'s 25 to 30', () => {
  assert.equal(HARD_MAX_USD_PER_RUN, 30)
  assert.equal(DEFAULT_MAX_USD_PER_RUN, 25)
})

test('AEO_MAX_USD_PER_RUN is read, and clamped to the hard ceiling', () => {
  assert.equal(runCapUsd(undefined), 25)
  assert.equal(runCapUsd(''), 25)
  assert.equal(runCapUsd('0'), 25)
  assert.equal(runCapUsd('-4'), 25)
  assert.equal(runCapUsd('nonsense'), 25)
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
