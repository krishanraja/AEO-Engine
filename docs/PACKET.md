# The packet, in plain English

`docs/packet.schema.json` is AeoPacket v1: one week of answer-engine research for one subject, POSTed by this engine to Control Center's `POST /api/aeo/ingest`. This page says what each field is for. The schema is the authority on shape; `src/schema/packet.ts` is the TypeScript mirror and the validator the pipeline runs before anything leaves the machine. Since 2026-11-13 the schema also describes the optional fields Control Center is asked to accept (`docs/briefs/2026-11-13-aeo-specialist.md`, section D); each is sent only when Control Center lists its feature (below, "Gated fields"), so with none listed the packet is exactly the closed v1 shape Control Center holds today.

Three rules hold for every string in the packet, whatever the field: no em dash, no email address, no @handle. The validator refuses the whole packet on the first breach. Control Center's ingest enforces the same and adds a few more (below), which this validator mirrors so a packet that passes here passes there.

## Timing

`week_start` is the Monday that owns the week, in UTC, by the same `mondayOf` rule as Control Center's [api/_growth.ts](https://github.com/krishanraja/control-center/blob/main/api/_growth.ts). The workflow is scheduled for Sunday 04:00 UTC on odd ISO weeks only (fortnightly since 2026-10-15; GitHub starts it hours late), and a Sunday belongs to the week that began the previous Monday, so the Sunday run reports that week: its calls are the fourteen days ending at run time (seven until 2026-11-12, which left the calls of the week between two runs unread), its probes are that morning's answers, and the `prior` in the context is the earlier packet Control Center holds for the subject (the Monday before while the run was weekly, the run two weeks before since the fortnightly schedule; Control Center chooses it, so this repository cannot confirm which it sends). `--week YYYY-MM-DD` normalises whatever date it is given to its Monday. Control Center refuses a `week_start` that is not a Monday.

## Top level

