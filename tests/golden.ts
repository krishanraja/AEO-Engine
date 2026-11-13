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

class FeaturedContext extends OfflineControlCenter {
  constructor(dir: string, private readonly features: readonly string[], private readonly edit?: (ctx: AeoContext) => void) { super(dir) }
  override async getContext(): Promise<AeoContext> {
    const ctx = structuredClone(await super.getContext())
    ctx.packet_features = [...this.features]
    const ctrl = ctx.subjects.find(s => s.slug === 'ctrl')
    if (ctrl) ctrl.brand_names = ['Mindmake']
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
