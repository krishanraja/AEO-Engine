/**
 * Canonical JSON and its SHA-256, exactly as Control Center's growth engine
 * protocol computes `payload_sha256`: object keys sorted at every depth, no
 * whitespace, arrays kept in order, strings as JSON.stringify writes them, no
 * Unicode normalisation. A key whose value is undefined is left out, as
 * JSON.stringify leaves it out. The digest of the protocol's worked example
 * is pinned in tests/protocol.test.ts.
 */
import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value)
    if (s === undefined) throw new Error('canonicalJson: value has no JSON form')
    return s
  }
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] === undefined) continue
    parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  }
  return `{${parts.join(',')}}`
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** The digest of a report: canonical JSON of everything but its own payload_sha256. */
export function reportDigest(report: Record<string, unknown>): string {
  const { payload_sha256: _drop, ...rest } = report
  return sha256Hex(canonicalJson(rest))
}
