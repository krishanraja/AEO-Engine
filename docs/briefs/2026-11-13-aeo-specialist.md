# Control Center brief: AEO-Engine as the AI-answers specialist (2026-11-13)

From AEO-Engine, for a Control Center session. AEO-Engine changes nothing in Control Center; this brief is the handoff. Krish's rulings of 13 November are quoted where they bind.

**Why.** On 13 November, a read-only check of Control Center's tables and AEO's own run logs found that the AI-answers loop measures little and changes nothing:

- **Almost no citations.** One probe of 294 on 8 November cited a Mindmake venture anywhere. The only hit in two fortnights is the same one twice: Perplexity citing a mindmake.co answer page written for exactly that question.
- **ChatGPT rarely searched.** About 87% of ChatGPT probes since September carry no citation, because AEO never forced the search. Fixed in AEO (this branch).
- **Claude's first citation was a raw search hit.** Fixed in AEO.
- **Three ventures were never measured.** Only five subjects are active (ctrl, circle, pulse, full-time, mindmake). Heartside, the publication and Legibility have none.
- **One request in the table.** `growth_answer_requests` holds a single row, growth-mindmake's, with 1 question.
- **AEO's ideas stall.** All 26 AEO content ideas are in state `seeded`.
- **No North Star reading.** `north_star_readings` for this repository reads `current: null` every day.

The plan in AEO-Engine has seven phases. Phases 0 to 2 need nothing from Control Center. The items below are what Control Center needs to do so that the later phases reach Krish and the venture engines. Each item is additive and flag-gated. AEO reads `features.*` and `packet_features`, and sends nothing Control Center has not accepted.

## A. Reconciliations (do first)

1. **North Star reader.** `READERS['aeo-engine']` writes `current: null` daily. The 8 November research report carried a measured `queries_cited_first`. Compute the share as `queries_cited_first / questions_asked` for the fortnight (see H). Report unknown only when no research report exists in the last 16 days.
   - From 22 November, AEO measures the first citation before any URL is cleaned, with path-aware matching and Krish's own-domain ruling. So prefer the research report's measured `queries_cited_first` to recounting stored probes.
   - If the reader recounts, it must apply the same rules ("The first citation: what Control Center's reader must match" in `docs/CONTROL-CENTER-BRIEF.md`).
2. **Heartside's request never arrived.**
   - growth-heartside's daily run asks once, when the directive serves `ai_answers` or `features.ai_answers`.
   - There is no row for it in `growth_answer_requests`.
   - Check that growth-heartside's directive serves `features.ai_answers`, and whether its `POST answers` was refused or never sent.
   - growth-heartside now writes a line saying why (AEO Phase 1).
3. **AEO content ideas stuck at `seeded`.** Stop seeding content ideas from AEO recommendations once kits flow (E). The 26 existing rows can stay as history.
4. **CTRL, Circle and Pulse standings have no reader.** No growth engine owns those products. Roll their standings up to growth-mindmake as `ai_answers.portfolio[]` (E).
5. **Fireflies is a retired route.** AEO stopped passing the key. Calls attributed to subjects were 0 in every live run.

## B. Registry

1. **Create venture subjects** (`growth_aeo_subjects`, kind `venture`, active), measured even while a venture's engine is held. Krish (13 Nov): Legibility and Full Time are "measured, with no kits and no proposals".
   - `heartside`: domains `heartside.io`
   - `publication`: domains `makeyourmindup.ai`, `home.makeyourmindup.ai`. Krish decides whether `home.makeyourmindup.ai` and `mindmakerlive.substack.com` stay on `mindmake` as well; until he does, leave `mindmake` unchanged.
   - `legibility`: domains `legibility.io`
2. **Own domains.** Ruling (Krish, 2026-11-13): krishraja.ai, krishraja.com and themindmaker.ai are his; fractionl.us is not.
   - Add the three to `krish.domains` in `/api/aeo/context`.
   - Add a `not_ours` list (fractionl.us) that every matcher honours.
   - AEO applies the same lists from `config/own-domains.json` until Control Center serves them, and logs a count when the two disagree.
