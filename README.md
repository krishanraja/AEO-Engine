# AEO-Engine

The fortnightly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. Every other Sunday it asks the AI assistants (Perplexity, ChatGPT, Claude, and Grok when a key exists) the questions those buyers ask, records who gets cited and whether we do, reads the week's calls for what buyers actually said, scores the demand behind each question, and ships one packet per subject to Control Center, which turns the recommendations into content ideas and the probes into the Growth tab's evidence. It keeps no list of its own: every subject, domain and competitor comes from Control Center, so adding a company there is the whole onboarding.

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

`.github/workflows/aeo-weekly.yml` runs Sunday 04:00 UTC on odd ISO weeks only (fortnightly since 2026-10-15; the file keeps its name so Control Center's links hold), on a manual dispatch (subject, dry; a dry run on Actions prints counts only and keeps no file, because this repository's artifacts are public, so read a whole packet with `--dry --out` locally), and on `repository_dispatch` type `aeo-run` from Control Center's Run-now button (`client_payload.command_id`, `client_payload.subject`). Three attempts fifteen minutes apart; the third failure is preserved so GitHub notifies. `week_start` is the Monday that owns the run in UTC, so the Sunday run reports the week that began the previous Monday.

Locally:

```
npm install
npm run run -- --subject all --dry --out out/packets.json     # live reads, no POST
npm run run -- --offline --dry --subject ctrl                  # fixtures only, no network
npm run run -- --subject <slug|uuid|all> [--week YYYY-MM-DD] [--command-id n] [--cap-usd n]
npm test && npm run typecheck && npm run check:config
```

The pipeline per subject (`src/pipeline/`): `00-context` reads Control Center; `10-transcripts` lists the last seven days of Fireflies calls, attributes each to one subject with one model call, and writes five to ten themes with paraphrase-only evidence; `20-gap` tallies who is cited where we are absent; `30-propose` writes 20 to 40 questions and carries last week's ids; `40-probe` asks every engine, up to the per-subject cap and the USD cap; `50-score` scores demand out of 100 from three measured proxies; `60-digest` writes the recommendations, watch list and (per kind) the approach hook or the playbook, with a deterministic fallback; `70-ship` validates and POSTs. Every client has an offline twin that reads `tests/fixtures`, so the same pipeline runs with no network. A prospect's questions are what that company's leaders would ask an assistant about their own problem; the read is whether Mindmake or Krish appears in the answer they would see.

## Reporting to Control Center (growth engine protocol)

Beside the packet ingest, which does not change, the engine reports through Control Center's growth engine protocol (`docs/control-center/ENGINE-PROTOCOL.md`) as `aeo-engine`, path slug `aeo`, product `mindmake`. The client is `src/clients/growthEngine.ts` (HTTPS only, no redirects, twenty seconds a call, the bearer in one header and never logged); the reports are built in `src/protocol/reports.ts`, sealed with a SHA-256 digest of their canonical JSON (`src/lib/canonical.ts`), and driven by `src/protocol/loop.ts` through `npm run protocol`.

- **The daily wake-up** (`.github/workflows/cc-growth-directive.yml`, on Control Center's `cc-growth-directive` dispatch around 05:10 UTC, or by hand): a started attempt, the directive, then a report that says when the last full research run reported and when the next scheduled one is, with `queries_cited_first` read back from that research run's own protocol report (free GETs, newest day first, back fifteen days). Then the readback, his decisions and the terminal attempt. This workflow holds no paid API key and never calls the research CLI, and `check:config` fails if it ever does: a directive cannot start paid research.
- **The research run** (`aeo-weekly.yml`, schedule or Run now, not a dry run): the plan job journals the started attempt and reads the directive before it reads the subject list; each research job leaves a counts-only summary, sealed to the workflow run (`src/lib/seal.ts`) because this repository's artifacts are public; the report job sends one report for the whole run, reads it back, reads his decisions and closes the attempt. The report carries `queries_cited_first`, one plain line per subject (ventures by name, prospects and aspirations by number only), and a `wall: spend` proposal only when the cap stopped probes.
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
src/pipeline/         the eight stages and run.ts
src/protocol/         the protocol loop: measurement, the two reports, the loop, its CLI
src/lib/              cost ledger, domains, text cleaning, week, logs
scripts/check-config.mts   CI guard: engines known, caps positive, no em dash in src or docs, no paid key on the directive path
tests/                one test per stage, the packet, the CLI, the clients, the fixtures
docs/                 the contract, STATE, BUILD-LOG, NEVER-PUBLISH, history
```
