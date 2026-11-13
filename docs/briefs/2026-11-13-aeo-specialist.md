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
6. **`subject.brand_checks`:** `[{question, must_not: [string], must: [string]}]`, a venture's brand-accuracy checks, at most three asked a research run. Full Time is never "betting tips"; Mindmake is not "Mindmaker".
   - AEO asks each once a research run on every packet engine, charged to its ledger (the Claude Code lane is free).
   - An answer passes when no `must_not` phrase appears and every `must` phrase does, as whole words in any case, with URLs and bare domains taken out. A check passes when every engine that answered it passed.
   - AEO reports counts only ("Brand checks: X of Y passed"), keeps each check's pass or fail by engine in its sealed summary with no answer text, and sends nothing in the packet (no field yet).
   - A failed check on a venture that is not held becomes one `strategy` suggestion (`aeo:brand:<product>:<sha8 of the question>`) only when no kit was proposed that run, naming the venture, the question and the phrases, never the answer.
   - The `must_not` phrases also mark a cited page that carries one as "refresh needed" (J).
   - Until Control Center serves `subject.brand_names`, AEO reads distinctive names from `config/subjects.json`: mindmake (Mindmake), heartside (Heartside), publication (makeyourmindup).

## C. Context additions (`GET /api/aeo/context`)

- **`packet_features: string[]`:** the optional packet fields Control Center accepts (D). AEO sends a field only when it is listed.
- **`subject.prior.queries[].panel`:** the panel state AEO sent last run (D), exactly as sent, so the next run can carry `first_seen`, `won_at`, `lost_at` and `streak`.
- **`subject.shipped[]`:** `{question | query_id, url, shipped_at, by}`, from venture declarations (E).
- **`subject.search_signals`:** read-only data AEO uses to diagnose and to show outcomes. Keys stay in Control Center, and AEO never holds a Search Console, GA4 or Bing credential.
  - `gsc_queries: [{query, page, impressions, clicks, position, date_from, date_to}]` for the subject's hosts, every query, not only striking distance.
  - `bing: {queries: [...], pages: [...], url_info: [{url, indexed, last_crawled}], crawl_issues: [...], keyword_volume: [{query, volume}]}`. The key is `BING_ANALYTICS_API_KEY`, which Krish added on 13 Nov.
  - `ai_referrals: [{landing_page, source, sessions, date, via: 'ga4' | 'clarity'}]`: sessions from an AI assistant to each landing page, from GA4 or from Clarity (G). Source is one of chatgpt.com, perplexity.ai, copilot.microsoft.com, gemini.google.com, claude.ai. A landing page may be a path or a full URL. AEO reads either `via`; when both are present for one page and day it reports each separately and never sums them, because they count differently. AEO still reads the first name, `ga4_ai_referrals` (no `via`), as GA4.
  - Missing means unknown (`null` with a reason), never zero.
  - What AEO does with them (Phase 5): for each page a venture shipped or a kit targets, Search Console impressions, clicks and average position over the last 28 days (and the 28 days before it shipped, when `shipped_at` is known), Bing `indexed` and last crawl, and AI-referral sessions. It sends them as `queries[].outcome` once `packet_features` lists `outcome` (D), adds one line to that kit's evidence, and reports one count line per venture: "AI referrals: N sessions to M answer pages in 28 days", GA4 and Clarity apart.
- **`subject.prior.cited_pages[]`:** the cited-pages sheet Control Center holds for the venture, its AEO-owned columns as AEO last sent them (J), so AEO can say when a mention was acquired or lost.

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
  - `panel: {state, first_seen, last_asked, won_at, lost_at, streak}`: `state` is one of `won | contested | cited | retrieved | absent | unknown`; the four dates are `YYYY-MM-DD` research weeks, and `first_seen`, `won_at`, `lost_at` and `streak` may be null (history unknown). Serve it back on `subject.prior.queries[]` exactly as sent, so the next run moves it forward.
  - `diagnosis: {gap_class, our_best_url, alignment, first_cited_host, first_cited_type}`
  - `outcome: {gsc, bing, ai_referrals}`
- **Top level:**
  - `kits[]`, up to 10, each the packet schema's kit (`docs/packet.schema.json`, `$defs.kit`): the shape in E, plus `product_slug` and `owned_by_platform`, with each `off_site` item `{host, source_type, engines}` (no `url` or `why` in the packet).
  - `site: {hosts: [{host, gates: [{gate, pass}]}]}`
  - `run_kind: 'research' | 'verify'`
  - `cited_pages[]`, up to 50: the venture's cited-pages sheet (J), feature `cited_pages`. With it, a kit's `off_site` items may also carry `mention` and `mention_ok`.