3. **`subject.brand_names`:** distinctive names only, such as Heartside, Mindmake and makeyourmindup. AEO detects unlinked mentions of these. Generic words (CTRL, Circle, Pulse, Full Time) stay out.
4. **`subject.engine_held`:** true while Krish holds that venture's engine (legibility, full-time today). AEO measures held subjects and builds no kits for them.
5. **Objective `questions_asked`:** register it beside `queries_cited_first` so the share has its denominator.

## C. Context additions (`GET /api/aeo/context`)

- **`packet_features: string[]`:** the optional packet fields Control Center accepts (D). AEO sends a field only when it is listed.
- **`subject.prior.queries[].panel`:** the panel state AEO sent last run (D), so the next run can carry `first_seen`, `won_at` and `streak`.
- **`subject.shipped[]`:** `{question | query_id, url, shipped_at, by}`, from venture declarations (E).
- **`subject.search_signals`:** read-only data AEO uses to diagnose and to show outcomes. Keys stay in Control Center, and AEO never holds a Search Console, GA4 or Bing credential.
  - `gsc_queries: [{query, page, impressions, clicks, position, date_from, date_to}]` for the subject's hosts, every query, not only striking distance.
  - `bing: {queries: [...], pages: [...], url_info: [{url, indexed, last_crawled}], crawl_issues: [...], keyword_volume: [{query, volume}]}`. The key is `BING_ANALYTICS_API_KEY`, which Krish added on 13 Nov.
  - `ga4_ai_referrals: [{landing_page, source, sessions, date}]`. Source is one of chatgpt.com, perplexity.ai, copilot.microsoft.com, gemini.google.com, claude.ai.
  - Missing means unknown (`null` with a reason), never zero.

## D. Packet ingest (AeoPacket v1, additive and optional)

AEO will attach its exact `docs/packet.schema.json` diff when it sends these. All fields are optional and listed in `packet_features` once accepted.

- **`queries[].probes[]`:**
  - `retrieved: string[]` (up to 20): what the engine searched, cited or not.
  - `searched: boolean`
  - `fan_out: string[]` (up to 8, each 200 characters or fewer): the engine's own search queries.
  - `our_position: integer | null`: 1-based position of our first URL among inline citations.
  - `name_mentioned: boolean | null`
  - `samples: {n, first, cited} | null`: repeat samples on contested questions.
- **`queries[]`:**
  - `panel: {state, first_seen, won_at, lost_at, streak}`
  - `diagnosis: {gap_class, our_best_url, alignment, first_cited_host, first_cited_type}`
  - `outcome: {gsc, bing, ai_referrals}`
- **Top level:**
  - `kits[]`, up to 10 (shape in E)
  - `site: {hosts: [{host, gates: [{gate, pass}]}]}`
  - `run_kind: 'research' | 'verify'`
- **Engines enum:** add `gemini`.
- **`growth_geo_probes`:** new nullable columns for the probe fields above.

`probes[].citations` keeps its shape. Its meaning is now "sources cited in the answer text, in order" for every engine. Before 22 November, Claude's list held raw search results. Treat readings before and after 22 November as a methodology break when charting.

## E. Venture protocol (proposed 1.23.0, `features.ai_answers_detail`)

Ruling (Krish, 2026-11-13): AEO's win kits reach him through each venture's own growth engine. Until this lands, AEO puts one kit a run on his list itself, behind `strategy`.

**`ai_answers.standing` gains:**
- `questions[]`, up to 40: `{query_id, question, state, engines: [{engine, our_position, first_host, first_url, searched}], first_seen, won_at, lost_at, kit_id}`.
- `kits[]`, up to 5, never for a subject whose engine is held. Each kit:

