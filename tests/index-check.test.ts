/**
 * The Brave index check (brief G4; protocol, "AEO-Engine's index check";
 * Ruling, Krish, 2026-11-14: Brave at $5 per 1,000 calls, at most $0.05 a day).
 * Control Center holds the Brave key and asks Brave; this engine decides what
 * to look up, through the research desk's `index_check` kind, and never sends
 * more than 10 a UTC day, whatever Control Center offers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BRAVE_USD_PER_CALL, INDEX_CHECK_MAX_PER_DAY, INDEX_CHECK_MAX_USD_PER_DAY, planIndexChecks, runIndexChecks, type ResearchDesk, type ResearchRow } from '../src/protocol/indexCheck.js'
import type { RunSummary, SubjectSummary } from '../src/protocol/measure.js'
import type { KitCandidate } from '../src/schema/kit.js'

const NOW = new Date('2026-11-22T09:00:00Z')

const kit = (n: number, over: Partial<KitCandidate> = {}): KitCandidate => ({
  product_slug: 'mindmake', query_id: `q${String(n).padStart(8, '0')}abcdef`, priority: 1, title: `question ${n}`,
  exact_payload: 'x', gap_class: 'not_retrieved', target_kind: 'update_page', reference: `https://mindmake.co/p${n}`, question: `how do I do thing ${n}?`, ...over,
})

const sub = (slug: string, k?: KitCandidate, backups: KitCandidate[] = []): SubjectSummary => ({ slug, kind: 'venture', ...(k ? { kit_candidate: k } : {}), ...(backups.length ? { kit_backups: backups } : {}) } as unknown as SubjectSummary)
const summary = (subjects: SubjectSummary[]): RunSummary => ({ v: 1, subject_arg: 'all', week_start: '2026-11-16', generated_at: NOW.toISOString(), engines: ['perplexity'], cap_usd: 5, spent_usd: 1, max_probe_usd: 0.07, error_code: null, subjects })

class Desk implements ResearchDesk {
  posted: Array<{ request_id: string; kind: string; query: string }> = []
  constructor(public caps: unknown, public rows: ResearchRow[] = [], public status = 'answered') {}
  async getCapabilities() { return this.caps }
  async listResearch() { return this.rows }
  async postResearch(reqs: Array<{ request_id: string; kind: string; subject_ref: string; query: string; why: string }>) {
    this.posted.push(...reqs)
    return reqs.map(r => ({ request_id: r.request_id, kind: r.kind, status: this.status, answer: 'ranked 3 of 20' }))
  }
}
const offered = (perDay = 10) => ({ research: { kinds: ['index_check'], per_day: { index_check: perDay } } })

test('the daily cap is 10 checks and $0.05 at Brave\'s $5 per 1,000', () => {
  assert.equal(INDEX_CHECK_MAX_PER_DAY, 10)
  assert.equal(BRAVE_USD_PER_CALL, 0.005)
  assert.equal(INDEX_CHECK_MAX_USD_PER_DAY, 0.05)
  assert.ok(INDEX_CHECK_MAX_PER_DAY * BRAVE_USD_PER_CALL <= INDEX_CHECK_MAX_USD_PER_DAY + 1e-12)
})

test('the plan asks one check per kit with an https page, top kits first, deduplicated', () => {
  const plan = planIndexChecks([summary([
    sub('a', kit(1), [kit(2), kit(3, { reference: 'mindmake.co' })]),
    sub('b', kit(4, { reference: 'https://mindmake.co/p1', query_id: 'q00000001abcdef' })),
    sub('c', kit(5, { question: undefined })),
    sub('d'),
  ])], NOW)
  assert.deepEqual(plan.map(p => p.query), ['https://mindmake.co/p1 | how do I do thing 1?', 'https://mindmake.co/p2 | how do I do thing 2?'])
  assert.ok(plan.every(p => p.kind === 'index_check' && p.request_id.startsWith('aeo:index:2026-11-22:')))
  assert.ok(plan.every(p => p.query.length <= 400))
})

test('never more than 10 a day, even when Control Center offers more', async () => {
  const many = Array.from({ length: 15 }, (_, i) => sub(`s${i}`, kit(i + 1)))
  const desk = new Desk(offered(50))
  const out = await runIndexChecks(desk, [summary(many)], NOW)
  assert.equal(desk.posted.length, 10)
  assert.equal(out.asked, 10)
  assert.equal(out.skipped_cap, 5)
  assert.ok(out.usd_estimate <= INDEX_CHECK_MAX_USD_PER_DAY)
})

test('checks already asked today count against the 10, so a second run that day asks only the rest', async () => {
  const today: ResearchRow[] = Array.from({ length: 7 }, (_, i) => ({ request_id: `aeo:index:2026-11-22:old${i}`, kind: 'index_check', status: 'answered', requested_at: '2026-11-22T04:10:00Z' }))
  const yesterday: ResearchRow[] = Array.from({ length: 9 }, (_, i) => ({ request_id: `aeo:index:2026-11-21:old${i}`, kind: 'index_check', status: 'answered', requested_at: '2026-11-21T23:59:00Z' }))
  const desk = new Desk(offered(), [...today, ...yesterday])
  const out = await runIndexChecks(desk, [summary(Array.from({ length: 6 }, (_, i) => sub(`s${i}`, kit(i + 1))))], NOW)
  assert.equal(out.used_today, 7)
  assert.equal(desk.posted.length, 3)
})

test('at the day\'s cap nothing is sent', async () => {
  const rows: ResearchRow[] = Array.from({ length: 10 }, (_, i) => ({ request_id: `x${i}`, kind: 'index_check', status: 'answered', requested_at: '2026-11-22T01:00:00Z' }))
  const desk = new Desk(offered(), rows)
  const out = await runIndexChecks(desk, [summary([sub('a', kit(1))])], NOW)
  assert.equal(desk.posted.length, 0)
  assert.equal(out.status, 'cap_reached')
})

test('a lower cap from Control Center wins', async () => {
  const desk = new Desk(offered(2))
  await runIndexChecks(desk, [summary(Array.from({ length: 5 }, (_, i) => sub(`s${i}`, kit(i + 1))))], NOW)
  assert.equal(desk.posted.length, 2)
})

test('held, sending nothing, while Control Center does not offer index_check', async () => {
  for (const caps of [{}, { research: { kinds: ['search'], per_day: { search: 10 } } }, null]) {
    const desk = new Desk(caps)
    const out = await runIndexChecks(desk, [summary([sub('a', kit(1))])], NOW)
    assert.equal(out.status, 'held')
    assert.equal(desk.posted.length, 0)
  }
})

test('the history unread means nothing is sent: an unknown count is never taken as zero', async () => {
  const desk = new Desk(offered())
  desk.listResearch = async () => { throw new Error('research_server_error') }
  const out = await runIndexChecks(desk, [summary([sub('a', kit(1))])], NOW)
  assert.equal(out.status, 'held')
  assert.equal(desk.posted.length, 0)
})

test('the outcome is counts only: no question, URL or answer', async () => {
  const desk = new Desk(offered())
  const out = await runIndexChecks(desk, [summary([sub('a', kit(1)), sub('b', kit(2))])], NOW)
  assert.deepEqual(Object.keys(out).sort(), ['answered', 'asked', 'failed', 'over_cap', 'planned', 'skipped_cap', 'status', 'usd_estimate', 'used_today'].sort())
  assert.equal(out.answered, 2)
  assert.doesNotMatch(JSON.stringify(out), /https|thing|ranked/)
})
