/**
 * A stage that may fail without failing the subject. Every stage added for
 * the diagnosis (the site audit, the page match, the first-cited read, the
 * diagnosis and the kits) runs through this: a failure is logged as a count
 * with the error's class name only (never its message, which can carry a
 * URL), and the stage's fallback is returned, so the packet still ships with
 * what the run did measure.
 */
import { log } from '../lib/log.js'

export async function withFallback<T>(name: string, fn: () => T | Promise<T>, fallback: T | (() => T), fields: Record<string, unknown> = {}): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const kind = e instanceof Error ? e.name || 'Error' : typeof e
    log('stage_failed', { stage: name, failed: 1, error_kind: String(kind).slice(0, 60), ...fields })
    return typeof fallback === 'function' ? (fallback as () => T)() : fallback
  }
}