```
{ kit_id, v: 1, query_id, question, gap_class, priority,
  target: {kind: new_page | update_page | off_site_only, url | null, host, suggested_path | null},
  title,
  capsule: {rules: [string], must_cover: [string] | null},
  h2s: [string],
  beat: [{url, host, engine, position, features}],
  site_fixes: [{gate, host, url, fix, owner_repo}],
  off_site: [{host, url, source_type, engines, why}],
  verify: {engines, samples, success, recheck, baseline},
  evidence: [string] }
```

- `request.digest`: the lowercase hex SHA-256 of the JSON array of the request's questions, each trimmed with internal whitespace collapsed to one space, sorted by code point, serialised as compact JSON with no spaces and non-ASCII characters left unescaped, then UTF-8 encoded (JavaScript `JSON.stringify`; Python `json.dumps(..., separators=(',',':'), ensure_ascii=False)`). An engine re-asks when its own list's digest differs.
- `portfolio[]` (growth-mindmake only): the same standing for ctrl, circle and pulse.

**`POST answers` gains:**
- `mode: 'replace' | 'append'` (default replace, as today)
- `shipped: [{question | query_id, url, shipped_at}]`
- `targets: [{question, url}]`
- domains editable after the first request

**AEO's directive gains:**
- `features.answer_requests_v2`: requests carry `note`, `mode`, `targets` and `shipped`.
- `features.aeo_kits_delivered`: once true, AEO stops proposing kits itself and keeps its check-ins.

The growth repos are public, so kits stay in their memory or gitignored files, and their logs carry counts only.

## F. Meter

`POST /api/aeo/meter` accepts rows of `{provider, agent, model, billing: 'api' | 'subscription', input_tokens, output_tokens, search_calls}`. Today only Anthropic rows land, so OpenAI and Perplexity spend is unmetered.

Ruling (Krish, 2026-11-13): Claude probes run on the Claude Code subscription token, with the paid API as a fallback. AEO stays within its $25-a-fortnight cap. Subscription rows carry tokens with `billing: subscription` and no dollar amount.

## G. Search plumbing (feeds C)

1. **Search Console.** Extend the n8n "Search Console Search Analytics Sync" workflow to the properties Krish shared on 13 Nov: mindmake.co, the makeyourmindup sites, heartside.io and fulltime.fm. Keep every query, not only striking-distance rows.
   - Today `maya_striking_distance` covers only ctrl, pulse and legibility.
   - If the workflow uses a fixed site list, add the four.
   - Identify which of the service account's keys the n8n credential uses, so Krish can delete the unused ones.
2. **Bing reader.** `GetQueryStats`, `GetPageStats`, `GetUrlInfo`, `GetCrawlIssues` and `GetKeywordStats` for the verified sites, read with `BING_ANALYTICS_API_KEY`. Bing's AI Performance report (Copilot citations) has no API today, so do not build for it.
3. **GA4.** Keep AI-assistant referrers in the `source_medium` breakdown. Today the breakdowns are sparse, and none of these sources appear.
4. **Index check.** Add a research-desk kind `index_check` for `aeo`, capped daily. It asks Brave Search whether a URL ranks for a question. Claude's search draws on Brave, so this is a free retrieval signal.

## H. North Star

- Share = `queries_cited_first / questions_asked` per fortnight, across ventures and prospects, aspirations excluded, as `docs/NORTH_STAR.md` defines.
- Also store per-venture shares, shown in each standing.
- **Two changes will move the reading; neither is a change of definition.** Only Krish changes the North Star.
  - Gemini joins as a fourth engine.
  - Three new subjects join the denominator.

  AEO reports a majority-of-engines count beside the any-engine count, and Krish decides how the share should read.

## I. Verify runs

- A `run_kind: verify` packet re-asks only shipped questions, three samples each, in an off week.
- It never replaces the research week's readings and is never counted in the share.
- It runs only on Krish's approved spend go-live `aeo:verify:<date>` whose `payload_sha256` matches. It changes his 15 October fortnightly ruling, so it waits for his yes.
