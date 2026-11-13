# The packet, in plain English

`docs/packet.schema.json` is AeoPacket v1: one week of answer-engine research for one subject, POSTed by this engine to Control Center's `POST /api/aeo/ingest`. This page says what each field is for. The schema is the authority on shape; `src/schema/packet.ts` is the TypeScript mirror and the validator the pipeline runs before anything leaves the machine.

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
| `themes_status` | `ok`: calls were attributed and themes written. `no_calls`: Fireflies answered and there were no calls in the window. `no_attributed_calls`: there were calls, none belonged to this subject at confidence 0.6 or above. `fireflies_unavailable`: any Fireflies error or a missing key; never reported as a quiet week. `not_applicable`: aspirations, which have no calls. Since 2026-11-13 Fireflies is a retired route (Control Center's tool catalog lists it so), the research workflow passes no Fireflies key, and every venture and prospect packet says `fireflies_unavailable`. |
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
| `status` | `recommend`: the top three to five by score that are absent on at least two probed engines (or on every probed engine when fewer than two were probed). `watch`: the rest with a score of 30 or more. `drop`: below. |
| `touchpoint_id` | The Growth map touchpoint this question came from, when it did. |
| `probes` | One per engine asked, up to eight: `engine`, `model`, `question`, `answer_snapshot` (cleaned, up to 1800 characters), `we_cited`, `citations` (up to eight URLs, in the order the answer cites them; see below), `cost_usd` (the estimate charged). A query beyond the subject's probe limit carries an empty list: the limit is 20 questions, raised to hold every question a venture's engine requested plus five more, and never above 30. Requested questions are probed first. |

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

- Its probes stay out of the packet (`engines`, `probes`, `gap.we_cited_engines`, recommendations and every stat) until the context Control Center serves lists `packet_features` containing `engine_gemini`. The context field is optional; absent means none.
- Until then its answers are counted only in the run's sealed summary, per engine: probes, searched, zero citations, first citation ours, and ours cited anywhere; the subject's `gated_engines` names it, and the research report gives its searched line with "not counted toward questions cited first".
- It never moves the North Star while gated: `countCitedFirst` (`src/protocol/measure.ts`) reads only the packet's engines, and a question only Gemini cited first counts for nothing.
- Its citations: the grounding supports in order of where they start in the answer, each source once. A grounding source is a redirect that hides its host, so a cited source is represented as `https://<title>/` when its title is a hostname; the first cited source, and any titled with one of our domains, is resolved to its real URL by reading the redirect's Location header (at most three a probe, the page itself never fetched). A redirect neither resolved nor titled with a hostname names no source, so it is never a packet citation; the measurement beside the packet keeps its place, as a source that is not ours.
- Its free tier is counted in grounding queries: a research job stops asking Gemini before an answer could carry it past 150 (`CAPS.GEMINI_MAX_QUERIES_PER_JOB`), only a job's first attempt asks it, and at ten subjects and three runs a month that stays inside the free 5000 (`check:config` holds it there). The skipped asks are counted and never charged.

When Control Center adds `gemini` to its engine enum and lists `engine_gemini`, the same run carries Gemini's probes in the packet and `validatePacket` accepts them (it takes the opened engines from the context). `docs/packet.schema.json` takes `gemini` in its engine enums in that same change, as the schema's own rule says: here first, with the reason.

## A recommendation

`n` (1 to 5), `title` (the piece or page), `target_query` and `query_id` (one of the packet's recommended queries), `angle` (what it argues and why it would be cited), `why_you_can_win` (see below), `evidence` (two to six lines, each citing something measured: a score, an engine we are absent on, a competitor host, a call theme), `engines` (where we are absent), `demand` (the query's score). The model writes the prose; the numbers, the ids and the engines come from the score table, and a recommendation the model invents for a query that was not recommended is dropped.

## The winnability gate

Absence is not opportunity. A question we are missing from because LinkedIn, a video platform, a national business title or a big consultancy owns the answer is a wall, not a gap: that answer was won by format and reach rather than by an argument, and one piece does not displace it. So a query being high demand and unoccupied is no longer enough to be recommended.

Before it writes, the digest is given the business canon (`krish.canon` on `GET /api/aeo/context`: positioning, what is sold, exactly who the buyer is, what the business believes, what it refuses to say) and asked three questions about every query. Who owns the answer now, read from the hosts cited in the evidence. What does he have that those hosts structurally cannot have, taken from the canon: the positioning, the buyer, the proof, the product. And is the person asking the buyer the canon describes, someone who can move a decision on their own. A question that fails any of the three is not a recommendation.

`why_you_can_win` (under 300 characters, or null) is the answer to the second question, written for that one query. "He knows a lot about this" is not one. **Null means the digest could not justify the recommendation**, which is a bug in the digest rather than a licence to make the piece anyway; the null is carried rather than the row dropped, so the reader can see which recommendation was not judged. The deterministic fallback never writes one: it can see who is cited, it cannot see what he has that they do not, so every fallback recommendation carries null and `stats.digest_writer` says `fallback`.

`not_worth_chasing` is what failed, at most six entries: `query_id` and `query` (one of the packet's queries, never also a recommendation), `owned_by` (the hosts that own the answer now, up to eight) and `why_not` (one plain sentence, no hedging). It is the more useful half of the packet on a bad week: being told to skip a question costs nothing, and chasing one that a platform owns costs a week. The fallback can answer the first of the three questions on its own, so when the writing pass fails it still moves out any query where more than half the cited hosts are large general platforms, and says in `why_not` that no judgement beyond who is cited was made.

Both fields are additive in schema version 1: a packet written before the gate omits them and still validates.

## Rules Control Center adds beyond the schema

A venture names its `product_slug` and only a venture does; `week_start` is a Monday; `themes` is empty unless `themes_status` is ok; query ids are unique within a packet; a recommendation's `query_id` is one of the packet's queries; a `not_worth_chasing` entry's `query_id` is one of the packet's queries, appears once, and is not also a recommendation; `playbook` only for an aspiration and `approach_hook` only for a prospect; at most 600 probes in a packet. `src/schema/packet.ts` checks all of these.

## Where the packet goes

`POST /api/aeo/ingest` answers 200 `{ ok, deduped, replaced }`, 400 with `errors`, 401, or 429 with `Retry-After` (retried once). The probes land in the probe table, the queries in the query corpus, the digest in the digest table, and the recommendations become content ideas under a governor. The engine never writes anywhere else.
