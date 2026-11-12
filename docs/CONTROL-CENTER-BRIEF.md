# Control Center brief: AEO-Engine

**Status (2026-11-12): adopted in this repository and running live, 1.20.0 included.** The protocol client, the daily `cc-growth-directive` workflow and the research run's report have run live: the first live daily run was 2026-10-19, the first full research run to deliver a report was 2026-10-25, and the first 1.20.0 report (with the engine's priorities, obsessions and next steps) was the daily run of 2026-11-12. Read on 2026-11-12 from GitHub Actions run history and from the reports Control Center holds (a read-only query): every daily report since 2026-10-26 is `ready`, and both full research reports (2026-10-25 and 2026-11-08) carry a measured `queries_cited_first`. No instruction from Krish has reached this engine yet. How it runs: `README.md`, "Reporting to Control Center".

The brief below is Control Center's handoff (its `docs/handoff/growth-engines/aeo.md`), copied as it stood on 2026-11-12. It is Control Center's words, not updated as the protocol moves; only its link to the protocol is made absolute so it opens from here. Where this repository answers it differently, "How this repository answers 1.20.0" at the end says so.

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
| State | Switched on 2026-10-18, with dispatch on. Your bearer is in this repository's secrets as `CONTROL_CENTER_ENGINE_TOKEN` (issued 2026-10-18), with `CONTROL_CENTER_URL` as a variable. Prove your client with `mode: synthetic` first |

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

## 1.20.0: krish_instruction and engine state

Ruling (Krish, 2026-11-11): every growth engine's priorities, obsessions, next steps and outstanding items feed live across Control Centre, and Krish instructs each engine with his next best action, which starts it. The protocol is [ENGINE-PROTOCOL.md](https://github.com/krishanraja/control-center/blob/main/docs/app/growth/ENGINE-PROTOCOL.md), "Krish's instruction and the engine's state (1.20.0)". In short:

- Read `directive.krish_instruction` (null or absent is fine). Gate every new report field on the served directive saying `features.engine_state === true`; before that, send nothing new.
- When you send a 1.20.0 field, set `schema_version` to `1.20.0`, and let your schema copies and validators take `priorities`, `obsessions`, `next_steps` and `instruction_acks` exactly as the protocol shapes them.
- An instruction can wake you a second time the same day: make `run_id` unique per wake.
- On a run whose directive carries an instruction you have not acked: `instruction_acks: [{ state: 'received', line }]` and one activity line first saying you received Krish's instruction `<id>`, the id only; if you act on it in that run, `started`, then `done` or `blocked` with a line. Never an ack in `holds`.
- Never print, log or commit his words: your repository and its Actions logs are public. Show the id and, at most, a SHA-256 digest.
- An instruction never authorises a send, post, spend, delete or permission change: walled work still goes out as a proposal.
- Fill `priorities` from your North Star line and your own constraint or recommendation, `next_steps` from your first unticked GET-GOING step and your NOW.md's "What is next", and `obsessions` only from Krish's quoted aims in your own docs, as lines. Never invent one; leave out a field you have no source for.
- Tests: an instruction present, one absent, held, and the second-wake `run_id`. Run your own checks, follow your own merge rule, and write now-notes, never NOW.md on a branch.

**Where, in AEO-Engine.** Keep the instruction in the object the loop builds (`src/protocol/loop.ts`, about line 104), put the activity line first, and replace the hard-coded empty `events` with the acks (`src/protocol/reports.ts`, `src/schema/report.ts`). Add a `run_id` discriminator for the second wake. An instruction that needs research is acked `blocked` with the line "needs a paid research run: press Run now", because the directive run never starts paid research (the cost wall).

## How this repository answers 1.20.0

Built 2026-11-11 (#29) and live since the daily run of 2026-11-12. `README.md`, "Krish's instruction and the engine's state", says how it runs; these are the places it differs from the brief above:

- **The acks sit in `instruction_acks`, not `events`.** The protocol puts them there; `events` stays empty, because this engine reports no closing event yet.
- **`next_steps` are read from three places:** the first unticked step of `docs/GET-GOING.md`, the next scheduled research run, and each item of NOW.md's "Waiting on Krish" (as `waits_on: krish`). NOW.md's "Next" line is not sent (`src/protocol/state.ts`).
- **The blocked line does not say "press Run now".** No page in Control Center draws a Run now press for this engine (Control Center's own `docs/app/growth/AEO-ENGINE.md` says so), and no Run now dispatch has reached this repository since 2026-09-08. The press that works is Run workflow on AEO weekly in GitHub Actions, so the line names it (since 2026-11-12).
- **An instruction can lapse before the research reaches it.** Control Center carries an instruction for 7 days; the research runs fortnightly. The daily run never starts paid research (the cost wall), so an instruction is acted on only by a research run inside its 7 days: the next scheduled one when it comes in time, or one Krish starts by hand. The blocked line says which, with the dates: "the next scheduled run, Sunday 22 November 2026, picks it up", or "comes after it lapses on Thursday 19 November 2026; press Run workflow on AEO weekly in GitHub Actions before then". A scheduled run counts as in time only when it is due more than 12 hours before the lapse, because GitHub starts scheduled runs hours late.
- **Done is never claimed.** A research run with an instruction open acks `started` (or `blocked` when the research failed): it probes Control Center's subject list and never reads his words, so whether it answered him is his to say with Clear.
