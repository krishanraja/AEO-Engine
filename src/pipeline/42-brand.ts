/**
 * Stage 42: brand-accuracy checks. Control Center serves a venture's checks
 * (`subject.brand_checks`, brief section B6): a question, the phrases an
 * answer must never use about the brand, and the phrases it must use. Full
 * Time is never "betting tips"; Mindmake is not "Mindmaker".
 *
 * Each check is asked once a research run on every packet engine, at most
 * CAPS.BRAND_CHECKS_PER_SUBJECT a subject, each ask charged to the ledger
 * before it is made, inside the cap and the subject's reserve (the Claude
 * Code lane is free). An answer passes when no must_not phrase appears in it
 * and every must phrase does, each as whole words in any case, read with
 * every URL and bare domain taken out (a citation is not a description). A
 * check passes when every engine that answered it passed.
 *
 * The answer's text is read here and dropped: only pass or fail, and which
 * of the check's own phrases failed, leave this stage, and only into the
 * sealed summary (and from there, for one failed check of a venture that is
 * not held, into one proposal on Krish's list). Logs carry counts.
 */
import { CAPS, SUBSCRIPTION_KINDS } from '../config/run.js'
import { FreeTierExhausted, SubscriptionLimit, type EngineAnswer, type EngineClient } from '../clients/types.js'
import type { Ledger } from '../lib/cost.js'
import { errText, log } from '../lib/log.js'
import type { BrandCheckResult, BrandJudgement, BrandSummary } from '../schema/brand.js'
import type { BrandCheckSpec } from '../schema/context.js'
import { inPacket, type GatedEngine, type ProbeEngine } from '../schema/packet.js'
import { costKindOf } from './40-probe.js'

export type { BrandCheckResult, BrandCheckSpec, BrandJudgement, BrandSummary }

const PHRASE_MAX = 80
const PHRASES_MAX = 10
const QUESTION_MIN = 8
const QUESTION_MAX = 300

const phrases = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string') continue
    const t = p.trim().replace(/\s+/g, ' ')
    if (t.length < 2 || t.length > PHRASE_MAX || out.some(o => o.toLowerCase() === t.toLowerCase())) continue
    out.push(t)
    if (out.length >= PHRASES_MAX) break
  }
  return out
}

/**
 * The checks a subject serves, read loosely: a question of 8 to 300
 * characters and at least one phrase, or the entry is dropped; each once (by
 * its question), at most `max`.
 */
export function brandChecksOf(raw: unknown, max: number = CAPS.BRAND_CHECKS_PER_SUBJECT): BrandCheckSpec[] {
  if (!Array.isArray(raw)) return []
  const out: BrandCheckSpec[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const r = x as Record<string, unknown>
    const question = typeof r.question === 'string' ? r.question.trim().replace(/\s+/g, ' ') : ''
    if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) continue
    const must_not = phrases(r.must_not)
    const must = phrases(r.must)
    if (!must_not.length && !must.length) continue
    if (out.some(o => o.question.toLowerCase() === question.toLowerCase())) continue
    out.push({ question, must_not, must })
    if (out.length >= max) break
  }
  return out
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Text with every URL and bare domain taken out, so a citation never counts as words. */
export function withoutUrls(text: string): string {
  return String(text ?? '').replace(URL_RE, ' ').replace(DOMAIN_RE, ' ')
}

/** Whether a phrase appears as whole words, in any case, with any run of spaces between its words. */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = String(phrase ?? '').trim()
  if (!p) return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu').test(String(text ?? ''))
}

/** One answer against one check: the must_not phrases it used and the must phrases it left out. Pure. */
export function judgeAnswer(text: string, check: Pick<BrandCheckSpec, 'must_not' | 'must'>): BrandJudgement {
  const t = withoutUrls(text)
  const used = check.must_not.filter(p => hasPhrase(t, p))
  const missing = check.must.filter(p => !hasPhrase(t, p))
  return { pass: !used.length && !missing.length, must_not: used, must: missing }
}

