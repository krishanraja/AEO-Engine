# Control Center brief: AEO-Engine

**Status (2026-10-27): adopted in this repository and running live.** The protocol client, the daily `cc-growth-directive` workflow and the research run's report are built, tested against a local stand-in, and have run live: the first live daily run was 2026-10-19 and the first full research run to deliver a report was 2026-10-25 (GitHub Actions run history, read 2026-10-27; what Control Center holds could not be read from here). How it runs: `README.md`, "Reporting to Control Center". The brief below is Control Center's handoff of 2026-10-18 and is not updated as the protocol moves.

Written 2026-10-18 by Control Center. **Your packet ingest stays exactly as it is**: `/api/aeo/context`, `/api/aeo/ingest`, `/api/aeo/run` and `/api/aeo/meter`, the AeoPacket schema, and `AEO_ENGINE_SECRET`. Krish ruled that every growth engine also runs one protocol loop (ADR-038 in Control Center), so Growth > Engines can show you beside the other five. Until you do, Control Center reads your last run from `aeo_commands`.

## Your registry row

| | |
|---|---|
| Slug in the path | `aeo` |
| `engine_id` | `aeo-engine` |
| `product_slug` | `mindmake` |
| Aim | When a buyer asks an AI assistant the questions Krish's ventures answer, Mindmake and its products are cited first, and this engine can show the week each one was won. By 2027-01-31 |
| Objectives | `queries_cited_first`: no target set yet, per fortnight |
| Cadence | fortnightly (odd ISO weeks, Sunday 04:00 UTC) |
| State | Switched on 2026-10-18, with dispatch on. Your bearer arrives in this repository's secrets as `CONTROL_CENTER_ENGINE_TOKEN`, with `CONTROL_CENTER_URL` as a variable. Until then, build against `mode: synthetic` |

## The protocol, in short

The full spec is `docs/control-center/ENGINE-PROTOCOL.md`, with the report and directive schemas and a worked example beside it. In short:

**Base URL and auth.**
- Base: `CONTROL_CENTER_URL`, which is `https://controlcenter.krishraja.com`.
- Bearer: `Authorization: Bearer $CONTROL_CENTER_ENGINE_TOKEN`. This is a `gen1_` token issued for this engine alone. Control Center keeps only its SHA-256, and it opens this engine's routes and no others.
- Transport: HTTPS only. Follow no redirects, use bounded timeouts, and read back before retrying any write.

**Every run, in this order:**
1. `POST {base}/api/growth/engines/aeo/attempts` with `status: started`, before reading any source.
2. `GET {base}/api/growth/engines/aeo/directive` returns today's `next_action`, your objectives with their targets and latest values, his decisions of the last seven days, and the walls.
3. Do the work, inside the walls. The rule, word for word: "Nothing sends, posts, spends, deletes or changes a permission without a decision from Krish whose payload_sha256 matches what you are about to do."
4. `POST {base}/api/growth/engines/aeo/reports` with header `Idempotency-Key: {run_id}`. The body is the report envelope:
   - `schema_version: "1.0.0"`, `engine_id`, `product_slug`, `run_id`, `mode`, `observed_at`, `source`, `status`
   - `objectives[]`, `activity[]`, `proposals[]`, `events[]`, `holds[]`
   - `payload_sha256`: the SHA-256 of the canonical JSON without that field, with keys sorted at every depth and no whitespace

   An unknown field is refused, never dropped. Then `GET .../reports/{run_id}` and compare the digest.
5. `POST .../attempts` again with the terminal state (`succeeded`, `failed` with a lower_snake `error_code`, or `unknown`) and `finished_at`. A terminal record never changes.
6. `GET {base}/api/growth/engines/aeo/decisions?since={last run}` returns his yes and no, each with the `payload_sha256` it was made on. Act on a yes only when that digest equals the payload you are about to use. A changed payload is a new ask, and it goes back to him by itself when you report it.

**How proposals and readings are judged.**
- A proposal behind a wall (`spend` with its `amount_usd`, `send` or `post` with its `exact_payload`, or `strategy`) goes on Krish's one list on Home, where Clear approves it, Purge declines it and Bump defers it a day.
- A proposal inside the walls is yours to do. Control Center may pick it as your next push.
- Unknown is `value: null` with a `reason`, never zero. A measured zero is `0`.
- `mode: synthetic` is stored and read back but never touches his numbers or his list. Use it to prove your client before Krish switches you on. A live report is refused (409 `engine_inactive`) until he does.

**The wake-up.** Control Center wakes you once a day around 06:10 London with `repository_dispatch` of type `cc-growth-directive`, whose `client_payload` is `{ directive_id, engine_id }` and nothing else. Add that trigger to your workflow. If you do not run on GitHub Actions, pull the directive at the start of your own run instead; it is the same directive.

## What you add

1. **One attempt per run.** Write the started attempt before the context pull, and the terminal one after ingest. Your error codes stay lower_snake codes, for example `context_unavailable`, `ingest_refused` or `budget_cap`.
2. **One report per run**, after the packet is ingested:
   - The `objectives[]` reading for `queries_cited_first` across your subjects.
   - `activity[]`: one line per subject, for example "Probed 40 questions for Heartside".
   - Proposals for any spend above your per-run cap (`wall: spend`). There should be none at today's cap.
   - Never anything from `NEVER-PUBLISH.md`.
3. **Optionally, the `cc-growth-directive` trigger.** Your run cadence stays yours. A directive on a non-run day may only ask you to report the gap.

## What does not change

- Packets, recommendations into content ideas, and Run now through `aeo_commands`.

## Known on the Control Center side

The content engine's schedule still expects your ingest every week. Since you moved to a fortnightly run, the content engine owns that fix.
