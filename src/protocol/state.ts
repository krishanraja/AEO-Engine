/**
 * The engine's state on a 1.20.0 report (Control Center's ENGINE-PROTOCOL.md,
 * "Krish's instruction and the engine's state"): what it is chasing, Krish's
 * own aims it will not let go of, and what it does next. Ruling (Krish,
 * 2026-11-11): every growth engine's priorities, obsessions, next steps and
 * outstanding items feed live across Control Centre.
 *
 * Every line comes from this repository as it stands at the run's commit,
 * read here, never written by hand and never by a model:
 *
 *   priorities  docs/NORTH_STAR.md's number and NOW.md's urgency line, then
 *               the objective's own reading, then the cost wall.
 *   obsessions  only Krish's quoted words: the North Star's aim in
 *               docs/NORTH_STAR.md and his autonomy ruling in AGENTS.md.
 *   next steps  the first unticked step of docs/GET-GOING.md, the next
 *               scheduled research run (today's, on a research Sunday before
 *               it has reported), and NOW.md's "Waiting on Krish".
 *
 * A source that is missing or reads strangely leaves its lines out; a line
 * that would not pass Control Center's guard (an address, a number, over the
 * length) is dropped, never cut mid-quote. A field with no line is left out,
 * and Control Center says "Not reported yet" for it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NEXT_STEPS_MAX,
  OBJECTIVE_KEY,
  OBSESSIONS_MAX,
  PRIORITIES_MAX,
  STATE_LINE_MAX,
  stateLineOk,
  type EngineNextStep,
  type EngineObsession,
  type EnginePriority,
  type EngineState,
  type ObjectiveReading,
} from '../schema/report.js'

export interface NorthStar { metric: string; target: string; unit: string; deadline: string }

/** What this repository says about itself, read once per run. */
export interface RepoState {
  northStar: NorthStar | null
  urgency: { level: number; reason: string | null } | null
  /** The quoted aim in docs/NORTH_STAR.md, and the day Krish set it. */
  aim: { quote: string; since: string | null } | null
  /** Krish's quoted autonomy ruling in AGENTS.md, and its day. */
  autonomy: { quote: string; since: string | null } | null
  /** The first unticked step of docs/GET-GOING.md. */
  firstUnticked: { step: number; text: string } | null
  /** NOW.md's "Waiting on Krish" items, one per clause. */
  waitingOnKrish: string[]
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function read(root: string, file: string): string | null {
  const p = join(root, file)
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null } catch { return null }
}

/** Markdown down to plain words: links to their text, no code ticks, no bold. */
export function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Splits on semicolons that are not inside brackets. */
function topLevelClauses(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

function dayOf(text: string): string | null {
  const m = /Set by Krish on (\d{1,2}) ([A-Za-z]+) (\d{4})/.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[2].toLowerCase())
  if (month < 0) return null
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

export function parseNorthStar(text: string | null): { northStar: NorthStar | null; aim: RepoState['aim'] } {
  if (!text) return { northStar: null, aim: null }
  const block = /```ya?ml north-star-metric\n([\s\S]*?)```/.exec(text)?.[1] ?? ''
  const field = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(block)
    return m ? m[1].trim().replace(/^"(.*)"$/, '$1') : null
  }
  const metric = field('metric')
  const target = field('target')
  const unit = field('unit')
  const deadline = field('deadline')
  const northStar = metric && target && deadline ? { metric, target, unit: unit ?? '', deadline } : null
  const quote = /^> (.+)$/m.exec(text)?.[1]?.trim() ?? null
  return { northStar, aim: quote ? { quote, since: dayOf(text) } : null }
}

export function parseUrgency(nowMd: string | null): RepoState['urgency'] {
  const json = nowMd ? /<!-- north-star-state (\{[^\n]*?\}) -->/.exec(nowMd)?.[1] : null
  if (!json) return null
  try {
    const s = JSON.parse(json) as { urgency?: unknown; urgency_reason?: unknown }
    if (typeof s.urgency !== 'number' || !Number.isInteger(s.urgency) || s.urgency < 1 || s.urgency > 5) return null
    return { level: s.urgency, reason: typeof s.urgency_reason === 'string' && s.urgency_reason.trim() ? s.urgency_reason.trim() : null }
  } catch {
    return null
  }
}

export function parseAutonomy(agents: string | null): RepoState['autonomy'] {
  const m = agents ? /^## Autonomy \(Ruling, Krish, (\d{4}-\d{2}-\d{2})\)\s*\n+Krish: "([^"\n]+)"/m.exec(agents) : null
  return m ? { quote: m[2].trim(), since: m[1] } : null
}

export function parseFirstUnticked(getGoing: string | null): RepoState['firstUnticked'] {
  const m = getGoing ? /^- \[ \] \*\*Step (\d+)\.\*\* (.+)$/m.exec(getGoing) : null
  return m ? { step: Number(m[1]), text: plain(m[2]) } : null
}

