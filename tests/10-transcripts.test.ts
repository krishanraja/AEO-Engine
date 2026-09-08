import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OfflineFireflies } from '../src/clients/offline.js'
import { FirefliesUnavailable, type FirefliesClient, type Transcript } from '../src/clients/types.js'
import { Ledger } from '../src/lib/cost.js'
import { callRef } from '../src/lib/text.js'
import { classifyTranscripts, excerptOf, gatherTranscripts, themesForSubject, type Attribution, type Gathered } from '../src/pipeline/10-transcripts.js'
import { FIXTURES, StubModel, fixtureContext, subject } from './helpers.js'

const now = new Date('2026-09-08T04:00:00Z')
const ctx = fixtureContext()
const ctrl = subject('ctrl')

const failing = (e: Error): FirefliesClient => ({ listTranscripts: async () => { throw e }, getTranscript: async () => { throw e } })

test('gatherTranscripts: no client means unavailable, never no_calls', async () => {
  const g = await gatherTranscripts(null, now)
  assert.equal(g.status, 'unavailable')
  assert.match(g.error ?? '', /FIREFLIES_API_KEY/)
})

test('gatherTranscripts: fixtures give two calls; any error is unavailable', async () => {
  const ok = await gatherTranscripts(new OfflineFireflies(FIXTURES), now)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.transcripts.length, 2)
  const a = await gatherTranscripts(failing(new FirefliesUnavailable('boom')), now)
  assert.equal(a.status, 'unavailable')
  assert.equal(a.error, 'boom')
  const b = await gatherTranscripts(failing(new Error('socket')), now)
  assert.equal(b.status, 'unavailable')
  assert.match(b.error ?? '', /^unexpected/)
})

test('excerptOf renumbers speakers and strips emails before the model sees anything', () => {
  const t: Transcript = {
    id: 'x', title: 'Call', date: '2026-09-03T10:00:00Z',
    sentences: [{ text: 'Hi, reach me at a.person@example.com', speaker_name: 'Someone Real' }, { text: 'Sure', speaker_name: 'Another Person' }, { text: 'Bye', speaker_name: 'Someone Real' }],
    summary: { overview: 'A call', keywords: ['k'], action_items: [] },
  }
  const ex = excerptOf(t)
  assert.ok(ex.includes('Speaker 1: Hi, reach me at'))
  assert.ok(ex.includes('Speaker 2: Sure'))
  assert.ok(!ex.includes('Someone Real') && !ex.includes('Another Person') && !ex.includes('@example.com'))
  assert.ok(ex.includes('Date: 2026-09-03'))
})

test('classifyTranscripts: one call per transcript, unknown ids and failures become null', async () => {
  const g = await gatherTranscripts(new OfflineFireflies(FIXTURES), now)
  const ledger = new Ledger(10)
  const model = new StubModel(req => (req.key === 'ff-7c1e2a' ? `{"subject_id":"${ctrl.id}","confidence":0.9,"reason":"fits"}` : '{"subject_id":"not-a-subject","confidence":0.9,"reason":"x"}'))
  const map = await classifyTranscripts(model, g.transcripts, ctx.subjects, ledger)
  assert.equal(map.get('ff-7c1e2a')?.subject_id, ctrl.id)
  assert.equal(map.get('ff-9d4b1f')?.subject_id, null)
  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[0].stage, 'classify')
  assert.ok(!model.requests[0].user.includes('@'))
  assert.equal(ledger.summary().by_kind.classify.calls, 2)
  const broken = await classifyTranscripts(new StubModel('THROW'), g.transcripts, ctx.subjects, new Ledger(10))
  assert.equal(broken.get('ff-7c1e2a')?.reason, 'classifier failed')
})

test('themesForSubject: every status', async () => {
  const gathered = await gatherTranscripts(new OfflineFireflies(FIXTURES), now)
  const none = new Map<string, Attribution>()
  const mine = new Map<string, Attribution>([['ff-7c1e2a', { subject_id: ctrl.id, confidence: 0.9, reason: '' }], ['ff-9d4b1f', { subject_id: ctrl.id, confidence: 0.5, reason: 'too low' }]])
  const ledger = new Ledger(10)

  const asp = await themesForSubject(new StubModel('{}'), subject('sample-studio'), gathered, mine, ledger)
  assert.equal(asp.themes_status, 'not_applicable')
  assert.deepEqual(asp.calls, { considered: 2, attributed: 0 })

  const unavailable: Gathered = { status: 'unavailable', transcripts: [], error: 'x' }
  const fu = await themesForSubject(new StubModel('{}'), ctrl, unavailable, none, ledger)
  assert.equal(fu.themes_status, 'fireflies_unavailable')
  assert.deepEqual(fu.calls, { considered: 0, attributed: 0 })

  const empty: Gathered = { status: 'ok', transcripts: [] }
  assert.equal((await themesForSubject(new StubModel('{}'), ctrl, empty, none, ledger)).themes_status, 'no_calls')

  const na = await themesForSubject(new StubModel('{}'), ctrl, gathered, none, ledger)
  assert.equal(na.themes_status, 'no_attributed_calls')
  assert.deepEqual(na.calls, { considered: 2, attributed: 0 })
  assert.equal(ledger.summary().calls, 0, 'no model call was charged so far')

  const ref = callRef('ff-7c1e2a')
  const model = new StubModel(JSON.stringify({ themes: [
    { theme: 'Voice drift \u2014 heavy editing', evidence: [
      { call_ref: ref, date: '2020-01-01', paraphrase: 'They said mail someone@example.com about the drift' },
      { call_ref: 'deadbeef', date: '2026-09-03', paraphrase: 'invented' },
    ] },
    { theme: '', evidence: [] },
  ] }))
  const ok = await themesForSubject(model, ctrl, gathered, mine, ledger)
  assert.equal(ok.themes_status, 'ok')
  assert.deepEqual(ok.calls, { considered: 2, attributed: 1 })
  assert.equal(ok.themes.length, 1)
  assert.equal(ok.themes[0].theme, 'Voice drift, heavy editing')
  assert.equal(ok.themes[0].calls, 1)
  assert.equal(ok.themes[0].evidence.length, 1)
  assert.equal(ok.themes[0].evidence[0].date, '2026-09-03', 'the date is the call\'s own date')
  assert.ok(!ok.themes[0].evidence[0].paraphrase.includes('@'))
  assert.equal(ledger.summary().by_kind.themes.calls, 1)
  assert.ok(model.requests[0].user.includes(`call_ref ${ref}`))
  assert.ok(!model.requests[0].user.includes('ff-7c1e2a'), 'the transcript id never reaches the model')

  await assert.rejects(themesForSubject(new StubModel('{"themes":[]}'), ctrl, gathered, mine, ledger), /no usable themes/)
})
