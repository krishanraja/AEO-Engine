/**
 * The protocol loop, in the order ENGINE-PROTOCOL.md sets: attempt started
 * before any source is read, the directive, the work, the report and its
 * readback, the decisions, and exactly one terminal attempt.
 *
 * Two commands use it. `directive` (the daily cc-growth-directive wake-up)
 * does every step itself and its "work" is free reads only: it never starts a
 * research run, and its workflow does not even hold a paid API key. The
 * research run spans jobs, so `startResearch` runs in its plan job and
 * `finishResearch` in its report job, sharing one attempt id.
 *
 * Every failure becomes a lower_snake code on the attempt. Nothing logged
 * here ever carries the bearer, a response body or a URL with a secret in it.
 *
 * Protocol 1.20.0: when the directive serves the engine's state, both runs
 * read this repository's own docs for it, and Krish's instruction comes
 * first in the report, by id. The words were dropped at the client; the log
 * carries the id only. Whether it was acked before is read from this
 * engine's own recent live reports, a free GET.
 */
import { GrowthEngineHttp, ProtocolError } from '../clients/growthEngine.js'
import { errText, log } from '../lib/log.js'
import { validateReport, type Attempt, type Decision, type Directive, type EngineReport } from '../schema/report.js'
import { buildDirectiveReport, buildResearchReport, researchRunId, STALE_DAYS, type Envelope, type ResearchInput, type StateContext, type StoredResearch } from './reports.js'
import { readRepoState } from './state.js'

export type Client = Pick<GrowthEngineHttp, 'postAttempt' | 'getDirective' | 'postReport' | 'getReport' | 'getDecisions' | 'getRecentReports'>

/** Where a 1.20.0 report's state comes from: the checkout's docs, and this run's public page for an ack's evidence. */
export interface StateOpts { root?: string; evidenceUrl?: string | null }

/** The directive's facts the logs may carry: never Krish's words, which the client already dropped. */
function directiveLog(d: Directive, chosenBy: string): Record<string, unknown> {
  return { directive_id: d.directive_id, chosen_by: chosenBy, has_proposal: !!d.next_action?.proposal_id, engine_state: d.features?.engine_state === true, instruction: d.krish_instruction?.id ?? null }
}

/**
 * The 1.20.0 context, or null when the directive does not serve the engine's
 * state (then nothing new is sent). An instruction counts as acked when one
 * of this engine's own recent live reports already named its id; a recent
 * read that fails acks it again, which Control Center ignores as stale.
 */
async function stateContext(c: Client, d: Directive | null, o: StateOpts): Promise<StateContext | null> {
  if (d?.features?.engine_state !== true) return null
  const instruction = d.krish_instruction ?? null
  let seen = false
  if (instruction) {
    try {
      seen = (await c.getRecentReports(10)).some(r => r.activity.some(l => l.includes(instruction.id)))
    } catch (e) {
      const code = codeOf(e, 'recent_unavailable')
      if (code === 'unauthorized' || code === 'forbidden') throw e
      log('protocol_recent_unavailable', { code })
    }
    log('protocol_instruction', { instruction: instruction.id, acked_before: seen })
  }
  return { repo: readRepoState(o.root), instruction, seen, evidenceUrl: o.evidenceUrl ?? null }
}

export interface LoopOutcome { status: 'succeeded' | 'failed'; error_code: string | null; report: EngineReport | null; replayed: boolean | null }

const DAY_MS = 86_400_000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const codeOf = (e: unknown, fallback: string) => (e instanceof ProtocolError ? e.code : fallback)

/**
 * POST once, then read back. A 409 is never retried: the stored report is
 * read, and it counts as delivered only if its digest is ours.
 */
export async function deliver(c: Client, report: EngineReport): Promise<{ replayed: boolean }> {
  const v = validateReport(report)
  if (!v.ok) {
    log('protocol_report_invalid', { errors: v.errors.slice(0, 12) })
    throw new ProtocolError('report_invalid', 0)
  }
  let replayed = false
  try {
    replayed = (await c.postReport(report)).replayed
  } catch (e) {
    if (!(e instanceof ProtocolError) || e.code !== 'report_conflict') throw e
    const stored = await c.getReport(report.run_id)
    log('protocol_report_conflict', { run_id: report.run_id, stored: !!stored, same_digest: stored?.payload_sha256 === report.payload_sha256 })
    if (stored?.payload_sha256 === report.payload_sha256) return { replayed: true }
    throw e
  }
  const back = await c.getReport(report.run_id)
  if (!back) throw new ProtocolError('readback_missing', 404)
  if (back.payload_sha256 !== report.payload_sha256) throw new ProtocolError('readback_mismatch', 200)
  log('protocol_report_delivered', { run_id: report.run_id, replayed, status: report.status })
  return { replayed }
}

