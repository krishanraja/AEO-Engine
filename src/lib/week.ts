/**
 * The Monday that owns a date, in UTC. Identical to mondayOf in Control
 * Center's api/_growth.ts, so both sides agree which week a packet belongs to.
 * A Sunday run therefore reports the week that began the previous Monday.
 */
export function mondayOf(d: Date): string {
  const day = d.getUTCDay()
  const back = day === 0 ? 6 : day - 1
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back))
  return m.toISOString().slice(0, 10)
}

export const YMD = /^\d{4}-\d{2}-\d{2}$/

/** ISO date (YYYY-MM-DD) of an ISO timestamp or a Date. */
export function ymdOf(v: string | number | Date): string {
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}
