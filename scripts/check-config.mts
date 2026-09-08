/**
 * Config guard, run in CI: the engine list is a known subset, every cap is
 * positive, and no em dash has crept into src/ or docs/ (prompts included,
 * because a prompt that carries one teaches the model to write one).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CAPS, ENGINES, PRICE_USD_PER_CALL } from '../src/config/run.js'
import { ENGINES_ALL } from '../src/schema/packet.js'

const failures: string[] = []

for (const e of ENGINES) if (!(ENGINES_ALL as readonly string[]).includes(e)) failures.push(`ENGINES carries unknown engine "${e}"`)
if (!ENGINES.length) failures.push('ENGINES is empty')
for (const [k, v] of Object.entries(CAPS)) if (!(typeof v === 'number' && v > 0)) failures.push(`CAPS.${k} must be a positive number, got ${String(v)}`)
for (const [k, v] of Object.entries(PRICE_USD_PER_CALL)) if (!(typeof v === 'number' && v > 0)) failures.push(`PRICE_USD_PER_CALL.${k} must be a positive number`)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
for (const root of ['src', 'docs']) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => { if (line.includes('\u2014')) failures.push(`${file}:${i + 1}: em dash`) })
  }
}

if (failures.length) {
  console.error('check:config failed:')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log(`check:config passed: engines ${ENGINES.join(', ')}; caps positive; no em dash in src/ or docs/.`)
