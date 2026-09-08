# The packet, in plain English

`docs/packet.schema.json` is AeoPacket v1: one week of answer-engine research for one subject, POSTed by this engine to Control Center's `POST /api/aeo/ingest`. This page says what each field is for. The schema is the authority on shape; `src/schema/packet.ts` is the TypeScript mirror and the validator the pipeline runs before anything leaves the machine.

Three rules hold for every string in the packet, whatever the field: no em dash, no email address, no @handle. The validator refuses the whole packet on the first breach. Control Center's ingest enforces the same and adds a few more (below), which this validator mirrors so a packet that passes here passes there.

## Timing

`week_start` is the Monday that owns the week, in UTC, by the same `mondayOf` rule as Control Center's `api/_growth.ts`. The workflow runs Sunday 04:00 UTC, and a Sunday belongs to the week that began the previous Monday, so the Sunday run reports that week: its calls are the seven days ending at run time, its probes are that morning's answers, and last week's `prior` in the context is the Monday before. `--week YYYY-MM-DD` normalises whatever date it is given to its Monday. Control Center refuses a `week_start` that is not a Monday.

## Top level

| Field | What it is for |
|---|---|
| `schema_version` | Always 1. A change to the shape bumps it on both sides. |
| `run_id` | A uuid minted per packet. Control Center treats a repeat of the same `run_id` for the same subject and week as a deduped retry; a different `run_id` replaces the week. Three workflow attempts therefore land the week once. |
| `command_id` | The Run-now command this run answers, from `repository_dispatch`, else null. Control Center closes the command on ingest. |
| `subject` | `id`, `kind` (venture, prospect, aspiration), `slug`, `product_slug`. A venture names its Growth product slug; the other kinds carry null. Never the name: a prospect's name stays in Control Center. |
| `week_start` | See Timing. |
| `generated_at` | ISO timestamp of the packet. |
| `engines` | The engines this run asked: the default three plus grok when a key exists. Unique, at least one. |
| `themes_status` | `ok`: calls were attributed and themes written. `no_calls`: Fireflies answered and there were no calls in the window. `no_attributed_calls`: there were calls, none belonged to this subject at confidence 0.6 or above. `fireflies_unavailable`: any Fireflies error or a missing key; never reported as a quiet week. `not_applicable`: aspirations, which have no calls. |
| `themes` | Five to ten buyer themes from this subject's calls, each with `calls` (distinct calls behind it) and up to six `evidence` items. Empty unless the status is ok. |
| `calls` | `considered`: transcripts in the seven-day window. `attributed`: how many the classifier gave to this subject. |
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
| `source` | Where it came from: `transcript` (a call theme), `gap` (a question a competitor is cited on), `seed` (a map touchpoint or seed topic), `striking_distance` (a Google query we nearly rank for), `watch_carry` (carried from last week's watch list), `room_signal` (a prospect's trigger). |
| `demand_score` | 0 to 100, the sum of the three proxies below, capped. |
| `demand_basis` | `llm_demand` 0 to 40: ten per engine that gave a substantive answer (200 or more characters with two or more citations). `transcript_evidence` 0 to 30: ten per call evidence item whose theme overlaps the query. `rising_volume` 0 to 30: when a striking-distance row matches the query exactly after normalisation, 15 for volume of 100 or more plus 15 when the position improved; otherwise 15 when a prior row exists and we went from absent to cited on any engine; else 0. `labels` always carries "no prompt-volume corpus; proxies only", plus "Google volume via DataForSEO" when volume was used. |
| `call_evidence` | Up to ten evidence items from the themes that overlap this query. |
| `gap` | `we_cited_engines`: the engines whose answer named one of our domains. `competitor_domains`: the hosts cited in this query's answers that are not ours, most frequent first, up to twelve. |
| `trend` | `new` with no prior row; else `up` or `down` when the score moved by ten or more; else `flat`. |
| `status` | `recommend`: the top three to five by score that are absent on at least two probed engines (or on every probed engine when fewer than two were probed). `watch`: the rest with a score of 30 or more. `drop`: below. |
| `touchpoint_id` | The Growth map touchpoint this question came from, when it did. |
| `probes` | One per engine asked, up to eight: `engine`, `model`, `question`, `answer_snapshot` (cleaned, up to 1800 characters), `we_cited`, `citations` (up to eight URLs), `cost_usd` (the estimate charged). A query over the per-subject cap carries an empty list. |

"Our domains" means the subject's own domains for a venture or an aspiration, and Mindmake's and Krish's domains for a prospect: the prospect read is whether Mindmake is in the answer that company's leaders would see.

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