/** Reads his decisions and logs how they meet what this report proposes. Never acts on one. */
async function readDecisions(c: Client, report: EngineReport, now: Date): Promise<Decision[]> {
  const decisions = await c.getDecisions(new Date(now.getTime() - STALE_DAYS * DAY_MS).toISOString())
  const ours = new Map(report.proposals.map(p => [p.proposal_id, p.payload_sha256]))
  const matched = decisions.filter(d => ours.has(d.proposal_id) && ours.get(d.proposal_id) === d.payload_sha256)
  log('protocol_decisions', {
    decisions: decisions.length,
    on_this_report: decisions.filter(d => ours.has(d.proposal_id)).length,
    approved_on_this_payload: matched.filter(d => d.decision === 'approved').length,
    acted_on: 0,
  })
  return decisions
}

async function terminal(c: Client, a: Attempt, status: 'succeeded' | 'failed', phase: string, errorCode: string | null, now: () => Date): Promise<void> {
  const end: Attempt = { ...a, status, phase, error_code: status === 'failed' ? errorCode ?? 'unknown_failure' : null, finished_at: now().toISOString() }
  try {
    await c.postAttempt(end)
    log('protocol_attempt', { attempt_id: a.attempt_id, status, error_code: end.error_code })
  } catch (e) {
    log('protocol_attempt_not_recorded', { attempt_id: a.attempt_id, status, code: codeOf(e, 'attempt_unrecorded') })
  }
}

export interface DirectiveOpts extends StateOpts {
  mode: 'live' | 'synthetic'
  revision: string
  attemptId: string
  now?: () => Date
  /**
   * This wake's own discriminator (the workflow run and its attempt). Krish's
   * instruction can wake the engine a second time in a day, so each wake's
   * run_id must be its own, or the second report is refused as a conflict.
   */
  wake?: string
}

/** The daily wake-up. Free reads only; never a research run. */
export async function runDirective(c: Client, o: DirectiveOpts): Promise<LoopOutcome> {
  const now = o.now ?? (() => new Date())
  const started = now()
  const runId = o.wake ? `aeo:${ymd(started)}:directive:${o.wake}` : `aeo:${ymd(started)}:directive`
  const attempt: Attempt = { attempt_id: o.attemptId, command: 'directive', run_id: runId, status: 'started', phase: 'start', error_code: null, started_at: started.toISOString() }
  try {
    await c.postAttempt(attempt)
  } catch (e) {
    const code = codeOf(e, 'attempt_unrecorded')
    log('protocol_attempt_not_recorded', { attempt_id: o.attemptId, status: 'started', code })
    // A started attempt that could not be written is reported as a terminal
    // failure if Control Center will take one; nothing else runs.
    await terminal(c, attempt, 'failed', 'start', code, now)
    return { status: 'failed', error_code: code, report: null, replayed: null }
  }

  let phase = 'directive'
  try {
    let directive: Parameters<typeof buildDirectiveReport>[0]['directive'] = null
    let directiveError: string | null = null
    let served: Directive | null = null
    try {
      const d = await c.getDirective()
      served = d.directive
      // Krish's instruction rides in this object by id (1.20.0); its words never reached it.
      directive = { directive_id: d.directive.directive_id, chosen_by: d.chosen_by, decisions_since: Array.isArray(d.directive.decisions_since) ? d.directive.decisions_since : [], instruction: d.directive.krish_instruction ?? null }
      log('protocol_directive', directiveLog(d.directive, d.chosen_by))
    } catch (e) {
      directiveError = codeOf(e, 'directive_unavailable')
      if (directiveError === 'unauthorized' || directiveError === 'forbidden') throw e
      log('protocol_directive_unavailable', { code: directiveError })
    }

    // The newest full research report, read back from Control Center: a free
    // GET per day, newest first, back to the stale line.
    phase = 'capture'
    let last: StoredResearch | null = null
    let lastError: string | null = null
    for (let back = 0; back <= STALE_DAYS && !last; back++) {
      const id = researchRunId(ymd(new Date(started.getTime() - back * DAY_MS)))
      try {
        const r = await c.getReport(id)
        if (r && r.mode === o.mode) last = { run_id: id, accepted_at: r.accepted_at, report: r.report }
      } catch (e) {
        lastError = codeOf(e, 'readback_unavailable')
        if (lastError === 'unauthorized' || lastError === 'forbidden') throw e
        break
      }
    }

    phase = 'state'
    const state = await stateContext(c, served, o)

    phase = 'report'
    const env: Envelope = { runId, mode: o.mode, observedAt: now(), revision: o.revision, capturedAt: started, state }
    const report = buildDirectiveReport({ ...env, directive, directiveError, last, lastError })
    const { replayed } = await deliver(c, report)

    phase = 'decisions'
    await readDecisions(c, report, now())

    await terminal(c, attempt, 'succeeded', 'done', null, now)
    return { status: 'succeeded', error_code: null, report, replayed }
  } catch (e) {
    const code = codeOf(e, `${phase}_failed`)
    if (!(e instanceof ProtocolError)) log('protocol_error', { phase, error: errText(e).replace(/Bearer\s+\S+/g, 'Bearer [redacted]') })
    await terminal(c, attempt, 'failed', phase, code, now)
    return { status: 'failed', error_code: code, report: null, replayed: null }
  }
}

