<!-- Copied from krishanraja/control-center docs/app/growth/ENGINE-PROTOCOL.md on 2026-10-18. Control Center's copy is authoritative. -->
# The growth engine protocol, version 1.0.0

Every growth engine reports into Control Center through this one protocol, and Control Center pushes each engine its next move through it (ADR-038 in Control Center). It replaces the per-engine receivers the handoffs asked for. The engines are:

| Engine | Slug in the path | `engine_id` | `product_slug` |
|---|---|---|---|
| krishanraja/growth-mindmake | `mindmake` | `growth-mindmake` | `mindmake` |
| krishanraja/growth-heartside | `heartside` | `growth-heartside` | `heartside` |
| krishanraja/growth-makeyourmindup | `makeyourmindup` | `growth-makeyourmindup` | `publication` |
| krishanraja/growth-fulltime | `fulltime` | `growth-fulltime` | `full-time` |
| krishanraja/growth-legibility | `legibility` | `growth-legibility` | `legibility` |
| krishanraja/AEO-Engine | `aeo` | `aeo-engine` | `mindmake` |

The registry is the table `growth_engines`. It holds each engine's aim (its North Star), its objectives with their targets, its cadence, whether it is switched on, and the SHA-256 of its bearer.

## The daily loop

Each run, every engine does these five things, in this order:

1. **Pull its directive.** `GET /api/growth/engines/<slug>/directive` returns today's one next action.
2. **Act inside the walls.** Nothing sends, posts, spends, deletes or changes a permission unless Krish has made a decision whose `payload_sha256` matches what the engine is about to do.
3. **Journal the attempt.** `POST /api/growth/engines/<slug>/attempts`, once when the run starts and once when it ends.
4. **Report.** `POST /api/growth/engines/<slug>/reports` sends what it measured, what it did, what it proposes, what closed and what it held.
5. **Read his decisions.** `GET /api/growth/engines/<slug>/decisions?since=<time>` returns his yes and no on what it proposed.

**When the loop starts.**
- Every day around 06:10 in London (the cron is `/api/growth/engines-dispatch` at 05:10 UTC), Control Center writes each active engine's directive.
- Where dispatch is on, it also wakes the engine's repository with one `repository_dispatch` of type `cc-growth-directive`. The payload is `{ directive_id, engine_id }`, nothing else, and the engine pulls the rest with its own bearer.
- An engine that does not run on GitHub Actions just pulls the directive at the start of its own run. The directive is the same either way.

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

| Method and path | Request | Response |
|---|---|---|
| `GET /api/growth/engines/<slug>/capabilities` | | `{ schema_version, engine_id, product_slug, idempotency: true, activation: { state, activated_on }, features }` |
| `GET /api/growth/engines/<slug>/directive[?date=YYYY-MM-DD]` | | `{ ok, chosen_by: 'rule'\|'krish', directive }` |
| `POST /api/growth/engines/<slug>/reports` | header `Idempotency-Key: <run_id>`, body a report | `{ accepted: true, run_id, payload_sha256, replayed }` |
| `GET /api/growth/engines/<slug>/reports/<run_id>` | | `{ accepted: true, run_id, payload_sha256, mode, accepted_at, report }`, or 404 |
| `POST /api/growth/engines/<slug>/attempts` | an attempt | `{ ok: true, attempt[, replayed] }` |
| `GET /api/growth/engines/<slug>/attempts/<attempt_id>` | | `{ ok: true, attempt }`, or 404 |
| `GET /api/growth/engines/<slug>/decisions[?since=<time>]` | | `{ ok, decisions: [{ proposal_id, decision: 'approved'\|'declined'\|'done', decided_at, payload_sha256 }] }` |

**Errors.**
- **400:** the report or attempt is malformed. The body names the field.
- **401:** the token is wrong or missing.
- **403:** the report names another engine or product.
- **409:** one of three things:
  - the same run was already reported with a different payload, which is a conflict
  - an attempt already has a different terminal record
  - `engine_inactive`, a live report from an engine Krish has not switched on
- **413:** the report is over 512 KB.
- **429:** rate limited, with `Retry-After`.
- **500 `store_failed`:** the store failed. This is redacted and carries no row or body.

## The report

The schema is [engine-report.schema.json](engine-report.schema.json). Every field is listed below. A field the protocol does not know is refused, never dropped.

