#!/usr/bin/env node
/**
 * Session closeout: every session that changes a repository leaves its
 * status, next step and North Star check current in NOW.md, without Krish
 * asking (Ruling, Krish, 2026-10-22).
 *
 * One file, two callers, the same bytes in both places:
 *
 *   - Claude Code's Stop hook. The repository administration publisher
 *     delivers this file as `.claude/hooks/harness-closeout.mjs` and registers
 *     it in `.claude/settings.json`. When a turn ends with committed product
 *     work and NOW.md untouched, the hook blocks once with the closeout steps.
 *     A second stop in the same turn (stop_hook_active) always passes, so the
 *     hook can never trap a session.
 *   - The `closeout` job in `.github/workflows/harness-repository-context.yml`
 *     on every pull request: `--ci --base <sha> --head <sha>`. This is what
 *     holds Codex and any other client to the same rule.
 *
 * The rule. A range of commits that changes anything but NOW.md, the history
 * archive or a harness-generated file must
 * also change NOW.md, bump its `as_of`, and carry one line under
 * "What is next and what is waiting on Krish":
 *
 *   - North Star check (YYYY-MM-DD): holds.
 *   - North Star check (YYYY-MM-DD): recalibration proposed. <why>
 *
 * dated no earlier than the work began. docs/NORTH_STAR.md changes only with
 * a `Ruling (Krish, YYYY-MM-DD)` line in a commit body or the pull request.
 * Commits written by the harness's own automation (docs(steward), docs(harness),
 * docs(canon)) are exempt, as is a range carrying
 * `Closeout: not needed, <reason>`.
 *
 * Dependency-free on purpose: it runs inside any repository, in any session.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NOW = 'NOW.md'
export const NORTH_STAR = 'docs/NORTH_STAR.md'
export const WAITING = 'What is next and what is waiting on Krish'
export const AUTOMATION = /^(docs\((steward|harness|canon)\)|chore\((heartbeat|brain)\)):/
// What each automation may touch. A commit that claims an automation subject
// but touches anything else is a session's own work, so the subject cannot be
// used to skip the rule.
const AUTOMATION_SCOPE = {
  steward: (p) => /\.md$/i.test(p) && p !== NORTH_STAR,
  harness: (p) => ['AGENTS.md', 'CLAUDE.md', 'docs/HARNESS_CONTEXT.md', SETTINGS, ...PUBLISHER_FILES].includes(p),
  canon: (p) => ['AGENTS.md', 'CLAUDE.md'].includes(p),
  heartbeat: (p) => /^state\//.test(p),
  brain: (p) => /^(brain|state)\//.test(p),
}
export const SETTINGS = '.claude/settings.json'
// Owned outright by the publisher. In .claude/settings.json it owns only its one
// Stop hook entry; every other setting there is the repository's to change.
export const PUBLISHER_FILES = ['.github/workflows/harness-repository-context.yml', '.claude/hooks/harness-closeout.mjs']
export const isAutomation = (c) => { const m = c.subject.match(AUTOMATION); return !!m && c.files.every(AUTOMATION_SCOPE[m[2] || m[3]]) }
export const DEPENDENCY_BOTS = new Set(['dependabot[bot]', 'renovate[bot]'])
export const SKIP = /^Closeout: not needed, \S.{7,}/m
export const RULING = /Ruling \(Krish, \d{4}-\d{2}-\d{2}\)/
const CHECK_LINE = /^- North Star check \((\d{4}-\d{2}-\d{2})\): (holds\.|recalibration proposed\.\s+\S.*)$/

/**
 * Work a reader of NOW.md could need to know about: anything but NOW.md itself,
 * the history archive and files the harness generates. Plan and handoff
 * documents count, because a session that rewrites a plan has moved the
 * repository's state as surely as one that changes code.
 */
export const NOT_WORK = /^(NOW\.md|docs\/history\/.*|docs\/HARNESS_CONTEXT\.md)$/
export const isProduct = (path) => !NOT_WORK.test(path)

/** The section body under a `## ` heading, or null. */
export function section(text, heading) {
  const lines = String(text || '').split(/\r?\n/)
  const at = lines.findIndex((l) => l.startsWith(`## ${heading}`))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n')
}

/** The North Star check line of a NOW.md: { date, verdict, proposal } or null. */
export function northStarCheck(text) {
  const body = section(text, WAITING)
  if (body == null) return null
  const hits = body.split(/\r?\n/).map((l) => l.trim().match(CHECK_LINE)).filter(Boolean)
  if (hits.length !== 1) return hits.length ? { date: null, verdict: 'duplicate', proposal: null } : null
  const [, date, rest] = hits[0]
  return rest === 'holds.' ? { date, verdict: 'holds', proposal: null } : { date, verdict: 'recalibration_proposed', proposal: rest.replace(/^recalibration proposed\.\s+/, '') }
}