- **`queries[].outcome`:** `{url, gsc: {impressions, clicks, position, from, to, before} | null, bing: {indexed, last_crawled} | null, ai_referrals: {from, to, ga4, clarity} | null}`, feature `outcome` (C). Null is unknown.
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
5. **Clarity reader.** Microsoft Clarity's tracking code is on mindmake.co and Clarity is linked to Krish's Google Analytics (Krish, 13 Nov). Its Data Export API is `GET https://www.clarity.ms/export-data/api/v1/project-live-insights` with `Authorization: Bearer <project token>`, `numOfDays` 1, 2 or 3 and up to three dimensions (Browser, Device, Country/Region, OS, Source, Medium, Campaign, Channel, URL); at most 10 requests a project a day and 1,000 rows, no pagination. Its AI channel group (since August 2025) separates ChatGPT, Copilot, Gemini, Claude and Perplexity, as the channels `AIPlatform` and `PaidAIPlatform`.
   - Call the export once a day per Clarity project, with dimension1 Channel and dimension2 URL and `numOfDays` 1.
   - Keep the AI-platform rows only: sessions per landing page and day.
   - The token is a Clarity project API token Krish generates in Clarity's project settings, held only in Control Center's environment, like `BING_ANALYTICS_API_KEY`: one per project, named for example `CLARITY_EXPORT_TOKEN_MINDMAKE`. AEO never holds it, and `check:config` refuses any Clarity name or host in AEO's code and workflows.
   - The rows feed `search_signals.ai_referrals` with `via: 'clarity'` (C).
   - Clarity's Bot Activity dashboard needs a supported CDN or server-log integration. Whether Vercel is one is unverified; do not build for it.

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
- Built in AEO (Phase 5): the standing plan `aeo:verify-plan:v1` (`stage: plan`, behind `strategy`), proposed by the daily report once a question is shipped or a kit plan approved, never again after his No; then, while the plan is approved, the go-live `aeo:verify:<the even-week Sunday>` (`stage: go_live`, parent the plan, behind `spend`), proposed Thursday to Saturday before that Sunday, its `exact_payload` canonical JSON of `{amount_usd, date, query_ids, samples}`. The verify report closes it with `verify_ran` and sends `question_won` and `question_lost`; it carries no objective.
- AEO posts a verify packet only when `packet_features` lists `run_kind`; without it Control Center would count the packet as a research week, so the results go only into the report.

## J. Cited-pages sheet

Ruling (Krish, 2026-11-13): AEO keeps a sheet per venture of the pages AI assistants cite for its questions and checks whether each page already mentions the venture; outreach from the sheet comes later, venture by venture, with his yes.

AEO measures and checks: it never finds a contact, never writes or sends outreach and never negotiates. The outreach columns belong to the venture engines and Control Center.

- **A Control Center table** keyed by `product_slug` and normalised `url` (no fragment, no `utm_*` parameter, the host lower-cased without `www.`, the path kept).
- **AEO-owned columns,** from the packet's `cited_pages` (D): `page_type`, `questions`, `engines`, `times_cited`, `times_first`, `mention` (`link`, `name`, `none` or `unchecked`), `mention_ok`, `checked_at`, and the flags `platform` and `own`. A row sent with `mention: unchecked` (not read this run) leaves the stored mention as it was.
- **Venture-owned outreach columns,** written only by the venture's engine or Krish: `contact`, `status`, `last_contacted`, `follow_up_on`, `requested_cost`, `notes`. Status is one of: not started, declined, refresh needed, outreach sent, followed up, negotiating, payment requested, approved, mention acquired.
- **Rules:** never commit to payment or terms without Krish's approved decision; the engines draft, and Krish approves each send.
- **Serving:** `subject.prior.cited_pages` in AEO's context (C). The venture standing (E) gains `cited_pages[]` (the top 20, outreach targets only, never a platform or our own page) under `features.ai_answers_detail`, so each venture engine can draft outreach later.
- **Already mentioned:** a row with a mention (`link` or `name`) and `mention_ok: true` is "already mentioned, skip". `mention_ok: false` (a brand check's `must_not` phrase is on the page, B6) is "refresh needed".
- **Mention acquired:** set from AEO's `mention_acquired` event (and `mention_lost` when one disappears), never by hand. The events name no URL: the report's protocol event carries only its name, the time and the run's page, and the counts go in a line; Control Center matches the rows by comparing the new sheet with the stored one.
- **How AEO builds it:** the pages cited for the venture's tracked questions this run (raw inline citations, first sample) and in the four weeks of probes Control Center serves; ranked by times first, times cited, questions, then URL; at most 50 rows. It reads the top 20 outreach targets a run, at most 3 a host, fetch only (GET, no script, robots.txt honoured, an honest User-Agent), reusing any page the pages-cited-first read already fetched; it keeps flags only, never a page's text.
