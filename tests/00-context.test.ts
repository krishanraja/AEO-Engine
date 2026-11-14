import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OfflineControlCenter } from '../src/clients/offline.js'
import { krishHitsDomains, loadContext } from '../src/pipeline/00-context.js'
import { FIXTURES, fixtureContext, subject } from './helpers.js'
import { urlMatchesDomain } from '../src/lib/domains.js'

const cc = new OfflineControlCenter(FIXTURES)

test('all selects every subject; a slug or a uuid selects one', async () => {
  assert.equal((await loadContext(cc, 'all')).selected.length, 3)
  assert.equal((await loadContext(cc, 'ctrl')).selected[0].slug, 'ctrl')
  assert.equal((await loadContext(cc, '2c8a4d3f-5b6e-4d9c-8f2a-3b4c5d6e7f80')).selected[0].slug, 'sample-media')
  // The whole context is kept even when one subject is selected: classification needs every subject.
  assert.equal((await loadContext(cc, 'ctrl')).ctx.subjects.length, 3)
})

test('an unknown subject names the known slugs', async () => {
  await assert.rejects(loadContext(cc, 'nope'), /known slugs: ctrl, sample-media, sample-studio/)
})

test('krish_hits_domains: own domains for ventures and aspirations, Mindmake for prospects', () => {
  const ctx = fixtureContext()
  assert.deepEqual(krishHitsDomains(ctx, subject('ctrl')), ['ctrl.mindmake.co', 'mindmake.co'])
  // A prospect reads against Krish's domains, plus the ones he ruled are his (config/own-domains.json).
  assert.deepEqual(krishHitsDomains(ctx, subject('sample-media')), ['mindmake.co', 'krishraja.com', 'mindmakerlive.substack.com', 'home.makeyourmindup.ai', 'makeyourmindup.ai', 'linkedin.com/in/krish-raja', 'krishraja.ai', 'themindmaker.ai'])
  assert.deepEqual(krishHitsDomains(ctx, subject('sample-studio')), ['sample-studio.example'])
})

// Audit krish-raja-3 (2026-11-14): Krish's LinkedIn profile is /in/krish-raja
// (his site, krish-raja src/content/site.ts). The list is Control Center's
// (content-engine KRISH_DOMAINS); this fixture mirrors it, so a citation of
// his real profile counts as ours and the wrong slug never does.
test('Krish\'s own domains: his real LinkedIn profile counts, the wrong slug does not', () => {
  const ctx = fixtureContext()
  const domains = krishHitsDomains(ctx, subject('sample-media'))
  const ours = (url: string) => domains.some(d => urlMatchesDomain(url, d))
  assert.equal(ours('https://www.linkedin.com/in/krish-raja/'), true)
  assert.equal(ours('https://uk.linkedin.com/in/krish-raja/details/experience/'), true)
  assert.equal(ours('https://www.linkedin.com/in/krishraja'), false, 'someone else\'s slug is never his')
})
