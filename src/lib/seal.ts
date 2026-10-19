/**
 * Sealed hand-off between the research jobs and the report job of one
 * workflow run.
 *
 * Each subject runs in its own job, and the one protocol report is written
 * after all of them, so their counts have to travel between jobs. The only
 * carrier GitHub offers is an artifact, and this repository is public, so an
 * artifact can be downloaded by anyone signed in. Packet stats and spend are
 * on the never-publish list, so the summary is sealed: AES-256-GCM under a
 * key derived (HKDF-SHA256) from AEO_ENGINE_SECRET and bound to the workflow
 * run, so a sealed file opens only inside the run that wrote it.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const SALT = 'aeo-engine/run-summary/v1'

function keyFor(secret: string, context: string): Buffer {
  if (!secret) throw new Error('seal: no key material')
  return Buffer.from(hkdfSync('sha256', secret, SALT, `run:${context}`, 32))
}

export function seal(value: unknown, secret: string, context: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyFor(secret, context), iv)
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()])
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
}

/** Throws on a wrong key, a wrong run, or any change to the sealed bytes. */
export function unseal(sealed: string, secret: string, context: string): unknown {
  const j = JSON.parse(sealed) as { v?: number; iv?: string; tag?: string; data?: string }
  if (j.v !== 1 || !j.iv || !j.tag || !j.data) throw new Error('seal: not a sealed summary')
  const d = createDecipheriv('aes-256-gcm', keyFor(secret, context), Buffer.from(j.iv, 'base64'))
  d.setAuthTag(Buffer.from(j.tag, 'base64'))
  const out = Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()])
  return JSON.parse(out.toString('utf8'))
}
