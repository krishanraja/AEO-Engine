import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs, uuidFromKey } from '../src/index.js'
import { CapReached, Ledger } from '../src/lib/cost.js'
import { citedHosts, hostOf, ourHits, pathPatternOf } from '../src/lib/domains.js'
import { CLEAN, callRef, normaliseQuery, questionsFrom, robustJson, scrubPII } from '../src/lib/text.js'
import { mondayOf } from '../src/lib/week.js'

test('CLEAN turns dashes into commas and caps', () => {
  assert.equal(CLEAN('one \u2014 two -- three - four', 100), 'one, two, three, four')
  assert.equal(CLEAN('full-time AI-native', 100), 'full-time AI-native')
  assert.equal(CLEAN('  spaced   out  ', 6), 'spaced')
})

test('scrubPII strips emails, handles and never-say terms', () => {
  assert.equal(scrubPII('mail me at a.b@example.com or @someone, thanks', []), 'mail me at or, thanks')
  assert.equal(scrubPII('The Acme Corp team asked', ['Acme Corp']), 'The team asked')
  assert.equal(scrubPII('keep word@word intact? no: word@word.com goes', []), 'keep word@word intact? no: goes')
})

test('callRef is eight hex characters and never the id', () => {
  const ref = callRef('ff-7c1e2a')
  assert.match(ref, /^[0-9a-f]{8}$/)
  assert.notEqual(ref, 'ff-7c1e2a')
})

test('normaliseQuery collapses phrasings', () => {
  assert.equal(normaliseQuery('How do I train an AI on my writing?'), normaliseQuery('how to train ai on your writing'))
  assert.notEqual(normaliseQuery('Should I build my own AI skill?'), normaliseQuery('Should I build my own AI skill or buy one?'))
})

test('questionsFrom splits an icp_trigger on the slash', () => {
  assert.deepEqual(questionsFrom('how do I get an AI assistant to write like me / should I build my own AI skill'), ['How do I get an AI assistant to write like me?', 'Should I build my own AI skill?'])
})

test('robustJson tolerates fences and prose', () => {
  assert.deepEqual(robustJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(robustJson('Sure: {"a":2} there'), { a: 2 })
  assert.equal(robustJson('nothing'), null)
})

test('domains helpers', () => {
  assert.equal(hostOf('https://www.Example.com/a/b'), 'example.com')
  assert.equal(hostOf('not a url'), '')
  assert.equal(pathPatternOf('https://x.example/essays/2026/pricing-ai-products'), '/essays/n')
  assert.equal(pathPatternOf('https://x.example/'), '/')
  assert.deepEqual(citedHosts(['https://a.example/1', 'https://www.a.example/2', 'https://b.example']), ['a.example', 'b.example'])
  assert.deepEqual(ourHits('see ctrl.mindmake.co', [], ['ctrl.mindmake.co', 'mindmake.co']), ['ctrl.mindmake.co'])
  assert.deepEqual(ourHits('go to (mindmake.co) now', [], ['mindmake.co']), ['mindmake.co'])
  assert.deepEqual(ourHits('nothing', ['https://mindmake.co/ctrl'], ['mindmake.co', 'krishraja.com']), ['mindmake.co'])
  assert.deepEqual(ourHits('nothing', ['https://notmindmake.co/x'], ['mindmake.co']), [])
})

test('mondayOf: a Sunday reports the week that began the previous Monday', () => {
  assert.equal(mondayOf(new Date('2026-09-13T04:00:00Z')), '2026-09-07')
  assert.equal(mondayOf(new Date('2026-09-07T00:00:00Z')), '2026-09-07')
  assert.equal(mondayOf(new Date('2026-09-08T23:59:59Z')), '2026-09-07')
})

test('the ledger charges estimates and stops at the cap', () => {
  const l = new Ledger(0.05, { perplexity: 0.02, chatgpt: 0.02, claude: 0.02, grok: 0.02, classify: 0.01, themes: 0.01, propose: 0.01, digest: 0.01 })
  l.charge('perplexity')
  l.charge('chatgpt')
  assert.equal(l.canAfford('claude'), false)
  assert.equal(l.canAfford('classify'), true)
  assert.throws(() => l.charge('claude'), CapReached)
  assert.equal(l.total, 0.04)
  assert.equal(l.summary().calls, 2)
})

test('uuidFromKey is stable and shaped like a uuid', () => {
  assert.equal(uuidFromKey('a'), uuidFromKey('a'))
  assert.notEqual(uuidFromKey('a'), uuidFromKey('b'))
  assert.match(uuidFromKey('a'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('parseArgs', () => {
  const a = parseArgs(['--subject', 'ctrl', '--week', '2026-09-10', '--dry', '--offline', '--out', 'x.json', '--command-id', '7', '--cap-usd', '3'])
  assert.equal(a.subject, 'ctrl')
  assert.equal(a.week, '2026-09-07')
  assert.equal(a.commandId, 7)
  assert.equal(a.capUsd, 3)
  assert.equal(parseArgs([], new Date('2026-09-13T04:00:00Z')).week, '2026-09-07')
  assert.throws(() => parseArgs(['--week', 'yesterday']))
  assert.throws(() => parseArgs(['--command-id', '0']))
  assert.throws(() => parseArgs(['--bogus']))
})
