import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { GrowthEngineHttp } from '../src/clients/growthEngine.js'
import { readDirectiveInputs } from '../src/index.js'
import { SOURCE_TYPES } from '../src/lib/sourceType.js'
import { cleanCitation } from '../src/pipeline/40-probe.js'
import { attachFeatures, fanOutFor, retrievedFor } from '../src/pipeline/68-features.js'
import { venturePage } from '../src/pipeline/62-kits.js'
import { requestShipped, requestTargets } from '../src/pipeline/run.js'
import { GAP_CLASSES, HOST_GATES, TARGET_KINDS } from '../src/schema/kit.js'
import {
  DIGEST_WRITERS, ENGINES_ALL, GATED_ENGINES, PACKET_FEATURES, PRODUCT_SLUGS, QUERY_SOURCES, QUERY_STATUSES, RUN_KINDS, SUBJECT_KINDS, THEMES_STATUSES, TRENDS,
  packetFeatures, validatePacket, type AeoPacket,
} from '../src/schema/packet.js'
import { PANEL_STATES } from '../src/schema/panel.js'
import { parseAnswerRequests, parseFeatures } from '../src/schema/report.js'
import { featuredRun, strip } from './golden.js'
import { ROOT, readJson } from './helpers.js'
import { schemaErrors } from './schema-check.js'
import { captureStderr, StandIn } from './standin.js'

const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'docs/packet.schema.json'), 'utf8')) as Record<string, unknown>
const OFF = () => readJson('expected/packet.ctrl.json') as AeoPacket
const ON = () => readJson('expected/packet.ctrl.features.json') as AeoPacket
const TOKEN = 'gen1_synthetic-token-never-to-be-logged-0123456789abcdef'

/** Which field of a packet belongs to which feature, wherever it sits. */
const FIELDS: Record<string, (p: AeoPacket) => boolean> = {
  probe_detail: p => p.queries.some(q => q.probes.some(x => 'retrieved' in x || 'searched' in x || 'fan_out' in x || 'our_position' in x)),
  name_mentions: p => p.queries.some(q => q.probes.some(x => 'name_mentioned' in x)),
  samples: p => p.queries.some(q => q.probes.some(x => 'samples' in x)),
  panel: p => p.queries.some(q => 'panel' in q),
  diagnosis: p => p.queries.some(q => 'diagnosis' in q),
  kits: p => 'kits' in p,
  site: p => 'site' in p,
  run_kind: p => 'run_kind' in p,
}

// ---------- the two golden packets ----------

test('features off: the packet is byte for byte the current expected one', async () => {
  const r = await featuredRun('ctrl', [])
  assert.deepEqual(r.failures, [])
  assert.deepEqual(strip(r.results[0].packet), strip(OFF()))
  for (const [f, has] of Object.entries(FIELDS)) assert.equal(has(r.results[0].packet), false, `${f} absent`)
})

test('features on, all listed: the packet matches its own golden, and every gated field is there', async () => {
  const r = await featuredRun('ctrl')
  assert.deepEqual(r.failures, [])
  const p = r.results[0].packet
  assert.deepEqual(strip(p), strip(ON()))
  for (const [f, has] of Object.entries(FIELDS)) assert.equal(has(p), true, `${f} present`)
  // The closed v1 part is unchanged underneath: drop the gated fields and it is the features-off packet.
  const bare = structuredClone(p) as unknown as Record<string, unknown>
  for (const k of ['kits', 'site', 'run_kind']) delete bare[k]
  for (const q of (bare as unknown as AeoPacket).queries) {
    delete (q as unknown as Record<string, unknown>).panel
    delete (q as unknown as Record<string, unknown>).diagnosis
    for (const x of q.probes) for (const k of ['retrieved', 'searched', 'fan_out', 'our_position', 'name_mentioned', 'samples']) delete (x as unknown as Record<string, unknown>)[k]
  }
  assert.deepEqual(strip(bare as unknown as AeoPacket), strip(OFF()))
  assert.equal(p.run_kind, 'research')
  assert.ok((p.kits ?? []).length > 0 && (p.kits ?? []).length <= 10)
  assert.ok(p.queries.some(q => q.panel?.state === 'won'))
  assert.ok(p.queries.flatMap(q => q.probes).some(x => x.samples && x.samples.n === 3), 'contested questions were sampled three times')
  assert.ok(p.queries.flatMap(q => q.probes).every(x => typeof x.name_mentioned === 'boolean'), 'the venture has a distinctive name, so every answer is read for it')
})

