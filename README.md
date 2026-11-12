# AEO-Engine

The fortnightly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. Every other Sunday it asks the AI assistants (Perplexity, ChatGPT, Claude, and Grok when a key exists) the questions those buyers ask, records who gets cited and whether we do, reads the fortnight's calls for what buyers actually said, scores the demand behind each question, and ships one packet per subject to Control Center, which turns the recommendations into content ideas and the probes into the Growth tab's evidence. It keeps no list of its own: every subject, domain and competitor comes from Control Center, so adding a company there is the whole onboarding.

## Never publish

A writer working from this repo's exhaust may not reveal:

- any credential or secret VALUE, and no secret NAME outside this README's secrets table
- any call participant's name, email address or handle, or any transcript text
- any theme paraphrase or call reference from a packet
- any prospect company name, room target, title, or trigger signal
- any engine answer snapshot or citation list
- any figure from a cost ledger or a packet's stats

The full list with reasons is `docs/NEVER-PUBLISH.md`.

## How it runs

`.github/workflows/aeo-weekly.yml` (named AEO weekly) is scheduled for Sunday 04:00 UTC on odd ISO weeks only (fortnightly since 2026-10-15; the file keeps its name so Control Center's links hold). GitHub starts scheduled runs late: every scheduled research run from 2026-09-27 to 2026-11-08 began between 08:50 and 10:56 UTC. It also runs on a manual dispatch, Run workflow in GitHub Actions (subject, dry; a dry run on Actions prints counts only and keeps no file, because this repository's artifacts are public, so read a whole packet with `--dry --out` locally), which is how Krish starts a run by hand today, and on `repository_dispatch` type `aeo-run` from Control Center's Run now route (`/api/aeo/run`, served by content-engine; `client_payload.command_id`, `client_payload.subject`). No Control Center page presses that route any more, and no `aeo-run` dispatch has reached this repository since 2026-09-08. Each subject job tries twice, five minutes apart; the second failure fails the job so GitHub notifies. `week_start` is the Monday that owns the run in UTC, so the Sunday run reports the week that began the previous Monday.

Locally:

```
npm install
npm run run -- --subject all --dry --out out/packets.json     # live reads, no POST
npm run run -- --offline --dry --subject ctrl                  # fixtures only, no network
npm run run -- --subject <slug|uuid|all> [--week YYYY-MM-DD] [--command-id n] [--cap-usd n]
npm test && npm run typecheck && npm run check:config
```

The pipeline per subject (`src/pipeline/`): `00-context` reads Control Center; `10-transcripts` lists the last fourteen days of Fireflies calls (the research runs fortnightly, so every call between two runs is read), attributes each to one subject with one model call, and writes five to ten themes with paraphrase-only evidence; `20-gap` tallies who is cited where we are absent; `30-propose` writes 20 to 40 questions and carries last week's ids; `40-probe` asks every engine, up to the per-subject cap and the USD cap; `50-score` scores demand out of 100 from three measured proxies; `60-digest` writes the recommendations, watch list and (per kind) the approach hook or the playbook, with a deterministic fallback; `65-voice` rewords those drafted lines in Krish's approved voice rules, only when the directive carries at least one, and never decides or scores anything; `70-ship` validates and POSTs. Every client has an offline twin that reads `tests/fixtures`, so the same pipeline runs with no network. A prospect's questions are what that company's leaders would ask an assistant about their own problem; the read is whether Mindmake or Krish appears in the answer they would see.

## Reporting to Control Center (growth engine protocol)

