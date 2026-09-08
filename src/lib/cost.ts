/**
 * The cost ledger. Every paid call is charged before it is made, against the
 * estimate in the price table, and the run stops probing when the next call
 * would cross the cap. The cap is a ceiling on estimates, not a bill: the
 * point is that a map that grows to 200 questions cannot quietly turn into a
 * 200-call weekly invoice.
 */
import { PRICE_USD_PER_CALL, type CostKind } from '../config/run.js'

export { PRICE_USD_PER_CALL, type CostKind }

export class CapReached extends Error {
  constructor(public readonly kind: CostKind, public readonly total: number, public readonly cap: number) {
    super(`usd cap reached: ${total.toFixed(4)} spent of ${cap.toFixed(2)}, next ${kind} call would cross it`)
    this.name = 'CapReached'
  }
}

export interface LedgerEntry { kind: CostKind; usd: number; label: string }

export class Ledger {
  readonly entries: LedgerEntry[] = []
  private _total = 0

  constructor(public readonly capUsd: number, private readonly prices: Record<CostKind, number> = PRICE_USD_PER_CALL) {}

  get total(): number { return round4(this._total) }

  priceOf(kind: CostKind): number { return this.prices[kind] ?? 0 }

  canAfford(kind: CostKind): boolean { return this._total + this.priceOf(kind) <= this.capUsd + 1e-9 }

  /** Records the estimate for one call, or throws CapReached without recording. */
  charge(kind: CostKind, label = ''): number {
    const usd = this.priceOf(kind)
    if (!this.canAfford(kind)) throw new CapReached(kind, this._total, this.capUsd)
    this._total += usd
    this.entries.push({ kind, usd, label })
    return usd
  }

  /** Per-kind totals for the dry-run report. */
  summary(): { total_usd: number; cap_usd: number; calls: number; by_kind: Record<string, { calls: number; usd: number }> } {
    const by_kind: Record<string, { calls: number; usd: number }> = {}
    for (const e of this.entries) {
      const b = (by_kind[e.kind] ||= { calls: 0, usd: 0 })
      b.calls++
      b.usd = round4(b.usd + e.usd)
    }
    return { total_usd: this.total, cap_usd: this.capUsd, calls: this.entries.length, by_kind }
  }
}

export function round4(n: number): number { return Math.round(n * 10000) / 10000 }
