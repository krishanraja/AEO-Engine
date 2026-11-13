/**
 * The offline run with every packet feature listed: the same fixtures as the
 * features-off golden (tests/fixtures/expected/packet.ctrl.json), a context
 * that lists every PACKET_FEATURES name, and one synthetic distinctive name
 * for the venture, so every gated field is exercised. Pure fixtures, no network.
 */
import { buildDeps, parseArgs } from '../src/index.js'
import { OfflineControlCenter } from '../src/clients/offline.js'
import type { AeoContext } from '../src/schema/context.js'
import { PACKET_FEATURES, type AeoPacket } from '../src/schema/packet.js'
import { runAll, type RunDeps, type RunResult } from '../src/pipeline/run.js'
import { FIXTURES } from './helpers.js'

export const GOLDEN_WEEK = '2026-09-07'
export const GOLDEN_NOW = new Date('2026-09-13T10:00:00Z')

/**
 * Synthetic search signals for the venture's two kit target pages (brief
 * section C), so the outcome field is exercised: Search Console rows inside
 * and outside the 28 days ending on GOLDEN_NOW, Bing URL information for one
 * page, and AI referrals from GA4 and from Clarity, kept apart.
 */
export const SYNTHETIC_SIGNALS = {
  gsc_queries: [
    { query: 'personal ai writing style', page: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style', impressions: 120, clicks: 6, position: 7.5, date_from: '2026-09-01', date_to: '2026-09-07' },
    { query: 'ai writing style', page: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style/', impressions: 40, clicks: 1, position: 11.5, date_from: '2026-09-08', date_to: '2026-09-12' },
    { query: 'old reading', page: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style', impressions: 500, clicks: 50, position: 3, date_from: '2026-07-01', date_to: '2026-07-31' },
    { query: 'style guide for an ai assistant', page: 'https://www.ctrl.mindmake.co/blog/style-guide-for-an-ai-assistant?utm_source=x', impressions: 0, clicks: 0, position: 0, date_from: '2026-09-02', date_to: '2026-09-02' },
  ],
  bing: { url_info: [{ url: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style', indexed: true, last_crawled: '2026-09-10T08:00:00Z' }] },
  ai_referrals: [
    { landing_page: '/answers/personal-ai-writing-style', source: 'chatgpt.com', sessions: 3, date: '2026-09-09', via: 'ga4' },
    { landing_page: 'https://ctrl.mindmake.co/answers/personal-ai-writing-style', source: 'perplexity.ai', sessions: 2, date: '2026-09-11', via: 'clarity' },
    { landing_page: '/answers/personal-ai-writing-style', source: 'chatgpt.com', sessions: 9, date: '2026-07-01', via: 'ga4' },
  ],
}

class FeaturedContext extends OfflineControlCenter {
  constructor(dir: string, private readonly features: readonly string[], private readonly edit?: (ctx: AeoContext) => void) { super(dir) }
  override async getContext(): Promise<AeoContext> {
    const ctx = structuredClone(await super.getContext())
    ctx.packet_features = [...this.features]
    const ctrl = ctx.subjects.find(s => s.slug === 'ctrl')
    if (ctrl) {
      ctrl.brand_names = ['Mindmake']
      ctrl.search_signals = SYNTHETIC_SIGNALS
    }
    this.edit?.(ctx)
    return ctx
  }
}

/** One offline dry run of `subject` with `features` listed, as the CLI would make it, in memory. */
export async function featuredRun(subject = 'ctrl', features: readonly string[] = PACKET_FEATURES, edit?: (ctx: AeoContext) => void, tweak?: (deps: RunDeps) => void): Promise<RunResult> {
  const args = parseArgs(['--offline', '--dry', '--subject', subject, '--week', GOLDEN_WEEK, '--fixtures', FIXTURES], GOLDEN_NOW)
  const deps = buildDeps(args, { ...process.env, XAI_API_KEY: '', GEMINI_API_KEY: '' }, GOLDEN_NOW)
  deps.cc = new FeaturedContext(FIXTURES, features, edit)
  tweak?.(deps)
  return runAll(deps, { subject, weekStart: GOLDEN_WEEK, dry: true, outPath: null, commandId: null })
}

export function strip(p: AeoPacket): Omit<AeoPacket, 'run_id' | 'generated_at'> {
  const { run_id: _r, generated_at: _g, ...rest } = p
  return rest
}
