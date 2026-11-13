/**
 * Run configuration: which engines answer, how much we probe, what it costs.
 * Read once at start; nothing else in the pipeline reads process.env.
 */
import type { Engine } from '../schema/packet.js'

export const DEFAULT_ENGINES: readonly Engine[] = ['perplexity', 'chatgpt', 'claude']

/** The default three, plus grok when an xAI key is present. */
export function resolveEngines(env: NodeJS.ProcessEnv = process.env): Engine[] {
  const out: Engine[] = [...DEFAULT_ENGINES]
  if (env.XAI_API_KEY) out.push('grok')
  return out
}

export const ENGINES: Engine[] = resolveEngines()

export const CAPS = {
  MAX_PROPOSED_QUERIES: 40,
  MIN_PROPOSED_QUERIES: 20,
  /**
   * The per-subject probe limit when no venture request is open. A subject
   * with requested questions probes max(this, requested + MIN_EXPLORATION_QUERIES),
   * never above MAX_PROBED_QUERIES_HARD (probeLimitFor in 40-probe.ts).
   */
  MAX_PROBED_QUERIES_PER_SUBJECT: 20,
  /** The ceiling on one subject's probed questions, requests included. */
  MAX_PROBED_QUERIES_HARD: 30,
  /** Questions of the engine's own choosing still probed after a venture's requested ones. */
  MIN_EXPLORATION_QUERIES: 5,
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
} as const

/**
 * Model ids per provider, changed here only. The OpenAI id is the Responses
 * API name used with the hosted web_search tool. Both it and the Anthropic id
 * with its web search tool answer live: in the research run of 2026-11-08
 * both answered for every subject, and the few probes that failed had timed
 * out (the job logs on GitHub Actions).
 */
export const MODELS = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  perplexity: 'sonar',
  xai: 'grok-4',
} as const

export type CostKind = Engine | 'classify' | 'themes' | 'propose' | 'digest' | 'voice'

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
  classify: 0.01,
  themes: 0.03,
  propose: 0.04,
  digest: 0.06,
  // The wording-only pass that applies Krish's approved voice rules to the
  // digest's drafted words (src/pipeline/65-voice.ts). Made only when he has
  // approved at least one rule, so none approved costs nothing.
  voice: 0.03,
}