export const asOf = (text) => String(text || '').match(/^as_of:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1] ?? null

/**
 * The decision, as data. `commits` are the range's own commits, oldest first,
 * each { subject, body, files }. `pending` are uncommitted paths (the hook only).
 * Returns { ok, problems, reason }.
 */
export function evaluate({ commits = [], body = '', author = '', nowText = null, nowExists = false, settingsText = null, since = null, today }) {
  const own = commits.filter((c) => !isAutomation(c))
  const messages = [body, ...own.map((c) => `${c.subject}\n${c.body}`)].join('\n')
  // Only dependency bots are exempt by author: their pull requests change no
  // status and cannot write NOW.md. Every other automation, the publisher
  // included, is exempt only by its own commit subjects, commit by commit.
  if (DEPENDENCY_BOTS.has(author)) return { ok: true, problems: [], reason: 'dependency update' }
  if (!own.length) return { ok: true, problems: [], reason: 'no session commits' }
  const files = new Set(own.flatMap((c) => c.files))
  const problems = []
  const touched = PUBLISHER_FILES.filter((p) => files.has(p))
  if (touched.length) problems.push(`${touched.join(', ')} belong to the harness's repository administration publisher. Change them in krishanraja/ai-harness, never here; the publisher delivers them.`)
  if (files.has(SETTINGS) && settingsText != null && !settingsText.includes('harness-closeout.mjs')) problems.push(`${SETTINGS} no longer registers the harness closeout hook. Keep its Stop entry; every other setting is this repository's to change.`)
  if (files.has(NORTH_STAR) && !RULING.test(messages)) problems.push(`${NORTH_STAR} changed without a "Ruling (Krish, YYYY-MM-DD): ..." line. Only Krish changes a North Star: revert it and propose the change in NOW.md instead.`)
  // A stated reason excuses an untouched NOW.md, never a malformed one.
  if (SKIP.test(messages) && !files.has(NOW)) return { ok: !problems.length, problems, reason: 'closeout not needed, by the stated reason' }
  if (![...files].some(isProduct)) return { ok: !problems.length, problems, reason: 'nothing a reader of NOW.md needs changed' }
  const floor = since || today
  if (!nowExists) problems.push(`${NOW} does not exist. Create it from the docs steward schema (ai-harness docs/steward/SCHEMA.md) so the repository says where it is.`)
  else if (!files.has(NOW)) problems.push(`Product files changed but ${NOW} did not. Update "Where it is right now" and "${WAITING}" so the next session starts from the truth.`)
  else {
    const stamp = asOf(nowText)
    if (!stamp || stamp < floor) problems.push(`${NOW} frontmatter as_of is ${stamp || 'missing'}; set it (and the "Where it is right now (as of ...)" heading) to the date of this work, ${today}.`)
    const check = northStarCheck(nowText)
    if (!check) problems.push(`${NOW} has no North Star check line under "${WAITING}". Re-read ${NORTH_STAR} and add exactly one: "- North Star check (${today}): holds." or "- North Star check (${today}): recalibration proposed. <why>".`)
    else if (check.verdict === 'duplicate') problems.push(`${NOW} has more than one North Star check line; keep exactly one, the current one.`)
    else if (check.date < floor) problems.push(`The North Star check in ${NOW} is dated ${check.date}, before this work began. Re-read ${NORTH_STAR} and date the line ${today}.`)
  }
  return { ok: !problems.length, problems, reason: problems.length ? 'closeout incomplete' : 'closed out' }
}

export function instructions(problems, today) {
  return [
    'Before you finish, close out this session (harness contract, "Session closeout"):',
    ...problems.map((p) => `- ${p}`),
    '',
    `How: update ${NOW} (as_of ${today}, "Where it is right now", "${WAITING}" with the single next action), leave its "head" for the docs steward, and keep one line "- North Star check (${today}): holds." or "...: recalibration proposed. <why>". Never edit ${NORTH_STAR}: a recalibration is Krish's call, so propose it there. Commit and push with the work.`,
    'If nothing in this work changes what a reader of NOW.md needs, add the commit body line "Closeout: not needed, <reason>".',
  ].join('\n')
}

// ------------------------------------------------------------------ git reads

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a) } catch { return null } }