Beside the packet ingest, which does not change, the engine reports through Control Center's growth engine protocol as `aeo-engine`, path slug `aeo`, product `mindmake`. The protocol is [Control Center's ENGINE-PROTOCOL.md](https://github.com/krishanraja/control-center/blob/main/docs/app/growth/ENGINE-PROTOCOL.md), which is authoritative; `docs/control-center/ENGINE-PROTOCOL.md` is a copy of it, taken whole on 2026-11-12, that lags it from its next change. This engine sends protocol 1.0.0 reports, and 1.20.0 reports when the directive serves the engine's state, and accepts any 1.x directive. The client is `src/clients/growthEngine.ts` (HTTPS only, no redirects, twenty seconds a call, the bearer in one header and never logged); the reports are built in `src/protocol/reports.ts`, sealed with a SHA-256 digest of their canonical JSON (`src/lib/canonical.ts`), and driven by `src/protocol/loop.ts` through `npm run protocol`.

- **The daily wake-up** (`.github/workflows/cc-growth-directive.yml`, on Control Center's `cc-growth-directive` dispatch around 05:10 UTC, or by hand): a started attempt, the directive, then a report that says when the last full research run reported and when the next scheduled one is, with `queries_cited_first` read back from that research run's own protocol report (free GETs, newest day first, back fifteen days). On a research Sunday the wake comes after the 04:00 slot but before GitHub starts the run, so until that run has reported, the run to come is today's. Then the readback, his decisions and the terminal attempt. This workflow holds no paid API key and never calls the research CLI, and `check:config` fails if it ever does: a directive cannot start paid research.
- **The research run** (`aeo-weekly.yml`, the schedule or a run started by hand, not a dry run): the plan job journals the started attempt and reads the directive before it reads the subject list; each research job reads the directive again, read-only and never fatal, only for Krish's approved voice rules (`taste`, protocol 1.5.0) that the `65-voice` pass applies, and leaves a counts-only summary, sealed to the workflow run (`src/lib/seal.ts`) because this repository's artifacts are public; the report job sends one report for the whole run, reads it back, reads his decisions and closes the attempt. The report carries `queries_cited_first`, one plain line per subject (ventures by name, prospects and aspirations by number only), and a `wall: spend` proposal only when the cap stopped probes.
- **Krish's instruction and the engine's state** (protocol 1.20.0, only when the directive says `features.engine_state`): both runs add the engine's priorities, Krish's quoted aims (obsessions) and next steps, read from this repository's own `docs/NORTH_STAR.md`, `NOW.md`, `AGENTS.md` and `docs/GET-GOING.md` at the run's commit (`src/protocol/state.ts`), never written by hand or by a model. His instruction (`krish_instruction`) is kept by id only; the client drops his words, because this repository and its Actions logs are public. Only paid research can act on it, and the daily run never starts paid research, so the daily run puts it first and acks it `received`, then `blocked` with a line that says when research will reach it: the next scheduled run, when that comes more than 12 hours before the instruction lapses, or else the date it lapses and the press that starts a run by hand (Run workflow on AEO weekly in GitHub Actions). Control Center carries an instruction for 7 days and the research runs fortnightly, so one given in an off week lapses before the next scheduled run unless Krish starts a run by hand. A research run with it open acks `started` (or `blocked` if the research failed, with the same when) and never `done`, which is his to say. The acks go once; later daily runs only say it is still open. An instruction never authorises a send, post or spend, and never starts paid research. Each daily wake's `run_id` ends in the workflow run and attempt, so a second wake the same day is not refused as a conflict.
- **`queries_cited_first`** counts the probed questions, across ventures and prospects, where at least one assistant gave one of our domains as its first citation (a venture's own domains; Mindmake's and Krish's for a prospect). Aspirations are other companies' sites and never count. It is measured only on a full run where every counted subject reported; otherwise it is `null` with a reason, never zero.
- A 409 on a report is read back and never retried; the attempt fails with `report_conflict`. A second full research run on the same UTC day therefore conflicts with the first, by design.

Locally, against a stand-in: `npm test` runs the whole loop against an in-process server (`tests/standin.ts`) in `synthetic` mode. `npm run protocol -- directive --mode synthetic` needs `CONTROL_CENTER_URL` and `CONTROL_CENTER_ENGINE_TOKEN`; a missing one is named and the exit is 2.

Costs: every paid call is charged against an estimate before it is made (`src/lib/cost.ts`); the run stops probing at the cap (`AEO_MAX_USD_PER_RUN`, default 25) and counts what it skipped. The dry run prints the ledger.

## The packet

`docs/packet.schema.json` is AeoPacket v1, the JSON this engine POSTs to `POST /api/aeo/ingest`. `src/schema/packet.ts` mirrors it in TypeScript with a hand-written validator that refuses any string carrying an email address, an @handle or an em dash. `docs/PACKET.md` explains every field and what it is for. Control Center holds an identical copy of the schema; change it here first and say why.

## Secrets, by name

Set as repository secrets (never in a file):

| Name | One line |
|---|---|
| `CONTROL_CENTER_URL` | Base URL of Control Center, for the context read, the ingest and the command patch. |
| `AEO_ENGINE_SECRET` | Bearer token Control Center expects on every packet call; also the key material that seals the per-job summaries. |
| `CONTROL_CENTER_ENGINE_TOKEN` | This engine's own growth engine protocol bearer (`gen1_`), for attempts, the directive, reports and decisions only. |
| `FIREFLIES_API_KEY` | Fireflies GraphQL. Absent means `themes_status: fireflies_unavailable`, never "no calls". |
| `ANTHROPIC_API_KEY` | The Claude engine for probes and the writer behind classification, proposal and the digest. |
| `OPENAI_API_KEY` | The ChatGPT engine (Responses API with web search). |
| `PERPLEXITY_API_KEY` | The Perplexity engine (sonar). |
| `XAI_API_KEY` | Optional. When set, Grok joins the engine list. |
| `EXA_API_KEY` | Reserved for a search fallback; not read yet. |

Repository variables: `AEO_MAX_USD_PER_RUN`, the spend ceiling on estimates per run; `CONTROL_CENTER_URL`, the same base URL, which the protocol steps read.

## Layout

```
src/index.ts          the CLI
src/config/run.ts     engines, caps, model ids, the price table
src/schema/           packet types and validator; the context shape
src/clients/          Control Center (packets and the growth engine protocol), Fireflies, one client per engine, the offline twins
src/pipeline/         the nine stages (00 context to 70 ship, with 65 voice) and run.ts
src/protocol/         the protocol loop: measurement, the two reports, the engine's state, the loop, its CLI
src/lib/              cost ledger, usage meter, domains, text cleaning, week, logs, canonical JSON and the seal for per-job summaries
scripts/check-config.mts   CI guard: engines known, caps positive, no em dash in src or docs, no paid key on the directive path, no packet uploaded by the research workflow
tests/                one test per stage, the packet, the CLI, the clients, the fixtures
docs/                 the contract, PACKET, STATE, GET-GOING (the build checklist), BUILD-LOG, NEVER-PUBLISH, NORTH_STAR, HARNESS_CONTEXT, the Control Center brief and protocol copy, history
```