export interface ResearchIds { attemptId: string; runId: string; startedAt: string }

/** In the plan job, before the subject list is read. */
export async function startResearch(c: Client, ids: ResearchIds): Promise<{ ok: boolean; code: string | null }> {
  const attempt: Attempt = { attempt_id: ids.attemptId, command: 'research', run_id: ids.runId, status: 'started', phase: 'plan', error_code: null, started_at: ids.startedAt }
  try {
    await c.postAttempt(attempt)
    log('protocol_attempt', { attempt_id: ids.attemptId, status: 'started' })
  } catch (e) {
    const code = codeOf(e, 'attempt_unrecorded')
    log('protocol_attempt_not_recorded', { attempt_id: ids.attemptId, status: 'started', code })
    return { ok: false, code }
  }
  try {
    const d = await c.getDirective()
    log('protocol_directive', directiveLog(d.directive, d.chosen_by))
  } catch (e) {
    // The research is the fortnight's work whatever the directive says, so a
    // directive that cannot be read is logged, not fatal.
    log('protocol_directive_unavailable', { code: codeOf(e, 'directive_unavailable') })
  }
  return { ok: true, code: null }
}

/**
 * In the report job, after every research job. It reads the directive again
 * (a free GET) for what it serves and Krish's open instruction; one that
 * cannot be read leaves a 1.0.0 report, as before.
 */
export async function finishResearch(c: Client, ids: ResearchIds, input: Omit<ResearchInput, 'runId'>, now: () => Date = () => new Date(), o: StateOpts = {}): Promise<LoopOutcome> {
  const attempt: Attempt = { attempt_id: ids.attemptId, command: 'research', run_id: ids.runId, status: 'started', phase: 'plan', error_code: null, started_at: ids.startedAt }
  let phase = 'directive'
  try {
    let served: Directive | null = null
    try {
      const d = await c.getDirective()
      served = d.directive
      log('protocol_directive', directiveLog(d.directive, d.chosen_by))
    } catch (e) {
      const code = codeOf(e, 'directive_unavailable')
      if (code === 'unauthorized' || code === 'forbidden') throw e
      log('protocol_directive_unavailable', { code })
    }
    phase = 'state'
    const state = await stateContext(c, served, o)
    phase = 'report'
    const report = buildResearchReport({ ...input, runId: ids.runId, state })
    const { replayed } = await deliver(c, report)
    phase = 'decisions'
    await readDecisions(c, report, now())
    // The report landed; the attempt still says whether the research did.
    const failedWork = input.planError ? input.planError : report.status === 'degraded' ? 'subject_failed' : null
    await terminal(c, attempt, failedWork ? 'failed' : 'succeeded', failedWork ? 'research' : 'done', failedWork, now)
    return { status: failedWork ? 'failed' : 'succeeded', error_code: failedWork, report, replayed }
  } catch (e) {
    const code = codeOf(e, `${phase}_failed`)
    if (!(e instanceof ProtocolError)) log('protocol_error', { phase, error: errText(e).replace(/Bearer\s+\S+/g, 'Bearer [redacted]') })
    await terminal(c, attempt, 'failed', phase, code, now)
    return { status: 'failed', error_code: code, report: null, replayed: null }
  }
}
