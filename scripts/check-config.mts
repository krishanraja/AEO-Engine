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
import { parseSubjectsConfig } from '../src/config/subjects.js'
import { SITE_FETCH, SITE_USER_AGENT } from '../src/clients/site.js'
import { CHILD_ENV_KEYS, childEnv } from '../src/clients/claudeCode.js'
import { ENGINES_ALL, GATED_ENGINES } from '../src/schema/packet.js'
import { VERIFY_HARD_MAX_USD } from '../src/schema/verify.js'

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
// The verify lane (src/protocol/verify.ts): a small off-week spend, never above 5 dollars a run.
if (!(CAPS.VERIFY_MAX_USD > 0 && CAPS.VERIFY_MAX_USD <= 5)) failures.push(`CAPS.VERIFY_MAX_USD must be positive and at most 5, got ${String(CAPS.VERIFY_MAX_USD)}`)
if (VERIFY_HARD_MAX_USD > 5 || CAPS.VERIFY_MAX_USD > VERIFY_HARD_MAX_USD) failures.push('the verify lane\'s hard ceiling (src/schema/verify.ts) must be at most 5 and at least CAPS.VERIFY_MAX_USD')
if (!Number.isInteger(CAPS.VERIFY_MAX_QUESTIONS) || CAPS.VERIFY_MAX_QUESTIONS > 10) failures.push('CAPS.VERIFY_MAX_QUESTIONS must be a whole number, at most 10')
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

// Per venture settings (src/config/subjects.ts): held products and owner repositories, product slugs only.
const subjectsFile = 'config/subjects.json'
try {
  const parsed = parseSubjectsConfig(JSON.parse(readFileSync(subjectsFile, 'utf8')))
  if (!parsed.ok) for (const e of parsed.errors) failures.push(`${subjectsFile}: ${e}`)
} catch (e) {
  failures.push(`${subjectsFile} could not be read as JSON: ${(e as Error).message}`)
}

// The site reader fetches and never runs a page (src/clients/site.ts): no
// browser automation package anywhere in package.json, redirects by hand, a
// positive budget, and an honest User-Agent that names no crawler or browser.
const BROWSER_PACKAGES = ['playwright', 'playwright-core', '@playwright/test', 'puppeteer', 'puppeteer-core', 'jsdom', 'happy-dom', 'linkedom', 'selenium-webdriver', 'webdriverio', 'chrome-remote-interface', '@sparticuz/chromium', 'chromium', 'nightmare', 'zombie', 'phantomjs', 'phantomjs-prebuilt', 'cypress']
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    const deps = pkg[field]
    const names = Array.isArray(deps) ? deps.map(String) : deps && typeof deps === 'object' ? Object.keys(deps) : []
    for (const n of names) if (BROWSER_PACKAGES.includes(n) || /playwright|puppeteer|selenium|headless|chromium/i.test(n)) failures.push(`package.json ${field} names ${n}; the site reader fetches only and never runs a page`)
  }
} catch (e) {
  failures.push(`package.json could not be read: ${(e as Error).message}`)
}
if (SITE_FETCH.redirect !== 'manual') failures.push('src/clients/site.ts must declare redirect: manual')
if (SITE_FETCH.method !== 'GET') failures.push('src/clients/site.ts must fetch with GET only')
for (const k of ['maxPerHost', 'maxHops', 'timeoutMs', 'maxBytes', 'minGapMs'] as const) if (!(typeof SITE_FETCH[k] === 'number' && SITE_FETCH[k] > 0)) failures.push(`SITE_FETCH.${k} must be a positive number`)
if (SITE_FETCH.maxPerHost > 40) failures.push('SITE_FETCH.maxPerHost may not exceed 40 requests a host')
if (SITE_FETCH.minGapMs < 1000) failures.push('SITE_FETCH.minGapMs must keep requests to one host at least a second apart')
if (SITE_FETCH.maxHops > 3) failures.push('SITE_FETCH.maxHops may not exceed 3')
if (CAPS.THIRD_PARTY_MAX_PAGES_PER_SUBJECT > 15 || CAPS.THIRD_PARTY_MAX_PAGES_PER_HOST > 3) failures.push('third-party pages: at most 15 a subject and 3 a host')
if (!/^AEO-Engine\/\d+\.\d+ \(\+https:\/\/github\.com\/krishanraja\/AEO-Engine; fetch-only audit\)$/.test(SITE_USER_AGENT) || /bot|mozilla|chrome|safari|gecko/i.test(SITE_USER_AGENT)) failures.push('SITE_USER_AGENT must name this engine honestly, never a crawler or a browser')
const httpSrc = readFileSync('src/clients/http.ts', 'utf8')
const requestTextSrc = httpSrc.slice(httpSrc.indexOf('export async function requestText'), httpSrc.indexOf('/** Throws HttpError unless'))
if (!/redirect: 'manual'/.test(requestTextSrc)) failures.push('src/clients/http.ts requestText must fetch with redirect: manual')
const siteSrc = readFileSync('src/clients/site.ts', 'utf8')
if (!/redirect: 'manual'/.test(siteSrc)) failures.push("src/clients/site.ts must declare redirect: 'manual'")

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
// Clarity too (Krish, 2026-11-13): its export token and its host stay in Control Center.
const noSearchKeys = ['BING_ANALYTICS_API_KEY', 'GA4_', 'GSC_', 'SEARCH_CONSOLE', 'CLARITY_', 'clarity.ms']
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