test('each gated field goes only when its own feature is listed', async () => {
  for (const f of Object.keys(FIELDS)) {
    const r = await featuredRun('ctrl', [f])
    assert.deepEqual(r.failures, [], f)
    const p = r.results[0].packet
    for (const [g, has] of Object.entries(FIELDS)) assert.equal(has(p), g === f, `listed ${f}: ${g}`)
  }
  // An unknown feature name opens nothing.
  const odd = await featuredRun('ctrl', ['something_new'])
  assert.deepEqual(strip(odd.results[0].packet), strip(OFF()))
  assert.deepEqual(packetFeatures(['kits', 'kits', 'nope', 3]), ['kits'])
})

test('validatePacket refuses every field whose feature is not listed, and takes it once listed', () => {
  assert.deepEqual(validatePacket(ON(), { features: [...PACKET_FEATURES] }), { ok: true, packet: ON() })
  const none = validatePacket(ON())
  assert.equal(none.ok, false)
  const errs = none.ok ? [] : none.errors
  for (const k of ['retrieved', 'searched', 'fan_out', 'our_position', 'name_mentioned', 'samples', 'panel', 'diagnosis', 'kits', 'site', 'run_kind']) {
    assert.ok(errs.some(e => e.includes(`unexpected key "${k}"`)), `${k} refused`)
  }
  for (const f of Object.keys(FIELDS)) {
    const v = validatePacket(ON(), { features: PACKET_FEATURES.filter(x => x !== f) })
    assert.equal(v.ok, false, `without ${f}`)
  }
  // The older form, open gated engines, still reads, and opens no field.
  assert.equal(validatePacket(OFF(), ['gemini']).ok, true)
  assert.equal(validatePacket(ON(), ['gemini']).ok, false)
})

test('validatePacket checks the gated fields\' own rules', () => {
  const all = { features: [...PACKET_FEATURES] }
  const errorsOf = (p: AeoPacket) => { const v = validatePacket(p, all); return v.ok ? [] : v.errors }
  const bad = ON()
  const probe = bad.queries.find(q => q.probes.some(x => x.samples))!.probes.find(x => x.samples)!
  probe.samples = { n: 3, first: 4, cited: 0 }
  bad.queries[0].panel = { ...bad.queries[0].panel!, state: 'winning' as never, last_asked: '2026-9-7' }
  bad.queries[1].diagnosis = { ...bad.queries[1].diagnosis!, alignment: 1.5 }
  bad.queries[2].probes[0].fan_out = ['x'.repeat(201)]
  bad.kits![0].query_id = '00000000-0000-4000-8000-000000000000'
  bad.kits![1].kit_id = bad.kits![0].kit_id
  bad.site!.hosts[0].gates[0].gate = 'made_up' as never
  ;(bad as unknown as Record<string, unknown>).run_kind = 'shadow'
  const errs = errorsOf(bad)
  for (const want of ['samples.first: above', 'panel.state', 'panel.last_asked', 'diagnosis.alignment: above 1', 'fan_out[0]: longer than 200', 'kits[0].query_id: not one of the packet', 'kits[1].kit_id: repeated', 'gates[0].gate', 'run_kind']) {
    assert.ok(errs.some(e => e.includes(want)), want)
  }
})