export interface BrandOutcome {
  results: BrandCheckResult[]
  /** Asks charged and made, answered, failed, and stopped by the cap. */
  asks: number
  answers: number
  failed: number
  skipped_cap: number
}

/**
 * Asks each check once on every packet engine, inside the cap and the
 * subject's reserve. A failed or unaffordable ask writes nothing for that
 * engine and is counted; nothing is guessed.
 */
export async function askBrandChecks(
  engines: readonly EngineClient[],
  checks: readonly BrandCheckSpec[],
  ledger: Ledger,
  reserveUsd = 0,
  opts: { open?: readonly GatedEngine[]; domains?: readonly string[]; subject?: string } = {},
): Promise<BrandOutcome> {
  const out: BrandOutcome = { results: [], asks: 0, answers: 0, failed: 0, skipped_cap: 0 }
  const asking = engines.filter(e => inPacket(e.engine, opts.open ?? []))
  let capHit = false
  for (const check of checks) {
    const affordable: EngineClient[] = []
    let pending = 0
    for (const engine of asking) {
      if (engine.exhausted === true) continue
      const kind = costKindOf(engine)
      const free = SUBSCRIPTION_KINDS.includes(kind)
      if ((capHit && !free) || !ledger.canAfford(kind, pending + reserveUsd)) {
        if (!capHit) log('cap_reached', { at_usd: ledger.total, cap_usd: ledger.capUsd, stage: 'brand_checks' })
        capHit = true
        out.skipped_cap++
        continue
      }
      affordable.push(engine)
      pending += free ? 0 : ledger.priceOf(kind)
    }
    for (const engine of affordable) ledger.charge(costKindOf(engine), `brand ${engine.engine}`)
    out.asks += affordable.length
    const answered = await Promise.all(affordable.map(async (engine): Promise<{ engine: EngineClient; a: EngineAnswer | null }> => {
      try {
        try {
          return { engine, a: await engine.ask(check.question, { domains: opts.domains ?? [] }) }
        } catch (e) {
          // code_then_api: the subscription's limit hands the ask to the paid lane, inside the same cap.
          const fb = engine.fallback
          if (!(e instanceof SubscriptionLimit) || !fb || capHit || !ledger.canAfford(costKindOf(fb), reserveUsd)) throw e
          ledger.charge(costKindOf(fb), `brand ${fb.engine} fallback`)
          return { engine, a: await fb.ask(check.question, { domains: opts.domains ?? [] }) }
        }
      } catch (e) {
        if (e instanceof FreeTierExhausted) {
          ledger.refund(costKindOf(engine), `brand ${engine.engine}`)
          out.asks--
          return { engine, a: null }
        }
        out.failed++
        log('brand_check_failed_call', { engine: engine.engine, error: errText(e) })
        return { engine, a: null }
      }
    }))
    const rows: BrandCheckResult['engines'] = []
    for (const { engine, a } of answered) {
      if (!a) continue
      out.answers++
      rows.push({ engine: engine.engine, ...judgeAnswer(a.text, check) })
    }
    out.results.push({ question: check.question, pass: rows.length ? rows.every(r => r.pass) : null, engines: rows })
  }
  log('brand_checks', { ...(opts.subject ? { subject: opts.subject } : {}), checks: checks.length, passed: out.results.filter(r => r.pass === true).length, failed_checks: out.results.filter(r => r.pass === false).length, asks: out.asks, answers: out.answers, failed: out.failed, skipped_cap: out.skipped_cap })
  return out
}

export function brandSummary(o: BrandOutcome): BrandSummary {
  return {
    checks: o.results.length,
    answered: o.results.filter(r => r.pass !== null).length,
    passed: o.results.filter(r => r.pass === true).length,
    answers: o.answers,
    skipped_cap: o.skipped_cap,
    results: o.results.map(r => ({ question: r.question, pass: r.pass, engines: r.engines.map(e => ({ engine: e.engine, pass: e.pass, must_not: [...e.must_not], must: [...e.must] })) })),
  }
}
