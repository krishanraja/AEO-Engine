import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gapFor, tallyHosts, theyCitedFrom } from '../src/pipeline/20-gap.js'
import { subject } from './helpers.js'

test('gapFor a venture: hosts cited where we were absent, most cited first', () => {
  const g = gapFor(subject('ctrl'), ['ctrl.mindmake.co', 'mindmake.co'])
  assert.equal(g.competitor_gap.domain, 'example-writer-tools.com')
  assert.equal(g.competitor_gap.times_cited, 2)
  assert.deepEqual(g.competitor_gap.questions, ['How do I get an AI assistant to write like me?'])
  assert.equal(g.tally.get('help.example-assistant.com')?.times, 1)
  assert.equal(g.tally.has('mindmake.co'), false, 'a probe we were cited on is not a gap')
  assert.deepEqual(g.outranked.map(o => o.question), ['How do I get an AI assistant to write like me?', 'Should I build my own AI skill?'])
  assert.deepEqual(g.outranked[0].engines, ['perplexity', 'chatgpt'])
  assert.deepEqual(g.outranked[0].competitor_domains, ['example-writer-tools.com', 'help.example-assistant.com'])
  assert.deepEqual(g.they_cited, [])
})

test('competitor_domains, when given, narrows the tally', () => {
  const s = { ...subject('ctrl'), competitor_domains: ['forum.example-dev.org'] }
  const g = gapFor(s, ['ctrl.mindmake.co', 'mindmake.co'])
  assert.equal(g.competitor_gap.domain, 'forum.example-dev.org')
  assert.equal(g.tally.size, 1)
  assert.equal(g.outranked.length, 1)
})

test('gapFor an aspiration keeps the URLs the engines cite for the playbook', () => {
  const g = gapFor(subject('sample-studio'), ['sample-studio.example'])
  assert.equal(g.they_cited.length, 2)
  assert.equal(g.they_cited[0].host, 'sample-studio.example')
  assert.equal(g.they_cited[0].path_pattern, '/essays/n')
  assert.deepEqual(g.they_cited[0].questions, ['How should I price an AI product?'])
  assert.equal(g.competitor_gap.domain, 'example-vc.com', 'who is cited when the aspiration is absent')
})

test('tallyHosts and theyCitedFrom ignore our own hosts and unparsable citations', () => {
  const probes = [
    { question: 'q', engine: 'claude' as const, we_cited: false, citations: ['https://mindmake.co/x', 'not a url', 'https://www.other.example/a'] },
    { question: 'q2', engine: 'grok' as const, we_cited: false, citations: ['https://other.example/b'] },
  ]
  const t = tallyHosts(probes, ['mindmake.co'], [])
  assert.deepEqual([...t.keys()], ['other.example'])
  assert.equal(t.get('other.example')?.times, 2)
  assert.deepEqual(t.get('other.example')?.questions, ['q', 'q2'])
  assert.equal(theyCitedFrom(probes, ['mindmake.co']).length, 1)
})
