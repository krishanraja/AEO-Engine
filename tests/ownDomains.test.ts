/**
 * Krish's ruling of 2026-11-13 on which domains are his: krishraja.ai,
 * krishraja.com and themindmaker.ai are; fractionl.us is not. The overlay in
 * config/own-domains.json applies it over Control Center's lists. Every
 * subject and domain here other than his ruled ones is invented.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyOwnDomains, covers, ownDomains, parseOwnDomains, type OwnDomains } from '../src/config/ownDomains.js'
import { krishHitsDomains } from '../src/pipeline/00-context.js'
import type { AeoContext, ContextSubject } from '../src/schema/context.js'
import { ROOT, fixtureContext, subject } from './helpers.js'

const FILE = JSON.parse(readFileSync(join(ROOT, 'config/own-domains.json'), 'utf8')) as Record<string, unknown>

test('the checked-in overlay validates and says what Krish ruled', () => {
  const parsed = parseOwnDomains(FILE)
  assert.equal(parsed.ok, true, JSON.stringify(parsed))
  const o = ownDomains()
  assert.deepEqual(o.krishAdd, ['krishraja.ai', 'krishraja.com', 'themindmaker.ai'])
  assert.deepEqual(o.applyKrishTo, ['mindmake'])
  assert.deepEqual(o.notOurs, ['fractionl.us'])
  assert.ok(!String(FILE._about).includes('\u2014'))
})

test('fractionl.us is never ours, even when Control Center lists it, for every kind of subject', () => {
  const ctx = structuredClone(fixtureContext()) as AeoContext
  ctx.krish.domains = [...ctx.krish.domains, 'fractionl.us', 'www.fractionl.us', 'blog.fractionl.us', 'fractionl.us/about']
  const venture = { ...subject('ctrl'), domains: ['ctrl.mindmake.co', 'fractionl.us'] } as ContextSubject
  const mindmake = { ...subject('ctrl'), slug: 'mindmake', product_slug: 'mindmake', domains: ['mindmake.co', 'FRACTIONL.US'] } as ContextSubject
  const aspiration = { ...subject('sample-studio'), domains: ['sample-studio.example', 'fractionl.us'] } as ContextSubject
  for (const s of [venture, mindmake, subject('sample-media'), aspiration]) {
    const list = krishHitsDomains(ctx, s)
    assert.ok(list.length > 0, s.slug)
    assert.ok(!list.some(d => d.includes('fractionl')), `${s.slug}: ${list.join(', ')}`)
  }
})

test("Krish's own domains count for a prospect and for the venture named in apply_krish_to, not for another venture or an aspiration", () => {
  const ctx = fixtureContext()
  const mindmake = { ...subject('ctrl'), slug: 'mindmake', product_slug: 'mindmake', domains: ['mindmake.co'] } as ContextSubject
  assert.deepEqual(krishHitsDomains(ctx, mindmake), ['mindmake.co', 'krishraja.ai', 'krishraja.com', 'themindmaker.ai'])
  // Named by its product slug when Control Center's subject slug differs.
  const byProduct = { ...mindmake, slug: 'mindmake-os' } as ContextSubject
  assert.ok(krishHitsDomains(ctx, byProduct).includes('themindmaker.ai'))
  assert.deepEqual(krishHitsDomains(ctx, subject('ctrl')), ['ctrl.mindmake.co', 'mindmake.co'])
  assert.deepEqual(krishHitsDomains(ctx, subject('sample-studio')), ['sample-studio.example'])
  assert.ok(krishHitsDomains(ctx, subject('sample-media')).includes('krishraja.ai'))
})

test('a subject entry adds and removes for that subject only', () => {
  const overlay: OwnDomains = { krishAdd: [], applyKrishTo: [], notOurs: ['fractionl.us'], subjects: { ctrl: { add: ['ctrl-docs.example'], remove: ['mindmake.co'] } } }
  assert.deepEqual(applyOwnDomains(['ctrl.mindmake.co', 'mindmake.co'], { kind: 'venture', slug: 'ctrl', product_slug: 'ctrl' }, overlay), ['ctrl-docs.example'])
  assert.deepEqual(applyOwnDomains(['mindmake.co'], { kind: 'venture', slug: 'pulse', product_slug: 'pulse' }, overlay), ['mindmake.co'])
})

test('covers: a host covers its subdomains, a path covers what is under it, and nothing else', () => {
  assert.equal(covers('fractionl.us', 'www.fractionl.us'), true)
  assert.equal(covers('fractionl.us', 'blog.fractionl.us/x'), true)
  assert.equal(covers('fractionl.us', 'notfractionl.us'), false)
  assert.equal(covers('linkedin.com/in/krishraja', 'linkedin.com/in/krishraja/details'), true)
  assert.equal(covers('linkedin.com/in/krishraja', 'linkedin.com/in/krishrajapal'), false)
  assert.equal(covers('linkedin.com/in/krishraja', 'linkedin.com'), false)
})

test('the validator refuses a misshapen overlay, a domain that is both added and not ours, and an em dash', () => {
  const good = structuredClone(FILE)
  assert.equal(parseOwnDomains({ ...good, extra: 1 }).ok, false)
  assert.equal(parseOwnDomains({ ...good, krish: { add: ['https://krishraja.ai'] } }).ok, false)
  assert.equal(parseOwnDomains({ ...good, krish: { add: ['Krishraja.ai'] } }).ok, false)
  assert.equal(parseOwnDomains({ ...good, not_ours: 'fractionl.us' }).ok, false)
  assert.equal(parseOwnDomains({ ...good, krish: { add: ['krishraja.ai', 'fractionl.us'] } }).ok, false)
  assert.equal(parseOwnDomains({ ...good, subjects: { ctrl: { add: ['x.example'], keep: [] } } }).ok, false)
  assert.equal(parseOwnDomains({ ...good, _about: 'mine \u2014 not theirs' }).ok, false)
  const { apply_krish_to: _a, ...missing } = good
  assert.equal(parseOwnDomains(missing).ok, false)
  assert.equal(parseOwnDomains({ ...good, subjects: { ctrl: { remove: ['mindmake.co'] } } }).ok, true)
})

test('only a venture product slug keys the overlay: a prospect or an aspiration is never named in this public file, nor matched by a key', () => {
  const good = structuredClone(FILE)
  // An invented prospect slug: refused as a subjects key and in apply_krish_to.
  const asSubject = parseOwnDomains({ ...good, subjects: { 'some-prospect-co': { add: ['x.example'] } } })
  assert.equal(asSubject.ok, false)
  assert.match(JSON.stringify(asSubject), /product slug/)
  assert.ok(!JSON.stringify(asSubject).includes('some-prospect-co'), 'the refusal does not echo the slug')
  assert.equal(parseOwnDomains({ ...good, apply_krish_to: ['some-prospect-co'] }).ok, false)
  assert.equal(parseOwnDomains({ ...good, subjects: { heartside: { add: ['heartside-help.example'] } }, apply_krish_to: ['mindmake', 'publication'] }).ok, true)

  // A non-venture whose slug happens to equal a product slug is not matched.
  const overlay: OwnDomains = { krishAdd: ['krishraja.ai'], applyKrishTo: ['mindmake'], notOurs: [], subjects: { mindmake: { add: ['extra.example'], remove: [] } } }
  assert.deepEqual(applyOwnDomains(['studio.example'], { kind: 'aspiration', slug: 'mindmake', product_slug: null }, overlay), ['studio.example'])
  assert.deepEqual(applyOwnDomains(['mindmake.co'], { kind: 'prospect', slug: 'mindmake', product_slug: null }, overlay), ['mindmake.co', 'krishraja.ai'], 'a prospect still reads Krish\'s domains, never a subject entry')
  assert.deepEqual(applyOwnDomains(['mindmake.co'], { kind: 'venture', slug: 'mindmake', product_slug: 'mindmake' }, overlay), ['mindmake.co', 'krishraja.ai', 'extra.example'])
})
