/**
 * Config guard, run in CI: the engine list is a known subset, every cap is
 * positive, config/own-domains.json has its shape, and no em dash has crept
 * into src/, docs/ or config/ (prompts included, because a prompt that
 * carries one teaches the model to write one).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CAPS, ENGINES, PRICE_USD_PER_CALL, resolveEngines, SUBSCRIPTION_KINDS, type CostKind } from '../src/config/run.js'
import { parseOwnDomains } from '../src/config/ownDomains.js'
import { CHILD_ENV_KEYS, childEnv } from '../src/clients/claudeCode.js'
import { ENGINES_ALL, GATED_ENGINES } from '../src/schema/packet.js'

const failures: string[] = []

const knownEngines = [...ENGINES_ALL, ...GATED_ENGINES] as readonly string[]
for (const e of [...ENGINES, ...resolveEngines({ XAI_API_KEY: 'x', GEMINI_API_KEY: 'x' })]) if (!knownEngines.includes(e)) failures.push(`ENGINES carries unknown engine "${e}"`)
if (!ENGINES.length) failures.push('ENGINES is empty')
for (const [k, v] of Object.entries(CAPS)) if (!(typeof v === 'number' && v > 0)) failures.push(`CAPS.${k} must be a positive number, got ${String(v)}`)
// A subscription kind is counted and never charged, so its price is exactly
// 0; every other kind is a dollar estimate the cap counts against.
for (const [k, v] of Object.entries(PRICE_USD_PER_CALL)) {
  if (SUBSCRIPTION_KINDS.includes(k as CostKind)) { if (v !== 0) failures.push(`PRICE_USD_PER_CALL.${k} is billed to a subscription and must be 0`) }
  else if (!(typeof v === 'number' && v > 0)) failures.push(`PRICE_USD_PER_CALL.${k} must be a positive number`)
}
if (CAPS.MAX_PROBED_QUERIES_HARD < CAPS.MAX_PROBED_QUERIES_PER_SUBJECT) failures.push('CAPS.MAX_PROBED_QUERIES_HARD must be at least CAPS.MAX_PROBED_QUERIES_PER_SUBJECT')
if (CAPS.MAX_PROPOSED_QUERIES < CAPS.MAX_PROBED_QUERIES_HARD) failures.push('CAPS.MAX_PROPOSED_QUERIES must hold the hard probe ceiling, requests included')
if (!Number.isInteger(CAPS.CLAUDE_API_SEARCH_MAX_USES)) failures.push('CAPS.CLAUDE_API_SEARCH_MAX_USES must be a whole number of searches')
// Gemini inside its free tier, as the code and the workflow enforce it: the
// per-job share, plus the one answer that can run past it (GeminiClient stops
// when the queries used plus the most one answer has used would pass the cap,
// so only an answer larger than every earlier one overruns, by the
// difference; ten is a stated allowance, not a count the code enforces),
// times the attempts of a job that ask Gemini (a retry is a fresh process,
// and resolveEngines leaves Gemini out of it), ten subjects and three runs a
// month.
const GEMINI_FREE_GROUNDING_PER_MONTH = 5000
const GEMINI_ONE_ANSWER_OVERRUN = 10
const geminiAttempts = [1, 2].filter(n => resolveEngines({ GEMINI_API_KEY: 'x', AEO_ATTEMPT: String(n) }).includes('gemini')).length
if (geminiAttempts !== 1) failures.push(`Gemini is asked on ${geminiAttempts} attempts of a research job; only the first may ask it, or a retry starts a second free-tier share`)
const geminiMonth = (CAPS.GEMINI_MAX_QUERIES_PER_JOB + GEMINI_ONE_ANSWER_OVERRUN) * Math.max(1, geminiAttempts) * 10 * 3
if (geminiMonth > GEMINI_FREE_GROUNDING_PER_MONTH) failures.push(`(CAPS.GEMINI_MAX_QUERIES_PER_JOB + ${GEMINI_ONE_ANSWER_OVERRUN} overrun) x ${geminiAttempts} attempt x 10 subjects x 3 runs is ${geminiMonth}, over the ${GEMINI_FREE_GROUNDING_PER_MONTH} free grounding queries a month`)

// The Claude Code lane's child environment is an allowlist: it never carries
// an API key, so the child cannot bill the API.
try {
  if (typeof childEnv !== 'function') failures.push('src/clients/claudeCode.ts must export childEnv')
  const probe = childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'x', OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', HOME: '/root' }, '/tmp/h')
  for (const k of Object.keys(probe)) if (!(CHILD_ENV_KEYS as readonly string[]).includes(k)) failures.push(`childEnv passes ${k}; only ${CHILD_ENV_KEYS.join(', ')} may reach the probe`)
  if (probe.HOME !== '/tmp/h') failures.push('childEnv must give the probe its own temporary HOME')
} catch (e) {
  failures.push(`childEnv could not be checked: ${(e as Error).message}`)
}

// Krish's ruled domain corrections (src/config/ownDomains.ts): the shape, closed.
const ownDomainsFile = 'config/own-domains.json'
try {
  const parsed = parseOwnDomains(JSON.parse(readFileSync(ownDomainsFile, 'utf8')))
  if (!parsed.ok) for (const e of parsed.errors) failures.push(`${ownDomainsFile}: ${e}`)
} catch (e) {
  failures.push(`${ownDomainsFile} could not be read as JSON: ${(e as Error).message}`)
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}
for (const root of ['src', 'docs', 'config']) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => { if (line.includes('\u2014')) failures.push(`${file}:${i + 1}: em dash`) })
  }
}

// Nowhere in the code or the workflows: a flag that skips the CLI's
// permissions, or its minimal mode. The probe keeps the CLI's own checks.
const noFlags = ['--' + 'bare', 'dangerously' + '-skip-permissions']
// Search data reaches this engine only through Control Center: no workflow or
// source file names a search or analytics credential of its own.
const noSearchKeys = ['BING_ANALYTICS_API_KEY', 'GA4_', 'GSC_', 'SEARCH_CONSOLE']
for (const root of ['src', '.github/workflows']) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    for (const f of noFlags) if (text.includes(f)) failures.push(`${file} names ${f}; the probe never skips the CLI's checks`)
    for (const k of noSearchKeys) if (text.includes(k)) failures.push(`${file} names ${k}; search data comes only through Control Center`)
  }
}

// The cost wall on the daily directive: its workflow holds no paid key and
// never calls the research CLI, so a directive cannot start a paid run.
const directiveWorkflow = '.github/workflows/cc-growth-directive.yml'
try {
  const wf = readFileSync(directiveWorkflow, 'utf8')
  for (const paid of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FIREFLIES_API_KEY', 'EXA_API_KEY', 'AEO_ENGINE_SECRET']) {
    if (wf.includes(paid)) failures.push(`${directiveWorkflow} names ${paid}; the directive path must hold no paid key`)
  }
  if (/npm run (--silent )?run\b|src\/index\.ts/.test(wf)) failures.push(`${directiveWorkflow} calls the research CLI; a directive never starts paid research`)
  if (!/types:\s*\[cc-growth-directive\]/.test(wf)) failures.push(`${directiveWorkflow} does not listen for cc-growth-directive`)
  if (!/permissions:\s*\n\s*contents:\s*read/.test(wf)) failures.push(`${directiveWorkflow} must be contents: read`)
} catch {
  failures.push(`${directiveWorkflow} is missing`)
}

// The research workflow never uploads a packet: packets carry call themes and
// prospect approach hooks, and this repository's artifacts are public. The
// only artifact it keeps is the sealed counts-only summary.
const researchWorkflow = '.github/workflows/aeo-weekly.yml'
try {
  const wf = readFileSync(researchWorkflow, 'utf8')
  const uploads = wf.split(/\n(?=\s*- (?:name|uses):)/).filter(step => step.includes('actions/upload-artifact'))
  for (const step of uploads) {
    if (!/path:\s*summary\/\s*$/m.test(step)) failures.push(`${researchWorkflow} uploads something other than the sealed summary; packets never leave the runner`)
  }
  // The Claude Code CLI is pinned to the version its stream was recorded from.
  const installs = [...wf.matchAll(/npm i(?:nstall)? -g (@anthropic-ai\/claude-code\S*)/g)].map(m => m[1])
  if (!installs.length) failures.push(`${researchWorkflow} does not install the Claude Code CLI`)
  for (const pkg of installs) if (!/^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/.test(pkg)) failures.push(`${researchWorkflow} installs ${pkg}; pin an exact version`)
  // The pinned CLI declares engines node >=22.0.0 (npm view
  // @anthropic-ai/claude-code@2.1.323 engines); npm only warns below it, so
  // this holds the research job to it. Raise it with the pin when a new CLI
  // asks for more.
  const CLAUDE_CODE_MIN_NODE = 22
  const researchJob = wf.match(/\n {2}research:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/)?.[1] ?? ''
  const nodes = [...researchJob.matchAll(/node-version:\s*['"]?(\d+)/g)].map(m => Number(m[1]))
  if (!nodes.length) failures.push(`${researchWorkflow}: the research job sets up no Node version`)
  for (const v of nodes) if (v < CLAUDE_CODE_MIN_NODE) failures.push(`${researchWorkflow}: the research job runs Node ${v}; the pinned Claude Code CLI needs Node ${CLAUDE_CODE_MIN_NODE} or later`)
  // Each attempt tells the run which it is, so a retry asks no Gemini.
  if (!/AEO_ATTEMPT="?\$attempt"?/.test(researchJob)) failures.push(`${researchWorkflow}: the research job's attempts do not set AEO_ATTEMPT, so a retry would start a second Gemini free-tier share`)
} catch {
  failures.push(`${researchWorkflow} is missing`)
}

if (failures.length) {
  console.error('check:config failed:')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log(`check:config passed: engines ${ENGINES.join(', ')}; caps positive; subscription kinds at 0; Gemini inside its free tier on one attempt a job; childEnv an allowlist; ${ownDomainsFile} valid; no em dash in src/, docs/ or config/; no permission-skipping flag and no search key in src/ or the workflows; the directive workflow holds no paid key or token; the research workflow uploads no packet, pins the CLI and runs it on the Node it needs.`)
