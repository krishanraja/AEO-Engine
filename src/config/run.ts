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
  MAX_PROBED_QUERIES_PER_SUBJECT: 20,
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
  chatgpt: 0.03,
  claude: 0.04,
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