/** Non-merge commits in base..head, oldest first, each with the files it touched. */
export function rangeCommits(cwd, base, head) {
  const SEP = '\u001e', END = '\u001f'
  const raw = tryGit(cwd, 'log', '--no-merges', '--reverse', '--name-only', `--format=${SEP}%s%n%b${END}`, `${base}..${head}`)
  if (raw == null) return null
  return raw.split(SEP).filter((s) => s.trim()).map((chunk) => {
    const [message, names = ''] = chunk.split(END)
    const [subject, ...rest] = message.split('\n')
    return { subject: subject.trim(), body: rest.join('\n').trim(), files: names.split('\n').map((s) => s.trim()).filter(Boolean) }
  })
}

/**
 * Where this session's work begins: the newest published commit HEAD sits on.
 *
 * A remote-tracking ref can be days stale (a cloud container cloned earlier
 * and checked out the latest commit without moving origin/main), and a stale
 * base pulls already-published commits, NOW.md updates included, into the
 * range, so a session that never closed out passes. So the default branch is
 * fetched first, briefly and best effort, and the local default branch is a
 * candidate too when HEAD has left it. The newest merge-base wins.
 */
export function defaultBase(cwd, { fetch = true } = {}) {
  const head = tryGit(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  const branches = [...new Set([head?.replace(/^origin\//, ''), 'main', 'master'].filter(Boolean))]
  if (fetch) {
    for (const b of branches) {
      try {
        execFileSync('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${b}:refs/remotes/origin/${b}`], { cwd, stdio: 'ignore', timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
        break
      } catch { /* offline or no such branch: fall back to what is local */ }
    }
  }
  const current = tryGit(cwd, 'symbolic-ref', '--short', 'HEAD')
  const refs = [...branches.map((b) => `origin/${b}`), ...branches.filter((b) => b !== current)]
  let best = null
  for (const ref of refs) {
    const base = tryGit(cwd, 'merge-base', 'HEAD', ref)
    if (!base) continue
    if (!best || tryGit(cwd, 'merge-base', '--is-ancestor', best, base) === '') best = base
  }
  return best
}

const dateOf = (cwd, sha) => tryGit(cwd, 'log', '-1', '--format=%cs', sha)

function readSettings(cwd, ref) {
  if (ref) return tryGit(cwd, 'show', `${ref}:${SETTINGS}`)
  const p = join(cwd, SETTINGS)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

function readNow(cwd, ref) {
  if (ref) { const t = tryGit(cwd, 'show', `${ref}:${NOW}`); return { nowExists: t != null, nowText: t } }
  const p = join(cwd, NOW)
  return existsSync(p) ? { nowExists: true, nowText: readFileSync(p, 'utf8') } : { nowExists: false, nowText: null }
}

// ------------------------------------------------------------------ callers

export function hook(input, today = new Date().toISOString().slice(0, 10)) {
  if (input?.stop_hook_active) return null
  const cwd = input?.cwd || process.cwd()
  if (tryGit(cwd, 'rev-parse', '--is-inside-work-tree') !== 'true') return null
  const base = defaultBase(cwd)
  if (!base) return null
  const commits = rangeCommits(cwd, base, 'HEAD')
  if (!commits?.length) return null
  // Committed work is what is handed on, so it is what the hook holds to the rule.
  const result = evaluate({ commits, ...readNow(cwd, 'HEAD'), settingsText: readSettings(cwd, 'HEAD'), since: dateOf(cwd, base), today })
  return result.ok ? null : { decision: 'block', reason: instructions(result.problems, today) }
}

export function ci({ cwd = process.cwd(), base, head, body = '', author = '', today }) {
  const commits = rangeCommits(cwd, base, head)
  if (commits == null) return { ok: false, problems: [`Could not read commits ${base}..${head}; fetch full history (actions/checkout fetch-depth: 0).`] }
  return evaluate({ commits, body, author, ...readNow(cwd, head), settingsText: readSettings(cwd, head), since: dateOf(cwd, base), today: today || dateOf(cwd, head) })
}

const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (main) {
  const args = process.argv.slice(2), flag = (f) => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1] }
  if (args.includes('--ci')) {
    const result = ci({ base: flag('--base'), head: flag('--head') || 'HEAD', body: process.env.PR_BODY || '', author: process.env.PR_AUTHOR || '' })
    if (result.ok) { console.log(`Closeout passed: ${result.reason}.`); process.exit(0) }
    console.log(instructions(result.problems, new Date().toISOString().slice(0, 10)))
    for (const p of result.problems) console.log(`::error::${p}`)
    process.exit(1)
  }
  let raw = ''
  try { raw = readFileSync(0, 'utf8') } catch { /* no stdin */ }
  let input = {}
  try { input = raw.trim() ? JSON.parse(raw) : {} } catch { /* not a hook payload */ }
  let out = null
  try { out = hook(input) } catch { out = null } // a broken check never traps a session
  if (out) process.stdout.write(JSON.stringify(out))
  process.exit(0)
}
