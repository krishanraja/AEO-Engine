/**
 * This engine's copy of the growth engine protocol (docs/control-center/),
 * copied verbatim from Control Center's docs/app/growth/protocol-bundle/
 * (protocol 1.28.0, "Keep one copy of this protocol"). bundle.json holds the
 * version, each file's sha256 and one bundle_sha256: sha256 of
 * "version <v>\n" then one "<file> <sha256>\n" line per file in name order.
 *
 * Each run compares that bundle_sha256 with the one capabilities serve as
 * protocol_bundle and reports one counted line, protocol_copy: current,
 * behind <version>, or unknown when capabilities cannot be read. A copy
 * that is behind is never a reason to hold a run.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface Bundle { version: string; files: Record<string, string>; bundle_sha256: string }

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')

/** The digest the protocol defines over a bundle's version and file hashes. */
export function bundleDigest(version: string, files: Record<string, string>): string {
  const names = Object.keys(files).sort()
  return sha256(`version ${version}\n${names.map(n => `${n} ${files[n]}\n`).join('')}`)
}

export function bundleDir(): string {
  return fileURLToPath(new URL('../../docs/control-center/', import.meta.url))
}

/** Reads bundle.json as it is; null when it is missing or misshapen. */
export function readBundle(dir = bundleDir()): Bundle | null {
  try {
    const j = JSON.parse(readFileSync(`${dir}bundle.json`, 'utf8')) as Record<string, unknown>
    const files = j.files as Record<string, unknown>
    if (typeof j.version !== 'string' || typeof j.bundle_sha256 !== 'string' || !files || typeof files !== 'object') return null
    if (!Object.values(files).every(v => typeof v === 'string')) return null
    return { version: j.version, files: files as Record<string, string>, bundle_sha256: j.bundle_sha256 }
  } catch { return null }
}

/** Every file in the copy against its sha256, and the bundle digest. Empty when the copy is whole. */
export function bundleProblems(dir = bundleDir()): string[] {
  const b = readBundle(dir)
  if (!b) return ['bundle.json is missing or misshapen']
  const out: string[] = []
  for (const [name, want] of Object.entries(b.files)) {
    let got: string
    try { got = sha256(readFileSync(`${dir}${name}`)) } catch { out.push(`${name} is missing`); continue }
    if (got !== want) out.push(`${name} does not match its sha256`)
  }
  if (bundleDigest(b.version, b.files) !== b.bundle_sha256) out.push('bundle_sha256 does not match the files')
  return out
}

/** Capabilities' protocol_bundle, read defensively; null when absent or misshapen. */
export function servedBundle(capabilities: unknown): { version: string; bundle_sha256: string } | null {
  const p = (capabilities && typeof capabilities === 'object' ? (capabilities as Record<string, unknown>).protocol_bundle : null) as Record<string, unknown> | null
  if (!p || typeof p.version !== 'string' || typeof p.bundle_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.bundle_sha256)) return null
  return { version: p.version.slice(0, 20), bundle_sha256: p.bundle_sha256 }
}

/** current, behind <version>, or unknown (capabilities unread, or this copy not whole). */
export function protocolCopyState(local: Bundle | null, served: { version: string; bundle_sha256: string } | null): string {
  if (!local || !served) return 'unknown'
  return local.bundle_sha256 === served.bundle_sha256 ? 'current' : `behind ${served.version}`
}