| Field | Meaning |
|---|---|
| `schema_version` | `"1.0.0"` |
| `engine_id`, `product_slug` | Must equal the registry row for the token |
| `run_id` | Stable id for this run. It is also the `Idempotency-Key` |
| `mode` | `live` or `synthetic`. Synthetic reports are stored and read back, but never touch live progress, the directive, the list or `workflow_runs`. A live report is refused until Krish switches the engine on |
| `observed_at` | When the facts were read |
| `source` | `{ revision, captured_at }`: the commit or snapshot the run used |
| `status` | `ready`, `held` (it ran and held its work, with reasons) or `degraded` (some sources missing). A business hold is not an error |
| `objectives[]` | One reading per objective: `{ key, value, unit, window_start, window_end, timezone, availability: measured\|missing\|stale, reason }`. Unknown is `value: null` with a reason, never zero. A measured zero is `0` |
| `activity[]` | What it did: `{ line, evidence_url }`, in plain words |
| `proposals[]` | At most 10, each shaped as below |
| `events[]` | What closed: `{ event, proposal_id, at, evidence_url }`. An event closes a proposal only when it names that proposal and the event in its `close_condition`, and closes a walled proposal only after Krish approved it |
| `holds[]` | `{ reason, detail }` for anything it held |
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

A proposal may not carry a key that asks Control Center to act (`send_*`, `post_*`, `publish_*`, `schedule_*`, `spend_*`, `pay_*` and so on). An engine proposes; nothing in Control Center sends for it.

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

A terminal record never changes. An exact replay is accepted, and a different terminal record for the same id is a 409. A `started` attempt with no end after 6 hours reads as unknown. Write the started attempt before you read any source, so a failure before the report still shows.

## The directive

The schema is [engine-directive.schema.json](engine-directive.schema.json).

| Field | Meaning |
|---|---|
| `directive_id` | `<slug>:<date>` |
| `for_date` | His day, in his time zone |
| `aim` | The engine's North Star |
| `objectives[]` | Each objective with its `target` (null when nobody set one), the `latest` value and its `availability` |
| `next_action` | `{ proposal_id, instruction, why, close_condition }`: the one thing to do |
| `decisions_since[]` | His decisions in the last seven days, each with the `payload_sha256` it was made on |
| `constraints` | `{ walls, spend_cap_usd: 0, max_actions: 5 }`. `walls` is the rule above, word for word |
| `in_house` | Mindmake only. `{ rule, counts }` says what Advisory (`pilot_deals`), Network (warm tiers) and Visibility (stages and rooms) did this week inside Control Center, as counts. A part that could not be read is `null`, never zero. These three drive Mindmake's growth already, so the engine proposes into them and never drafts a second note or pitch to someone they already hold |

**How the next action is chosen, by rule** (Ruling, Krish, 2026-10-18), in order:

1. Something Krish approved that the engine has not yet done, with the approved payload.
2. If the engine is failing, unknown or stale: repair, naming what broke.
3. The unwalled pending proposal that closes the widest gap to an objective. An objective that is not measured yet counts as a wide gap, and a proposal on no objective as a small one.
4. If everything proposed is behind a wall: keep preparing, and do not act on what waits on Krish.
5. If nothing is proposed: propose your best move on the widest gap.

Krish can pick another unwalled proposal on Growth > Engines as tomorrow's push (`chosen_by: krish`). The rule never replaces his pick.

## Health, as Growth > Engines shows it

The states are `inactive`, `never_reported`, `healthy`, `held`, `degraded`, `failing`, `stale` and `unknown`.
- The newest attempt speaks first. A newer failure never inherits an older success, and the last success is shown beside it.
- Stale means no report or attempt past the cadence: 36 hours for daily, 8 days for weekly, 15 days for fortnightly.

## What lands where

| What | Where |
|---|---|
| Each accepted live report | One `workflow_runs` row (`workflow_id` = `engine_id`, `agent_id` from the registry), so fleet health sees it |
| A walled proposal | Home's one list, source `engine`. Clear approves exactly that payload, Purge declines, Bump keeps it off until his next day (`api/_verbs.ts`, `actOnEngine`) |
| An unwalled proposal | Growth > Engines, where he can pick it as tomorrow's push |
| Objectives, activity, holds | Growth > Engines |
| Media and copy to review | Growth > Packs, until packs join this protocol |
