import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OfflineControlCenter } from '../src/clients/offline.js'
import { krishHitsDomains, loadContext } from '../src/pipeline/00-context.js'
import { FIXTURES, fixtureContext, subject } from './helpers.js'

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
  assert.deepEqual(krishHitsDomains(ctx, subject('sample-media')), ['mindmake.co', 'krishraja.com', 'mindmakerlive.substack.com', 'linkedin.com/in/krishraja'])
  assert.deepEqual(krishHitsDomains(ctx, subject('sample-studio')), ['sample-studio.example'])
})
