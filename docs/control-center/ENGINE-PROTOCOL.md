# The growth engine protocol, version 1.28.0

Every growth engine reports into Control Center through this one protocol, and Control Center pushes each engine its next move through it ([ADR-038](https://github.com/krishanraja/control-center/blob/main/docs/DECISIONS/038-one-protocol-for-growth-engines.md)). It replaces the per-engine receivers the handoffs asked for. The engines are:

| Engine | Slug in the path | `engine_id` | `product_slug` |
|---|---|---|---|
| krishanraja/growth-mindmake | `mindmake` | `growth-mindmake` | `mindmake` |
| krishanraja/growth-heartside | `heartside` | `growth-heartside` | `heartside` |
| krishanraja/growth-makeyourmindup | `makeyourmindup` | `growth-makeyourmindup` | `publication` |
| krishanraja/growth-fulltime | `fulltime` | `growth-fulltime` | `full-time` |
| krishanraja/growth-legibility | `legibility` | `growth-legibility` | `legibility` |
| krishanraja/AEO-Engine, the one AI-answers specialist (`role: specialist`, 1.22.0) | `aeo` | `aeo-engine` | `mindmake` |

The registry is the table `growth_engines`. It holds each engine's aim (its North Star), its objectives with their targets, its cadence, whether it is switched on, the SHA-256 of its bearer, and its role (1.22.0): `venture` for an engine that grows one product, `specialist` for AEO-Engine, the one AI-answers specialist every venture's engine calls (Ruling, Krish, 2026-11-12). Control Centre lists the venture engines as the engines, one a product, and shows the specialist once, under OS.

## Activation: active, held, inactive, paused

`activation_state`, which capabilities return as `activation.state`, is one of four:

| State | Woken by the push or the refill | Its asks on his list | Growth council move for its product | Its bearer | Live reports |
|---|---|---|---|---|---|
| `active` | yes | yes | none: the engine is its one strategy voice | works | taken |
| `held` | no | none | none | works | taken, and what it proposes waits until he releases it |
| `inactive` | no | none | the council's | works | refused (`engine_inactive`); synthetic only |
| `paused` | no | none | the council's | refused (401) | refused |

**Held** (Ruling, Krish, 2026-10-29): not ready means a held activation state: no wake, no asks on his list, no growth council move, and the bearer stays valid. He holds an active engine, or releases a held one, with one press on Growth > Engines (`PATCH /api/growth/engines` `{ engine_id, hold }`, `setHold` in `api/_growthEngines.ts`). While held, the directive's `next_action` is `HELD_RULE` and nothing else, not even an approved yes or a push he picked: propose nothing, ask him nothing, and report one hold that names what stops you being ready and what would clear it. A push he picked waits: the hold directive is answered, never stored over it, so his pick is your directive again once he releases you. While held, none of your row proposals reach his home screen widget and none of your Jonny pitches are drafted, even if you keep reporting. A release starts one fresh cadence: you are never counted behind for the time you were held (`released_at`). The approved executor never acts for a held engine. Within 1.x this is only a new value of `activation.state`: treat any state you do not know as not active.

## Versions

Control Center only ever adds within 1.x: a new minor version adds fields, never removes or changes one, and every older 1.x report is still taken. So:

- **Accept any 1.x** in what Control Center serves (the directive, capabilities, decisions), and ignore a field you do not know. Never require an exact version back.
- **Send the version you speak.** `capabilities.schema_versions` lists every version Control Center takes; check that yours is in it.
- **Raise yours only for a field you use.** 1.1.0 adds a proposal's `stage` and `parent_proposal_id`; 1.2.0 adds its `subject_ref`; 1.4.0 adds the North Star number and urgency to the directive (below), and nothing to the report. 1.5.0 adds `taste`, Krish's approved voice rules, to the directive (below), and nothing to the report. 1.6.0 adds a proposal's `row`, `rank`, `reach`, `amplifier_kind`, `features`, `serves` and `source_revision`, a version 2 action, 40 proposals a report, `week_goals` and `rows_rule` in the directive (`rows_rule` is no longer sent since 2026-10-28: the engine's taxonomy carries the bounds), `carried_out` and `reason_code` in a decision, and the research desk (below). 1.7.0 adds a row proposal's `because` and `brief`, which a row then needs, and the context's `mindmake_fit`, `sells_competing_services`, `known_since`, `email_last` and `quiet_ties` (below). 1.8.0 adds a row proposal's `card`, the full card a tap opens, which a row then needs, and the context's `email_inbound`, `email_outbound`, `source_list` and `last_post_at` (below). 1.9.0 lets a visibility or events row's email action name Jonny's box (`mailbox`), which Control Center drafts each day with no press, and adds each stage's podcast facts and booking route and each pitch's outcome to the context (below). 1.10.0 adds `web_analytics` to the directive for an engine whose product has a Google Analytics site with the per-post (`utm_content`) breakdown (Make Your Mind Up) or one its engine reads without it (Mindmake's mindmake.co, with `consent_gated`) (below); the meetings Krish held to Mindmake's context, with his good tap on his list (`features.meetings`); `origin_candidates` to Mindmake's report (below); the show-notes note, a version 2 action's `kind: show_notes_ask` (below); `withdrawn[]`, an engine taking back its own proposals he has not decided (below); typed `facts[]` on each person row of Mindmake's context (`features.facts`, below); and an engine's own latest live reports (`GET reports?recent=<n>`, `features.recent_reports`). 1.11.0 adds the prior-outreach read, each person's Mindmake record, for growth-legibility only (below), and nothing to the report or the directive. 1.12.0 adds `prior_mindmake` to a version 2 email action, the Mindmake record its words were written from, so Clear drafts growth-legibility's approved email into Krish's own box (`features.draft_press`, below), and reads a send's version 2 action whole at the report. 1.13.0 adds the buyer (`icp`) to growth-legibility's directive (`features.icp`), legibility.io to its directive's `web_analytics`, the site's daily totals (`daily`) and its newest check (`health`) to that block, and the research desk to growth-legibility under its own caps (below), and nothing to the report. 1.14.0 adds the engagement task, a version 2 action of kind `copy_open` behind the post wall (`features.copy_open`, below), `tapped` to a decision's `carried_out`, and `behind_by` and `rank_in_fleet` to the directive, whose `max_actions` now scales with the urgency (below). 1.15.0 adds `inspiration`, Krish's own suggestions from his inspiration board with the trials he tagged, to growth-makeyourmindup's directive (`features.inspiration`, below), and nothing to the report. 1.16.0 adds `credits`, the prepaid credit pools your product is placed on and your share of each, to every engine's directive, and `credits_spent` to the report (`features.credits`, below). 1.17.0 adds `buffer_channels` and `post_metrics` to the report, the Pull on a post he approved, and the exact-target rule for an engagement tap on X, TikTok, Instagram or LinkedIn (`features.buffer_channels`, `features.pull`, `features.post_metrics`, `features.exact_engage_targets`, below). 1.18.0 adds `found_routes` to Mindmake's report: the booking addresses and form pages your answered lookups gave, which Control Center records on the stage or the guest only when its own checks pass, and answers with what it recorded (`features.found_routes`, below). 1.19.0 adds `circle` (up to 50 public people for Krish's circle lane, matched or filed with no address) and `mirror` (the AI mirror's questions) to Mindmake's report (`features.circle`, `features.mirror`, below). 1.20.0 adds `krish_instruction` and `features` to every directive, Krish's own next best action for the engine given through Control Center's one door, and `priorities`, `obsessions`, `next_steps` and `instruction_acks` to the report, the engine's state on every place in Control Center and what it did with his instruction (`features.engine_state`, `features.krish_instruction`, below). 1.21.0 adds `instruction` to a suggestion in growth-makeyourmindup's `inspiration`, a card Krish ticked as a style to use within a week, and `inspiration_used` to the report, the cards an asset you made used, which close his tick (`features.inspiration_instructions`, `features.inspiration_used`, below). 1.22.0 makes AEO-Engine the one AI-answers specialist (Ruling, Krish, 2026-11-12): every venture engine's directive carries its own product's AI-answer standing (`ai_answers`), a venture engine asks AEO for its product's AI-answer work with `POST answers`, AEO's directive carries the open requests (`answer_requests`), and AEO's report may carry `answers_served` (`features.ai_answers`, `features.answer_requests`, below). 1.23.0 adds the morning lane (Ruling, Krish, 2026-11-13: morning drafts in Gmail with no press): Mindmake's email row actions for Krish's own box are drafted into his Gmail each day, up to 10, and stay pending until he sends, and what became of each reaches the context's `drafts` as `opted_out_at`, `bounced_at` and `binned_at` (`features.morning_drafts`, `features.mail_outcomes`, below), and nothing to the report or the directive. 1.24.0 adds four paths a meeting may come from in Mindmake's `origin_candidates` (Rulings, Krish, 2026-11-13: the full-funnel engine): `webinar`, `post-engager`, `cold-outbound` and `video-note`, each refused in a report older than 1.24.0, and keeps a first meeting with someone new, whose attendee Control Center files as a contact first (`features.meeting_paths`, below, "Held meetings and the good tap"). 1.25.0 changes no report field: Mindmake's listed buyers come with their person rows and triggers, drafts with their person, feedback with its id, and his open deals by person (`features.advisory_people`, below, "Warm buyers"). 1.26.0 changes no report field: a venture engine's AI-answer standing carries its questions, AEO's win kits, its cited pages, its request's digest and, for Mindmake, the portfolio; `POST answers` takes `mode`, `shipped` and `targets`; and AEO-Engine's open requests carry them, its kits now reaching Krish through the venture engines (`features.ai_answers_detail`, `features.answer_requests_v2`, `features.aeo_kits_delivered`, below, "AI answers"). 1.27.0 changes no report field: a wake that carries Krish's instruction also starts your own instruction job with `repository_dispatch` `cc-engine-instruction` (`features.instruction_job`, below, "Starting the work"). 1.28.0 changes no report field: Mindmake's context carries `upcoming_meetings`, the meetings still to come in the next fortnight (`features.upcoming_meetings`, below, "Meetings still to come"). 1.10.0 was served in steps on 2026-10-27, some after 1.11.0 and 1.12.0: rely on its feature flags (`withdrawn`, `show_notes`, `facts`, `recent_reports`), never on the version alone.

**Keep one copy of this protocol.** `docs/app/growth/protocol-bundle/` in Control Center is the copy every engine keeps: these four files (this document, both schemas and the example report), public-safe (every email address reads `<address>`), and `bundle.json` with the version, each file's sha256 and one `bundle_sha256`. Copy the directory verbatim into your repository, test each file against its sha256, and on each run compare your `bundle_sha256` with the one capabilities serve as `protocol_bundle` (`{ version, bundle_sha256 }`, a capability with no version of its own). Report one counted line, `protocol_copy: current`, `behind <version>` or `unknown` when capabilities cannot be read; a copy that is behind is never a reason to hold a run. The hash is sha256 of `version <version>\n` followed by one `<file> <sha256>\n` line per file in name order.

On 2026-10-19 Control Center began serving 1.1.0. Legibility required exactly 1.0.0 back from capabilities, and Mindmake from the directive, so both stopped on every run (`receiver_contract_mismatch`, `directive_invalid`) and reported nothing for two days. That is why this rule exists.

## The daily loop

Each run, every engine does these five things, in this order:

1. **Pull its directive.** `GET /api/growth/engines/<slug>/directive` returns today's one next action.
2. **Act inside the walls.** Nothing sends, posts, spends, deletes or changes a permission unless Krish has made a decision whose `payload_sha256` matches what the engine is about to do.
3. **Journal the attempt.** `POST /api/growth/engines/<slug>/attempts`, once when the run starts and once when it ends.
4. **Report.** `POST /api/growth/engines/<slug>/reports` sends what it measured, what it did, what it proposes, what closed and what it held.
5. **Read his decisions.** `GET /api/growth/engines/<slug>/decisions?since=<time>` returns his yes and no on what it proposed.

**When the loop starts.**
- Every day at 05:10 UTC (`/api/growth/engines-dispatch`; 00:10 in New York, Krish's `operator_timezone`, whose civil day names the directive), Control Center writes each active engine's directive.
- Where dispatch is on, it also wakes the engine's repository with one `repository_dispatch` of type `cc-growth-directive`. The payload is `{ directive_id, engine_id }`, nothing else, and the engine pulls the rest with its own bearer.
- An engine that does not run on GitHub Actions just pulls the directive at the start of its own run. The directive is the same either way.
- Control Center may wake an engine again later the same day with the same payload (growth-mindmake, when a row of his widget runs low; at most once an hour). An engine treats it as another run of the same day: it pulls the directive again and reports with a new `run_id`.

## Auth

**The bearer.**
- Each engine has its own bearer: `Authorization: Bearer gen1_<43+ url-safe characters>`.
- Control Center stores only its SHA-256, on `growth_engines.token_sha256`. The token goes into the engine repository's own secrets as `CONTROL_CENTER_ENGINE_TOKEN`.
- `scripts/growth/issue-engine-token.mts` issues one. Running its SQL replaces the old token, which stops working at once.

**What the bearer can and cannot do.**
- A token opens its own engine's routes only. A token for another engine gets the same 401 as no token.
- It cannot open Krish's dashboard routes, and his cookie cannot write to these.
- No CORS headers are sent; these are server callers.
- Requests are rate limited to 60 a minute per token, and every response is `Cache-Control: no-store`.

**Base URL.** `https://controlcenter.krishraja.com`, in the engine's `CONTROL_CENTER_URL`. HTTPS only. Do not follow redirects. Use bounded timeouts. Never retry a write blindly: read it back first.

## Routes

### AI answers: one specialist for every venture (1.22.0, `features.ai_answers`, `features.answer_requests`)

Ruling (Krish, 2026-11-12): "AEO-Engine becomes the one specialist that every venture's growth engine calls for its AI-answer work. Each venture's tile shows its own AI-answer standing, the separate 'mind/make, AI answers' tile goes, and Control Centre's own AI-answer checks and Heartside's separate Answers job fold into AEO." And on AEO's North Star: "the share counts the questions asked that fortnight (1 of 100 = 1% on 8 Nov); questions not asked stay unknown rather than lost."

**A venture's engine** (every engine whose registry `role` is `venture`; capabilities say `features.ai_answers: true`):

- Never probes an AI assistant itself, and keeps no AI-answer job of its own. Its AI-answer work is AEO's.
- Reads its own product's standing in the directive, as `ai_answers: { standing, rule }`, added when the directive is served (absent when it could not be read; never a guess). `standing` is null or `{ product_slug, tracked, latest, misses, moves, history, request }`: `tracked` says AEO has a subject for the product; `latest` is the newest fortnight AEO asked about it, `{ as_of, asked, cited_first, share }` (share in percent), or null; `misses` are up to three of that fortnight's questions where another site is cited first, each `{ question, first }` (the host cited first, or null when nothing was cited); `moves` are up to three of AEO's moves to win them, from its newest digest, `{ title, target_query }`; `history` the older readings, newest first, up to six; `request` its own newest request, `{ id, state, questions, requested_at, served_at }`, or null. `GET /api/growth/engines/<slug>/answers` answers the same standing on its own, `{ ok, schema_version, read_at, ai_answers, rule }`.
- Asks AEO for its product's AI-answer work with `POST /api/growth/engines/<slug>/answers`, body `{ questions: [string], domains?: [host], note?: string }`: 1 to 25 buyer questions, each 8 to 300 characters, exactly what a stranger types, never an address, a link or a number; up to 5 bare hosts its product is cited by; a note of at most 400 characters. For its own product only: the bearer names the engine and the engine its product. A newer request replaces its open one. A product AEO has no subject for gets one from the hosts named, so the first request must name them (400 otherwise). Answers `{ ok, request_id, product_slug, subject: 'existing' | 'created', questions, replaced }`. Asking is not spending: AEO asks the questions at its next research run, under its own spend cap, and the misses and moves come back in `ai_answers`.

**The specialist** (AEO-Engine; capabilities say `features.answer_requests: true`):

- Reads the venture engines' open requests in its directive, as `answer_requests: [{ request_id, engine_id, product_slug, subject_slug, questions, requested_at }]`, added when the directive is served, or with `GET /api/growth/engines/aeo/answers` (`{ ok, schema_version, read_at, answer_requests }`). It never files one (403).
- Asks each request's questions verbatim, first, under that product's subject at its next research run, and says which it asked in its research report: `answers_served: [request_id]` (at most 50, 1.22.0, refused before 1.22.0 and from any other engine). Control Centre marks each served; a replay changes nothing twice, and a failure never unaccepts the report.
- Its packets carry a venture's own product slug (the packet schema takes `heartside`, `legibility` and `publication` beside the five before), so each venture's standing is read from its own subject.

**The detail (1.26.0, `features.ai_answers_detail`; Ruling, Krish, 2026-11-13: AEO's win kits reach him through each venture's own growth engine).**

When capabilities say `features.ai_answers_detail: true`, a venture's `standing` (in the directive and from `GET answers`) also carries:
- **`questions`:** up to 40, the newest research run's questions, one each. Each is `{ query_id, question, state, engines: [{ engine, our_position, first_host, first_url, searched }], first_seen, won_at, lost_at, kit_id }`:
  - `state` is AEO's own panel when it sent one (`won`, `contested`, `cited`, `retrieved`, `absent`, `unknown`);
  - otherwise it is read from the answers: first on any assistant is `won`, ours cited later is `cited`, none is `absent`.
  - Questions with a kit come first, then those not won.
- **`kits`:** up to 5 of AEO's win kits from its newest digest, best priority first, exactly as AEO-Engine sent them (its `docs/packet.schema.json`, `$defs.kit`). There are none while Krish holds your engine.
- **`cited_pages`:** up to 20 pages from the cited-pages sheet worth reaching out to.
  - Never a platform or one of ours, ranked by times first, times cited, questions, then URL.
  - Each is `{ url, host, page_type, questions, engines, times_cited, times_first, mention, mention_ok, checked_at, status }`.
  - A `link` or `name` mention with `mention_ok: true` is already mentioned: skip it. `mention_ok: false` means refresh needed. `status` is the outreach state; "mention acquired" is set from AEO's reading, never by hand.
  - Outreach from it is drafted for Krish, venture by venture, and nothing is sent, paid or agreed without his yes.
- **`request.digest`:** the lowercase hex SHA-256 of the request's questions. Each is trimmed with every run of whitespace made one space, sorted by code point, and written as compact JSON with non-ASCII unescaped, UTF-8 encoded. That is JavaScript `JSON.stringify`, or Python `json.dumps(sorted(...), separators=(',', ':'), ensure_ascii=False)`. Re-ask when your own list's digest differs.
- **`portfolio`:** growth-mindmake only. The same standing for CTRL, Circle and Pulse, which no engine of their own reads.

`POST answers` then also takes:
- **`mode`:** `replace` (the default, as before) or `append`. Append adds your questions to the open request, keeping its own first, at most 25.
- **`shipped`:** up to 25 `{ question | query_id, url, shipped_at }`, a page that has shipped for one of your questions. It is kept per product and page, the newest word winning, and AEO asks those questions first.
- **`targets`:** up to 25 `{ question, url }`, the page you mean to win each question with.

Every URL is a public https page with no login, address or port. The hosts in `domains` may now be added to your product's subject after its first request, never one another product's subject counts and never one that is not ours (`addableHosts`). The answer says what it did: `{ ..., mode, shipped, targets, domains_added, domains_refused }`.

**The specialist (1.26.0):**
- With `features.answer_requests_v2`, each `answer_requests` item also carries `note`, `mode`, `targets` and `shipped`, the product's shipped pages newest first.
- With `features.aeo_kits_delivered`, the venture engines carry its win kits to Krish, so AEO-Engine proposes no kit of its own and keeps its check-ins.

**What Control Centre reads and shows.** Each venture's standing is read from AEO's stored research (`growth_geo_probes` rows with a `run_id`, `growth_aeo_subjects`, `growth_aeo_digests`, `growth_answer_requests`; `api/_aiAnswers.ts`, `src/lib/aiAnswers.ts`), on its engine's tile and in its drawer. AEO's own number is the share of questions cited first in the newest research fortnight across every counted subject (a venture, or a prospect with Mindmake's domains; an aspiration is never counted), over the questions actually asked that fortnight: a subject not asked adds nothing, so a question not asked is unknown, never lost. Control Centre measures it (`READERS['aeo-engine']` in `api/_northStarRefresh.ts`, unknown past 16 days) and shows it once, under OS, Systems. Control Centre's own Monday probe (`api/growth/geo-probe.ts`) is retired: it answers 410, and its past rows stay in `growth_geo_probes` with `run_id` null, as history.


### Scoped context and complete outcomes (1.3.0)

Capabilities add `features.context`, `features.outcomes` and `features.exact_actions`.
Each is false when the engine or deployment lacks the corresponding adapter.
Older reports and clients remain valid. A catalog entry does not prove usable access.

`GET /api/growth/engines/<slug>/context` returns `{ ok, context }` with
engine/product identities, observation time, native records, selected Network
identities, canonical warm paths, proof permissions and per-source coverage.
Each coverage entry carries availability, completeness, row count, source date
and reason. The Network selection is bounded and explicitly partial. Relationship
warmth and consent classification have separate counts and definitions. These
reads contain no raw correspondence, mailbox addresses, profiles or credentials.
Correspondence, transcripts and connectors unverified through the engine bearer
remain visibly unavailable. This is a scoped preparation read, not a new CRM.
`work_context` reuses the existing version-1 selected-job contract and snapshot
builder. Jobs come from native Advisory `growth_context.engine_jobs`, with
their existing source identities; no parallel job table is created. That
context runs the complete producer cycle before fresh campaign preparation,
under the shared capacity. An unavailable context or missing source holds
those jobs explicitly. Native replies without enough request context block
fresh acquisition; engine plan declines are retained until a new review.

`GET /api/growth/engines/<slug>/outcomes` returns `{ ok, outcomes }` with
complete paginated native lifecycle records, source coverage, London-week and
original first-30-day windows, and explicit definitions/unavailable measures.
The read is independent of contact selection. Bookings never count as held calls;
qualification remains human-owned. A paid timestamp without independent payment
evidence cannot establish a verified paid proof. Missing coverage is unknown.
Recognition, distribution, efficiency and free-pilot measures remain unknown until
their native sources record complete evidence; never infer them from drafts.

The initial adapter is Mindmake only. Other engines receive feature flags false
and 404 for these reads, with their existing reports and directives unchanged.

### Exact approved actions (1.3.0)

`GET /api/growth/engines/<slug>/prepare-action/<plan_id>` prepares an action
from an approved campaign plan and its current native record. It returns an
existing unexpired child unchanged, or `completed`, before preparing anything
new. Current proof permission and recipient eligibility are checked again.

The action is the proposal's full JSON `exact_payload`: version, channel,
recipient contact id and address, subject, body, assets, cost, not-before,
expiry, source reference and source updated time. Its digest is SHA-256 of
canonical JSON of the action. A go-live names the approved parent plan.
An amendment is approved as the entire finished action and uses the existing
amendment digest. Any native edit, changed address, suppression, closed window
or invalid digest blocks execution. The two-London-day window accommodates
the next daily dispatch, including the clock change.

`POST /api/growth/engines/<slug>/execute/<proposal_id>` is the shared executor,
separate from the proposal-only handler and all drafting surfaces. It accepts
no action supplied in the request: the approved record is authoritative.
Only zero-cost email with no assets is supported, about an Advisory deal
(`source_ref: pilot:<uuid>`) or, with no deal, about the person it goes to
(`source_ref: contact:<uuid>`, the recipient's own id: a partner, an intro;
since 2026-11-14, audit cos-6). A link put on words in the body
(`[the proposal](https://...)`, https only) is sent as HTML with the link on its
words beside the exact plain text; no other markup is read, and the receipt is
verified on the plain part. Nobody whose reply asked for no more email
(`people_drafts.opted_out_at`) is sent to, checked before and again at the
claim. This replaces sending such a note through the n8n workflow "Mindmaker
OS | Send Email", which kept no receipt. Unsupported channels, attachments,
spend and direct Visibility execution are blocked. An institutional first message may use its
linked native Advisory relationship; Visibility still owns the session and gates.

A private service-only `growth_engine_actions` journal claims each proposal once,
inside a transaction that checks both approvals and the current registry. A send
acknowledgement is `submitted`. Only an independent Gmail GET with the matching
recipient, subject, body and SENT label permits `verified`. Lost or ambiguous
sends stay `claimed`/`unknown` and are never resent. Known provider ids can be
reconciled with `POST .../execute/<id>` and `{ reconcile: true }` without
another send. `GET .../execute/<id>` only reads the receipt.
The existing `mail_sent` done check moves the native lifecycle from the verified
receipt, preserving one completion system and its audit and Undo behavior.

Never claim autonomy from configuration or a green run. Acceptance still requires
an exact human-approved external action and a real independently verified receipt.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/growth/engines/<slug>/capabilities` | | `{ schema_version, schema_versions, protocol_bundle: { version, bundle_sha256 }, autonomy, engine_id, product_slug, idempotency: true, activation: { state, activated_on }, features[, research: { kinds, per_day }] }`; `research` only for an engine the research desk is open to (below) |
| `GET /api/growth/engines/<slug>/directive[?date=YYYY-MM-DD]` | | `{ ok, chosen_by: 'rule'\|'krish', directive }` |
| `POST /api/growth/engines/<slug>/reports` | header `Idempotency-Key: <run_id>`, body a report | `{ accepted: true, run_id, payload_sha256, replayed[, found_routes][, circle][, instruction_acks] }`; `found_routes` (1.18.0) only when the report carried routes, `circle` (1.19.0) only when it carried people, `instruction_acks` (1.20.0) only when a live report carried acks: `{ applied, unknown, stale }` (below) |
| `GET /api/growth/engines/<slug>/reports/<run_id>` | | `{ accepted: true, run_id, payload_sha256, mode, accepted_at, report }`, or 404 |
| `GET /api/growth/engines/<slug>/reports?recent=<n>` (1.10.0, `features.recent_reports`) | | `{ ok: true, reports: [{ run_id, accepted_at, status, activity }] }`: the engine's own latest live reports, newest first, `n` from 1 to 10, never the proposals or the full payload, so an engine counts its own proof runs without a ledger of its own |
| `POST /api/growth/engines/<slug>/attempts` | an attempt | `{ ok: true, attempt[, replayed] }` |
| `GET /api/growth/engines/<slug>/attempts/<attempt_id>` | | `{ ok: true, attempt }`, or 404 |
| `GET /api/growth/engines/<slug>/decisions[?since=<time>]` | | `{ ok, decisions: [{ proposal_id, decision: 'approved'\|'declined'\|'done', decided_at, payload_sha256, stage, amended[, exact_payload, amount_usd, amended_sha256][, carried_out][, reason_code, reason_text] }] }` |
| `POST /api/growth/engines/<slug>/research` | `{ requests: [...] }` (1.6.0, Mindmake; 1.13.0, Legibility, its own caps) | `{ ok, research: [{ request_id, kind, subject_ref, query, why, status, evidence, answer, requested_at, answered_at }] }` |
| `GET /api/growth/engines/<slug>/research[/<request_id>]` | | `{ ok, research }`, or 404 |
| `GET /api/growth/engines/<slug>/prior-outreach?contacts=<id>,<id>` | 1 to 50 contact ids (1.11.0, growth-legibility only; 404 `prior_outreach_not_supported` for any other engine) | `{ ok, schema_version, read_at, prior_outreach }`, each id's Mindmake record (below, "Prior Mindmake outreach") |

The context, outcomes, prepare-action and execute routes are above, under 1.3.0.

**Features.** `capabilities.features` names its flags (`api/_growthEngines.ts`). Each says whether this deployment serves that part to this engine; a false flag means do not use it. A flag added without a version (`places`, `suppression`, `asset_links`, `network_routes`) is a capability, not a version: send or read its part at whatever 1.x you speak, once the flag is true.

| Flag | Since | Which engine gets it |
|---|---|---|
| `directive`, `reports`, `attempts`, `decisions`, `synthetic` | 1.0.0 | every engine |
| `stages`, `amendments` | 1.1.0 | every engine |
| `subjects` | 1.2.0 | every engine |
| `context`, `outcomes`, `exact_actions` | 1.3.0 | Mindmake |
| `rows` | 1.6.0 | Mindmake |
| `decline_reasons`, `carried_out` | 1.6.0 | every engine |
| `research` | 1.6.0 (Mindmake), 1.13.0 (Legibility) | Mindmake and Legibility, each under its own caps |
| `meetings`, `show_notes`, `facts` | 1.10.0 | Mindmake |
| `withdrawn`, `recent_reports` | 1.10.0 | every engine |
| `prior_outreach` | 1.11.0 | Legibility |
| `draft_press` | 1.12.0 | Legibility |
| `icp` | 1.13.0 | Legibility |
| `copy_open` | 1.14.0 | every engine |
| `credits` | 1.16.0 | every engine; the block comes only to one whose product a pool is placed on |
| `found_routes` | 1.18.0 | Mindmake, where the recorder is wired in |
| `circle` | 1.19.0 | Mindmake, where the recorder is wired in |
| `mirror` | 1.19.0 | Mindmake, where an answer engine key is set |
| `engine_state` | 1.20.0 | every engine. The directive's own `features.engine_state` says the same: send `priorities`, `obsessions`, `next_steps` and `instruction_acks` only when it is true |
| `krish_instruction` | 1.20.0 | every engine, where the instructions table is served |
| `taste_floor` | no version (I-14) | every engine: the directive's `taste` carries `floor` and `approved_production_rules` (above) |
| `instruction_job` | 1.27.0 | every engine, where the instructions table is served: a wake that carries his instruction also sends `repository_dispatch` `cc-engine-instruction` (below) |
| `inspiration_instructions`, `inspiration_used` | 1.21.0 | growth-makeyourmindup, where the inspiration board is served |
| `ai_answers` | 1.22.0 | every venture engine (`role: venture`), where AI answers are served: its product's standing in the directive, and `POST answers` |
| `answer_requests` | 1.22.0 | AEO-Engine alone (`role: specialist`): the open requests in its directive, and `answers_served` in its report |
| `morning_drafts` | 1.23.0 | Mindmake: its email row actions for Krish's own box are drafted into his Gmail each morning with no press (below) |
| `mail_outcomes` | 1.23.0 | Mindmake, where the context is served: each morning draft's `opted_out_at`, `bounced_at` and `binned_at` in `drafts` (below) |
| `meeting_paths` | 1.24.0 | Mindmake, where its meetings are served: four more paths in `origin_candidates`, and a first meeting with someone new kept, its attendee filed as a contact (below, "Held meetings and the good tap") |
| `ai_answers_detail` | 1.26.0 | every venture engine, where AI answers are served: the standing's `questions`, `kits`, `cited_pages`, `request.digest` and, for Mindmake, `portfolio`; `POST answers` takes `mode`, `shipped` and `targets` |
| `answer_requests_v2` | 1.26.0 | AEO-Engine alone: each open request carries `note`, `mode`, `targets` and `shipped` |
| `aeo_kits_delivered` | 1.26.0 | AEO-Engine alone: the venture engines carry its win kits to Krish, so it proposes none of its own |
| `advisory_people` | 1.25.0 | Mindmake, where the context is served: each listed buyer and intro ask in `records.advisory` carries its `person` row and stored trigger, each `drafts` row its `contact_id`, each `feedback` row its `id`, and `records.deals` his open Pipeline deals by person; the morning lane writes to no one with an open deal (below, "Warm buyers") |
| `upcoming_meetings` | 1.28.0 | Mindmake, where the context is served: `upcoming_meetings`, the meetings still to come in the next fortnight (below, "Meetings still to come") |
| `places` | no version (2026-10-28) | Mindmake, where the context is served |
| `suppression` | no version (2026-10-28) | Mindmake. Its list hides the widget's rows and its taxonomy checks rows, Nos and presses (below) |
| `asset_links` | no version (2026-10-28) | Mindmake, where the context is served and SendLinks is connected |
| `voice_check` | no version (2026-11-07) | every engine. `POST voice-check` with `{ text, channel, subject?, mode? }` (channel: Krish's own `email`, `linkedin`, `x`, `threads`, `substack_note`, `instagram`, `message`, `comment`, `form` or `clip`; Jonny's `email_jonny`; or the publication's `script`, `article`, `caption`, `carousel` or `substack`, which add Make Your Mind Up's canon; exactly `VOICE_CHANNELS` in `src/lib/voiceRules.ts`, and any other is refused with 400) answers `{ ok, check }`: krish-voice's hard fails, warnings, scored checks, fingerprint and distance. Check words in Krish's name before you hand them over; Control Center holds a draft with a hard fail and never rewrites an engine's words. A verdict only, never approval (docs/app/everywhere/voice-check.md) |

**Errors.**
- **400:** the report or attempt is malformed. The body names the field.
- **401:** the token is wrong or missing.
- **403:** the report names another engine or product.
- **409:** one of three things:
  - the same run was already reported with a different payload, which is a conflict
  - an attempt already has a different terminal record
  - `engine_inactive`, a live report from an engine Krish has not switched on (a held engine's live report is taken)
- **413:** the report is over 512 KB.
- **429:** rate limited, with `Retry-After`.
- **500 `store_failed`:** the store failed. This is redacted and carries no row or body.
- **503 `research_store_unavailable`:** the research desk could not read its own requests, so nothing was asked (`api/_growthResearch.ts`).

### Krish's instruction and the engine's state (1.20.0)

Ruling (Krish, 2026-11-11): every growth engine's priorities, obsessions, next steps and outstanding items feed live across Control Centre, and Krish instructs each engine with his next best action, which starts it. In his words: "They are responsible for driving the overall success of each venture, so make sure I can instruct each one with my next best action and have it get going (as well as always understand the current state of play and what's outstanding)."

**His instruction.** He gives it from any engine through the one door (the Engine drawer's Instruct, the door's `engine` hint; `api/_sayRun.ts` kind `instruction`, no model). Control Center keeps it in `growth_engine_instructions` and:

1. marks any open instruction of yours `superseded`: one is open at a time;
2. stores the new one, `ki_` and 24 hex characters, open;
3. if you are held or paused: does not wake you and leaves your directive alone (`queued_held`). When he releases you, it is carried and woken once, under the cap;
4. otherwise rebuilds today's directive so it carries `krish_instruction`, keeping the rule's `next_action` and any pick of his, and sets `picked_up_at` back to null;
5. wakes you at most once in 5 minutes and 12 times in his day (over that, `capped`: the next wake or push carries it);
6. sends the same `repository_dispatch` `cc-growth-directive`, now with `{ directive_id, engine_id, instruction_id }`: ids only, never his words. With no dispatch token it is `pull_only`, which is not a failure.

`krish_instruction` is `null | { id, words, given_at, given_by: "krish", supersedes }`, carried in every day's directive until you ack it `done`, he withdraws it (Purge), marks it done (Clear) or replaces it, or it is 7 days old (then `expired`). His Bump ("Send it again tomorrow") leaves it out until the start of his next day, so that day's push carries and wakes it. It is never `next_action.instruction`, which stays Control Center's own words. **It is never an approval**: the walls do not move, so a send, post, spend, delete or permission change it asks for still comes back to him as a walled proposal he approves by `payload_sha256`. A held engine's directive carries `krish_instruction: null` and `HELD_RULE`, nothing else.

**Never print, log or commit his words.** Your repository and its Actions logs are public: show only the id and, if you must, a SHA-256 digest.

**Your acks.** On the run whose directive carries an instruction you have not acked, send `instruction_acks: [{ instruction_id, state: 'received', line, at, evidence_url }]` and put one activity line first saying you received Krish's instruction `<id>` (the id only). If you act on it in that run, send `started` and then `done` or `blocked`, each with a line: what you did, or why it is blocked and what would unblock it, never his words. Control Center applies acks from live reports only, to your own instructions only, and forward only: `received`, then `started` or `blocked` (each can follow the other), then `done`, and nothing after `done`. `done` closes it. An id that is not yours is ignored and counted (`unknown`), a step backwards is ignored and counted (`stale`). The step it already holds, sent again (`received` again, `started` again, `blocked` again, as you may on every run while you work on it), is never a step backwards: with a new line and a later `at` it replaces the line he sees and counts as `applied`, with the same line it changes nothing and counts nothing, and with another line but an earlier `at` it is `stale` (since 2026-11-12; until then every repeat was counted `stale` and the first line stayed on screen). An ack never goes in `holds`. An ack may also come from a working session in your repository on Krish's own Control Center connection (`get_engine_instruction` reads the open instruction for the repository, `ack_engine_instruction` answers it by the same forward-only rule; I-13, 2026-11-14), so a session that takes his instruction up answers it the same way your run would.

**Starting the work (1.27.0, `features.instruction_job`).** Whenever a wake carries his open instruction (his press, his release of a hold, or the day's push while it is open), Control Center also sends `repository_dispatch` with `event_type: cc-engine-instruction` and `client_payload: { instruction_id, engine_id, directive_id }`, ids only. A repository with no workflow for that event ignores it and its directive run still acks `received`. To carry instructions out, run a job on that event that starts Claude Code in your own GitHub Actions (the pattern content-engine's make job uses; never a Claude routine), reads `krish_instruction` from today's directive with your own bearer, works inside the walls, opens an auto-merging pull request for any change to your repository, and acks `started`, then `done` or `blocked`, in a live report. An instruction is never an approval: anything that sends, posts, spends, deletes or changes a permission still comes back as a walled proposal. Use the same concurrency group for the job and your directive run, so two never write state at once.

**Your state.** At 1.20.0, and only when the directive says `features.engine_state: true`, a report may carry:

| Field | Shape | What it is |
|---|---|---|
| `priorities[]` | at most 5 `{ rank: 1..5, line, objective_key \| null }` | what you are chasing, most important first: from your North Star line and your own constraint or recommendation |
| `obsessions[]` | at most 3 `{ line, since: YYYY-MM-DD \| null }` | only Krish's own quoted aims from your docs, as lines. Never invent one; leave the field out when you have no source |
| `next_steps[]` | at most 5 `{ line, waits_on: engine \| krish \| other, when: YYYY-MM-DD \| null }` | what you do next: your first unticked step and your NOW.md's "What is next" |
| `instruction_acks[]` | at most 5, as above | what you did with his instruction |

Each line is plain text on one line, at most 200 characters (an ack's at most 280), with no address or phone number; anything else refuses the report. Control Center shows them on every place exactly as you sent them (`GET /api/growth/engines`), says "Not reported yet" for a field you left out, and never infers one. Your state is read from your newest live report that carries any of `priorities`, `obsessions` or `next_steps` (`readStateReports` in `api/_growthEngines.ts`, `state_report` on the read), so a report that carries none of them (a handoff, a claim) never blanks it; every place shows that report's time, and once it is more than a day old it says so plainly ("Reported 2 days ago, more than a day old"; on Home's tile "(said 2 days ago)"). Send your state on the report that plans your day; another report may leave it out. When no report has ever carried `next_steps`, it shows your NOW.md's "What is next and what is waiting on Krish" instead, and your "Where it is right now" is the state of play either way.

**A second wake in a day.** An instruction can wake you twice in one day, so `run_id` must be unique per wake: add the GitHub run id and attempt, or your own `--run-id` discriminator.

### The five rows: people in front of Krish (1.6.0)

Ruling (Krish, 2026-10-26): growth-mindmake owns everything about growing Mindmake and connecting Krish to the right people: who, how far each one reaches, the words, and what it learns from his answers. Control Center holds the holistic view: the records, the walls, the press, and his home screen. It ranks nothing itself and never writes a Mindmake pitch ([ADR-041](https://github.com/krishanraja/control-center/blob/main/docs/DECISIONS/041-the-engine-hunts-control-center-holds.md)).

Every action should make him exponentially more visible, so the engine hunts amplifiers, people whose yes puts him in front of many others (`amplifier_kind`): `investor` (prolific investors), `connector` (well-connected people), `ai_capital` (people anywhere with inordinate money who want to shape AI and steer their investments to it), `ai_trainer`, `student_educator` and `ceo_educator` (those who teach AI, students or CEOs at scale), and `broadcaster` (mass broadcast and social channels on growing with AI).

A proposal for his home screen carries, on top of 1.2.0:

| Field | Meaning |
|---|---|
| `row` | `reach_out`, `network`, `visibility`, `events` or `partners`: where it shows. The ask decides the row (an intro or a portfolio session, getting closer, appearing on their channel, a talk or a session, co-delivering) |
| `rank` | The engine's order within the row, 1 first. Control Center shows this order and never re-ranks it |
| `reach` | `{ value, band, basis, source_url, as_of }`. A `value` is a claim, so it names its `source_url` and `as_of`, and its `band` matches it. Without a source give `value: null` and a band; `unknown` is said, never guessed |
| `amplifier_kind`, `features` | The kind, and `{ sector, topic, seniority }` (lower-case words, seniority `c_suite`, `senior` or `other`), which his reasons for a No filter on |
| `serves` | One of `week_goals`, word for word, or null |
| `source_revision` | 1 to 8 `{ repo, path, sha }`: every file the words were written from, by its git blob SHA on the default branch. Before he acts, Control Center reads each SHA again; a file that moved or went makes the action stale (it shows the next one, and you write it again), and a repository it cannot read acts on nothing. It holds no venture fact itself |

**Why him, why them (1.7.0).** Krish, 2026-10-27: "I have no idea whether I want to do those things or not. Or why I should do those things." At 1.7.0 a row proposal also carries, and needs:

| Field | Meaning |
|---|---|
| `because` | 1 to 80 characters, the line under the title on his card (two lines of it): who they are and why them, so he can decide from the card alone ("Hosts a 6-year tech podcast. Known since 2021, last email Jun 2024."). With it, a 1.7.0 row's title is at most 56 characters, so both fit beside the presses whole |
| `brief` | 2 to 6 lines of at most 200 characters, what he reads when he taps the card: who they are, how he knows them, why them, what a yes gets him (the goal), the reach and its basis, and the Mindmake fit. Control Center shows it above the exact words a press would carry out |

A 1.6.0 row is still taken without them; its `why` stands in for the case.

**The full card (1.8.0).** Krish, 2026-10-27: "I need to be fully in the know as to who they are, why I'm getting in touch with them, what benefit I would have, and what angles to take." At 1.8.0 a row proposal also carries, and needs, `card`, which a tap on the card opens in parts (the phone shows the 1.7.0 `brief` to an older app, so keep both, saying the same facts):

| Part | Meaning |
|---|---|
| `who` | 1 to 320 characters: who they are and what their organisation does, from the record's `who` or their title and company |
| `known` | 1 to 240: how he knows them, plainly: since when, through what (Gmail, LinkedIn connections, phone contacts), the emails each way and the last one. Never a claim the counts contradict ("You have written to each other" needs mail both ways) |
| `why` | 1 to 3 whole sentences of at most 240: why them, and why now (their hook, their company's moment, a recent public post) |
| `gain` | 1 to 3 whole sentences of at most 240: what he gets if they say yes, tied to the week goal it serves, a number only with its source |
| `angles` | 1 to 3 `{ title, line }`: the angle to take, its title (at most 60) from the venture's own canon, its line (at most 240) tying that theme to this person |
| `sources` | 0 to 6 `{ label, url }`: the public https pages the facts came from. Never a way to reach them: a LinkedIn profile, `mailto:`, `wa.me` or `tel:` link is refused |

A card that cannot say who, why and what he gets is not one he can decide on: hold the suggestion and ask for the research that would fill it, rather than send a thin one. A 1.7.0 row is still taken without a card; the phone shows its brief.

A row proposal is a prepared `send`, `stage: null` (Krish carries it out himself, so it is never a go-live the executor could send), with `subject_ref` set and `channel` equal to its action's. Its `title` is the line he reads on his phone, shown whole, so it is at most 72 characters of plain words. Its `exact_payload` is a **version 2 action**, with no address and no number: Control Center reads those from its own records when he presses.

```json
{ "version": 2, "channel": "email", "recipient_contact_id": "<uuid>", "subject": "One line", "body": "The words", "form": null, "mailbox": null }
```

`channel` is `email` (a subject, up to 7,000 characters), `x_message` or `whatsapp` (up to 1,000, opened for him with the words typed), or `form` (`recipient_contact_id` null, `form: { url, answers: [{ label, value }] }`, 1 to 40 answers). `mailbox` (1.9.0) and `kind` (1.10.0, `show_notes_ask` or absent), and `asset_ref` (no version, `features.asset_links`), are below. The recipient may differ from `subject_ref`: an introduction goes to the mutual and is about the person they introduce. A 1.6.0 report may carry 40 proposals, a ranked queue for each row.

**His answer.** From his home screen widget, or from Clear on his one list (Krish, 2026-10-26: Clear on Home makes the draft too), the press carries it out and records how (`carried_out`: `draft`, a Gmail draft he sends himself; `message`, a message app opened with the words typed; `submit`, a form submitted on his tap). Never send or submit a proposal he carried out; the shared executor refuses it (`carried_out_by_krish`), and Control Center reports the closing event when it sees it. Purge carries `reason_code` (`wrong_person`, `not_now`, `already_in_touch`, `too_small`, `wrong_audience`, `not_my_topic`, `pitch_off`, `other`) and his own words in `reason_text`: offer better, and do not offer that person, or anything like it on that reason, again. The context's `feedback` carries every past answer with the row, subject, `amplifier_kind`, `features` and `reach` it was about, so a reason can be applied to what is like it and what he taught is never forgotten.

**Context, 1.6.0** (Mindmake). On top of 1.3.0, `GET .../context` adds `amplifier_candidates` (up to 300 people on tiers 1 to 4 who read as reaching many, up to 200 close ties first and then 100 from the wider network, each by followers: a title tagged amplifier or multiplier, 5,000 followers or more, or a creator or influencer badge; a wide net, you judge), `routes` (per contact id, `{ email: verified|unchecked|none, x, linkedin, instagram, whatsapp, in_network }`, never the address; `in_network` since `features.network_routes`, below; X only once the person's numeric X id is on file, since X's message link needs it; WhatsApp only for someone close), `companies` (`company_intel` for their domains), `research` (below; anyone a research row names, by `subject_ref` or as a commenter he already has, gets `routes` too) and `voices` (the people he follows for inspiration, as the content engine keeps them in `content_creators`: `{ slug, name, linkedin_url, why, last_post_url, last_post_at }`; who gathers under them is yours to find). Each part has its coverage line; a part that cannot be read says so and is never sent empty.

**Context, 1.7.0.** Every row of `network`, `amplifier_candidates` and the new `quiet_ties` carries `mindmake_fit` (Control Center's own read of how well the person fits Mindmake, 0 to 100, or null when unscored, never another venture's score), `sells_competing_services` (true when they sell what Mindmake sells), `known_since` and `email_last` (the date of the last email between them, the one record of contact Control Center keeps: `last_touch_at` is never written). `quiet_ties` is up to 100 close ties (`1_reciprocated`, `2_core_network`) whose last email is more than 90 days old, best fit first, with their `routes`. Control Center ranks none of it; which are worth his time is yours.

**Context, 1.8.0.** The same rows also carry what the full card is written from: `email_inbound` and `email_outbound` (how many emails each way), `source_list` (where he knows them from, by source name: `gmail_*`, `linkedin_export`, `phone_address_book`, `instagram_export`, `meta_export`; never an address), `last_post_at`, and `intent_summary` on every row (it was on `amplifier_candidates` only). `who`, `why_them` and `hook` were there already.

**Context, 1.10.0: typed facts** (Mindmake, `features.facts: true`). Every row of `network`, `amplifier_candidates` and `quiet_ties` also carries `facts`: at most 8 of `{ kind, text, source_url, observed_at }`, so a card's words are built from facts and never from prose. Nothing is removed from the row. `text` is the record in plain words, at most 200 characters; `source_url` is a public https page it can be checked on, or null when the source is Control Center's own record or a profile; `observed_at` is when the fact was true at its source, ISO, or null when the record does not say (never the time of the read, and a date more than a day ahead is null). The kinds, kept in this order when a person has more than 8 (`FACT_KINDS` in `api/_personFacts.ts`):

| `kind` | From | `source_url` | `observed_at` |
|---|---|---|---|
| `role` | `contact_intelligence.current_title` and `current_company`, only when a profile read is dated (`enriched_at`); an undated title is not a fact | null (the profile) | `enriched_at` |
| `role_change` | the newest `contact_role_history` row (what the record held before a refresh showed something else) with the role now held, or `role_changed_at` alone | null | when Control Center first saw the change, not when the move happened |
| `post` | up to 2 of their own sentences from `posts_sample` (the strongest two), or `intent_evidence` when none qualifies; a post with no public page is left out | the post | the post's date; null for `intent_evidence`, whose post is known but not its date |
| `shared_room` | a community whose member list he holds and is on (`roomsOf` in `src/lib/knownFrom.ts`, `contacts.sources`) | null | when that list was imported |
| `shared_employer` | up to 2 of Krish's employers on their career (`shared_history`), close ones first; says both were there, never that they worked together, and a large one says they may never have met | null | `enriched_at` |
| `email` | `email_inbound` and `email_outbound`, counted from his mailbox, and `email_last`; a zero count is the column's default and is left out | null | `email_last` |
| `known_since` | `known_since` and `known_since_basis`, an upper bound on when they met | null | `known_since` |
| `reach` | `followers` on LinkedIn | null (the profile) | `enriched_at` |
| `badge` | `is_influencer`, `is_creator` | null (the profile) | `enriched_at` |
| `last_post` | `last_post_at`, unless a `post` already says that day | null | `last_post_at` |

Never a fact: `who`, `why_them`, `hook`, `risk`, `intent_summary`, `evidence` or any other sentence a model wrote. Never in a fact: an email address, a phone number or a profile link. A piece of text that carries one is dropped whole, never trimmed into a different sentence, and a profile (LinkedIn `/in/`, an X, Instagram, Facebook, TikTok or Threads account page) is never a `source_url`. `facts` is `[]` when the person was read and nothing qualifies, and null when the facts could not be read. Its coverage line is `{ source: 'facts', available, complete, rows, observed_at, reason }`: `rows` counts the people with at least one fact; `available: false` with `source_unavailable` when nothing could be read; `complete: false` with `role_history_unavailable` when the role history could not be read, so `role_change` is missing, not absent. A stale fact keeps its own date: how old is too old is yours to judge.

**Context: places and the focus inputs** (Mindmake, `features.places: true`; growth-mindmake plan section 12, M7 and M13). So the engine plans Mindmake's places, its AI-answer questions and its catch-ups from what Control Center collects (Ruling, Krish, 2026-10-27: Control Center reads and reports, the engine owns the strategy), the context carries five more parts, each with its coverage line (`source` named as the part). Each is null with `reason: 'source_unavailable'` when it could not be read, `[]` when it was read and holds nothing, and `complete: false` with the reason in brackets when more were left out than the limit carries. `api/_growthContext.ts` `placesContext`; Control Center ranks none of it.

| Part | What it carries | Limit |
|---|---|---|
| `records.touchpoints` | Mindmake's rows of `growth_touchpoints`: `id, product_slug, channel, icp_trigger, watering_hole, coverage_status, cost_efficiency_score, assumption_flag, updated_at`, newest first | 200 (`newest_200`) |
| `records.geo_probes` | Mindmake's venture probes (`subject_kind: venture`) of the last 30 days from `growth_geo_probes`: `id, product_slug, subject_kind, question, engine, run_at, we_cited, answer_snapshot, competitors_cited, touchpoint_id`, newest first | 500 (`newest_500_of_30_days`) |
| `records.accounts` | Mindmake's social accounts from `growth_social_accounts`: `product_slug, platform, status, handle`. A handle only: never a login, a profile link or a note | 100 (`first_100`) |
| `touches` | Contacts due a touch by now, as the focus playbooks' catch-up reads them: `contact_id, next_touch_due_at`, soonest first, never a name, and never a do-not-contact or closed contact | 50 (`soonest_due_50`) |
| `home_city` | His city as Control Center's one home-city reader returns it (`readHomeCitySetting` in `api/_homeCity.ts`): `london`, `new_york` or `sydney`, or null when unread. With no city set it is the default city, and the coverage line says `default_city_no_setting` | one |

**Mindmake's AI-answer questions (M13, 2026-10-28).** Your weekly review plans which of Mindmake's places to probe and which questions to ask (its plan agreed with Control Center's probes on 174 of 176). So the Monday probe (`api/growth/geo-probe.ts`) no longer asks its shared questions for Mindmake: its touchpoints are left out of the plan, and the run says why (`held`). It asks Mindmake's questions again only once you send your plan in a field it reads, which you do not yet. The field it waits for, named and not read: `places` in your report, `{ version: 1, as_of, questions: [{ touchpoint_id, question }], domains: [host] }`, with at most 12 questions in your order and the hosts Mindmake's canon names (counted as whole hosts). The other products keep their questions, their list of domains and the twelve a run. Growth's queue (`nextMoves` in `src/lib/growthModel.ts`) no longer ranks Mindmake's planned accounts or its places.

**Jonny's pitches (1.9.0).** Krish, 2026-10-27: pitch as many podcasts as possible from Jonny's Gmail, "Drafted daily, no press", "For visibility Jonny sends". A version 2 email action may carry `mailbox`: `null` (his own box, as before), `krish`, or `jonny`, and `jonny` only on the `visibility` row (a podcast) or the `events` row (a stage to speak on). Write a `jonny` pitch in Jonny's voice for Krish ("I work with Krish Raja", Krish in the third person, signed Jonny: Ruling, Krish, 2026-10-20), about a stage Control Center holds (`subject_ref: target:<id>`), to the stage's `booking_contact_id`. Control Center drafts each one into Jonny's Gmail with no press, best rank first, at most 10 a day (`api/_pitchDrafts.ts`), only once Gmail answers as Jonny's own box, and records it as carried out as a draft, so it never reaches Krish's list or a press on his widget, and the executor never sends it. Jonny reads it and presses Send. An earlier report naming a mailbox is refused.

**Context, 1.9.0.** Stages with no product are Krish's own visibility and are now in `visibility` beside Mindmake's. Each podcast carries what the daily walk read from its public feed (`api/_podcastFeeds.ts`): `feed_url`, `episodes`, `latest_episode_at`, and `booking_contact_id` with `booking_source` when the show publishes an address of its own (never the address). `drafts` carries each pitch's `proposal_id`, `visibility_target_id`, `mailbox` and what became of it, as Gmail and his calendar show it: `sent_at`, `replied_at`, `booked_at`, `recorded_at`, `published_at`. A show already pitched is not pitched again; learn from which ones answer. Each stage also carries the speaker call or guest form its own page links to (`cfp_url`) and, read from the form's own page by the daily walk, the fields it asks (`form_fields`: `[{ label, name, type, required, options }]`, `form_fields_at`; an empty list is a form drawn in script, which you leave alone). `visibility` carries each stage's `suggested_talk_title` and `audience_size`, and `guests` each guest's `invite_state` and `scheduled_at`; a guest's contact and a stage's booking contact get `routes`.

**Guest invites (1.9.0).** An invite to a guest for one of his own shows (Signal & Noise or Make Your Mind Up) is a `jonny` email on the `visibility` row about the guest (`subject_ref: contact:<id>`, the guest's own `contact_id`). Control Center drafts it into Jonny's Gmail with the same daily cap, files it as a guest draft (`job: guests`, `show` the guest's show), marks the guest invited, and reads its outcome as for a pitch; booked is the calendar event that names the guest, which sets the guest's `scheduled_at`.

**Forms on his tap (2026-10-27).** A version 2 `form` action (`recipient_contact_id: null`, `form: { url, answers: [{ label, value }] }`) on a stage (`subject_ref: target:<id>`) is now pressable: his **Submit** on the widget, or Clear on Home, fills the form in a browser with your answers, each in the field whose own label it names, and sends it (Ruling, Krish, 2026-10-26: "a form is filled for him and his tap submits it"). Write answers by the labels in `form_fields`, one for every required field. It submits only when every required field is filled and the page asks nothing only he can give: a CAPTCHA, a login, a payment, or a terms box (ticking one is a legal yes in his name). Otherwise nothing is sent and `forms` says why. `forms` carries each try (`proposal_id`, your own proposal id, `url`, `status`: `submitted`, `confirmed` when the page said it arrived, or `not_sent`; `filled`, `missing`, `blockers`, `unused` answers no field asked for, `after_url`, `after_title`, `submitted_at`; never the page's text or its picture). A `not_sent` form is yours to route again: answer what was missing, or fall to the next best route (a Jonny pitch to the stage's booking contact). A form is sent once per proposal; a stage it was sent for is marked applied.

### The show-notes note (1.10.0)

Ruling (Krish, 2026-10-27): "After one of Jonny's pitches to someone else's show or stage is booked, Jonny sends the host one short note asking for the brief link in its show notes or event page." You write the words; Control Center drafts them into Jonny's Gmail and never sends.

- **Served where.** Capabilities say `features.show_notes: true` (Mindmake only); send the kind only then.
- **The action.** A version 2 email action with `mailbox: "jonny"` and `kind: "show_notes_ask"`, on the `visibility` or `events` row, about the stage he was booked on (`subject_ref: target:<id>`), to the host Jonny pitched. Refused with a sentence naming why when the report is older than 1.10.0, the mailbox is not `jonny`, the channel is not `email`, or the subject is not a `target:`. Any other `kind` is refused; leave it out for a plain pitch.
- **When it is drafted.** Only once `drafts` holds one of Jonny's pitches to that stage (`job: booked`, `mailbox: jonny`, with its `proposal_id`) with `booked_at` recorded: someone else's show or stage confirmed a date. Never after a guest invite to his own shows (`job: guests`), and never for a stage booked through a form, which has no thread in Jonny's box. Until then it is held (`show_notes_not_booked`), out of sight.
- **Once a stage.** A stage already asked holds any second note (`show_notes_asked`), and the database refuses one (migration `20261112140000_show_notes_ask.sql`).
- **The walls.** It goes to the host Jonny just wrote to, so for a recorded booking alone the 14-day rule and the pause after his carried-out pitch do not hold it. Every other wall does: do not contact or closed, a No on that host or stage, words from files that moved, and an address on record.
- **Counted inside the ten.** Each note takes one of the 10 Jonny drafts a day, in your rank order with the pitches; rank it first if it should go the day the booking lands. It is recorded as carried out as a draft, so the executor never sends it, and Jonny presses Send.
- **In the context.** `drafts` carries it as `job: show_notes`, with `sent_at` and `replied_at` from its thread. It is never a pitch, a reply to a pitch or a booking: it never carries `booked_at`, `recorded_at` or `published_at`, the widget's count of Jonny's pitches leaves it out, and it never adds to this week's bookings.

### Morning drafts (1.23.0, `features.morning_drafts`, `features.mail_outcomes`)

Ruling (Krish, 2026-11-13): morning drafts in Gmail with no press. He sends from Gmail. A draft he has not sent within 3 days is binned (his standing yes, for that bin only). You write the words; Control Center drafts them into his own Gmail and never sends.

- **What is drafted.** Every email row action on any of the five rows whose `mailbox` is null or `krish` (never `jonny`, whose pitches are Jonny's lane above), that passes the same walls as his press (`rowCandidates`, read afresh by the lane itself, never another drafter's copy: live, current words, nobody he ruled out or wrote to in the last 14 days, nobody whose answer may ask for no more email, an address on record), with nobody drafted to from either box in the last 14 days and nobody sent a note in the 14 days after its send, and one draft a person: the best ranked of theirs. Right before each claim the proposal (still pending, not expired, not bumped) and the person (not do not contact or closed, no answer asking for no more email) are read again, so a press, a No or a do-not-contact in the minutes before is never drafted (`moved_on`). Your words pass his voice check first (`channel: email`); a hard fail is held, never rewritten, and the run says why (`voice_held`, `voice_reason`). An asset goes as the person's own SendLinks link, or the draft waits with its claim given back (`asset_held`). His Gmail must answer as his own box first (`verifyMailbox`), and the draft carries his own Gmail signature.
- **One draft a proposal, ten a day, one open draft a person, whatever runs at once.** The table holds it, not a read: one draft per `proposal_id` across the lane and his own Draft press (which files its claim first as `job: row_press`, so whichever comes second is refused and his press says "Already drafted in your Gmail."), ten numbered places a day (`drafted_on`, `slot` 1 to 10, unique by box and day), and one morning draft a person not yet sent or binned. A second run that loses a place or a person is told so (`capped`, `taken`), never an error to him.
- **The order and the cap.** By your `rank`, then the row (`network`, `partners`, `reach_out`, `events`, `visibility`), then the proposal id. At most 10 a day in his box (his own civil day, in the time zone he set), at most 5 a run, every 2 minutes with the widget push and never later than 40 seconds into it (`out_of_time`), and only in his morning, from 05:00 until noon in that time zone (`MORNING_HOURS`): a row you send later waits for the next morning (the run says `after_hours`), so the drafts are one batch at the top of his Drafts.
- **The proposal stays pending.** Drafting is not carrying it out: nothing is recorded on the proposal until he sends it. While it sits in his Gmail it leaves the widget and the Pipeline, and his one list counts it as waiting on a draft in his Gmail and names it with a press that opens the draft itself, and so does any other action to the same person (held `in_morning_drafts`); a proposal once drafted is never offered again, whatever became of the draft. A note he sent holds its person for 14 days after the send across every lane, his press and Jonny's pitches too (held `written_to_lately`). A draft holds its person while it can still be there: a recorded draft until a day past the bin, and a claim with no draft yet until its draft is found or shown not to exist.
- **A claim is never given back blind.** A draft is recorded before it counts. When Gmail may have made a draft without saying so (a timeout, a dropped answer), or its record cannot be written and Gmail will not take it back, the claim stays (`unsure`). A claim a run was cut off on, 15 minutes old with no draft, is looked for in his Drafts (a read: a draft to that address with that subject since the claim). Found, it is recorded and followed like any other (`claims_adopted`) only when the draft's opening is the lane's own words, so the bin can never reach a draft he wrote himself; a draft that is not the lane's gives the claim back. None in his Drafts, his sent mail is searched the same way: a send there keeps the claim, so the proposal is never drafted to them again. None in either, the claim is given back (`claims_cleared`); anything unreadable keeps it for the next read (`claims_kept`), looked at again at most every 6 hours.
- **His send.** Read from the draft's thread in his box, at most every half hour for 30 days: when he sends it, `sent_at` is recorded and the proposal is carried out as a draft (`carried_out: draft`, as his own press records one; the executor never sends it). A send he scheduled counts as sent for every hold and is never binned or deleted; it is recorded once it goes.
- **The first answer, from the recipient only.** Only a message from the address his note went to, or another address Control Center holds for that person, is their answer; a cc'd colleague, an assistant or anyone else is passed over, and a later message from the recipient is still read. A reply sets `replied_at`. Words that may ask not to be written to again (please unsubscribe, unsubscribe me, remove or take me off your list, remove me at the end of a sentence, remove or delete my address or details, stop emailing me, do not contact or email me, don't reach out again, opt me out, opt out of your emails; never "remove me from the cc", "our unsubscribe rate" or "don't email me here, use my new address") set `opted_out_at` and `replied_at`. That is a guess from words, so it never marks anyone do not contact: it keeps the person out of every lane that drafts on its own (the rows, so the widget, the Draft press and the morning lane, and Jonny's pitches; `optedOut` in `api/_rowPress.ts`), and their reply waits on his list for him to read. A mail server's failure notice is looked for before any automatic answer (a bounce often carries `Auto-Submitted`) and sets `bounced_at`; it marks the address invalid only when the notice names the address the note went to and the person still holds it, so a bounce for a cc'd colleague's address marks nothing. A person answering his subject is never a bounce, whatever the subject says, unless a mail server sent it. A notice that delivery is only delayed is neither, and nor is an automatic answer: its headers first (`Auto-Submitted`, `X-Autoreply`, `X-Autorespond`, `Precedence` auto_reply, bulk or junk, `X-Auto-Response-Suppress`), then its own subject, then an opening that says out of the office, away or on leave with when it ends, and never one that answers him (a question, a yes, a time to talk), which is a person who happens to be away.
- **The bin, and closing.** A row is closed unsent only after a thread read that succeeded and shows no send and nothing scheduled; an unreadable thread is tried again, never closed. Each read looks at the draft itself by its own id (a read): gone, he deleted it, and it is closed at once as `discarded`, freeing the person. A draft he has not sent 72 hours after it was made is deleted from his Drafts, by its own draft id only (the bin is the lane's only delete), and stamped `binned_at`. A delete Gmail refuses leaves it for the next run. Either way the proposal leaves pending the way your own withdrawal does (`expired`, `done_evidence: { kind: "binned", reason, people_draft_id }`), never as his No or his Clear, so nothing counts it as waiting on his yes. When he marks the person do not contact, or you take the ask back, after it was drafted, nothing deletes the draft before the bin: his list names it for him to delete ("<name> is now marked do not contact. Delete the draft to them in Gmail.", held `morning_draft_to_delete`).
- **A reply comes to his list.** When the recipient answers a note he sent (`replied_at`, not a bounce), it is one item on his one list, "<first name> replied. Book the call", with one press that opens their reply in his own Gmail and the step "Reply with two or three times you are free this week." (the `reply` source, `api/_waiting.ts`; Ruling, Krish, 2026-11-13). One a person: a person's newest reply decides, and Advisory's deal for the same person wins, a pitch to a show that names them included. It closes itself when the call is on his calendar (the same `meeting_booked` check a deal that replied uses, counting only a call made at or after the reply, so the next of a standing catch-up never counts), which stamps the draft's `booked_at` with when the call was made. His Clear (he booked it or answered them himself) takes it off his list but not out of that calendar look: he most often answers with times and the call lands a day later, and that booking still reaches `booked_at`. His Purge (it is going nowhere) ends the look with no booking. A reply whose words may ask for no more email is its own item, "<first name> replied and may be asking not to be emailed again", the same press, the step "Read it. Nothing more goes to them from the drafting lanes either way.", closed only by his Clear or Purge (`his_word`), never by a call. Neither is written into your context, and nothing is sent. Until migration `20261113150000_morning_replies.sql` is applied nothing is asked.
- **In the context.** `drafts` carries each one as `job: morning`, `mailbox: krish`, with its `proposal_id`, its `visibility_target_id` for a stage, and `sent_at`, `replied_at`, `booked_at` (when the call on his calendar was made, after their reply, whether or not he had pressed Clear), `opted_out_at`, `bounced_at` and `binned_at`; his own Draft press's claim shows as `job: row_press` (its proposal records the press). Learn from which you wrote that he sent, that were answered, that became a booked call, and that he left to the bin. **Suppress anyone with `opted_out_at`:** never propose another action to them in any lane; Control Center keeps them out of its drafting lanes and their reply is on his list, but it never marks them do not contact, so the suppression is yours as well. A bounced address is out of every route you are given. The migration is `20261113120000_morning_drafts.sql`; until it is applied nothing is drafted, the run says so, and every reader that names its columns reads without them.
- **Switching the lane off.** Hold growth-mindmake on Growth > Engines: nothing more is drafted, and the outcome read and the bin keep running for what is already in his Drafts. Never revert the code to stop it: the code before this lane cannot see a morning draft, so it would offer the drafted proposals again, let the old Draft press make a second draft, never bin the waiting ones and never record their sends. If a revert cannot be avoided, first hold the engine, let the bin and the outcome read close every open morning draft (or delete them by their recorded ids), and only then revert.

### Warm buyers: Advisory's listed buyers, read whole (1.25.0, `features.advisory_people`)

growth-mindmake writes Advisory's listed buyers and intro asks as REACH OUT rows for his own box (its GET-GOING step 0.6). To do that safely it must know who each one is, why now, and whether anyone has written to them already, from either box. Since 1.25.0 the context carries all of it:

- **`records.advisory`**: each row also carries `intent_evidence`, `intent_evidence_url` and `last_post_at`, the stored trigger. A row that is `listed`, with `ask_kind` `buyer` or `intro`, also carries `person`: the contact's person row in the shape of a `network` row (`network_tier`, `current_title`, `current_company`, `who`, `why_them`, `facts`, `email_last`, `mindmake_fit`, `sells_competing_services`, `contacts`), whether or not they are among the hundred the network part ranks, or `null` when no person row is held. Their address's route is in `routes`, never the address.
- **`drafts`**: each row also carries `contact_id`, so a draft from either box, his or Jonny's, is read back to its person.
- **`feedback`**: each row also carries its own `id`, which a draft's `proposal_id` names.
- **`records.deals`**: his open Pipeline deals (stages New to Negotiating), `{ contact_id, stage, closed_at: null }` each, read through the one Pipeline reader; never a value or a name. Unreadable is said in coverage (`deals`), never sent as none.
- **The morning lane writes to no one with an open deal.** Someone with an open deal is written to on the Pipeline, by the deal's own next step. A run that cannot read the Pipeline drafts nothing.

### The engagement task: copy and open (1.14.0)

An engagement task is a batch of replies or comments Krish posts himself, each one tap. Each tap goes by the route it has (`tapRoute`, Ruling, Krish, 2026-11-12: "Do more than copy where possible: where an approved route exists (Gmail draft, a form, Buffer), the press prepares the real action for your one confirm. Copy and open stays only where no route exists."): a reply to an exact X post opens X's own reply box on that post with the words typed, and his press of Reply there posts it; every other tap (a comment on LinkedIn, Instagram or TikTok, a profile, any other page) copies the exact words and opens the public page, where he pastes and posts them. Nothing changes on the wire: send the exact post's address and the route follows from it. Control Center never posts or sends anything for him; a route only opens a page. A post on his own channels is not a tap: send it as a go-live of posts (1.17.0), which the engine queues through Buffer after his yes. It shows on his one list and on your engine's tile on his home screen widget, and closes when he says he posted them.

- **Served where.** Capabilities say `features.copy_open: true` (every engine); send it at 1.14.0 or later.
- **The action.** A walled proposal behind `post`, with no `stage` and no `row`, whose `exact_payload` is a version 2 action: `{ "version": 2, "channel": "engage", "kind": "copy_open", "body": "<what the taps are for, up to 1000 characters>", "taps": [{ "label", "text", "url" }] }`. One to 25 taps. `label` is one line of up to 80 characters; `text` is the exact words, up to 2200 characters, with no email address and no phone number in them; `url` is the public https page he opens, with no login in it, and never a chat, an address or a number: a chat host (`wa.me`, `t.me` and the like), an email anywhere in its path or query, a `+`-led or formatted run of ten digits or more, or a contact query key with a value (`to=`, `phone=`) is refused (`tapUrlCarriesContact`). A bare run of digits in a path, a post id, is fine. No `recipient_contact_id`, `subject`, `form`, `mailbox`, `prior_mindmake` or `asset_ref`: it goes to no person. Refused at the report, with a sentence naming why, before 1.14.0, behind another wall, with a stage, on a row, or malformed.
- **As many as clear the bar, in one ask.** One ask per engine still holds (`oneTurnEach`), so batch the day's taps into one task rather than one proposal each.
- **On his list.** "<Engine>: Engage: <title>", each tap's words in full beside one press by its route, **Reply on X** or **Copy and open** (with why there is no route). Clear says he posted them; Purge skips them; Bump keeps them off until his next day. There is no "Change it first": he changes the words where he pastes them.
- **On his widget.** Your engine's tile shows it as ready, with the taps (`taps` on the tile) and one press worded by the routes ("Reply on X: all 3", "Copy and open all 2", "Open all 3: 1 typed, 2 to copy"; `tapsPress`), which opens his list.
- **Closing.** His Clear is recorded as `carried_out: tapped` (`pressEngage` in `api/_rowPress.ts`). A plain Clear without it is refused, so his yes is never read as "post it", and the shared executor refuses any decision he carried out. Read the decision back and count it; the words are his once he posts them.

### Posts that go live one by one, and the Pull (1.17.0)

Wave 2, W2.8: Growth posts exactly what he approved. Each post he reviews alone is its own go-live (stage `go_live`, wall `post`, `proposal_id` ending `:item-<n>`), whose `exact_payload` is the manifest `growth-golive-manifest/1`: `{ schema, run_id, slots: [line] }`, each line with its `slot_id`, `channel`, `due_at`, `publish_mode`, `buffer_channel_id` and `words`. `expires_at` is the post's due time.

- **His list reads the post, never the JSON.** "<Engine>: Go live: <title>", with each post's channel, when it goes out (in his zone) and its words. Clear says "approve this post" (or "approve these N posts"), Purge says "pull it". There is no "Change it first": he changes a post in its draft, or pulls it.
- **Approved only on your own channels.** Send `buffer_channels: { allowed: { <channel>: <Buffer id> }, denied: [<Buffer id>] }` in your live reports (1.17.0). His Clear on a go-live of posts is refused, and nothing is written, when you have not sent it yet, when a post names no Buffer id, an id that is not the one you listed for its channel (a decoy), one you listed as denied, or one another engine lists as its own (the Full Time and Heartside channels share the Buffer organisation). His No needs no list.
- **The Pull.** His Purge before his yes declines the go-live. After his yes, the same Purge is the Pull until the post's slot: from Growth, Engines ("Going out", each approved post with **Pull it**), through the one list's own verb. It writes a newer declined decision on that go-live (`decided_at` moves; read the latest decision, as you do). Before release schedules the post (5 to 90 minutes ahead) it stays a draft. Inside that window the card warns it may already be scheduled: then fail loudly (`scheduled_after_decline`) and never unschedule; that stays his, in Buffer. Past its slot there is no Pull, and Control Center never unschedules a post (`pullWindow`, `pullGoLive` in `api/_verbs.ts`).
- **Each post's numbers.** Send `post_metrics[]` (1.17.0), each `{ proposal_id, slot_id, channel, posted_at, url, measured_at, reach, sends, saves, likes, comments }`, a number your channel does not show as null, never zero. Growth, Engines shows each post with sends and saves per reach, marked as hypotheses until his own data confirms them.
- **The off-day lane (W2.9).** Send `offdays` (above, the report table). A card he routes `offday_post` on his Inspiration board comes in your directive's `inspiration` with that route: offer it in the Off-days options first. His green press on "Off-day posts: N ready" sends `growth-offday-topup` (ids only); one press, one top-up, never the series slot and never over a day's cap.
- **Engage taps go exactly where he engages.** Krish, 2026-10-28: "make sure everything is one click copiable and the click through goes precisely where i need to engage." A tap whose page is on X, TikTok, Instagram or LinkedIn must open the exact post (its reply box is on that page) or the exact profile, never a feed, a search, a home page or a short link, and a LinkedIn reply carries no link (`tapTargetKind`, the same patterns as Growth's `engine/engage.py`). A task with one tap that is not exact is refused at the report and never reaches his list.

### His inspiration board: the baseline for what you plan (1.15.0)

Krish, 2026-10-29: "When the growth-makeyourmindup repository plans: In all this content, it should know what I've suggested already and try and use that as the baseline standard." His board ([docs/app/inspiration/](https://github.com/krishanraja/control-center/blob/main/docs/app/inspiration/README.md)) holds what he saved, why in his words, and what he wants tried.

- **Served where.** growth-makeyourmindup only (`INSPIRATION_ENGINES` in `src/lib/growthEngines.ts`); capabilities say `features.inspiration: true`. The directive's `inspiration` is `{ rule, suggestions[] }`, newest first, at most 40 (schema: `engine-directive.schema.json`).
- **What a suggestion carries.** `card_id`, `saved_at`, `kind`, `lane`, `name`; `trials[]`, each `{ trial, label, means }`, from his taps on Try this only: `record_like_this` (he records a piece to camera in this style), `reskin_news` (the story, usually positive or real-world AI news, rebuilt as our post), `reskin_meme` (the joke, rebuilt for our readers) and `borrow_format` (the structure or visual device for one of our posts), with `trialed_at`; `his_words[]` (why it's here, and what he likes when he typed it: quote these as his); `agreed_reasons[]` (guesses he tapped: agreement, never his words); `routes`, `read_as` and `note_for_claude`; `post_url`, `platform` and `author` when it came from a link; `drive_url` (private to him); and `answered`.
- **Which cards.** Only those with something of his: a trial, his words or an answer. A carousel's other slides, the Instagram inspo feed and a research corpus are left out.
- **How to use it.** As the `rule` says: the baseline standard for what you plan and make. Each trial is a format or outcome he asked to have tried, so a plan either schedules a trial of it or says why it waits. Rebuild a source in the publication's own voice and look; never copy it. Never use it to judge, score or rank a draft.
- **Unknown, never none.** A read that fails leaves `inspiration` out; an empty `suggestions` means he has suggested nothing yet. Before the trial columns exist (migration `20261113090000_inspiration_trials.sql`) the cards still come, with `trials` empty.
- **An instruction, not just inspiration (1.21.0).** Ruling (Krish, 2026-11-12): an inspiration card he ticks is an instruction that jumps the queue: Content means make it into a piece now, Production means use the style within a week. A Production card he ticked carries `instruction` `{ action_id, kind: "copy_style", due_at, overdue, words }` and comes first, the soonest due first, even with nothing else of his on it; the block then carries `instruction_rule`, word for word what it asks. Use the style in your next fitting asset (a carousel, a meme or an off-day post) before `due_at`, rebuilt in the publication's own voice and look, name the card in that concept's `style_card`, and report it in `inspiration_used` (`features.inspiration_used`). A use reported after his tick closes it in Control Center's done-check sweep (`inspiration_act`); past `due_at` and unused, his Publish Board says so in one line. It is your obligation, never an ask on his list. A Content card he ticked is content-engine's to make into a piece, never yours: it carries no instruction here.

### Prepaid credits: spend your share before it is wiped (1.16.0)

Krish pays monthly for credit pools a vendor wipes at its reset; Higgsfield's own ledger shows 1,024 paid credits deducted on 2026-09-24 and 1,303 on 2026-10-24. Ruling (Krish, 2026-10-29): "Ultimately, we should be maxing out everything we can possibly max out that we're already paying for." An engine may spend up to its share of a pool each cycle with no proposal, and reports what it made.

- **Served where.** Every engine (`features.credits: true`); the directive carries `credits` only when a pool is placed on its product. The placements are Krish's (the tool value catalog's, `TOOL_PLACEMENTS` in `api/harness/_tool-value-catalog.ts`): the ventures marked main split 80% of a pool's grant equally, the ventures marked some split 20%; with no some venture the mains split all of it. A share held by a venture with no engine (CTRL, Pulse, operations) stays unspent as the reserve.
- **What a pool carries.** `{ pool, tool, unit, share, share_amount, spent_this_cycle, remaining_for_you, pool_balance, balance_as_of, use_by, resets_on, days_left, unit_costs[] }`, soonest wipe first (`creditsBlock` in `src/lib/growthEngines.ts`). `remaining_for_you` is your share less what you reported since the cycle began, and never more than the pool holds when its balance was read this cycle; `pool_balance` is null when it was not. `unit` is `credits`, `characters` or `usd` (Apify's included usage). `unit_costs` are measured costs of one output where Krish has them (Higgsfield: a Seedance clip 210, a GPT Image still 2.75).
- **Spend it.** As the `rule` says: on work that moves your objectives, up to `remaining_for_you`, without a proposal. Credits left at the reset are money lost. Make stills before video, and render motion only for a concept that earned it. Never past `remaining_for_you`, never a top-up, a plan change or new money, and nothing you make is published, posted or sent without its own approval.
- **Report it.** Each report carries `credits_spent[]`, `{ pool, amount, asset, objective_key }`, at most 40, at 1.16.0 or later (below). Control Center sums your live reports' spend since each pool's cycle began and takes it off your share in the next directive. `asset` says what it made in words, never an address.
- **Unknown, never none.** A read that fails leaves `credits` out; it never means a share of zero.
- **A ceiling is not a target.** Each pool carries `mode`. `use_it` is prepaid and wiped at the reset, so spend it. `ceiling` is pay as you go (Apify; Ruling, Krish, 2026-10-29: "apify is pay as you go, always"): the share is the most you may spend this cycle, never a target, it is never behind and never in a lapse email. Run only what a decision needs, the cheapest run that answers it. A session settles each Apify run with `actor`, `job`, `items` and `used` (counts only), and reads `get_apify_learnings` before the next: per actor and job, what a kept result cost and a verdict, `keep`, `trial` (under 3 runs) or `drop` (twice reported with nothing kept, or 3 times the best per kept result for the same job; a run that never said what it kept is unknown, never a waste). A run started through the connector's `apify.run` with `engine` reserves and settles by itself; pass `used` with `settle_credit_spend` only for a run you reserved yourself. An absent `mode` reads as `use_it`.
- **Codex, weekly.** `codex` is the Pro plan's weekly allowance in `percent` left (grant 100), resetting each Tuesday UTC, spent first; makeyourmindup main, Mindmake some. `codex-credits` is the paid credits on top, all makeyourmindup's, with no weekly cap yet (Krish, 2026-10-29: "dont need added bottlenecks right now"), and a reservation from it is refused with `allowance_first` until 80% of the week's allowance is used. No API reads either: the machine Codex runs on records each balance with `record_credit_balance`.
- **Codex, weekly.** `codex` is the Pro plan's weekly allowance in `percent` left (grant 100), resetting each Tuesday UTC, spent first. `codex-credits` is the paid credits on top, a `ceiling` of 5,000 a week, and a reservation from it is refused with `allowance_first` until 80% of the week's allowance is used (Krish, 2026-10-29). Placed on makeyourmindup (main) and Mindmake (some). No API reads either: the machine Codex runs on records each balance with `record_credit_balance`.
- **Or spend it from a scheduled session.** Your runner holds no generator keys, so the spending can happen in one scheduled Claude session for your engine, with the tools' connectors and the Control Center connector attached (Krish, 2026-10-29). The session reads the same block with `get_engine_credits`, calls `reserve_credit_spend` before every generation (refused past `remaining_for_you`, while you are held, or with the block unknown; several may be open at once, each off your share) and `settle_credit_spend` after it with the provider's actual cost and job ids, 0 to void it. Those rows (`growth_credit_spends`, `api/_creditSpends.ts`) come off your share exactly as your reports' `credits_spent` do, so never report the same spend twice. A reservation left open for 24 hours stops counting. The wire is unchanged. A scheduled session starts with no repository and cannot reach yours on GitHub, so it reads its brief with `get_engine_brief` (`api/harness/_engineBrief.ts`): your credits brief and AGENTS.md (and PLAYBOOK.md for Heartside) from main at call time, on Control Center's own GitHub access, for the five engines and those files only.
- **Routes for held stages (Mindmake's credits session; integration plan I-02).** The connector's `get_route_gaps` lists the open stages with neither a booking address nor a form (`target:<id>`, type, name, feed and site, when first held; never an address), oldest first, so the session's connector quota goes to them. `file_found_route({ subject_ref, kind, value, source_url })` files a route it found: Control Center reads `source_url` once more, stores the page as one of growth-mindmake's research lookups (kind `search`, inside the daily search cap, at no cost), and records the route only by the `found_routes` rules below. It answers `recorded: true`, or `recorded: false` with `not_on_page`, `not_booking_words`, `off_site_form`, `already_on_record`, `page_unreadable`, `cap_reached`, `not_a_route`, `subject_not_found` or `store_failed`, never an address (`api/_routeGaps.ts`). The wire is unchanged: the next run sees the route in its context and the hold lifts by its own rule.

### Your own number: the objective Control Center reads (1.14.0)

Each morning Control Center reads your repository's North Star number from your own latest live report (`READERS` in `api/_northStarRefresh.ts`) and writes the state line in your `NOW.md` when it changed. You count; Control Center never counts again. Report the objective your directive's `objectives` names, measured or null with its reason:

| Engine | Objective | Window |
|---|---|---|
| growth-legibility | `weekly_builders` | this ISO week |
| growth-mindmake | `good_meetings` | one week, in your zone, that started in the last 14 days |
| growth-heartside | `organic_net_sales_usd` (registered by `20261112200000_heartside_organic_objective.sql`; Shopify net sales attributed to your organic posts, trailing 4 weeks, beside the store's `net_sales_usd`) | the last 28 days, ending in the last two days |
| growth-makeyourmindup | `new_subscribers` | one New York week that started in the last 14 days |

The target your directive gives that objective is your own repository's: the `target` of the `north-star-metric` block in your `docs/NORTH_STAR.md`, read by the same morning refresh, never the registry's copy (`withOwnTarget` in `api/_growthEngines.ts`, `ENGINE_NUMBER_OBJECTIVES` in `api/_northStarRefresh.ts`). When Krish raises it in your repository, the next directive carries it with no migration here. Until the block has been read, the registry's target stands.

A completed week's count (a window that started before this week's rung) is measured against that week's rung and dated its last day, and your line says "in the week of" that Monday, never "this week" (`countedWeekOf`). Unknown, never zero, when the report is synthetic, more than 36 hours old, null, not a number (a whole count for people or meetings), or another window: the line then stays as your own session last wrote it.

### An asset in an email: one SendLinks link per person (no version, `features.asset_links`)

Ruling (Krish, 2026-10-28): "you have a repository in my GitHub called sendlinks. Just use that. Shouldn't need an account." An asset reaches people as a link in the words, and each person gets their own, so whether they opened it can be read back: the visibility check, and the asset's own reading, since a PDF runs no Analytics tag. SendLinks (krishanraja/sendlinks) runs on the same Supabase project as Control Center, with one hashed bearer per caller.

- **Served where.** Capabilities say `features.asset_links: true` for Mindmake only, where the context is served and Control Center's SendLinks bearer is set (`SENDLINKS_BEARER`). Send `asset_ref` only then, at whatever 1.x you speak. A report carrying one when the flag is false, or from another engine, is refused (400, naming `features.asset_links`). Until then keep the plain link in the words.
- **The field.** On a version 2 `email` action, beside the others:

```json
{ "version": 2, "channel": "email", "recipient_contact_id": "<uuid>", "subject": "One line", "body": "... the one-sheet: https://mindmake.co/media/one-sheet.pdf ...", "form": null, "mailbox": "jonny",
  "asset_ref": { "url": "https://mindmake.co/media/one-sheet.pdf", "title": "Krish Raja, speaker one-sheet", "purpose": "one-sheet", "expires_in_hours": 720 } }
```

  - `url`: the asset's own https link on `mindmake.co`, `www.mindmake.co`, `drive.google.com`, `docs.google.com`, `canva.com` or `www.canva.com`, up to 2,000 characters. It must stand in `body` exactly as written, as a link of its own (after the start, a space or an opening bracket or quote; before the end, a space, a closing bracket or quote, or a full stop or comma that ends the sentence), and nowhere run into other text: a `?utm=` added after it, or a path that continues it, is refused, because the swap could leave the plain link behind.
  - `title`: one line, up to 200 characters, shown to the person and to link previews.
  - `purpose`: a lower-case slug, such as `one-sheet` or `decision-aid`, that opens are counted by.
  - `expires_in_hours`: a whole number from 1 to 2,160 (90 days, SendLinks' own bound), counted from the draft. A draft can sit in Jonny's box for days before he sends it, so give it weeks, not hours. There is no read-once: mail scanners spend views.
  - Nothing else: an unknown key (such as `max_views`) is refused, as is `asset_ref` on any channel but `email`.
- **When it is drafted.** Jonny's pitches (`api/_pitchDrafts.ts`) and his own Draft press (`api/_rowPress.ts`) ask SendLinks for one link for that recipient (`POST /links`: kind `url`, venture `mindmake`, the address on record, `ref` `cc:<Control Center proposal id>:<contact id>`, `on_duplicate: reissue`) and put it in the draft wherever `url` stood. A second try for the same action and person reissues the same link with a new token, and the old token stops working. The link's id, never the link or its token, is kept beside the draft in `growth_asset_links`, with the contact id and never their address.
- **When it cannot be.** No bearer, SendLinks not answering, a refusal, an expired link under the same ref (`link_inactive`), or a record that cannot be written: nothing is drafted and the plain link is never put in its place. A Jonny pitch is held for the next run (the push's `asset_held` and `asset_reason`, its claim given back); his press answers "Not drafted." with the reason. While no bearer is set, a row whose action names an asset is held off his widget (`asset_links_off`).
- **In the context: `asset_opens`.** `{ links, assets }`, with its coverage line `{ source: 'asset_opens', available, complete, rows, observed_at, reason }`. `links` is every link drafted in the last 90 days, newest first, at most 500: `{ link_id, proposal_id` (your own proposal id), `draft_id` (the `drafts` row it went out in, or null for a draft in Krish's own box), `mailbox, asset_url, purpose, title, minted_at, expires_at, opened, first_opened_at, last_opened_at, opens, downloaded, state, read_at }`. `opened`, `opens` and `downloaded` are null until SendLinks has been read for that link, never false on nothing. `assets` is each asset's own reading, by `purpose` and `asset_url`: `{ links, read, opened, opens, first_opened_at, last_opened_at }`. Never an address, a contact id or the link. Opens are read from SendLinks' own `GET /links/<id>` inside the widget push, 20 links a run, each at most every 30 minutes, until a day after it expires; an open is a person opening it, never a named unfurler or scanner, though a mail scanner posing as a browser can still count as one. `complete` is false with `newest_500_of_90_days`, `sendlinks_not_connected` or `opens_not_yet_read`; `available: false` with `source_unavailable` when it could not be read.

### Inside his network: only Krish emails them (no version, `features.network_routes`)

Ruling (Krish, 2026-10-28): "anyone that comes from inside my Network, should only ever be emailed by me." No draft lands in Jonny's box for anyone inside it.

- **Served where.** Capabilities say `features.network_routes: true` for Mindmake, where the context is served. No new version: read it at whatever 1.x you speak, once the flag is true.
- **The field.** Every entry of `routes[contact_id]`, for every contact the context routes (the network, amplifier candidates, quiet ties, anyone a research row names, each guest's contact and each stage's booking contact), carries `in_network`: `true` when the person is inside his network, `false` when they are not, `null` when it could not be read. Inside is `contact_intelligence.network_tier` on tiers 1 to 4 (`1_reciprocated`, `2_core_network`, `3_known_network`, `4_owned_network`; `KNOWN_TIERS` in `src/lib/knownFrom.ts`). A contact with no tier is judged by the same list the tier is built from: any of his own networks among its sources (`OWN_NETWORK_SOURCES`) puts it inside, none puts it outside. A failed read, a missing contact or an unknown tier is `null`. One reader answers it, `networkOf` in `api/_mailboxes.ts`, the same one that guards Jonny's box.
- **What to do with it.** Write a `mailbox: 'jonny'` action only where `in_network` is `false`. For `true`, write it for Krish's own box, in his voice, or not at all. `null` is never outside: treat it as `true`.
- **What Control Center does anyway.** Jonny's daily drafter (`api/_pitchDrafts.ts`) reads each recipient again before it picks a pitch, and holds any whose recipient is inside or unread with the code `network_is_krish`: never claimed, never counted in the day's ten, and never moved into Krish's box in Jonny's voice. The widget push's run row counts them (`pitches.drafts.network_held`, `network_hold`, `network_reason`). The People Draft press refuses a Jonny draft to the same people.

### The chat backstop: Krish's flagged lines into his taste ledger (no version, `features.taste_backstop`)

W3.3 (2026-10-29). Each chain repository's SessionEnd hook keeps the lines Krish typed that its local filter flags as a correction or a rejection, scrubbed of secrets, in a local file (schema `growth-taste-backstop/1`; Krish chose "Local file, runner posts"). The engine's runner posts them here, and Control Center files each into his taste ledger (content-engine's `taste_reports`, which inspirationhouse files daily) once. `api/_tasteBackstop.ts`.

```
POST /api/growth/engines/<slug>/taste
Authorization: Bearer <the engine's own token>
Content-Type: application/json

{ "schema": "growth-taste-backstop/1",
  "rows": [ { "venture": "makeyourmindup", "repository": "growth-makeyourmindup", "kind": "rejection",
              "line": "No, I hate the hazard tape on that cut.",
              "line_sha256": "<sha256 hex of line, exactly as sent>",
              "session": "<the session id>", "noted_at": "2026-11-01T21:00:00Z", "posted": false,
              "lane": "production" } ] }
```

- `rows`: 1 to 50. `kind` is `correction` or `rejection`. `line` is one line he typed, 1 to 2000 characters, never a chat (a blank line inside refuses it). `line_sha256` must be the sha256 of `line` as sent, after your own scrub. `repository` is `owner/name` or a bare name (taken as krishanraja's). `lane` is optional: `strategy`, `production` (the default), `visibility` or `voice`. `posted` is yours and is not read. `noted_at` may not be in the future. `venture` may be null or left out: the row is then filed with none and the repository's mapped venture fills it (inspirationhouse's runner sends null); a non-null value must be a venture slug.
- **Answer**: 200 `{ ok: true, schema, filed, duplicate, refused, results: [{ line_sha256, result: "filed" | "duplicate" | "refused", id?, error? }] }`, one result per row in order; one refused row never stops the rest. 400 when the schema or the row count is wrong; 401 a bad bearer; 404 `taste_not_supported` when this deployment has no ledger store.
- **Once each**: the row becomes `client_report_id` `backstop:<line_sha256>` under emitter `backstop:<engine_id>`, and `taste_reports` is unique on the two, so a line posted again answers `duplicate`. Mark it posted when its result is `filed` or `duplicate`; post again only what was refused for a reason you fixed, or not answered.
- **What it becomes**: kind `krish_words` (his words, as typed), said in "a Claude Code session in <owner/name>" at `noted_at`, polarity `dislikes` for a rejection and `neutral` for a correction, surface `backstop`. The venture is the repository's mapped one when it has one (`taste_venture_repositories`, filled by `taste_venture_fill`); a null venture always leaves it to the map. The venture you named (`makeyourmindup` is read as `publication`) is used only for an unmapped repository, else the row is held unassigned for Krish. What you named is kept in `meta.named_venture`.
- **Scrubbed again here** with the secret guard's patterns (`SCRUB_PATTERNS`, the same as `scripts/check-no-secrets.mts` plus a bearer header and a `key=value` secret): a line that still held one is stored with `[removed]` in its place and `meta.scrubbed: true`.
- A repository with no engine posts the same body to `POST /api/taste/backstop` on `TASTE_BACKSTOP_TOKEN` (emitter `backstop:hook`). Control Center's own hook is `scripts/hooks/taste-backstop.mjs`, which takes `--dry-run --transcript <file>` to print exactly what it would send.

### Held meetings and the good tap (1.10.0)

Ruling (Krish, 2026-10-27): "The number counts any good meeting: he marks it good with one tap after it, whether with a buyer, a multiplier, a partner or a host. The engine pre-fills where it came from, and the path is recorded once and never rewritten." Control Center collects the meetings, holds them and asks him; you count them. Capabilities say `features.meetings: true` for Mindmake only; every other engine gets nothing new.

**Collected.** Once a day, inside the daily push and just before it (`api/growth/engines-dispatch.ts`, `collectMeetings` in `api/_meetings.ts`), Control Center reads his connected calendars, read only, for the last 28 days. A meeting he held is a timed event (never all day) that has ended, was not cancelled and he did not decline, with 2 to 25 people. Never a meeting with only himself or Jonny, and never a machine, a room or his own name under another address among its people. It keeps an opaque `meeting_id` (a hash of the calendar's own id and the start, never the raw id), the contacts and the start, never the title or an address. A meeting already kept is never written again, so his answer is never touched (table `growth_meetings`, migration `20261112130000_growth_meetings.sql`).

**A first meeting with someone new is kept (1.24.0, `features.meeting_paths`).** Until 1.24.0 a meeting was kept only when one of its people was already a contact Control Center held, so a first meeting with someone new was never asked about or counted. Now each person in a meeting he held whom Control Center does not hold by an email on record is filed first (`fileAttendees` in `api/_meetings.ts`), the newest meetings first and at most 40 a run, and the meeting is kept with them.

- **A contact Control Center holds always counts**, whatever their address or name: a show's bookings@ or hello@ it holds keeps the meeting and can be its person (the contact you trace the podcast or guest-seat path from), and so do people named like a tool (Andrew Motion, Li Gong). What follows applies only to someone it does not hold.
- **Never a machine or a shared mailbox.** Someone Control Center does not hold is a notetaker or a meeting tool (`botAttendee`) by the tool's own sending address (<address>, <address>), by a notetaker company's own domain (anyone there it does not hold: otter.ai, fireflies.ai, fathom, read.ai, tldv, granola, meetgeek, avoma, krisp, notta, sembly, airgram, supernormal, bluedot, meetjamie, tactiq), or by a name, its mailbox's or the one its entry shows once what a calendar adds is taken off (brackets, a title or company after a dash or a bar), that is exactly the tool ("Fathom", "Calendly"), only cue words ("Notetaker"), the tool right beside a cue word (notetaker, recorder, bot, assistant, AI: "Jamie AI", "Gong Recorder", "Zoom Bot") or a two-word tool ("Read.ai", "Microsoft Teams", "Cal.com"). Never by a word inside a person's name ("Andrew Motion", "Ben Bot") or by what a calendar adds after it ("Anna Berg (Zoom)", "Jamie Chen | Acme AI"), and never every person at a company of many people such as Zoom, Microsoft or Gong. A role, group or room mailbox (info, hello, team, contact, admin, support, sales, office, bookings, events, hr, jobs, careers, press, media, marketing, accounts, billing, finance, legal, ops, partnerships, enquiries, reception, assistant, scheduling, calendar, and any growth-team@, all-hands@ or boardroom3@, `roleMailbox`) it does not hold is never one of a meeting's people either. A meeting whose only others are these is no meeting: a call with only Krish, Jonny and a notetaker is none.
- **Who is filed: a person at a company.** Someone is filed only when the name their calendar entry shows is a person's name (two real words, not a handle, initials, an organisation, a group, a room or a tool; `attendeeName`) and their address is at a company, never a free or personal provider: webmail (gmail, outlook, hotmail, yahoo, icloud, proton and the like), the ISPs of the UK, the US, Australia, Europe and Asia (sky.com, virginmedia.com, iinet.net.au, comcast.net, web.de, orange.fr, naver.com and the like) or a private relay (Apple's, duck.com), each by the endings it really uses (`src/lib/freeMail.ts`, the one list). So friends and family on his own calendars are never filed. Anyone else is not a person to file: never filed, never counted as waiting. Someone Control Center already holds still counts whatever their address.
- **The name kept** is the one the calendar shows with what it adds taken off: anything in brackets ("(Acme)", "(she/her)"), a title in front ("Dr"), the letters after ("PhD", "Jr") and a job title after a dash; "Okafor, Sana" is kept as "Sana Okafor".
- **An address that is a contact's own** (`contacts.email`) but has no identity yet is linked to that contact and nothing else on it changes, a do-not-contact or closed one included: never made again, never changed. An address whose identity on that contact was retired, while their record still holds it, is still theirs: the meeting is kept with them, nothing is written or counted, and never a second contact with it.
- **The same full name at the same company is the same person** (Ruling, Krish, 2026-10-14): the address is linked to the contact already there, as an identity (`basis: meeting_company`), never a second row.
- **A name alone is never a merge.** A new contact whose name another contact has is filed with up to three "same person?" questions for him (`contact_merge`), the same full name first, so a run asks at most 120. Namesakes are read in the database, blind to accents on both sides (`contacts_by_surname` and `fold_name`, migration `20261113130000_meeting_paths.sql`: a stored "Ana Muñoz" or "Minh Lê" is found for a calendar's "Ana Munoz" or "Minh Le"), every one of them, a page at a time; more than 20 pages and the person waits. Titles, letters after a name and brackets are folded off both names before they are compared. The questions are written before the contact, under the id its address will have, so one that cannot be written leaves the person for the next run instead of filing them unasked, and a question is asked once for an address, however many meetings he has with them.
- **A do-not-contact or closed namesake**: when one of them has the name, nobody is filed and they never change. He is asked "same person?" about them instead (the question names the contact he has, and the person he met only by the name the calendar shows and the domain of their address), and the meeting waits on his answer (`held_back`). His yes keeps the meeting with the contact he has, changing nothing on them; his no files the person as anyone new is, at the next read.
- **Anyone filed** becomes a contact with the name, the address, `origin_channel: calendar_meeting`, `consent_tier: warm` (he met them), the meeting as its source and an email identity, and an intelligence row on `4_owned_network`, so in `routes` they are `in_network: true` and only Krish emails them. That row is made again at every read for each contact filed from a meeting in the last 28 days until it lands; one still missing is counted in `filed_skipped`. Never a guessed profile or anything else.
- **The meeting's person** (`contact_id`) is the first of its people Control Center held before that read, the organiser first, so its path and wins stay with the person you trace; someone filed that morning is its person only when nobody in it was held. Control Center keeps everyone in it, and at his tap a path you name for any of them is read after the person's own (below).
- **Coverage.** A meeting he held that could not be kept, because someone in it who should be filed was left for the next read (over the 40, or a read or a write that failed) and nobody else in it is held, makes the coverage line `complete: false` with `meetings_not_all_kept`. One that waits only on his "same person?" answer about someone held back makes it `complete: false` with `meetings_waiting_same_person`. A meeting whose only people are company addresses nobody can name (no name on the calendar entry, and an address not shaped first.last, which `nameFromAddress` reads as a name) also makes it `complete: false` with `meetings_not_all_kept` (since 2026-11-14; before, such meetings were dropped uncounted). Someone left over in a meeting kept anyway, a role, group, room or machine, or a personal address (never filed by rule) never does. The stored read counts `filed`, `linked`, `filed_skipped`, `asked`, `held_back`, `meetings_waiting` (both kinds), `meetings_same_person` (the second kind), `meetings_unnamed`, `meetings_personal` and `paths`. A meeting Krish organised where the calendar left him off the guest list is still a meeting.

**Context.** `GET .../context` carries `meetings`: the last 28 days, oldest first, each `{ meeting_id, contact_id, held_at, good, good_at, origin_path, origin_ref, assists[], said_yes_because }`. `good` and `good_at` are null until he answers; `origin_path`, `origin_ref` and `assists` are null and empty until his tap records them; `said_yes_because` is null (nothing writes it yet). Its coverage line is `{ source: 'meetings', available, complete, rows, observed_at, reason }`. `available` is false when his calendar was not read (`calendar_not_read`: never read, no calendar connected, or every one failed), when the last read is more than 36 hours old (`calendar_read_stale`), when the table cannot be read (`source_unavailable`) or does not exist yet (`meetings_not_set_up`). `complete` is false when one of his calendars did not answer (`calendar_partly_read`) or the read could not keep what it found, or a meeting waits for someone in it to be filed (`meetings_not_all_kept`), or waits only on his answer about someone held back (`meetings_waiting_same_person`). An unavailable list is never a count of none.

**Meetings still to come (1.28.0, `features.upcoming_meetings`; integration plan I-05).** The same calendar read that finds the meetings he held also keeps the ones in the next 14 days, and the context carries them as `upcoming_meetings`: up to 40, soonest first, each `{ meeting_id, starts_at, contact_id, contact_ids[], organizer, first_meeting }`. `contact_ids` are the people Control Center holds in it (a meeting with none is left out), `contact_id` the first of them, `organizer` is `him`, `them` (one of those people) or `other`, and `first_meeting` is whether none of them is in a meeting he held (null when that could not be read). Never a name, an address, a title, a description or a calendar id. It is null, with its reason in `coverage` (`upcoming_never_read`, `upcoming_stale` past 36 hours, `upcoming_unread`), never an empty list it cannot vouch for; `complete` is false when one of his calendars did not answer (`calendar_not_all_read`). Nothing new is polled. Call prep and anything else you build on it are yours; nothing here touches a calendar event.

**The good tap.** Every meeting he held in the last 28 days and has not answered comes onto his one list at once (source `meeting`), so he can answer them in one sitting: up to 20, the oldest first, and the rest come forward as he answers. Each waits until your first report after it was found, so you have had the chance to say where it came from, or a day, whichever is first. Clear says it was good; Purge says it was not. The same tap records where it came from, once: from your latest live report's `origin_candidates`, the first candidate that names a path for the person he met (then the others in the meeting) is `origin_path` and `origin_ref`, and any other path named for them is kept apart in `assists`. With none, it is `unknown`. Once recorded it is never rewritten, by a later report or anything else: the database refuses the change. If your report cannot be read at his tap, nothing is kept and he taps again, so a passing failure never records `unknown` for good. If the database refuses the path (a path its check does not hold yet), his answer is kept and so is the path his tap chose, beside it (`origin_pending`, never served to you); he is told so in one plain sentence on his list, and the next morning's calendar read records exactly that path once the database takes it (`recordAnsweredPaths`), never a path from a report made after his answer, and never `unknown` for want of one. So for a day or more a meeting may carry `good` with `origin_path` null: a path still to come, not `unknown`. Before migration `20261113130000_meeting_paths.sql` is applied there is nowhere to keep it, so such a tap keeps his answer with no path, and says so. So send a candidate for each person in an unanswered meeting in your context, in the run after it appears. A path is one of the fourteen in the report's `origin_candidates` (below); the four 1.24.0 added (`webinar`, `post-engager`, `cold-outbound`, `video-note`) need a report at 1.24.0, and the database takes them once migration `20261113130000_meeting_paths.sql` is applied.

### The research desk (1.6.0)

Control Center holds the tools; the engine decides what to look up. `POST /api/growth/engines/<slug>/research` with `{ requests: [{ request_id, kind, subject_ref, query, why }] }`, 1 to 10:

- `kind` is `search` (an Exa web search: up to five results, each `{ title, url, snippet, published }`) or `question` (a Perplexity answer with its citations), or one of the three LinkedIn signal kinds below.
- `query` is at most 400 characters and never carries an address or a phone number; `why` says what the answer decides.
- Each `request_id` is answered once: the same id replays its stored answer, and the same id with different words is 409.
- Status is `answered`, `empty`, `failed` or `over_cap`. Each engine's caps count only its own requests (1.13.0); Mindmake's are per day: 120 searches (about $0.0025 each) and 40 questions (about $0.001 each), from measured unit costs, raised from 40 and 20 on 2026-10-31 (Krish: "Raise the daily lookup"); 6 `posts` (up to $0.02 each), 3 `post_engagers` (up to $0.08 each) and 8 `person_route` (up to $0.01 each), from the Apify actors' published prices, each run also capped in dollars at Apify; 150 `write` (about $0.0015 each, 2026-11-06). Every kind at its cap is about $1.01 a day. Over the cap nothing runs; ask again tomorrow under a new id. `GET .../capabilities` carries `research: { kinds, per_day }`.

**Signals** (Krish, 2026-10-26: people who comment on posts like "AI's next job casualty could be your boss" are worth reaching, "but only if they're the right types of ICP: worried executives, as opposed to AI people"; the voices he follows "are talking to the people I want to talk to"; "the growth engine needs to think about those types of signals and relevant signals from the ICPs I want, and bring them to me for action"). Which signals matter, which posts to read and which commenter is his buyer are yours. Control Center only collects:

- `posts`: `query` is topic words, or the profile link of a voice (`https://www.linkedin.com/in/<id>`). Up to ten posts from the last month, each a result with `engagement: { comments, reactions }`; `title` is the author and their headline.
- `post_engagers`: `query` is one LinkedIn post link. Up to forty commenters, one result each, with `snippet` their comment as written and `person: { handle, name, headline, contact_id }`. `contact_id` is set when he already has them, which makes them warm. The post's author is left out, and so is anyone he marked do not contact or closed.
- `person_route`: `query` is `li:<handle>` from a `post_engagers` result. Someone he already has costs nothing (`subject_ref` names them). Otherwise one profile read with an email search, and the person is filed as a cold, engaged contact (`origin_channel` `growth_signal`), so you can name them as `contact:<id>` and his press can draft to them. The answer says only `an address the search checked`, `only a guessed address, kept off the record` or `no address found`; an address the search did not check never reaches the record (`api/_ingestGate.ts`), and the same person is never searched twice or filed twice. The address never comes back to you.
- `write` (2026-11-06, Ruling, Krish: yes to a model writing the openings): `query` is the instruction and the facts, up to 400 characters, never an address or a number. Claude (`UTILITY_MODEL`) answers with the short text the request asks for (one sentence, or a catch-up of a few sentences), from only those facts, with no web search and no evidence (`WRITE_SYSTEM` in `api/_growthResearch.ts`). Use it for the opening sentence of a catch-up or an invite, not `question`, which searches the web and failed 7 of 12 such rewrites on its first live run. Read every answer by your own fixed rules and hold what fails; Control Center only runs the model.
- `GET .../research[/<request_id>]` reads them back, and the next context carries the last 14 days.

### Routes found in answered lookups (1.18.0, `features.found_routes`)

A version 2 action names its recipient by contact id, so an address you read out of an answered lookup is no use until Control Center records it. Send what you found in the report's `found_routes[]`, at most 40, at 1.18.0, each `{ subject_ref, kind, address | url, source_url, request_id }`: `subject_ref` is `target:<visibility_target id>`, `contact:<id>` (a contact he holds with no address: a guest's, or, since 2026-11-06 with `features.person_routes`, anyone's) or `guest:<guest record id>` (a guest with no contact); `kind` is `email` (with `address`) or `form` (with `url`); `source_url` is the result the route was read from; `request_id` is the lookup. Control Center's checks decide, not yours (`api/_foundRoutes.ts`):

- The lookup is your own (another engine's id is not found), `answered`, and about that subject: its `subject_ref` is the route's, or, for a guest with no contact, which the desk cannot name, its id begins `email:guest:<guest id>:`.
- `source_url` is one of that lookup's stored results, and the address appears in that result's title or snippet as a whole address (a spelled-out `name [at] site [dot] com` counts); a form's `url` is one of the lookup's results or stands whole as a link in one's title or snippet (the start of a longer link is not it).
- An address that never takes a pitch (no-reply, privacy, billing, sales, press and their kind) is refused for anyone. For a stage, a personal-looking address (not `booking@`, `guests@`, `speakers@`, `hello@`, `contact@`, `info@` and their kind) counts only where the words before it, in its own sentence, say it is the way to book, pitch, speak or apply.
- A form is a stage's only, on the same site as `source_url`, on a page the form walk reads.
- For a contact who is not a guest (`features.person_routes`, 2026-11-06), stricter, because a person has no booking inbox: never one he marked do not contact or closed (`do_not_contact`), never a role inbox such as `info@` or `hello@` (`role_for_person`), an address whose local part carries their first or last name or their first initial and last name (`address_not_theirs`), and a result whose title or snippet names them by their last name (`name_not_in_evidence`).
- Nothing on record is ever overwritten: a booking contact, a `cfp_url`, a guest's contact or a contact's address. An address already on another contact row is refused (two rows for one person is a merge, which is Krish's).

What passes is recorded through the existing ingest gate (`bookingContact`, as the stage walk files the address a stage's own page gives): a stage's `booking_contact_id` with `booking_source: 'research'`, a guest's `contact_id`, or a guest contact's empty address, each contact cold (`consent_tier: cold_scraped`, `origin_channel: growth_research`) with the engine, `request_id` and `source_url` in its `sources`. A form becomes the stage's empty `cfp_url`, so the daily walk reads its `form_fields` and the existing form lane writes it. The next context then carries the route as a contact id; whose box a later draft lands in is still the network rule (`in_network`).

The acceptance answers `found_routes: { dry_run, checked, recorded, already, refused: { <reason>: n }, routes: [{ subject_ref, kind, request_id, outcome }] }`, never an address. Routes are taken in order: the first route for a subject and kind that passes its evidence checks claims it, a later one is `duplicate_in_report`, and one refused on its evidence claims nothing. `outcome` is `recorded`, `already` (on record exactly as you sent it: a replay or a repeat), `would_record` (a dry run) or one reason: `duplicate_in_report`, `request_not_found`, `request_not_answered`, `subject_mismatch`, `source_not_in_evidence`, `address_not_in_evidence`, `url_not_in_evidence`, `not_a_route_address`, `personal_without_booking_words`, `form_for_non_stage`, `form_not_same_site`, `form_not_readable`, `subject_not_found`, `not_a_guest` (no longer given since `person_routes`), `do_not_contact`, `role_for_person`, `address_not_theirs`, `name_not_in_evidence`, `would_overwrite`, `address_on_another_contact` or `store_failed`. A synthetic report, or a live one from an engine that is not active, is a dry run: every check, no write. A recorder that fails answers `found_routes: { error: 'found_routes_unrecorded' }` and never unaccepts the report. Nothing here sends or drafts. Another engine's report carrying `found_routes` is refused (400).

### The circle and the AI mirror (1.19.0, `features.circle`, `features.mirror`)

Ruling (Krish, 2026-11-05): get in front of the very rich and the very influential as the person they talk to about AI, in his own name, starting with 50 people outside his network. Who they are is yours; whether each is someone he already has is Control Center's.

**`circle[]`**, at most 50 a report, at 1.19.0: `{ name, company, role, kind, why, source_urls, reach, show }`. `kind` is `exited_founder`, `investor_partner`, `public_figure` or `family_office`; `source_urls` is two or three public https pages that say who they are, for a stranger; for someone in his own network send `contact_id` instead, a contact your context served (`network`, `amplifier_candidates`, `quiet_ties`), and no pages; `reach` is `{ value, basis }` or null; `show` is `makeyourmindup`, `signal_noise` or null, the show you invite them onto. A circle says who, never how: any `@` or a run of nine digits in its text refuses the report. Control Center (`api/_circleImport.ts`):

- links the same full name at the same company to the contact already there, when only one matches, and sets its `circle_kind` when it has none (the Meta import's rule 5, `api/_metaImport.ts`);
- with a `contact_id`, links that contact when the name agrees and it is not do-not-contact or closed (`contact_not_found`, `contact_mismatch` otherwise);
- files someone who shares only a name with a contact he has, and puts a "same person?" question in People to check for each (`contact_merge`, the import's own question), never a merge;
- files anyone else as a cold contact with no address (`origin_channel: growth_circle`, `consent_tier: cold_scraped`, your pages in `sources`);
- files a guest record (`discovery_source: growth_circle`, `invite_state: proposed`) for a person with a `show` who has none, so your invites read them in `records.guests` (their axes are unscored: the guest standard is yours to apply to a circle guest);
- never touches a do-not-contact or closed contact, a handle, an organisation, or Krish.

The acceptance answers `circle: { dry_run, checked, created, linked, asked, refused: { <reason>: n }, people: [{ index, outcome, contact_id, in_network }] }`. `asked` counts the same-person questions filed. `outcome` is `created`, `linked`, `would_create`, `would_link` (a dry run), `not_a_name`, `not_a_person`, `is_krish`, `duplicate_in_report`, `not_to_be_contacted`, `contact_not_found`, `contact_mismatch` or `store_failed`. Use `in_network` as you use the context's: someone he knows goes on his own row, only a stranger in Jonny's box. An address reaches a circle contact only the existing ways (`person_route`, `found_routes`). A recorder that fails answers `circle: { error: 'circle_unrecorded' }` and never unaccepts the report.

**`mirror`**, `{ version: 1, questions }`: 3 to 8 questions, each naming the person as `{name}`, with `{company}` the only other fill. Control Center keeps the newest live one and runs it when Krish presses "Make the mirror" on a person, or when a circle guest says yes (at most three a day): it asks Perplexity, ChatGPT, Claude and Gemini, reads their answers against the facts on record, and keeps the read private on the AEO engine's own tables (`api/_mirror.ts`: the person is a `growth_aeo_subjects` row of kind `person`, never active; each answer a `growth_geo_probes` row; the read the subject's `growth_aeo_digests` row for the week). Nothing is sent. Another engine's report carrying `circle` or `mirror` is refused (400).

### The buyer, the site and the research desk, for growth-legibility (1.13.0)

On 27 October growth-legibility held every run with `icp_not_current_approved` though Krish had saved Legibility's buyer on Growth > Buyers that day: nothing carried `product_icp` to the engine. Capabilities now say `features.icp: true` for growth-legibility alone, and its directive carries the buyer.

**The buyer** (`icp`, in the directive). Exactly the shape the engine takes as `snapshot.icp`, read each time the directive is built from Legibility's own `product_icp` row, never another product's:

| Field | Meaning |
|---|---|
| `product_slug` | `legibility`, the engine's own product (`growth_engines.product_slug`) |
| `source` | `control-center:product_icp` |
| `buyer_definition` | The buyer in plain words, one field a line (`buyerDefinition` in `src/lib/icp.ts`): Who, Buyer titles, Seniority, Companies, They buy when, Not for, Where, Notes, each only when he filled it. Null unless approved |
| `status` | `approved` when the row is defined (buyer titles and a who line, generated in Postgres); otherwise `missing`, with no row, an undefined row, or words over 4,000 characters (never half a buyer) |
| `revision` | `sha256:<hex>` of the row's fields and its `updated_at`: the same until the row changes. Null with no row |
| `reviewed_at` | When he last saved the row (`updated_at`), one UTC instant to the millisecond. Null with no row |

A read that fails leaves `icp` out of the directive: unknown, never a missing buyer you could take as his answer. Hold as you do without it.

**The site** (`web_analytics`, 1.10.0's block). legibility.io's source and landing rows (`engineReads` in `src/lib/webProperties.ts`), as mindmake.co's reach growth-mindmake: no post is tagged, so no per-post part and `events` is null. 1.13.0 adds two parts to the block, for every engine that has one, wherever the store reads them:

- `daily`: the site's headline totals a day from `growth_metrics` (`<prefix>_sessions_1d`, `_users_1d`, `_pageviews_1d`, `_key_events_1d`): `{ date, sessions, users, pageviews, key_events }`, only the days with at least one figure, oldest first, up to 28 days through the newest day on file (`webDaily` in `src/lib/growthEngines.ts`). A day missing from the list is unknown, and so is a figure that is null on a day that is there; never zero. `[]` when nothing is on file; null as a whole when it could not be read.
- `health`: the newest daily check of the site (`web_property_insights`): `{ as_of, verdict, flags, line }`, where `verdict` is `ok`, `quiet`, `provisional`, `never_received`, `tag_missing`, `wrong_stream`, `api_disabled` or `no_access`; `flags` holds any of `consent_gated`, `thresholded`, `admin_unverified`, `undercounting`, `host_filter_off` and `read_failed`; and `line` says the verdict and each flag in plain words. Null when it could not be read, has never run, or its verdict is not one of these eight.

The site is chosen by the engine's product (`engineSiteFor`), so AEO-Engine, whose product is `mindmake`, gets mindmake.co's block too, `daily` and `health` included. That follows from the code; no test covers it.

Read it to say what the site did, never to invent a figure: a day or a part with no reading is unknown.

**The research desk.** `POST .../research` (1.6.0, above) is open to growth-legibility under its own caps, counted apart from Mindmake's: 10 `search` and 5 `question` a day, about $0.03 at the measured unit costs. No LinkedIn kind: `person_route` files a person as a Mindmake contact, and the Legibility engine has no ruling to file anyone. Any other kind is 400. `GET .../capabilities` carries `research: { kinds: ['search', 'question'], per_day: { search: 10, question: 5 } }`, and `GET .../research[/<request_id>]` reads its own answers back (it has no context read).

**AEO-Engine's index check** (2026-11-14, AEO-Engine's brief, G4). The research desk is open to aeo-engine for one kind only, `index_check`, under its own cap of 10 a day, counted apart from every other engine's.
- **The query** is `<https page> | <question>`.
- **What runs:** Control Center asks Brave Search the question, never the page, and reads the top 20 web results (`BRAVE_API_KEY`, else `GATEWAY_BRAVE_KEY`).
- **The answer** is one of three:
  - `ranked <n> of <m>`;
  - `not in the top <m>; another page on <host> ranked <n>`;
  - `not in the top <m>, nor any page on <host>`.
- **The evidence** is the results themselves, in Brave's order. Pages are compared by host (without `www`) and path, and a subdomain is another site.
- **Cost:** Brave bills $5 per 1,000 requests (its pricing page, read 2026-11-14), so the cap is at most $0.05 a day.
- **Capabilities:** `GET .../capabilities` carries `research: { kinds: ['index_check'], per_day: { index_check: 10 } }`.
- **Refused:** any other kind is 400, and no other engine is offered this kind.

**Its objectives.** The registry now lists `weekly_builders` (builders making trusted reads this week, the North Star number; 300, a week) and `conversations_held` (4 a fortnight, the Wave 1 bar), beside `activated`, `returning` and `net` (migration `20261112150000_legibility_number_objectives.sql`, applied to production on 2026-10-27 and read back: the row's objectives are `activated`, `returning`, `net`, `weekly_builders` and `conversations_held`). Report them as objectives once the directive's `objectives` names them: `weekly_builders` measured or null with its reason, `conversations_held` null with its reason until the calendar read exists. Each morning Control Center reads `weekly_builders` from your latest live report (`READERS` in `api/_northStarRefresh.ts`) to refresh the state line in your `NOW.md`: unknown when it is null, not measured, synthetic, more than 36 hours old or not this ISO week's.

### Prior Mindmake outreach (1.11.0)

Ruling (Krish, 2026-10-27): "We need to make sure that if I've already reached out to this person for MindMake, legibility is positioned as a partner product." The approved wording that came after it says Legibility is "one of the products we build at Mindmake", never a partner (Ruling, Krish, 2026-10-27; growth-legibility `docs/OUTREACH-TEMPLATE.md`, and F33 in its `docs/FAILURES.md`), which is why the word "partner" is held below. Control Center is the one source of whether someone was reached for Mindmake (`api/_priorOutreach.ts`), and growth-legibility copies its answer unchanged into `candidate.contact.prior_mindmake`.

`GET /api/growth/engines/legibility/prior-outreach?contacts=<id>,<id>` takes 1 to 50 distinct Control Center contact ids, lowercase uuids, comma separated. It answers growth-legibility only: any other engine gets 404 `prior_outreach_not_supported`, and `features.prior_outreach` is true for Legibility alone. Anything else in `contacts` (a name, an uppercase id, a repeat, 51 ids, none) is 400 and reads nothing. It sits behind the same bearer and rate limit as every route here.

It returns `{ ok, schema_version, read_at, prior_outreach }`, where `prior_outreach` holds exactly the ids asked for, in their order, each a closed record of five keys:

| state | by | state_at | last_touch_at | record_url |
|---|---|---|---|---|
| unknown | null | null | null | null |
| none | null | null | null | the person's record |
| open | null | null, always | null or a UTC time | the person's record |
| client | null | null or a UTC time (when a pilot was booked or paid) | null or a UTC time | the person's record |
| drafted | null | UTC | UTC, at or after state_at | the person's record |
| sent, replied | krish or other | UTC | UTC, at or after state_at | the person's record |
| met | krish | UTC | UTC, at or after state_at | the person's record |

`record_url` is the person's own record in Control Center, `https://controlcenter.krishraja.com/#/people?person=<id>`, which opens the one person sheet. No answer carries a name, an address, a subject, a body, a thread id or a row id.

**What counts.** Mindmake outreach by Krish, and Mindmake notes a colleague sends for him (`by: other`). Visibility never counts (Ruling, Krish, 2026-10-27): podcast pitches, guest invites, press asks, the People drafts for Guests, Speaking and press, and Events, and the pitches a colleague sends for him on the visibility and events rows. Someone touched only by those reads `none`, or `open` while one of those items is still open. The sources, each read for the asked ids only:

- **Advisory** (`pilot_deals`). The stage comes from the stamps, never from the current state: `call_taken_at` is met, `replied_at` or `call_booked_at` replied, `sent_at` sent, `drafted_at` drafted, all by Krish, for the buyer, intro and collaborator ask kinds. A deal that is listed, drafted, replied, call booked or call taken now is open, whatever its kind. A deal booked or paid for a pilot is a client.
- **growth-mindmake's proposals.** One carried out as a draft or a message is drafted, outside the visibility and events rows and Jonny's box. One pending and live that names the person as its recipient or its subject is open. Declined, expired and form submissions do not count.
- **growth-mindmake's executor** (`growth_engine_actions`). Verified is sent by Krish; claimed, submitted or unknown is open. A verified send does not count when the Advisory deal it came from is not a buyer, intro or collaborator ask (a podcast pitch, a guest invite, press, or reconnect).
- **People drafts** (`people_drafts`, by `contact_id`). The advisory job counts (Jonny's box is `other`); the job hunt never does. A draft in a colleague's box not yet sent, within 90 days, or booked and not recorded, is open. A show recorded is never met.

**For Krish to confirm:** whether the `reconnect` ask kind counts as Mindmake outreach. Until he says, it does not (it is open while open).

**The order** is unknown, then client, then open, then the furthest of met, replied, sent and drafted, then none. Krish's own rows decide the stage when he has any; otherwise a colleague's. `last_touch_at` is the latest counted touch.

**Unknown is not none.** Every id is unknown when any source cannot be read, or comes back incomplete; an id is unknown on its own when it has no contact row (missing, or merged away into another), carries a date Control Center cannot read or one after `read_at`, has an Advisory deal whose ask kind Control Center does not know, or has a People draft whose job it does not know. `none` means every source was read whole and nothing counted was found. Read again at the time you prepare: the record changes as he works.

**On his list.** Whatever route a Legibility send takes to his list, Control Center reads the record there too, and holds it off the list, counted and named, when: no one person is linked to it (`prior_outreach_unlinked`: name them in `subject_ref` as `contact:<id>`, or, at 1.0.0, put their record link in the evidence); the record is unknown (`mindmake_history_unknown`), open (`mindmake_thread_open`) or a client (`mindmake_client`); the last Mindmake touch is under 14 days old (`mindmake_touch_too_recent`); or the words contradict the record: someone reached for Mindmake whose words do not name Mindmake (`mindmake_not_named`), or someone never reached whose words do (`mindmake_named_without_touch`); someone reached whose words name Mindmake without the approved same-company line, that Legibility is one of the products we build at Mindmake (`mindmake_framing_missing`); or words that use "partner" in any form (`partner_wording`). One it allows shows the record in words on its evidence line.

### Legibility drafts in his own box (1.12.0)

Ruling (Krish, 2026-10-27): "Legibility drafts land in Krish's mindmake.co mailbox, and the press re-reads the Mindmake record first." Capabilities say `features.draft_press: true` for growth-legibility alone.

**What to send.** A walled `send` whose `exact_payload` is a version 2 email action (the shape in "The five rows" above), with no row and no rank:

```json
{ "version": 2, "channel": "email", "recipient_contact_id": "<uuid>", "subject": "One line", "body": "The words", "form": null, "mailbox": "krish",
  "prior_mindmake": { "state": "sent", "by": "krish", "state_at": "<UTC>", "last_touch_at": "<UTC>", "record_url": "<the person's record>" } }
```

- `prior_mindmake` is the basis: the record you wrote the words from, copied unchanged from `candidate.contact.prior_mindmake`. `state`, `state_at` and `last_touch_at` are required (a time or null); `by` and `record_url` may come too; nothing else. Only an email carries it.
- `mailbox` is `krish` or null. Both mean his own box: the mailbox `GOOGLE_IMPERSONATE_SUBJECT` names, <address>; `jonny` is refused at the press.
- Name the same person in `subject_ref` (`contact:<id>`) as in `recipient_contact_id`, and list the files the words were written from in `source_revision` (the template, for one).
- At 1.12.0 a send's version 2 action is read whole at the report, so a malformed one is refused there, not at his press; an older report may not carry `prior_mindmake`. Plain words stay plain words: Clear approves them as before, and he copies them.

**His press.** Clear on his one list (the list says "draft it in Gmail", shows the subject and words, and has no amend: he changes the words in the draft) runs `api/_rowPress.ts`, the press a Mindmake row uses, and holds with a code, drafting nothing, when:

- the words' files moved (`stale`) or cannot be checked (`source_unreadable`); the person is missing (`contact_missing`), marked do not contact or closed (`do_not_contact`), or was emailed in the last 14 days (`written_to_lately`); no good address is on record (`no_route`);
- the action names Jonny's box (`not_krish_box`), is not an email (`not_an_email`), names an asset, whose tracked link is made only for Mindmake's own emails (`asset_link_unsupported`), or cannot be read (`unreadable_action`); its subject is someone other than its recipient (`prior_outreach_unlinked`);
- it carries no basis (`prior_outreach_undeclared`);
- the record, read again now by the one reader, is unknown (`mindmake_history_unknown`, any failed read included), open (`mindmake_thread_open`) or a client (`mindmake_client`);
- it differs from the basis in state, or shows a Mindmake touch later than the basis's `last_touch_at` (`prior_outreach_changed`): write it again from the new record;
- the last Mindmake touch is under 14 days old (`mindmake_touch_too_recent`), or the words contradict the record, as on his list (`mindmake_not_named`, `mindmake_framing_missing`, `mindmake_named_without_touch`, `partner_wording`);
- Gmail does not confirm the token reaches one of his own addresses (`mailbox_unverified`, checked by `verifyMailbox` before every draft; it accepts the address `GOOGLE_IMPERSONATE_SUBJECT` names or any in `KRISH_PRIVATE_ADDRESSES`).

Otherwise the exact subject and words go into one Gmail draft in his box, to the address on record, and the proposal is recorded as carried out as a draft (`carried_out: draft` in your decisions). Never send it: he presses Send himself, and the executor refuses anything he carried out. A held proposal stays pending; the next run reads the record again and writes it anew.

**What the press answers** (`pressLegibility` in `api/_rowPress.ts`, through `POST /api/act`):

| Outcome | Status | Meaning |
|---|---|---|
| drafted | 200 | The draft is in his box, recorded as carried out, and the app opens it |
| a hold above | 409 | Nothing drafted; the error names the reason and its code |
| `mailbox_unverified` | 502 | Nothing drafted: Gmail did not confirm the box |
| `moved_on` | 409 | The proposal is no longer pending, or it has expired |
| `contacts_unavailable` | 500 | The people could not be read, so nothing was checked or drafted |
| `proposal_unreadable` | 500 | The proposal itself could not be read, so Clear holds: nothing is approved, checked or drafted (`clearRowById` in `api/_rowPress.ts`) |
| the draft could not be made | 502 | Gmail did not make the draft; nothing was recorded |
| `drafted_not_recorded` | the status of the failed record write | The draft is in his box but the carried-out record failed. The press returns the draft's link; the list route passes on only the status and the code |

## The report

The schema is [engine-report.schema.json](engine-report.schema.json). It and the directive's schema keep the `$id` they were first published under (`...-1.0.0.json`): it names the schema, not the version, which is in each title. Every field is listed below. A field the protocol does not know is refused, never dropped.

| Field | Meaning |
|---|---|
| `schema_version` | Any of `capabilities.schema_versions` (1.0.0 to 1.20.0), the version you speak. A field newer than the version you send is refused |
| `engine_id`, `product_slug` | Must equal the registry row for the token |
| `run_id` | Stable id for this run. It is also the `Idempotency-Key` |
| `mode` | `live` or `synthetic`. Synthetic reports are stored and read back, but never touch live progress, the directive, the list or `workflow_runs`. A live report is refused until Krish switches the engine on |
| `observed_at` | When the facts were read |
| `source` | `{ revision, captured_at }`: the commit or snapshot the run used |
| `status` | `ready`, `held` (it ran and held its work, with reasons) or `degraded` (some sources missing). A business hold is not an error |
| `objectives[]` | One reading per objective: `{ key, value, unit, window_start, window_end, timezone, availability: measured\|missing\|stale, reason }`. Unknown is `value: null` with a reason, never zero. A measured zero is `0` |
| `activity[]` | What it did: `{ line, evidence_url }`, in plain words |
| `proposals[]` | At most 10, or 40 from 1.6.0, each shaped as below |
| `events[]` | What closed: `{ event, proposal_id, at, evidence_url }`. An event closes a proposal only when it names that proposal and the event in its `close_condition`, and closes a walled proposal only after Krish approved it |
| `holds[]` | `{ reason, detail }` for anything it held |
| `inspiration_used[]` | 1.21.0, optional, growth-makeyourmindup (`features.inspiration_used`): the cards Krish ticked as a style to use that an asset you made used, `{ card_id, asset, made_at }`, at most 40. `asset` is what you made, in words, never an address or a link; `made_at` an ISO time or null. A use reported after his tick closes it (above, "His inspiration board") |
| `priorities[]`, `obsessions[]`, `next_steps[]`, `instruction_acks[]` | 1.20.0, optional, only when the directive says `features.engine_state`: your state on every place, and what you did with his instruction (above, "Krish's instruction and the engine's state") |
| `withdrawn[]` | 1.10.0, optional (capabilities say `features.withdrawn: true`): your own pending proposals you take back, `{ proposal_id, reason }`, at most 40. Each one Krish has not decided becomes `expired` with your reason kept (`done_evidence: { kind: 'withdrawn', reason, run_id }`) and leaves his list; one he decided, or another engine's, is left as it is. A proposal may not be both proposed and withdrawn in one report, and a reason is words, never an address. Use it when the record a proposal rested on is gone, so it could never run |
| `origin_candidates[]` | 1.10.0, Mindmake only (`features.meetings`), optional. Where you read his recent meetings came from: `[{ contact_id, path, origin_ref }]`, at most 40. `path` is one of `existing-relationship`, `multiplier-intro`, `partner`, `guest-seat`, `podcast`, `own-show-guest`, `public-signal`, `inbound`, `referral` or `unknown`, and at 1.24.0 also `webinar` (a lesson he hosted), `post-engager` (someone who answered his own post), `cold-outbound` (cold outreach) or `video-note` (a video note he sent), each refused in an older report (`features.meeting_paths`); `origin_ref` is a stable id (`contact:<id>`, a proposal id) or a public https page, never an address, or null. A report from another engine carrying it is refused, as is an older version. Below, held meetings |
| `suppression` | Mindmake only (`features.suppression`), optional, at any version: what you say to hide on his widget, by your own rule. Below, the suppression list and the taxonomy |
| `taxonomy` | Mindmake only (`features.suppression`), optional, at any version, sent once a run beside `suppression`: your rows, kinds, bands, reasons, presses and row doctrine. Below |
| `credits_spent[]` | 1.16.0, optional (`features.credits`): the prepaid credits this run spent, `{ pool, amount, asset, objective_key }`, at most 40. `pool` is a pool key from your directive's `credits`, `amount` is in its unit and positive, `asset` is what it made in words (never an address) and `objective_key` is the objective it serves or null. It counts against your share (above) |
| `buffer_channels` | 1.17.0, optional (`features.buffer_channels`): `{ allowed: { <channel>: <Buffer id> }, denied: [<Buffer id>] }`, at most 20 allowed and 50 denied. A go-live of posts is approved only on these (above). The newest live report that carries it is the one read |
| `post_metrics[]` | 1.17.0, optional (`features.post_metrics`): each post's numbers as Buffer shows them, at most 60, `{ proposal_id, slot_id, channel, posted_at, url, measured_at, reach, sends, saves, likes, comments }`, each number a whole number or null when not shown. Shown on Growth, Engines (above) |
| `offdays` | 1.17.0, optional, growth-makeyourmindup (W2.9): the week's off-day options as `growth.py mix offdays` writes them (`growth-offdays/1`: `week_of`, `days` of up to 6 options a date, each with `concept_id`, `lane` and `ready`; its other fields are kept in the stored report). His list counts the ready ones from today on as "Off-day posts: N ready", and his Clear sends `repository_dispatch` `growth-offday-topup` with `client_payload` `{ engine_id, report_run_id, week_of, request_id }`: answer it with one `mix topup` into the next free filler slot |
| `found_routes[]` | 1.18.0, optional, Mindmake only (`features.found_routes`): routes read out of your own answered lookups, `{ subject_ref, kind, address \| url, source_url, request_id }`, at most 40. Recorded only when Control Center's checks pass, and answered route by route in the acceptance (above, "Routes found in answered lookups") |
| `payload_sha256` | SHA-256 of the canonical JSON of the report without this field: keys sorted at every depth, no whitespace, arrays kept in order, no Unicode normalisation. The server recomputes it |

**A proposal.**

| Field | Meaning |
|---|---|
| `proposal_id` | Stable across runs. A changed payload keeps the id and changes `payload_sha256`, and that sends it back to Krish |
| `title`, `why` | Plain words |
| `kind` | `advice` (a sentence), `prepared` (the artifact exists) or `autonomous` (finished inside the walls). An autonomous proposal cannot be behind a wall |
| `wall` | `none`, `spend`, `send`, `post` or `strategy`. Anything behind a wall goes on Krish's one list on Home |
| `amount_usd` | Required for `spend` |
| `channel` | Where it would go |
| `exact_payload` | The exact words. Required for `send` and `post` |
| `objective_key` | Which objective it moves; the directive rule weighs it by that objective's gap |
| `evidence[]` | `{ label, url }`, at most 12, https only |
| `close_condition` | `{ event, reference }`: the event that proves it done |
| `expires_at` | After this it never comes forward |
| `stage` | 1.1.0. `plan`, `go_live` or `check_in` for an autonomous engine's steps, below. A plan is behind a wall; a go-live is a send, post or spend; a check-in is a `strategy` call with its progress in `exact_payload` |
| `parent_proposal_id` | 1.1.0. The plan a go-live carries out, or a check-in reports on. Required on both |
| `subject_ref` | 1.2.0. The person, stage or room it is about, by the id Control Center gave you: `contact:<id>`, `target:<id>` or `event:<id>`. Optional. When Advisory, People, Visibility or Events already holds the same one, his list keeps their copy, not yours (below) |

A proposal may not carry a key that asks Control Center to act (`send_*`, `post_*`, `publish_*`, `schedule_*`, `spend_*`, `pay_*` and so on). An engine proposes; nothing in Control Center sends for it.

### The suppression list and the taxonomy (no version, `features.suppression`)

growth-mindmake plan section 12, M10. So the widget hides what Krish said No to by the engine's rule and not Control Center's copy, a Mindmake report may carry two fields, sent only once capabilities say `features.suppression: true`, at any version. A report from another engine carrying either is refused (400). Control Center checks their schema (`parseSuppression` and `parseTaxonomy` in `src/lib/growthEngines.ts`), stores them with the report, and reads back each from the newest live report that carried it (`readEngineSuppression` in `api/_growthEngines.ts`, through the same parsers). A malformed field refuses the whole report, with the field named, never dropped. The engine first sent both, accepted, at 01:03 UTC on 28 October 2026, and its list agreed with Control Center's copy on 340 of 340 checks. Since then (the retirement step):

- **The widget hides by your list.** `suppressedBy` in `src/lib/widgetPlays.ts` applies it as your `suppressionApplies` does, check for check and in its order (`never`, `not_on_row`, `paused` until its time, `reach_floor` at or below its band by band order, `audiences` with a null sector for every sector, `topics`), with no rule of Control Center's own. Anyone he answered after your list's `as_of` (a No, or a draft, message or submit he carried out) is held until your next list (`answered_since_list`), so a No never comes back before you have read it. A booked host's show-notes note is not held by the pause after the pitch that booked him (1.10.0).
- **Rows, Nos and presses are checked against your taxonomy** (`rowRules` in `src/lib/growthEngines.ts`): a row proposal's `row`, `amplifier_kind`, `reach.band`, title, `because`, `brief` and `card` bounds against the report's own taxonomy, or with none in it the newest stored; a No's `reason_code` and a Clear's `carried_out` likewise (`actOnEngine` in `api/_verbs.ts`). A name you no longer list is refused. Control Center's own lists (`REACH_ROWS`, `AMPLIFIER_KINDS`, `REACH_BANDS`, `DECLINE_REASONS`, `CARRIED_OUT`) stay only as the schema of what it can store and draw, so a name it cannot draw yet is refused too, by name.
- **`rows_rule` is no longer sent.** The row doctrine is yours.
- **Before your first list or taxonomy**, or when the stored one cannot be read, Control Center's own copy decides as before (`answeredLike` and `CONTROL_CENTER_ROW_RULES`), so nothing breaks. It is the only copy left. A failed read of your list shows no row rather than one he said No to.

- `suppression`: `{ version: 1, as_of, never: [subject_ref], not_on_row: [{ row, subject_ref }], paused: [{ subject_ref, until }], reach_floor: [{ kind, at_or_below }], audiences: [{ kind, sector }], topics: [topic] }`, every key present. `as_of` and `until` are ISO times with a time of day; `row` is one of the five rows; `kind` one of the seven amplifier kinds; `at_or_below` one of the six bands (a candidate of that kind at that band or lower is hidden); `sector` at most 59 characters, or null for every sector; a `topic` 1 to 59 characters. A `subject_ref` matches `^[a-z_]{2,20}:[A-Za-z0-9._:-]{1,120}$` (`contact:<id>`, `target:<id>`), never a name or an address. Each list at most 500 entries, no entry twice, sorted as your `suppressionList` sorts it (`never` and `topics` by code unit; `not_on_row` by row then subject, `paused` by subject, `reach_floor` by kind and `audiences` by kind then sector, each by `localeCompare`); the whole field at most 65,536 bytes of JSON. It replaces every earlier list.
- `taxonomy`: `{ version: 1, rows[5], kinds[7], bands[6], reasons[8], carried_out[3], ask_for: { kind: ask }, row_for: { ask: row }, doctrine: { title_max, because_max, title_max_with_because, brief_lines: { min, max }, card_lines: { min, max }, card_sources_max, angle_title_max } }`, at most 2,048 bytes of JSON. Each list holds different names (`^[a-z0-9][a-z0-9_]{0,63}$`); each `ask_for` key is one of its `kinds` and each value a key of its `row_for`; each `row_for` value is one of its `rows`; each bound a whole number from 0 to 10,000, a `min` never over its `max`.

## The attempt

| Field | Meaning |
|---|---|
| `attempt_id` | Stable id |
| `command` | For example `daily`, `engine`, `weekly-review` |
| `run_id` | The report it produced, or null |
| `status` | `started`, then exactly one of `succeeded`, `failed` or `unknown` |
| `phase` | Where it was, for example `capture`, `plan`, `report` |
| `error_code` | lower_snake code, required on `failed`. A code, never a message, body, URL or credential |
| `started_at`, `finished_at` | `finished_at` is required on a terminal state and absent on `started` |

The response and the readback carry the attempt exactly as the engine sent it, times included, so an engine can compare by exact equality (the store keeps its record beside the time columns, migration `20261030100000_growth_engine_attempt_record.sql`). A terminal record never changes. An exact replay is accepted, and a different terminal record for the same id is a 409. A `started` attempt with no end after 6 hours reads as unknown. Write the started attempt before you read any source, so a failure before the report still shows.

## The directive

The schema is [engine-directive.schema.json](engine-directive.schema.json).

| Field | Meaning |
|---|---|
| `directive_id` | `<slug>:<date>` |
| `for_date` | His day, in his time zone |
| `aim` | The engine's North Star |
| `objectives[]` | Each objective with its `target` (null when nobody set one), the `latest` value and its `availability` |
| `next_action` | `{ proposal_id, instruction, why, close_condition }`: the one thing to do |
| `decisions_since[]` | His decisions in the last seven days, each as `GET .../decisions` gives it: the `payload_sha256` it was made on, the `stage`, and his version when `amended` |
| `constraints` | `{ walls, autonomy, autonomy_rule, spend_cap_usd: 0, max_actions }`. `walls` is the rule above, word for word; `autonomy` and `autonomy_rule` say who acts once he approves, below, and end with the one-ask-at-a-time rule. `max_actions` is 5 times the intensity's `drafts_multiplier` since 1.14.0: 5 at no urgency, U1 or U2, 10 at U3 or U4, 15 at U5 (Ruling, Krish, 2026-10-29: at U3 to U5, engines and Control Center may raise volume caps up to each repo's existing policy bounds without a signed week spec; volume only, walls unchanged). It is a ceiling: your own policy bounds still bind you |
| `aim_by`, `week_of`, `week_target`, `current`, `urgency`, `urgency_reason` | 1.4.0, optional. The parent product's North Star number from Control Center's daily refresh ([ADR-040](https://github.com/krishanraja/control-center/blob/main/docs/DECISIONS/040-every-repository-chases-one-number.md)): its deadline, this week's rung of its weekly ladder, the latest reading, the urgency U1 to U5 by ai-harness `contract/north-star-metric.md`, and why. Mindmake's figures read `"private"`. Absent when no refresh has read the number |
| `north_star` | 1.4.0, optional. `{ parent, own, intensity }`: the parent product's number and the engine's own (each `{ repo, metric, unit, aim_by, week_of, week_target, current, urgency, urgency_reason, read_on }`, or null), and `intensity { urgency, drafts_multiplier, rule }`, set by the more urgent of the two. U3 doubles draft output, U4 asks for a bold swing every day, U5 for three unconventional recovery plays. The walls and `spend_cap_usd` never move with it; since 1.14.0 `max_actions` scales with `drafts_multiplier` |
| `behind_by` | 1.14.0, optional. `{ of, repo, metric, unit, week_of, short_by, share, urgency }`: the gap to this week's rung of the number that sets your intensity, the more urgent of your own and your product's (`of`: `own` or `parent`). `short_by` is this week's target less the reading, never below zero (the reading less the target for a number that should fall), `"private"` for a private figure (Mindmake's), and null when not measured; `share` is how much of this week's rung is reached (1 is on it), null when not measured. Put it on every report as the gap line. Absent when no refresh has read either number |
| `rank_in_fleet` | 1.14.0, optional. `{ rank, of }`: where you stand among the active engines by `behind_by`, furthest behind first (the lowest `share`, an unmeasured number as far behind as any, then the higher urgency, then the engine id). A held, paused or inactive engine is never ranked and never gets it. Absent when the refresh could not be read |
| `taste` | 1.5.0, optional. `{ rule, approved_voice_rules[] }`: Krish's approved voice rules (`taste_profile_form`, lane voice: approved or reworded by him only, form only, his words only while the answer they quote stands), and only those of the engine's own product's venture, never another's (since 2026-10-28), each `{ layer, rule, his_words, what_it_means }`. Follow them for how anything you draft is written, never to choose what it is about, and never to judge, score or rank. An empty list means none approved yet: never invent one. Absent means they could not be read today (krishanraja/inspirationhouse `docs/TWO_WAY.md`, step 6) When capabilities say `features.taste_floor: true` (a flag with no version, I-14, 2026-11-14), `taste` also carries `floor`, `{ rule, venture, as_of, standards[] }`: his approved or reworded standards (`taste_floor`; a draft never reaches you) for the formats you make, your own venture's only, strongest first, at most 40, each `{ id, layer, formats, statement, how_to_check, his_words, standing, support_n }`, the floor your makers never go beneath, form only; and `approved_production_rules`, his approved production rules shaped as `approved_voice_rules`. Each is absent when it could not be read, and an empty list means none approved yet: then the slot still runs, and you never invent or borrow a standard. |
| `week_goals` | 1.6.0, optional. His goals for this week in his own words, newest week, at most three. A row's `serves` quotes one exactly. Empty when he has set none; absent when they could not be read |
| `rows_rule` | Retired on 2026-10-28 (growth-mindmake plan section 12, M10): no longer sent. The row doctrine is the engine's, and its `taxonomy` carries the bounds Control Center checks |
| `web_analytics` | 1.10.0, optional. Only for an engine whose product is the venture of a Google Analytics site with the per-post breakdown (`contentBreakdown` in `src/lib/webProperties.ts`, matched by the site's venture; Make Your Mind Up, site `mymu`) or one its engine reads without it (`engineReads`; Mindmake, site `site`, mindmake.co, since 2026-10-27: Ruling, Krish, 2026-10-27, through Control Center, never directly; Legibility, site `legibility`, legibility.io, since 1.13.0). 1.13.0 adds `daily` and `health` (above, "The buyer, the site and the research desk"). For a site without the per-post breakdown there are no `utm_content` rows, `events` is null and no reason is given for it. `consent_gated: true` is present only for a site that counts a visitor once they press Allow (mindmake.co): every count is a floor. `{ property, measurement_id, through, days, events, rows, coverage }`: the last `days` (28) of `web_analytics_daily` through the newest day captured (`through`). `rows` is every breakdown row in the window, oldest day first, each `{ date, dim_type, value, sessions, users, key_events }`, where `dim_type` is `source_medium`, `landing_page` or `utm_content`, and a `utm_content` value is `<utm_content>|<session source>|<event name>` (split it on the first and the last `|`, never on every one, since a source can hold one; `users` on a `utm_content` row is Google's total users for that post, source and event, so never add it across a post's events). `events` is each event name in the per-post rows, `{ name, key_event, count_28d }`: `key_event` is true when its key events add up above zero, and `count_28d` is the sessions it happened in, summed over those rows (sessions, not events). `coverage { complete, reason, dates }` says what is missing, and `dates` lists the days that carry rows of each kind. The per-post part is judged on its own days, never on the source rows that go back further: when the per-post breakdown starts inside the window, or per-post rows are on fewer days than the window, `complete` is false and the reason says how many days `events` and `count_28d` cover. A day without per-post rows had no tagged visits or was not captured, so it is unknown, not zero. A newest day more than 2 days before the directive's day also makes it incomplete. A part that cannot be read is null with its reason, never zero: the table unread or nothing captured makes `through`, `events` and `rows` null; no per-post row in the window makes `events` null. Counts only: no person and no address (a value that reads as an email address is left out). Absent for every other engine |
| `credits` | 1.16.0, every engine whose product a pool is placed on (`features.credits`). `{ rule, pools[] }`: each prepaid credit pool, your share, what is left of it and the day it is wiped; spend within `remaining_for_you` needs no proposal (above). Absent when no pool is placed on your product, or the pools could not be read today |
| `inspiration` | 1.15.0, growth-makeyourmindup only (`features.inspiration`). `{ rule, suggestions[] }`: his own suggestions from his inspiration board, his words and the trials he tagged, as the baseline for what you plan (above). From 1.21.0 a card he ticked as a style to use carries `instruction` and comes first, with `instruction_rule` beside `rule` (`features.inspiration_instructions`). Absent when they could not be read today |
| `icp` | 1.13.0, growth-legibility only (`features.icp`). Its own product's buyer from `product_icp`, in the shape it takes as `snapshot.icp` (above). Absent when it could not be read today |
| `in_house` | Mindmake only. `{ rule, counts }` says what Advisory (`pilot_deals`), Network (warm tiers) and Visibility (stages and rooms) did this week inside Control Center, as counts. A part that could not be read is `null`, never zero. They are records Control Center holds, sent as data: growth-mindmake owns every Mindmake growth decision (Ruling, Krish, 2026-10-27), and never drafts a second note or pitch to someone a record already holds |
| `krish_instruction` | 1.20.0, every engine where `features.krish_instruction`. `null` or `{ id, words, given_at, given_by: "krish", supersedes }`: his own next best action for you, carried until you ack it done, he ends or replaces it, or it is a week old. Act on it first, inside the walls; it is never an approval (above). Absent when it could not be read today |
| `features` | 1.20.0. `{ engine_state, krish_instruction }`: what this directive's protocol serves. Report your state only when `engine_state` is true. From 1.21.0 growth-makeyourmindup's also says `inspiration_used: true`: send `inspiration_used` only then. Added when the directive is served: `ai_answers` and `ai_answers_detail` (1.22.0, 1.26.0, a venture engine), `answer_requests`, `answer_requests_v2` and `aeo_kits_delivered` (AEO-Engine), as the capabilities say |

**How the next action is chosen, by rule** (Ruling, Krish, 2026-10-18), in order:

1. Something Krish approved that the engine has not yet done, with the approved payload (his version when he amended it). For an autonomous engine, an approved plan says "build it up to go-live, then propose the go-live", and an approved go-live says "go live with exactly what he approved".
2. If the engine is failing, unknown or stale: repair, naming what broke.
3. The unwalled pending proposal that closes the widest gap to an objective. An objective that is not measured yet counts as a wide gap, and a proposal on no objective as a small one. Urgency raises the floor of every gap on an objective (U2 0.1, U3 0.4, U4 0.6, U5 0.8), so behind the number, a proposal that moves it comes first.
4. If everything proposed is behind a wall: keep preparing, and do not act on what waits on Krish. He sees one of your asks at a time, so add no second ask of a kind that already waits on him.
5. If nothing is proposed: propose your best move on the widest gap; at U3 two experiments, at U4 one bold swing, at U5 three unconventional recovery plays, each different in kind.

Krish can pick another unwalled proposal on Growth > Engines as tomorrow's push (`chosen_by: krish`). The rule never replaces his pick.

## Amend: his version before his yes

On his list, an engine's proposal that carries words (`exact_payload`) or, for a spend, an amount can be changed before he approves it ("Change it first", then "Approve my version": one press). Ruling (Krish, 2026-10-19): he approves or amends.

- His yes is still to the proposal he was shown: `payload_sha256` in the decision is the engine's digest.
- The decision also says `amended: true` and carries his version: `exact_payload`, `amount_usd`, and `amended_sha256`, the SHA-256 of the canonical JSON of exactly `{ "amount_usd": ..., "exact_payload": ... }` (both keys, `null` when absent).
- Recompute `amended_sha256` before acting, then act on his version, never your own.
- If you change the proposal's payload after his decision, his yes and his version both lapse, and it comes back to him.

## Autonomy: plan, then go-live

Each engine is `handcrafted` or `autonomous` (`growth_engines.autonomy`, in the directive's `constraints` and in `capabilities`). Ruling (Krish, 2026-10-22): Mindmake now prepares autonomously and executes only a supported, exact approved finished action with independent verification. This supersedes its 19 October handcrafted setting. Krish can switch any engine back to handcrafted.

**Autonomous**, in four steps, each on his list:
1. **The plan.** Propose what you are going to do as `stage: "plan"` behind a wall (usually `strategy`), with the plan in `exact_payload` so he can amend it. Wait for his yes.
2. **The go-live.** Once the plan is approved, build everything up to go-live: the assets, the exact words, the amount. Then propose `stage: "go_live"` with `parent_proposal_id` set to the plan, behind `send`, `post` or `spend`. Nothing goes out yet.
3. **Live.** When he approves the go-live, go live yourself with exactly what he approved, or his amended version, and report the closing event with its evidence. Purge on a go-live means stop.
4. **Check in, often.** While a plan is open (approved and not done), propose `stage: "check_in"` naming it, behind `strategy`, with how it is going against the plan and what comes next in `exact_payload`. His list asks "On track?": Clear keeps it going, his amendment redirects it, Purge stops the plan (the rule then never pushes it again). Each engine's repository sets how often; a go-live never waits on a check-in, and a check-in never replaces the go-live review.

A go-live of creative work (a post, a video, a caption) meets the engine's own quality bar before it is proposed, and says so in its evidence. Krish has a low tolerance for poor creative output: hold work that is not good enough rather than propose it, and treat his amendments and declines as the standard to learn from.

**Handcrafted:** prepare the exact artifact and stop. Krish sends, posts or spends himself.

Either way, the walls rule holds: nothing goes out without a decision whose digest matches what goes out.

## On his list: one ask at a time, one copy of a thing

Ruling (Krish, 2026-10-21), so the engines and the parts of Control Center that already queue things for him never put the same thing in front of him twice:

- **One ask per engine at a time.** Of an engine's walled proposals, his list shows one: a go-live first, then a check-in, then a plan, then a spend, a send, a post and a strategy call, the oldest first within each. The rest wait their turn, each named, and the next comes forward when he answers (or bumps) the one shown. So never add a second ask of a kind that already waits; keep the one waiting current instead.
- **Spends take turns by the ladder** (Ruling, Krish, 2026-10-22). Spends draw on the same prepaid credits, so while one venture's spend (not its plan or check-in) is on his list, a spend from a venture lower on the portfolio ladder is held, named (`waits_on_ladder`), and comes forward when the higher one is answered or bumped. That engine's next ask still comes forward in the meantime.
- **A Legibility invitation waits on the person's Mindmake record** (Ruling, Krish, 2026-10-27). It is held, counted and named, for the reasons in "Prior Mindmake outreach (1.11.0)" above.
- **One copy of a person, stage or room.** Advisory (`pilot_deals`), People, Visibility and Events already draft notes and pitches. A proposal whose `subject_ref` names someone or something they hold is left off his list, and theirs stays. It is not declined: it waits, and it lapses when it expires. Never a second note or pitch to someone a record already holds.
- **Who owns what.** Control Center's People and Visibility own outreach to shows and guests for Make Your Mind Up, so that engine proposes posts and measures, never a pitch, a swap or a partner note. A product with an active or held engine has that engine as its one strategy voice: the Sunday growth council writes no weekly move for it, and his list brings no council move forward for it (held: Ruling, Krish, 2026-10-29).

## Health, as Growth > Engines shows it

The states are `inactive`, `never_reported`, `healthy`, `held`, `degraded`, `failing`, `stale` and `unknown`.
- The newest attempt speaks first. A newer failure never inherits an older success, and the last success is shown beside it.
- Stale means no report or attempt past the cadence: 36 hours for daily, 8 days for weekly, 15 days for fortnightly.
- **Behind goes on his list** (Ruling, Krish, 2026-10-29). An active engine broken (stale, failing or unknown) or never reported for longer than one cadence since it was last fine, or at U4 or U5 with no proposal for 48 hours, is an `engine_health` item on Home's one list (an engine that has never succeeded counts from the day it was switched on, and nothing counts from before its last release from a hold), asking him to repair it or hold it, ahead of your own asks (one ask per engine). It closes itself once you run on schedule again (`engine_healthy` in the done-check sweep). So report an attempt every run, including a run that only holds.

## What lands where

| What | Where |
|---|---|
| Each accepted live report | One `workflow_runs` row (`workflow_id` = `engine_id`, `agent_id` from the registry), so fleet health sees it |
| A walled proposal | Home's one list, source `engine`, one per engine at a time and never beside Control Center's own copy of the same subject. Clear approves exactly that payload, Purge declines, Bump keeps it off until his next day (`api/_verbs.ts`, `actOnEngine`) |
| An unwalled proposal | Growth > Engines, where he can pick it as tomorrow's push |
| A row proposal (1.6.0) | His home screen widget, in the engine's rank within its row, and his one list like any walled proposal. On either, the press carries it out (`api/_rowPress.ts`): a Gmail draft in his box, or a message app opened with the words typed, recorded as `carried_out`. His No is recorded with its `reason_code` |
| An engagement task (1.14.0) | Home's one list and the engine's tile on his widget, its taps each carried out by one press by its route: X's reply box with the words typed for an X post, else copied and opened. Clear records that he posted them (`carried_out: tapped`); nothing posts from Control Center |
| A growth-legibility send written as a version 2 email action (1.12.0) | Home's one list, once the person's Mindmake record allows it. Clear drafts it into his own box (`pressLegibility` in `api/_rowPress.ts`), recorded as `carried_out: draft`; otherwise it is held with a code, and nothing is drafted |
| A meeting he held (1.10.0) | Home's one list, source `meeting`: "How was your meeting with <name>?", every unanswered one of the last 28 days at once, up to 20. Clear says it was good, Purge says it was not, Bump keeps it off until his next day (`api/_verbs.ts`, `actOnMeeting`). His answer, and where it came from, reach you in the context's `meetings` |
| Objectives, activity, holds | Growth > Engines |
| Media and copy to review | Growth > Packs, until packs join this protocol |