// The free rehearsal holds no paid key and never starts the research CLI:
// it reads the context and validates fixture packets, nothing more.
const rehearsalWorkflow = '.github/workflows/aeo-rehearsal.yml'
try {
  const wf = readFileSync(rehearsalWorkflow, 'utf8')
  for (const paid of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'XAI_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'EXA_API_KEY', 'CONTROL_CENTER_ENGINE_TOKEN']) {
    if (wf.includes(paid)) failures.push(`${rehearsalWorkflow} names ${paid}; the free rehearsal holds no paid key`)
  }
  if (/npm run (--silent )?run\b|src\/index\.ts/.test(wf)) failures.push(`${rehearsalWorkflow} calls the research CLI; the free rehearsal never probes`)
} catch {
  failures.push(`${rehearsalWorkflow} is missing`)
}

// The research workflow never uploads a packet: packets carry call themes and
// prospect approach hooks, and this repository's artifacts are public. The
// only artifact it keeps is the sealed counts-only summary.
const researchWorkflow = '.github/workflows/aeo-weekly.yml'
try {
  const wf = readFileSync(researchWorkflow, 'utf8')
  const uploads = wf.split(/\n(?=\s*- (?:name|uses):)/).filter(step => step.includes('actions/upload-artifact'))
  for (const step of uploads) {
    if (!/path:\s*(summary|site)\/\s*$/m.test(step)) failures.push(`${researchWorkflow} uploads something other than the sealed summary or the sealed site audit; packets never leave the runner`)
  }
  // Our own hosts are read once a run, in the site job: the subject jobs read
  // its sealed file and must never audit our hosts themselves (src/site.ts).
  const siteJob = wf.match(/\n {2}site:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/)?.[1] ?? ''
  if (!/npm run --silent site -- /.test(siteJob)) failures.push(`${researchWorkflow}: no site job audits our hosts once for the run`)
  const researchSteps = wf.match(/\n {2}research:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/)?.[1] ?? ''
  if (!/--site-in site\/audit\.json/.test(researchSteps)) failures.push(`${researchWorkflow}: the research job does not read the run's site audit (--site-in), so each subject job would audit our hosts itself`)
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
  // The verify path (src/protocol/verify.ts) names no secret the research
  // job does not already hold: the plan job's verify steps and the report job.
  const secretsIn = (text: string) => new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))
  const planJob = wf.match(/\n {2}plan:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/)?.[1] ?? ''
  const reportJob = wf.match(/\n {2}report:\n([\s\S]*?)(?=\n {2}[a-z][a-z0-9_-]*:\n|$)/)?.[1] ?? ''
  const verifySteps = planJob.split(/\n(?=\s*- (?:name|uses|if|run):)/).filter(step => /verify/i.test(step))
  if (!verifySteps.some(step => /npm run --silent verify -- decide/.test(step))) failures.push(`${researchWorkflow}: the plan job does not read Krish's decision on the verify run (npm run verify -- decide)`)
  const held = secretsIn(researchJob)
  for (const name of new Set([...verifySteps.flatMap(step => [...secretsIn(step)]), ...secretsIn(reportJob)])) {
    if (!held.has(name)) failures.push(`${researchWorkflow}: the verify path names ${name}, which the research job does not hold`)
  }
  if (!/--mode verify --verify-payload out\/verify-payload\.json/.test(researchJob)) failures.push(`${researchWorkflow}: the research job does not run a verify with the plan job's payload`)
  if (!/attempts="1"/.test(researchJob)) failures.push(`${researchWorkflow}: a verify run must make one attempt; a verify spend is never retried blindly`)
} catch {
  failures.push(`${researchWorkflow} is missing`)
}

if (failures.length) {
  console.error('check:config failed:')
  for (const f of failures) console.error(`- ${f}`)
  process.exit(1)
}
console.log(`check:config passed: engines ${ENGINES.join(', ')}; caps positive; subscription kinds at 0; Gemini inside its free tier on one attempt a job; childEnv an allowlist; ${ownDomainsFile} and ${subjectsFile} valid; the site reader fetches only (no browser package, redirect manual, a budget, an honest User-Agent); no em dash in src/, docs/ or config/; no permission-skipping flag and no search key in src/ or the workflows; the directive workflow holds no paid key or token; the research workflow uploads no packet, reads our hosts once in its site job, pins the CLI and runs it on the Node it needs; the verify lane is capped at ${CAPS.VERIFY_MAX_USD} dollars (at most 5), runs once and names no secret the research job does not hold.`)
