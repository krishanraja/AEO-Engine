/**
 * Run configuration: which engines answer, how much we probe, what it costs.
 * Read once at start; nothing else in the pipeline reads process.env.
 */
import type { Engine, ProbeEngine } from '../schema/packet.js'

export const DEFAULT_ENGINES: readonly Engine[] = ['perplexity', 'chatgpt', 'claude']

/**
 * Which attempt of its research job this run is: AEO_ATTEMPT, which the
 * research workflow's retry loop sets (1, then 2). 1 when unset or not a
 * whole number above zero, so a run by hand is a first attempt.
 */
export function attemptOf(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(String(env.AEO_ATTEMPT ?? '').trim())
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/**
 * The default three, plus grok when an xAI key is present, plus gemini when a
 * Gemini key is present and this is the job's first attempt. Gemini is a
 * gated engine (src/schema/packet.ts): it is asked and counted in the sealed
 * summary, and stays out of the packet until the context opens it. Its
 * free-tier share is counted in the process, and a retry is a fresh process,
 * so a retry asks no Gemini rather than start a second share (check:config
 * proves the month inside the free tier on that basis).
 */
export function resolveEngines(env: NodeJS.ProcessEnv = process.env): ProbeEngine[] {
  const out: ProbeEngine[] = [...DEFAULT_ENGINES]
  if (env.XAI_API_KEY) out.push('grok')
  if (env.GEMINI_API_KEY && attemptOf(env) === 1) out.push('gemini')
  return out
}

/** For the config guard and logs only; a run resolves its engines in buildDeps (src/index.ts). */
export const ENGINES: ProbeEngine[] = resolveEngines()

/**
 * Which way the Claude probes reach Claude (Ruling, Krish, 2026-11-13: Claude
 * probes run on the Claude Code subscription token, with the paid API as a
 * switch-on fallback).
 *
 *   code           the Claude Code CLI on the subscription token (src/clients/claudeCode.ts)
 *   api            the Messages API with its hosted web search (src/clients/anthropic.ts)
 *   compare        the code lane for every question, and the API lane beside it on
 *                  the first COMPARE_API_QUESTIONS_PER_SUBJECT questions of each
 *                  subject, tallied in the sealed summary and never in the packet
 *   code_then_api  the code lane, falling back to the API only when the
 *                  subscription's limit stops a probe
 */
export const CLAUDE_LANES = ['code', 'api', 'compare', 'code_then_api'] as const
export type ClaudeLane = (typeof CLAUDE_LANES)[number]

/**
 * Runs whose week_start is on or before this date compare the two lanes by
 * default: the run of 22 November (week_start 2026-11-16) is the first on the
 * code lane, and it is read against the API lane before the API is switched
 * off. From the research week of 23 November the default is `code`.
 */
export const COMPARE_FIRST_RUN_UNTIL = '2026-11-16'

export interface LaneChoice {
  lane: ClaudeLane
  /** Why: set (AEO_CLAUDE_LANE), dated_default, or no_token (a code lane asked for without the subscription token). */
  reason: 'set' | 'dated_default' | 'no_token'
  /** What AEO_CLAUDE_LANE said, when it said something this engine does not know. */
  unknown?: string
}

/**
 * The lane for a run, from AEO_CLAUDE_LANE and the run's week. Read in
 * buildDeps, never at module load. Empty or unknown means the dated default.
 * A lane that needs the subscription token falls back to `api` when
 * CLAUDE_CODE_OAUTH_TOKEN is absent, so a missing secret never zeroes Claude.
 */
export function resolveClaudeLane(env: NodeJS.ProcessEnv, weekStart: string): LaneChoice {
  const raw = String(env.AEO_CLAUDE_LANE ?? '').trim().toLowerCase()
  const known = (CLAUDE_LANES as readonly string[]).includes(raw)
  const fallback: ClaudeLane = weekStart <= COMPARE_FIRST_RUN_UNTIL ? 'compare' : 'code'
  const lane = known ? (raw as ClaudeLane) : fallback
  const choice: LaneChoice = { lane, reason: known ? 'set' : 'dated_default', ...(raw && !known ? { unknown: raw.slice(0, 40) } : {}) }
  if (lane !== 'api' && !env.CLAUDE_CODE_OAUTH_TOKEN) return { ...choice, lane: 'api', reason: 'no_token' }
  return choice
}

export const CAPS = {
  MAX_PROPOSED_QUERIES: 40,
  MIN_PROPOSED_QUERIES: 20,
  /**
   * The per-subject probe limit when no venture request is open. A subject
   * with requested questions probes max(this, requested + MIN_EXPLORATION_QUERIES),
   * never above MAX_PROBED_QUERIES_HARD (probeLimitFor in 40-probe.ts).
   */
  MAX_PROBED_QUERIES_PER_SUBJECT: 25,
  /** The ceiling on one subject's probed questions, requests included. */
  MAX_PROBED_QUERIES_HARD: 30,
  /** Questions of the engine's own choosing still probed after a venture's requested ones. */
  MIN_EXPLORATION_QUERIES: 5,
  /**
   * Contested questions a subject re-asks twice more on every engine that
   * answered, so one noisy answer is never read as a win (src/pipeline/41-samples.ts).
   * At 8 questions and 3 engines that is 48 extra asks a subject at most,
   * each charged to the ledger inside the cap (the Claude Code lane is free).
   */
  MAX_SAMPLED_QUESTIONS_PER_SUBJECT: 8,
  /**
   * The Claude Code lane's turn limit for one probe (--max-turns): a search or
   * two, the answer, and room for a search that comes back empty.
   */
  CLAUDE_CODE_MAX_TURNS: 8,
  /**
   * Questions per subject the API lane is asked beside the code lane in
   * `compare` mode (src/config/run.ts, CLAUDE_LANES). Paid, charged to the
   * ledger, and never in the packet.
   */
  COMPARE_API_QUESTIONS_PER_SUBJECT: 5,
  /**
   * Gemini grounding queries one research job may run (the sum of each
   * answer's webSearchQueries). The free tier allows 5000 a month; this, plus
   * one answer's overrun, times ten subjects times three runs a month stays
   * inside it (check:config), because only a job's first attempt asks Gemini.
   * Gemini stops before an answer could pass it, and its skipped probes are
   * counted and never charged.
   */
  GEMINI_MAX_QUERIES_PER_JOB: 150,
  /** Grounding redirects resolved to their real URL per Gemini probe (one GET each, never the page). */
  GEMINI_MAX_RESOLUTIONS_PER_PROBE: 3,
  /**
   * Hosted web searches one Claude probe may run (the tool's max_uses). It was
   * five until 2026-11-13, when the usage meter read Claude probes costing
   * more than their estimate; two searches ground one answer and keep a probe
   * well inside its timeout. See PRICE_USD_PER_CALL.claude.
   */
  CLAUDE_API_SEARCH_MAX_USES: 2,
  MAX_CITATIONS: 8,
  ANSWER_SNAPSHOT_CHARS: 1800,
  /** Spend ceiling for one run, all subjects. AEO_MAX_USD_PER_RUN overrides. */
  MAX_USD_PER_RUN: Number(process.env.AEO_MAX_USD_PER_RUN) > 0 ? Number(process.env.AEO_MAX_USD_PER_RUN) : 25,
  /**
   * Transcript window: the last fourteen days ending now. The research runs
   * fortnightly (since 2026-10-15), so a seven-day window never read the calls
   * of the week between two runs.
   */
  TRANSCRIPT_WINDOW_DAYS: 14,
  /** A transcript is attributed to a subject at this classifier confidence or above. */
  MIN_ATTRIBUTION_CONFIDENCE: 0.6,
  /** A watch row needs at least this demand score. */
  WATCH_MIN_SCORE: 30,
  /** A demand score that moves by this much against last week reads as up or down. */
  TREND_STEP: 10,
  /**
   * The site reader (src/clients/site.ts): fetch only, GET only, never a
   * script run. Requests to one host in one process, its throttle, its
   * deadline, its body cap and its redirect hops.
   */
  SITE_MAX_REQUESTS_PER_HOST: 40,
  SITE_MIN_GAP_MS: 1000,
  SITE_TIMEOUT_MS: 15_000,
  SITE_MAX_BYTES: 512 * 1024,
  SITE_MAX_HOPS: 3,
  /** A host that fails this many requests in a row is read no further this process. */
  SITE_MAX_ERRORS_PER_HOST: 3,
  /**
   * The site audit (src/pipeline/15-site.ts): our own hosts per subject, the
   * pages a subject's diagnosis reads, the pages read on one host (each host
   * is audited once a run, src/site.ts), and sitemap files and URLs per host.
   */
  SITE_MAX_HOSTS_PER_SUBJECT: 3,
  SITE_MAX_PAGES_PER_SUBJECT: 25,
  SITE_MAX_PAGES_PER_HOST: 25,
  SITE_MAX_SITEMAPS_PER_HOST: 8,
  SITE_MAX_SITEMAP_URLS_PER_HOST: 200,
  /** The pages cited first for our questions (src/pipeline/45-pages.ts): per subject, and per host. Never their links. */
  THIRD_PARTY_MAX_PAGES_PER_SUBJECT: 15,
  THIRD_PARTY_MAX_PAGES_PER_HOST: 3,
  /** A page of ours answers a question when this share of the question's words is in its title and H1. */
  PAGE_MATCH_MIN: 0.35,
  /**
   * The verify lane (src/protocol/verify.ts): the most an off-week verify run
   * may ask Krish to spend, in whole dollars, and the most questions it
   * re-asks. check:config holds the amount positive and at most 5.
   */
  VERIFY_MAX_USD: 3,
  VERIFY_MAX_QUESTIONS: 10,
  /** Brand-accuracy checks a subject asks a research run, each once on every packet engine (src/pipeline/42-brand.ts). */
  BRAND_CHECKS_PER_SUBJECT: 3,
  /** The cited-pages sheet (src/pipeline/48-cited-pages.ts): rows a venture keeps, pages checked for a mention a run, and per host. */
  CITED_PAGES_PER_SUBJECT: 50,
  MENTION_CHECKS_PER_SUBJECT: 20,
  MENTION_CHECKS_PER_HOST: 3,
  /** The outcome window on Control Center's search signals (src/pipeline/63-outcomes.ts), in days. */
  OUTCOME_WINDOW_DAYS: 28,
} as const

/**
 * Model ids per provider, changed here only. The OpenAI id is the Responses
 * API name used with the hosted web_search tool. Both it and the Anthropic id
 * with its web search tool answer live: in the research run of 2026-11-08
 * both answered for every subject, and the few probes that failed had timed
 * out (the job logs on GitHub Actions).
 */
export const MODELS = {
  // Both Claude lanes ask this model: the API lane by id, the Claude Code
  // lane through --model, so a compare run compares the lane and not the model.
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  perplexity: 'sonar',
  xai: 'grok-4',
  // Gemini API generateContent with google_search grounding (src/clients/gemini.ts).
  gemini: 'gemini-3.6-flash',
} as const

/**
 * What the ledger counts. An engine's probe, the Claude Code lane's probe
 * (claude_code: on the subscription, counted and never charged), and the
 * writing stages.
 */
export type CostKind = ProbeEngine | 'claude_code' | 'classify' | 'themes' | 'propose' | 'digest' | 'voice'

/**
 * Cost kinds billed to a subscription, not per call. The ledger counts their
 * calls at a price of exactly 0 and never stops one at the cap: the cap is a
 * ceiling on dollars, and these spend none (check:config holds them at 0).
 */
export const SUBSCRIPTION_KINDS: readonly CostKind[] = ['claude_code']

/**
 * Estimated USD per call. These are estimates: a probe answer with a hosted
 * web search is billed on tokens plus a per-search fee that differs by
 * provider, and the model calls vary with the evidence size. Tune from the
 * first ledgers (the dry run prints one) rather than from a rate card.
 */
export const PRICE_USD_PER_CALL: Record<CostKind, number> = {
  perplexity: 0.01,
  // Raised from 0.03 on 2026-11-13, when the web search became required on
  // every ChatGPT probe (src/clients/openai.ts): before, about seven in eight
  // probes did not search, so most paid no search fee and read no search
  // content. Nothing meters OpenAI usage yet (src/lib/usage.ts reads Anthropic
  // responses only), so this is a conservative estimate, unproven until the
  // provider's spend for the 22 November run is read against it.
  chatgpt: 0.05,
  // Raised from 0.04 on 2026-11-13: at five searches a probe the usage meter
  // read Claude probes above that estimate (its figures stay in Control
  // Center). At CAPS.CLAUDE_API_SEARCH_MAX_USES searches a probe is expected
  // to cost 0.06 to 0.07, so the cap estimate takes the top of that range.
  claude: 0.07,
  grok: 0.05,
  // A Gemini probe's tokens; its grounding searches are inside the free tier
  // (CAPS.GEMINI_MAX_QUERIES_PER_JOB keeps them there). A small estimate, so
  // the cap still counts the calls.
  gemini: 0.005,
  // The Claude Code lane runs on the subscription token: no dollar is
  // charged, and the CLI's own cost figure is never read into the ledger.
  claude_code: 0,
  classify: 0.01,
  themes: 0.03,
  propose: 0.04,
  digest: 0.06,
  // The wording-only pass that applies Krish's approved voice rules to the
  // digest's drafted words (src/pipeline/65-voice.ts). Made only when he has
  // approved at least one rule, so none approved costs nothing.
  voice: 0.03,
}