export function parseWaitingOnKrish(nowMd: string | null): string[] {
  if (!nowMd) return []
  const section = /^## What is next and what is waiting on Krish\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(nowMd)?.[1] ?? ''
  const bullet = /^- Waiting on Krish:\s*(.+)$/m.exec(section)?.[1]
  if (!bullet) return []
  return topLevelClauses(plain(bullet))
    .map(c => cap(c.replace(/^and\s+/i, '').replace(/\.$/, '').trim()))
    .filter(Boolean)
    .map(c => `${c}.`)
}

/** Reads this repository's own docs from `root` (the run's checkout). Never throws. */
export function readRepoState(root: string = process.cwd()): RepoState {
  const nowMd = read(root, 'NOW.md')
  const { northStar, aim } = parseNorthStar(read(root, 'docs/NORTH_STAR.md'))
  return {
    northStar,
    urgency: parseUrgency(nowMd),
    aim,
    autonomy: parseAutonomy(read(root, 'AGENTS.md')),
    firstUnticked: parseFirstUnticked(read(root, 'docs/GET-GOING.md')),
    waitingOnKrish: parseWaitingOnKrish(nowMd),
  }
}

/** A step's first clause when the whole is too long: what comes before its first colon. */
function stepLine(step: number, text: string): string | null {
  const prefix = `GET-GOING step ${step}: `
  const whole = `${prefix}${text}`
  if (stateLineOk(whole, STATE_LINE_MAX)) return whole
  const clause = text.split(/:\s/)[0].replace(/ above\b/g, '').trim()
  const short = `${prefix}${clause.replace(/[.;,]$/, '')}.`
  return stateLineOk(short, STATE_LINE_MAX) ? short : null
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/**
 * A time in words: "Sunday 22 November 2026 at 04:00 UTC". Never
 * "2026-11-22 04:00": its ten digits in one run read as a phone number to
 * Control Center's guard, which then refuses the whole report.
 */
export function inWords(d: Date): string {
  const hhmm = d.toISOString().slice(11, 16)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${cap(MONTHS[d.getUTCMonth()])} ${d.getUTCFullYear()} at ${hhmm} UTC`
}

export interface StateInput {
  repo: RepoState
  /** This report's reading of queries_cited_first. */
  objective: ObjectiveReading
  /** The next scheduled research run. */
  nextRun: Date
}

/**
 * Priorities, obsessions and next steps from what the repository says and
 * this report measured. Pure. Each list keeps only lines Control Center will
 * take, and a list with none is left out.
 */
export function buildEngineState(i: StateInput): Omit<EngineState, 'instruction_acks'> {
  const keep = <T extends { line: string }>(xs: Array<T | null>, max: number): T[] => xs.filter((x): x is T => !!x && stateLineOk(x.line, STATE_LINE_MAX)).slice(0, max)

  const priorities: Array<EnginePriority | null> = []
  const ns = i.repo.northStar
  if (ns) {
    const base = `${ns.metric}: ${ns.target}${ns.unit} by ${ns.deadline}`
    const u = i.repo.urgency
    const withUrgency = u ? `${base}. Now U${u.level}${u.reason ? `, ${u.reason}` : ''}.` : `${base}.`
    priorities.push({ rank: 0, line: stateLineOk(withUrgency, STATE_LINE_MAX) ? withUrgency : `${base}.`, objective_key: OBJECTIVE_KEY })
  }
  const o = i.objective
  if (o.availability === 'measured' && o.value !== null) {
    priorities.push({ rank: 0, line: `Raise queries cited first from ${o.value}, as measured by the last full research run, toward the North Star.`, objective_key: OBJECTIVE_KEY })
  } else {
    priorities.push({ rank: 0, line: `Get an honest reading of queries cited first: only a full research run measures it, and the next is ${inWords(i.nextRun)}.`, objective_key: OBJECTIVE_KEY })
  }
  priorities.push({ rank: 0, line: 'Keep the cost wall: paid research starts only from the fortnightly schedule or a run Krish starts by hand, never from a directive or an instruction.', objective_key: null })
  const ranked = keep(priorities, PRIORITIES_MAX).map((p, n) => ({ ...p, rank: n + 1 }))

  const obsessions = keep<EngineObsession>([
    i.repo.aim ? { line: `"${i.repo.aim.quote}"`, since: i.repo.aim.since } : null,
    i.repo.autonomy ? { line: `"${i.repo.autonomy.quote}"`, since: i.repo.autonomy.since } : null,
  ], OBSESSIONS_MAX)

  const step = i.repo.firstUnticked ? stepLine(i.repo.firstUnticked.step, i.repo.firstUnticked.text) : null
  const nextSteps = keep<EngineNextStep>([
    step ? { line: step, waits_on: 'engine', when: null } : null,
    { line: `The next scheduled research run, ${inWords(i.nextRun)}, measures queries cited first again.`, waits_on: 'engine', when: ymd(i.nextRun) },
    ...i.repo.waitingOnKrish.map(w => ({ line: w, waits_on: 'krish' as const, when: null })),
  ], NEXT_STEPS_MAX)

  return {
    ...(ranked.length ? { priorities: ranked } : {}),
    ...(obsessions.length ? { obsessions } : {}),
    ...(nextSteps.length ? { next_steps: nextSteps } : {}),
  }
}