| Field | What it is for |
|---|---|
| `schema_version` | Always 1. A change to the shape bumps it on both sides. |
| `run_id` | A uuid minted per packet. Control Center treats a repeat of the same `run_id` for the same subject and week as a deduped retry; a different `run_id` replaces the week. The two attempts a subject job makes (five minutes apart) therefore land the week once. |
| `command_id` | The Run-now command this run answers, from `repository_dispatch`, else null. Control Center closes the command on ingest. |
| `subject` | `id`, `kind` (venture, prospect, aspiration), `slug`, `product_slug`. A venture names its Growth product slug; the other kinds carry null. Never the name: a prospect's name stays in Control Center. |
| `week_start` | See Timing. |
| `generated_at` | ISO timestamp of the packet. |
| `engines` | The engines whose answers the packet carries: the default three plus grok when a key exists. Unique, at least one. A gated engine (gemini, below) is asked but is not listed here until the context opens it. |
| `themes_status` | `ok`: calls were attributed and themes written. `no_calls`: Fireflies answered and there were no calls in the window. `no_attributed_calls`: there were calls, none belonged to this subject at confidence 0.6 or above. `fireflies_unavailable`: any Fireflies error or a missing key; never reported as a quiet week. `not_applicable`: aspirations, which have no calls, and a verify run's packet, which reads none (README, "The verify lane"). Since 2026-11-13 Fireflies is a retired route (Control Center's tool catalog lists it so), the research workflow passes no Fireflies key, and every venture and prospect packet says `fireflies_unavailable`. |
| `themes` | Five to ten buyer themes from this subject's calls, each with `calls` (distinct calls behind it) and up to six `evidence` items. Empty unless the status is ok. |
| `calls` | `considered`: transcripts in the fourteen-day window (seven until 2026-11-12). `attributed`: how many the classifier gave to this subject. |
| `queries` | The week's questions, scored. Up to 60. |
| `strongest_signal` | One sentence, the measured fact that matters most this week, or null when nothing was measured. |
| `recommendations` | Up to five pieces or pages to make, one per recommended query that survives the winnability gate, most demand first. Control Center turns these into content ideas. |
| `not_worth_chasing` | Up to six probed questions he should not try to win, each naming the hosts that own the answer and one plain sentence on why he will not displace them. A question here is never also a recommendation. |
| `watch_list` | Queries worth watching next week, up to 15, each with a one-line why. |
| `competitor_gap` | The host cited most often where we were absent, across the last four weeks of probes plus this week, how many times, and up to ten of the questions. |
| `playbook` | Aspirations only, else null: which of the subject's own pages the engines cite, grouped by host and path shape, with a why per group. |
| `approach_hook` | Prospects only, else null: one sentence Krish could open with, grounded in a cited answer that company's leaders would see, or null when nothing measured supports one. |
| `stats` | `queries`, `probes` (answers recorded), `probes_failed` (engine calls that errored; nothing written for them), `probes_skipped_cap` (query and engine pairs not asked because the USD cap was reached), `cost_usd` (the sum of the probes' estimates), `engines`, `transcripts` (same as `calls.considered`), `digest_writer` (`claude` when the model wrote the prose, `fallback` when the deterministic writer did). |

## Evidence

An evidence item is `call_ref` (the first eight hex characters of a sha256 of the transcript id; never the id), `date` (the call's own date, YYYY-MM-DD), and `paraphrase` (under 200 characters, never a quote, never a name). The same shape appears under a theme and under a query's `call_evidence`.

## A query

| Field | What it is for |
|---|---|
| `query_id` | Stable across weeks. When this week's question matches last week's by a normalised comparison (lower-case, punctuation and stop words removed), the prior id is carried; otherwise a new uuid is minted. Trends depend on this. |
| `query` | The question as a person would type it into an assistant, 3 to 400 characters. |
| `source` | Where it came from: `transcript` (a call theme), `gap` (a question a competitor is cited on), `seed` (a map touchpoint or seed topic, or a question a venture's engine requested word for word, protocol 1.22.0), `striking_distance` (a Google query we nearly rank for), `watch_carry` (carried from last week's watch list), `room_signal` (a prospect's trigger). |
| `demand_score` | 0 to 100, the sum of the three proxies below, capped. |
| `demand_basis` | `llm_demand` 0 to 40: ten per engine that gave a substantive answer (200 or more characters with two or more citations). `transcript_evidence` 0 to 30: ten per call evidence item whose theme overlaps the query. `rising_volume` 0 to 30: when a striking-distance row matches the query exactly after normalisation, 15 for volume of 100 or more plus 15 when the position improved; otherwise 15 when a prior row exists and we went from absent to cited on any engine; else 0. `labels` always carries "no prompt-volume corpus; proxies only", plus "Google volume via DataForSEO" when volume was used. |
| `call_evidence` | Up to ten evidence items from the themes that overlap this query. |
| `gap` | `we_cited_engines`: the engines whose probe says `we_cited` (below). `competitor_domains`: the hosts cited in this query's answers that are not ours, most frequent first, up to twelve. |
| `trend` | `new` with no prior row; else `up` or `down` when the score moved by ten or more; else `flat`. |
| `status` | For a venture or a prospect, since 2026-11-13, by the diagnosis (below, "Why a question is not won"). `recommend`: of the questions we are not cited on at all, the top three by kit priority, and up to five while they score 30 or more. `watch`: every question we are cited on (won, and cited not first), and the rest with a score of 30 or more. `drop`: below. For an aspiration, whose "ours" is another company's site, the rule it had: `recommend` the top three to five by score that are absent on at least two probed engines (or on every probed engine when fewer than two were probed), `watch` the rest at 30 or more. |
| `touchpoint_id` | The Growth map touchpoint this question came from, when it did. |
| `probes` | One per engine asked, up to eight: `engine`, `model`, `question`, `answer_snapshot` (cleaned, up to 1800 characters), `we_cited`, `citations` (up to eight URLs, in the order the answer cites them; see below), `cost_usd` (the estimate charged). A query beyond the subject's probe limit carries an empty list: the limit is 25 questions, raised to hold every question a venture's engine requested plus five more, and the shipped and kit questions (below, "Gated fields"), never above 30. Requested questions are probed first. Each is the first sample; repeat samples are counted beside it (below). |

"Our domains" means the subject's own domains for a venture or an aspiration, and Mindmake's and Krish's domains for a prospect: the prospect read is whether Mindmake is in the answer that company's leaders would see. Control Center's lists are read every run, then Krish's ruled corrections are applied over them from `config/own-domains.json` (Ruling, Krish, 2026-11-13: krishraja.ai, krishraja.com and themindmaker.ai are his; fractionl.us is not): his own domains are added for every prospect and for the Mindmake venture, and a domain he ruled is not his is never counted, whatever a list says. A domain with a path, such as a profile page on a social network, counts only for URLs under that path, never for every page on that host.

## What a probe's citations and we_cited mean

Since 2026-11-13 (first live in the research run of 22 November 2026), `probes[].citations` is the sources the answer cites **in its text**, in the order it first cites them, each URL once. It is not every page the assistant's search returned. Per engine:

| Engine | Where its citations come from |
|---|---|
| `claude` | Two lanes, one engine (`src/config/run.ts`, `AEO_CLAUDE_LANE`). The API lane: the `web_search_result_location` citations attached to the answer's text blocks, across every turn of a paused search, at most two web searches a probe (it was five); before 2026-11-13 it was every URL in the response in block order, so the first citation was the first raw search hit, cited or not. The Claude Code lane (the default from the research week of 23 November; `model` reads `claude-code/<model>`): the URLs the answer's text carries that its WebSearch calls returned, in order of first appearance, each once; a URL the model typed that no search returned is dropped and counted, never cited. Its `cost_usd` is 0: it runs on the Claude Code subscription. |
| `chatgpt` | The `url_citation` annotations on the answer's text, ordered by where they sit in it. The web search is now required on every probe (`tool_choice: required`); before, it was only offered, and most ChatGPT answers since September cited nothing because the model answered from memory. |
| `perplexity` | The sources the answer's `[n]` markers point to, in the order the markers first appear; when an answer carries no marker, its source list in its own order. Before, the whole source list in its own order. |
| `grok` | Its citation list in its own order (Grok is not asked today). |

`citations[0]` is therefore the answer's first cited source, or the first one left after cleaning. The packet's list is cleaned (a URL carrying an email address or an @handle is dropped, and the list stops at eight), so this engine measures the first citation before that cleaning, from the answer as it came back; that reading travels beside the packet in the run's sealed summary, never in the packet, and is what the engine's own `queries_cited_first` counts. A packet's own `citations[0]` can therefore differ from what the engine counted when the answer's first source was such a URL.

Two readings of "cited first" exist, and they agree only when Control Center reads the packet the way this engine does:

- **The engine's objective**, `queries_cited_first` in the research report, counted here from the uncleaned inline citations, against the subject's domains with Krish's ruled corrections applied and a path-aware match.
- **The North Star share Krish reads**, computed in Control Center (`READERS['aeo-engine']` in its `api/_northStarRefresh.ts`) from the packets' probes against its own domain lists. It matches the engine's count only if it also matches a domain with a path only under that path, applies `config/own-domains.json` (fractionl.us never ours; krishraja.ai, krishraja.com and themindmaker.ai ours for every prospect and for Mindmake), and reads `citations[0]`. The cleaning difference above it cannot close: the packet's shape is closed, so it never carries the uncleaned first source. `docs/CONTROL-CENTER-BRIEF.md` carries the ask.

Two other readings take the same list, so they move with it from 22 November: `demand_basis.llm_demand` counts answers with two or more citations, now cited ones only, and `gap.competitor_domains` and `competitor_gap` count the hosts an answer cites, no longer every host Claude's search returned. A demand score's trend across that run reads the change of measurement as well as any change in demand.

`we_cited` is true when the answer names one of our domains in its text, or cites a URL on one of them in its inline citations. A page the search returned and the answer did not cite no longer makes it true (that was how Claude's probes read until 2026-11-13), a domain inside another URL's query string no longer counts, and a domain with a path counts only under that path.

What the engines report about how they searched (whether they searched, the queries they ran, every source they read) is kept for the run's counts and is not in the packet: its shape is shared with Control Center and closed.

## Gemini, the gated engine

Gemini (`gemini-3.6-flash` with Google Search grounding, `src/clients/gemini.ts`) is asked when `GEMINI_API_KEY` is set, inside its free tier. `gemini` is not in the packet's engine enum: that enum is joint with Control Center and closed, and a packet naming an engine it does not know is refused. So Gemini is gated:

- Its probes stay out of the packet (`engines`, `probes`, `gap.we_cited_engines`, recommendations and every stat) until the context Control Center serves lists `packet_features` containing `engine_gemini`. The context field is optional; absent means none. Listed is not enough on its own: Gemini enters the packet only when Krish has also ruled it into the share, set as the repository variable `AEO_GEMINI_COUNTS=true` (repair of 2026-11-14, audit aeo-8: production has listed `engine_gemini` since 13 November, so adding the key alone would have moved the North Star the same day, with no shadow run).
- Until then its answers are counted only in the run's sealed summary, per engine: probes, searched, zero citations, first citation ours, and ours cited anywhere; the subject's `gated_engines` names it, and the research report gives its searched line with "not counted toward questions cited first".
- It never moves the North Star while gated: `countCitedFirst` (`src/protocol/measure.ts`) reads only the packet's engines, and a question only Gemini cited first counts for nothing.
- Its citations: the grounding supports in order of where they start in the answer, each source once. A grounding source is a redirect that hides its host, so a cited source is represented as `https://<title>/` when its title is a hostname; the first cited source, and any titled with one of our domains, is resolved to its real URL by reading the redirect's Location header (at most three a probe, the page itself never fetched). A redirect neither resolved nor titled with a hostname names no source, so it is never a packet citation; the measurement beside the packet keeps its place, as a source that is not ours.
- Its free tier is counted in grounding queries: a research job stops asking Gemini before an answer could carry it past 150 (`CAPS.GEMINI_MAX_QUERIES_PER_JOB`), only a job's first attempt asks it, and at ten subjects and three runs a month that stays inside the free 5000 (`check:config` holds it there). The skipped asks are counted and never charged.

When Control Center adds `gemini` to its engine enum and lists `engine_gemini`, the same run carries Gemini's probes in the packet and `validatePacket` accepts them (it takes the opened engines from the context). `docs/packet.schema.json` carries `gemini` in its engine enum since 2026-11-13, described as gated by `engine_gemini` like every other optional field (below), so the schema is the diff Control Center is asked to take.

## Gated fields: sent only when Control Center lists them (since 2026-11-13)

Control Center owns the packet's shape and refuses a field it does not know. So every field below is optional, and the engine sends one only when the context's `packet_features` (an optional list of strings on `GET /api/aeo/context`; absent means none) names its feature. `validatePacket(value, { features })` refuses any of them whose feature is not listed, and `src/pipeline/68-features.ts` attaches each only when it is. With none listed the packet is byte for byte what it was (`tests/fixtures/expected/packet.ctrl.json`); with all listed it is `tests/fixtures/expected/packet.ctrl.features.json`. Both are checked against this schema file by the tests.

| Feature | Fields | What they say |
|---|---|---|
| `probe_detail` | `probes[]` `retrieved` (up to 20), `searched`, `fan_out` (up to 8, each up to 200 characters), `our_position` | What the engine's search returned, cited or not (cleaned like citations: no URL with an email, a handle or a grounding redirect, and an em dash in a URL percent-encoded, as in a citation); whether it searched; its own search queries (no name, address, handle or em dash); the 1-based position of our first inline citation, or null. |
| `name_mentions` | `probes[]` `name_mentioned` | Whether the answer names the subject outside any URL or bare domain, whole word and in any case, from Control Center's `subject.brand_names` (distinctive names only, such as Heartside, Mindmake and makeyourmindup; never a generic word). Null when the subject has none. |
| `samples` | `probes[]` `samples {n, first, cited}` | A contested question's repeat samples on that engine, this answer included (below); null when it was asked once. |
| `panel` | `queries[]` `panel {state, first_seen, last_asked, won_at, lost_at, streak}` | Where the question stands, run after run (below). |
| `diagnosis` | `queries[]` `diagnosis {gap_class, our_best_url, alignment, first_cited_host, first_cited_type}` | Why it is not won (above, "Why a question is not won"). A venture or a prospect only. |
| `kits` | top-level `kits[]` (up to 10) | The venture's win kits, highest priority first, in the shape `src/schema/kit.ts` names (README, "Win kits"). Never for a held venture, a prospect or an aspiration. A kit that would break a packet rule, or repeat an earlier kit's `kit_id` (two questions whose ids share their first 8 characters), is left out on its own and counted in the log, so it never stops the packet. Its evidence gains one outcome line when the search signals cover its page (below, "Outcomes"). |
| `site` | top-level `site {hosts: [{host, gates: [{gate, pass}]}]}` | Our hosts' gates from the fetch-only site audit. |
| `run_kind` | top-level `run_kind: research \| verify` | `research` from a research run; `verify` from an off-week verify run (README, "The verify lane"), which re-asks only the questions of Krish's approved go-live and is never counted in the share. A verify run posts a packet only when this feature is listed: without it Control Center would read the packet as a research week. |
| `engine_gemini` | `gemini` in the engines enum | Above, "Gemini, the gated engine". |
| `outcome` | `queries[]` `outcome {url, gsc, bing, ai_referrals}` | What Control Center's search signals say about the page a venture shipped or a kit targets for that question (below, "Outcomes"). Only when the context serves `search_signals`; each part null when its signal was not served. |
| `cited_pages` | top-level `cited_pages[]` (up to 50), and a kit's `off_site[]` `mention` and `mention_ok` | The venture's cited-pages sheet (below, "The cited-pages sheet"). A row that would break a packet rule is left out on its own and counted in the log. |

**The panel.** Each probed question of a venture or a prospect has a state, checked in this order: `won` (an engine's first inline citation is ours on at least 2 of 3 samples when the question was picked for repeat samples, else on its one sample; an engine whose re-asks the cap stopped, left on one answer, cannot win a picked question alone), `contested` (first on some sample, under that bar on every engine), `cited`, `retrieved` (a page of ours retrieved, not cited), `absent`, `unknown` (no engine answered; or a question that held a win read short of won while the cap, its free tier or a failed call kept a packet engine from answering in full, so the run cannot say it was lost; never a loss). Every date is a research week, the packet's `week_start`, so "the week it was won" is `won_at`. The panel moves forward from the one this engine sent last run, which Control Center is asked to serve back as `subject.prior.queries[].panel` (brief section C): `won_at` is the latest week it became won after a run measured it short of won, `lost_at` the latest week it went from holding a win to a measured non-win, `streak` the runs in a row in the same state (a second run in the same week adds nothing to it, and reports a move only when the question's won-status changed). An unknown run keeps a win on record; one with no win or loss on record leaves its won-status unknown, so the next win or loss is not given a week. Without a served panel the history is unknown: `won_at`, `lost_at` and `streak` are null, never guessed, and `first_seen` is this week only for a query id first asked this run whose words the four weeks of probes do not hold. A question already won when first tracked has no `won_at`, since it may have been won long before; no move is reported for it. A packet question this run did not ask (past the probe limit) carries its served panel unchanged, so its history is never dropped. A served panel with a date that is not a real day is read as unknown.

**Repeat samples.** One answer can look like a win and be noise. After the first pass, a contested question is asked twice more on every packet engine that answered it (`src/pipeline/41-samples.ts`): a question cited anywhere this run by a packet engine, won last run, or one a venture shipped a page for or Krish approved a kit plan on (whatever tier it took, a requested one included), at most 8 a subject (`CAPS.MAX_SAMPLED_QUESTIONS_PER_SUBJECT`). A gated engine's citation (Gemini) never makes a question contested. Each re-ask is charged to the ledger inside the cap and the digest's reserve, like any probe (the Claude Code lane is free). The packet's `probes`, its `stats` and `queries_cited_first` stay on the first sample, so every reading stays comparable with the runs before; the re-asks are counted in the sealed summary and the ledger. The win rule above reads all the samples.

**What is probed first** (`src/pipeline/55-panel.ts`): a venture's requested questions, then the questions it shipped a page for (Control Center's `subject.shipped`, or a request's `shipped` with `features.answer_requests_v2`), then the questions of a kit plan Krish approved, then the questions won last run, then those cited anywhere last run (by the served panel, else the four-week probe history's newest run), then the rest in the usual order. The first three are never cut by the usual limit of 25; the ceiling of 30 still bounds them. A kit, shipped or won question the proposal left out is asked anyway, with last week's id.

## Outcomes (since 2026-11-13)

When Control Center serves a subject's `search_signals` (brief section C: Search Console query rows, Bing URL information, and AI-assistant referrals from GA4 and from Clarity, each row saying `via`), each venture question that has a tracked page (the page the venture said it shipped for it, else the page its kit targets, when the kit names one) carries `outcome` (`src/pipeline/63-outcomes.ts`):

| Part | What it is |
|---|---|
| `url` | The tracked page. |
| `gsc` | `impressions`, `clicks` and `position` (averaged by impressions; null with none) of the queries whose page is that URL, over the 28 days ending on the run's day (`from`, `to`), and `before`: the same over the 28 days before it shipped, when its shipping day is known and a row on the page's host starts (`date_from`) on or before that window's first day, else null (rows that start later say nothing of its early days, so it is unknown, never zero). A row belongs to the window that holds its last day (`date_to`); one that runs across the shipping day (from before it to on or after it) belongs to neither window. |
| `bing` | `indexed` and `last_crawled` for the URL. |
| `ai_referrals` | `ga4` and `clarity`: AI-assistant sessions landing on that page in the same 28 days, each null when its source was not served or holds no row on the page's host. Never summed: they count differently. |

Missing is unknown, never zero. A signal Control Center did not serve, or served empty, is null; a Search Console list with no row on the page's host does not cover it, and is null for that page; a GA4 or Clarity list covers a page only with a row on its host (or, for a page on one of the venture's own hosts, a row given as a bare path), else it is null for that page; a Bing list with no row for the URL is null. Only a signal that covers the page and holds no row for it in the window reads as zero. URLs are joined after normalising both (no fragment or utm parameter, the host lower-cased without www, the scheme and a trailing slash ignored). A landing page given as a bare path names no host, so it meets only pages on the venture's own hosts (its domains with no path), each page with that path once, and counts once in the venture's total however many of our hosts it meets. The research report says, per venture, "AI referrals: N sessions to M answer pages in 28 days", GA4 and Clarity apart, or unknown when no tracked page is covered.

## The cited-pages sheet (since 2026-11-13)

Ruling (Krish, 2026-11-13): AEO keeps a sheet per venture of the pages AI assistants cite for its questions and checks whether each page already mentions the venture; outreach from the sheet comes later, venture by venture, with his yes. AEO measures and checks: it never finds a contact, writes or sends outreach, or negotiates (brief section J).

Each row of `cited_pages` (`src/pipeline/48-cited-pages.ts`), for a venture (held ones included: measured, never proposed):

| Field | What it is |
|---|---|
| `url` | Normalised: no fragment, no `utm_*` parameter, the host lower-cased without `www.`, the path kept. A URL that cannot be carried (an email or a handle in it, a grounding redirect) is never a row. |
| `host`, `page_type` | Its host, and its type (`src/lib/sourceType.ts`). |
| `questions`, `engines` | The tracked questions it was cited for, and the packet engines that cited it. |
| `times_cited`, `times_first` | Answers that cited it, and answers whose first citation it was: this run's raw inline citations (first sample), and the four weeks of probes Control Center serves (from those, a probe's first listed page counts as first only when the probe did not cite us, since its list is the pages that were not ours). |
| `mention` | `link` (an `<a href>` in its visible body to one of the venture's domains, path-aware), else `name` (a distinctive name in its visible words, whole word on both sides and any case, its letters and digits compared so "Make Your Mind Up" meets makeyourmindup and "Heartsides" is not Heartside: Control Center's `subject.brand_names`, else `config/subjects.json`'s overlay, none for a product whose name is a common word; or one of the venture's domains written as text with no link, such as "heartside.io", path-aware), else `none`; `unchecked` when it was not read this run. |
| `mention_ok` | Null when the page does not mention the venture (`none` or `unchecked`): a `must_not` phrase only matters on a page that mentions us. Else false when one of the venture's brand checks' `must_not` phrases is on the page (refresh needed), true when none is. |
| `checked_at` | The day it was read, or null. |
| `platform`, `own` | One of the general platforms, or one of the venture's own pages: kept and flagged, never an outreach target. |

Rows rank by times first, then times cited, then questions, then URL; at most 50. Each run reads the top 20 outreach targets, at most 3 a host, with the fetch-only site reader and every rule of it (GET only, no script run, public hosts only, robots.txt asked first and honoured, and asked again for a same-domain redirect hop, an honest User-Agent, size, time and type caps, a budget and a throttle per host); a page the pages-cited-first read already fetched this run (that read asks robots.txt first too) is reused, never fetched again. Fresh fetches on one host come out of the subject's share of the run's per-host budget: 40 requests a host over the run's subjects, from which its robots.txt, the pages cited first and then the mention check's fresh fetches are drawn, so a run with many subjects checks fewer new pages a host and reuses the rest. Only these flags are kept, never a page's words. With the sheet Control Center served (`subject.prior.cited_pages`), a page that went from `none` to a mention sends `mention_acquired`, and one whose mention went to `none` sends `mention_lost`; without it, nothing is guessed. A kit's `off_site` place carries `mention` and `mention_ok` when the sheet read a page on that host cited for the kit's question, so the venture's engine skips one already mentioned.

## A recommendation

`n` (1 to 5), `title` (the piece or page), `target_query` and `query_id` (one of the packet's recommended queries), `angle` (what it argues and why it would be cited), `why_you_can_win` (see below), `evidence` (two to six lines, each citing something measured: a score, an engine we are absent on, a competitor host, a call theme, the gap class), `engines` (where we are absent), `demand` (the query's score). The model writes the prose; the numbers, the ids and the engines come from the score table, and a recommendation the model invents for a query that was not recommended is dropped. For a venture or a prospect the recommendations come highest kit priority first.

## Why a question is not won (since 2026-11-13)

A miss used to reach Krish and the venture engines as a title. Now each probed question of a venture or a prospect gets a cause, the **gap class**, read from every answer's measurement (`src/pipeline/52-diagnose.ts`), checked in this order:

| Class | When | The fix it names |
|---|---|---|
| `won` | an engine's first inline citation is ours | keep it |
| `cited_not_first` | an engine cites us, not first | move the cited page up: lead with the answer |
| `retrieved_not_cited` | an engine's search returned a page of ours and its answer cited others | make the page worth citing |
| `not_retrieved` | a page of ours answers the question (our best page, below) and no search returned it | make the page findable |
| `no_page` | no page of ours answers it | write the page, in the buyer's words |
| `unknown` | no engine answered | none |

Our best page comes from the site reader (README, "The site reader"): each audited page of ours scored by the share of the question's distinctive words in its title and H1. A word is not distinctive when it is filler (much, own, need, best and the like), "ai", or in more than half of the subject's questions, since a word every question shares matches every page; under 0.35, or with fewer than two distinctive words matched (one, when the question has only one), no page of ours answers it. When none matches but an engine already cited a page of ours (`cited_not_first`) or its search returned one (`retrieved_not_cited`), that page is the one to fix. The page cited first is each engine's first inline citation that is not ours, the first engine's first; a first citation whose URL carries an email or a handle stays the first, by its host alone and never read, and one that is a grounding redirect leaves that engine with none, so a later source is never promoted. It is typed (listicle, forum, video, review, news, directory, reference, vendor, unknown) and, unless it is a video or a forum thread, read fetch only for what it does: words, the words of its first paragraph under the H1, H2s, a date, and whether it is served without a script. General platforms owning most of the first citations, one vote per engine (the winnability gate's list), halve a question's priority.

**Kit priority** is class weight (cited not first 4, retrieved not cited 3, not retrieved 2, no page 1) times (1 + demand / 100), halved when platforms own the first citation; ties break on `query_id`. It is distance to first, demand and winnability in one number.

**How a recommendation reads now.** The packet's shape is unchanged. Each recommendation's last evidence line is its diagnosis: `gap: retrieved_not_cited (retrieved, not cited); our page: <url>; first cited: <host>, <type>, <words> words, answer first in <n> words, <n> H2s, dated`. When the matcher found no page but an engine named one of ours, the middle part reads `our page retrieved: <url>` (or `our page cited: <url>`); with neither, `no page of ours matches`. The deterministic fallback opens its `angle` with the fix the class names. So Control Center's existing moves and content ideas carry the cause with no schema change. The model reads the same fields in its evidence (`gap_class`, `priority`, `our_best_url`, `our_cited_url`, `first_cited` with its features) and is asked to name the fix in each angle. A recommendation is never made for a question the same packet lists in `not_worth_chasing`, and neither is a win kit.

An aspiration is not diagnosed: its "ours" is another company's site, so its status and recommendations keep the rule they had.

## The winnability gate

Absence is not opportunity. A question we are missing from because LinkedIn, a video platform, a national business title or a big consultancy owns the answer is a wall, not a gap: that answer was won by format and reach rather than by an argument, and one piece does not displace it. So a query being high demand and unoccupied is no longer enough to be recommended.

Before it writes, the digest is given the business canon (`krish.canon` on `GET /api/aeo/context`: positioning, what is sold, exactly who the buyer is, what the business believes, what it refuses to say) and asked three questions about every query. Who owns the answer now, read from the hosts cited in the evidence. What does he have that those hosts structurally cannot have, taken from the canon: the positioning, the buyer, the proof, the product. And is the person asking the buyer the canon describes, someone who can move a decision on their own. A question that fails any of the three is not a recommendation.

`why_you_can_win` (under 300 characters, or null) is the answer to the second question, written for that one query. "He knows a lot about this" is not one. **Null means the digest could not justify the recommendation**, which is a bug in the digest rather than a licence to make the piece anyway; the null is carried rather than the row dropped, so the reader can see which recommendation was not judged. The deterministic fallback never writes one: it can see who is cited, it cannot see what he has that they do not, so every fallback recommendation carries null and `stats.digest_writer` says `fallback`.

`not_worth_chasing` is what failed, at most six entries: `query_id` and `query` (one of the packet's queries, never also a recommendation), `owned_by` (the hosts that own the answer now, up to eight) and `why_not` (one plain sentence, no hedging). It is the more useful half of the packet on a bad week: being told to skip a question costs nothing, and chasing one that a platform owns costs a week. The fallback can answer the first of the three questions on its own, so when the writing pass fails it still moves out any query where more than half the cited hosts are large general platforms, and says in `why_not` that no judgement beyond who is cited was made.

Both fields are additive in schema version 1: a packet written before the gate omits them and still validates.

## Rules Control Center adds beyond the schema

A venture names its `product_slug` and only a venture does; `week_start` is a Monday; `themes` is empty unless `themes_status` is ok; query ids are unique within a packet; a recommendation's `query_id` is one of the packet's queries; a `not_worth_chasing` entry's `query_id` is one of the packet's queries, appears once, and is not also a recommendation; `playbook` only for an aspiration and `approach_hook` only for a prospect; at most 600 probes in a packet. `src/schema/packet.ts` checks all of these.

## Where the packet goes

`POST /api/aeo/ingest` answers 200 `{ ok, deduped, replaced }`, 400 with `errors`, 401, or 429 with `Retry-After` (retried once). The probes land in the probe table, the queries in the query corpus, the digest in the digest table, and the recommendations become content ideas under a governor. The engine never writes anywhere else. A win kit is in a packet only once Control Center lists the `kits` feature; until then, and beside it, the top kit goes to Control Center as a plan in the protocol report (README, "Win kits").