test('both golden packets, and the prospect\'s, validate against docs/packet.schema.json itself', () => {
  assert.deepEqual(schemaErrors(SCHEMA, OFF()), [])
  assert.deepEqual(schemaErrors(SCHEMA, ON()), [])
  assert.deepEqual(schemaErrors(SCHEMA, readJson('expected/packet.sample-media.json')), [])
  // And the schema checker is not a rubber stamp: it refuses what the file refuses.
  const bad = ON() as unknown as Record<string, unknown>
  ;(bad.queries as Array<Record<string, unknown>>)[0].panel = { state: 'won' }
  bad.extra = 1
  const errs = schemaErrors(SCHEMA, bad)
  assert.ok(errs.some(e => e.includes('panel.first_seen: required')))
  assert.ok(errs.some(e => e.includes('$.extra: unknown field')))
})

test('the TypeScript enums and the JSON schema agree', () => {
  const defs = SCHEMA.$defs as Record<string, Record<string, unknown>>
  const props = SCHEMA.properties as Record<string, Record<string, unknown>>
  const query = (defs.query.properties as Record<string, Record<string, unknown>>)
  const kit = defs.kit.properties as Record<string, Record<string, unknown>>
  const enumOf = (x: Record<string, unknown>) => x.enum as string[]
  assert.deepEqual(enumOf(defs.engine), [...ENGINES_ALL, ...GATED_ENGINES], 'engines, gemini behind engine_gemini')
  assert.deepEqual(enumOf(defs.kind), [...SUBJECT_KINDS])
  assert.deepEqual(enumOf(query.status), [...QUERY_STATUSES], 'query statuses')
  assert.deepEqual(enumOf(query.source), [...QUERY_SOURCES])
  assert.deepEqual(enumOf(query.trend), [...TRENDS])
  assert.deepEqual(enumOf(props.themes_status), [...THEMES_STATUSES], 'themes statuses')
  assert.deepEqual(enumOf((props.stats.properties as Record<string, Record<string, unknown>>).digest_writer), [...DIGEST_WRITERS])
  assert.deepEqual(enumOf(defs.gap_class), [...GAP_CLASSES], 'gap classes')
  assert.deepEqual(enumOf((defs.panel.properties as Record<string, Record<string, unknown>>).state), [...PANEL_STATES], 'panel states')
  assert.deepEqual(enumOf(defs.source_type), [...SOURCE_TYPES])
  assert.deepEqual(enumOf(kit.product_slug), [...PRODUCT_SLUGS])
  assert.deepEqual(enumOf((((props.subject.properties as Record<string, Record<string, unknown>>).product_slug.oneOf as Array<Record<string, unknown>>)[0])), [...PRODUCT_SLUGS])
  assert.deepEqual(enumOf((kit.target.properties as Record<string, Record<string, unknown>>).kind), [...TARGET_KINDS])
  assert.deepEqual(enumOf(props.run_kind), [...RUN_KINDS])
  const gate = ((((props.site.properties as Record<string, Record<string, unknown>>).hosts.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).gates.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
  assert.deepEqual(enumOf(gate.gate), [...HOST_GATES])
})

// ---------- the cleaning, and a kit that would break a rule ----------

test('gated fields are cleaned like the rest: no handle, email or em dash, each once, within their caps', () => {
  const ev = { engine: 'chatgpt' as const, citations: [], retrieved: ['https://a.example/1', 'https://medium.com/@someone/x', 'https://a.example/1', ...Array.from({ length: 30 }, (_, i) => `https://b.example/${i}`)], fan_out: ['best tools \u2014 for writers', 'ask someone@example.com', 'ask @someone', 'best tools, for writers', ...Array.from({ length: 12 }, (_, i) => `query ${i}`)] }
  const r = retrievedFor(ev)
  assert.equal(r.length, 20)
  assert.ok(!r.some(u => u.includes('@')))
  assert.equal(r.filter(u => u === 'https://a.example/1').length, 1)
  const f = fanOutFor(ev)
  assert.equal(f.length, 8)
  assert.equal(f[0], 'best tools, for writers')
  assert.ok(!f.some(x => /@|\u2014/.test(x)))
  assert.equal(f.filter(x => x === 'best tools, for writers').length, 1)
  // A raw search result with an em dash in its URL is percent-encoded, as a browser sends it, and the packet still ships.
  const dashed = retrievedFor({ engine: 'chatgpt', citations: [], retrieved: ['https://news.example/ai\u2014writing-guide', 'https://a.example/x'], fan_out: [] })
  assert.deepEqual(dashed, ['https://news.example/ai%E2%80%94writing-guide', 'https://a.example/x'])
  const p = ON()
  const probe = p.queries.flatMap(q => q.probes).find(x => Array.isArray(x.retrieved))!
  probe.retrieved = dashed
  assert.deepEqual(validatePacket(p, { features: [...PACKET_FEATURES] }), { ok: true, packet: p })
  assert.equal(cleanCitation('https://news.example/ai\u2014writing-guide'), 'https://news.example/ai%E2%80%94writing-guide', 'a citation too')
})

test('a kit that would break a packet rule is left out on its own, and the packet still ships', () => {
  const p = ON()
  const kits = structuredClone(p.kits!)
  kits[0].evidence = ['write to someone@example.com']
  const base = OFF()
  const out = attachFeatures(base, { features: ['kits'], details: new Map(), evidence: new Map(), kits })
  assert.equal(out.kitsDropped, 1)
  assert.equal(out.packet.kits?.length, kits.length - 1)
  assert.equal(validatePacket(out.packet, { features: ['kits'] }).ok, true)
})

test('two kits sharing a kit_id (the first 8 of their query ids): only the first goes, and the packet still ships', () => {
  const p = ON()
  const base = OFF()
  const [first] = p.kits!
  const twin = { ...structuredClone(first), query_id: base.queries.find(q => q.query_id !== first.query_id && q.query_id.slice(0, 8) !== first.query_id.slice(0, 8))!.query_id }
  const out = attachFeatures(base, { features: ['kits'], details: new Map(), evidence: new Map(), kits: [first, twin] })
  assert.equal(out.kitsDropped, 1)
  assert.deepEqual(out.packet.kits?.map(k => k.query_id), [first.query_id], 'the higher-priority, first kit stays')
  assert.equal(validatePacket(out.packet, { features: ['kits'] }).ok, true)
})

// ---------- request v2: targets and shipped pages ----------

test('request v2: targets as pages and shipped pages are read only when the directive serves answer_requests_v2', () => {
  const base = { request_id: '0f8fad5b-d9cb-469f-a165-70867728950e', engine_id: 'growth-heartside', product_slug: 'heartside', subject_slug: 'heartside', questions: ['What gift says my dog loves me?'], requested_at: '2026-11-20T05:00:00Z' }
  const raw = [{ ...base, mode: 'append', targets: [{ question: 'What gift says my dog loves me?', url: 'https://heartside.io/answers/dog-gift' }, { question: 'short', url: 'https://heartside.io/x' }, { question: 'What else could be asked here?', url: 'mailto:x' }], shipped: [{ question: 'What gift says my dog loves me?', url: 'https://heartside.io/answers/dog-gift', shipped_at: '2026-11-19T10:00:00Z' }, { query_id: '0F8FAD5B-D9CB-469F-A165-70867728950E', url: 'https://heartside.io/p' }, { url: 'https://heartside.io/no-question' }] }]
  const v1 = parseAnswerRequests(raw)
  assert.ok(!('target_urls' in v1[0]) && !('shipped' in v1[0]), 'without the flag, nothing new is read')
  const [v2] = parseAnswerRequests(raw, { v2: true })
  assert.equal(v2.mode, 'append')
  assert.deepEqual(v2.target_urls, [{ question: 'What gift says my dog loves me?', url: 'https://heartside.io/answers/dog-gift' }])
  assert.deepEqual(v2.shipped, [
    { question: 'What gift says my dog loves me?', url: 'https://heartside.io/answers/dog-gift', shipped_at: '2026-11-19T10:00:00Z' },
    { query_id: '0f8fad5b-d9cb-469f-a165-70867728950e', url: 'https://heartside.io/p', shipped_at: null },
  ])
  assert.equal(requestShipped([v2]).length, 2)
  assert.equal(requestTargets([v2]).get('gift says dog loves'), 'https://heartside.io/answers/dog-gift')
  assert.equal(parseFeatures({ engine_state: false, krish_instruction: false, answer_requests_v2: true, aeo_kits_delivered: true })?.aeo_kits_delivered, true)
  assert.equal(parseFeatures({ engine_state: false, krish_instruction: false, aeo_kits_delivered: 'yes' })?.aeo_kits_delivered, undefined)
  // A named page becomes a kit's target only when it is on one of our domains.
  assert.equal(venturePage('https://heartside.io/answers/dog-gift', ['heartside.io']), 'https://heartside.io/answers/dog-gift')
  assert.equal(venturePage('https://elsewhere.example/x', ['heartside.io']), null)
})

test('a venture\'s named target page becomes its kit\'s target', async () => {
  const kitQuestion = 'What is a personal AI writing style?'
  const r = await featuredRun('ctrl', ['kits'], undefined, deps => {
    deps.requests = [{ request_id: '0f8fad5b-d9cb-469f-a165-70867728950e', engine_id: 'growth-mindmake', product_slug: 'ctrl', subject_slug: 'ctrl', questions: [], requested_at: '', target_urls: [{ question: kitQuestion, url: 'https://ctrl.mindmake.co/answers/writing-style' }] }]
  })
  const kit = r.results[0].packet.kits?.find(k => k.question === kitQuestion)
  assert.ok(kit)
  assert.deepEqual(kit.target, { kind: 'new_page', url: 'https://ctrl.mindmake.co/answers/writing-style', host: 'ctrl.mindmake.co', suggested_path: '/answers/writing-style' })
})

// ---------- the research job reads the plans in flight ----------

test('the research job reads its directive once: taste, requests, and the kit plans Krish approved and has not stopped', async () => {
  const s = new StandIn(TOKEN)
  await s.start()
  try {
    s.directive = { ...s.directive, features: { engine_state: false, krish_instruction: false, answer_requests_v2: true }, answer_requests: [{ request_id: '0f8fad5b-d9cb-469f-a165-70867728950e', engine_id: 'growth-heartside', product_slug: 'heartside', questions: ['What gift says my dog loves me?'], requested_at: '2026-11-20T05:00:00Z', shipped: [{ question: 'What gift says my dog loves me?', url: 'https://heartside.io/a' }] }] } as never
    s.decisions = [
      { proposal_id: 'aeo:kit:heartside:aaaaaaa1', decision: 'approved', decided_at: '2026-11-15T09:00:00Z', payload_sha256: '1'.repeat(64) },
      { proposal_id: 'aeo:kit:ctrl:aaaaaaa2', decision: 'approved', decided_at: '2026-11-14T09:00:00Z', payload_sha256: '2'.repeat(64) },
      { proposal_id: 'aeo:checkin:ctrl:aaaaaaa2', decision: 'declined', decided_at: '2026-11-18T09:00:00Z', payload_sha256: '3'.repeat(64) },
      { proposal_id: 'aeo:kit:pulse:aaaaaaa3', decision: 'declined', decided_at: '2026-11-15T09:00:00Z', payload_sha256: '4'.repeat(64) },
    ]
    const c = new GrowthEngineHttp(s.base, TOKEN)
    const { result, text } = await captureStderr(() => readDirectiveInputs({}, c, new Date('2026-11-22T06:00:00Z')))
    assert.deepEqual(result.kitPlans.map(p => p.plan_id), ['aeo:kit:heartside:aaaaaaa1'])
    assert.equal(result.requests[0].shipped?.[0].url, 'https://heartside.io/a')
    assert.equal(s.count('GET', '/api/growth/engines/aeo/directive'), 1, 'one directive read')
    assert.match(text, /"event":"kit_plans","state":"read","open":1,"stopped":1,"done":0/)
    assert.ok(!text.includes('dog loves'), 'no question in a log line')
  } finally {
    await s.close()
  }
})
