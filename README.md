# AEO-Engine

The weekly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. Every Sunday it asks the AI assistants (Perplexity, ChatGPT, Claude, and Grok when a key exists) the questions those buyers ask, records who gets cited and whether we do, reads the week's calls for what buyers actually said, scores the demand behind each question, and ships one packet per subject to Control Center, which turns the recommendations into content ideas and the probes into the Growth tab's evidence. It keeps no list of its own: every subject, domain and competitor comes from Control Center, so adding a company there is the whole onboarding.

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

`.github/workflows/aeo-weekly.yml` runs Sunday 04:00 UTC, on a manual dispatch (subject, dry), and on `repository_dispatch` type `aeo-run` from Control Center's Run-now button (`client_payload.command_id`, `client_payload.subject`). Three attempts fifteen minutes apart; the third failure is preserved so GitHub notifies. `week_start` is the Monday that owns the run in UTC, so the Sunday run reports the week that began the previous Monday.

Locally:

```
npm install
npm run run -- --subject all --dry --out out/packets.json     # live reads, no POST
npm run run -- --offline --dry --subject ctrl                  # fixtures only, no network
npm run run -- --subject <slug|uuid|all> [--week YYYY-MM-DD] [--command-id n] [--cap-usd n]
npm test && npm run typecheck && npm run check:config
```

The pipeline per subject (`src/pipeline/`): `00-context` reads Control Center; `10-transcripts` lists the last seven days of Fireflies calls, attributes each to one subject with one model call, and writes five to ten themes with paraphrase-only evidence; `20-gap` tallies who is cited where we are absent; `30-propose` writes 20 to 40 questions and carries last week's ids; `40-probe` asks every engine, up to the per-subject cap and the USD cap; `50-score` scores demand out of 100 from three measured proxies; `60-digest` writes the recommendations, watch list and (per kind) the approach hook or the playbook, with a deterministic fallback; `70-ship` validates and POSTs. Every client has an offline twin that reads `tests/fixtures`, so the same pipeline runs with no network. A prospect's questions are what that company's leaders would ask an assistant about their own problem; the read is whether Mindmake or Krish appears in the answer they would see.

Costs: every paid call is charged against an estimate before it is made (`src/lib/cost.ts`); the run stops probing at the cap (`AEO_MAX_USD_PER_RUN`, default 25) and counts what it skipped. The dry run prints the ledger.

## The packet

`docs/packet.schema.json` is AeoPacket v1, the JSON this engine POSTs to `POST /api/aeo/ingest`. `src/schema/packet.ts` mirrors it in TypeScript with a hand-written validator that refuses any string carrying an email address, an @handle or an em dash. `docs/PACKET.md` explains every field and what it is for. Control Center holds an identical copy of the schema; change it here first and say why.

## Secrets, by name

Set as repository secrets (never in a file):

| Name | One line |
|---|---|
| `CONTROL_CENTER_URL` | Base URL of Control Center, for the context read, the ingest and the command patch. |
| `AEO_ENGINE_SECRET` | Bearer token Control Center expects on every engine call. |
| `FIREFLIES_API_KEY` | Fireflies GraphQL. Absent means `themes_status: fireflies_unavailable`, never "no calls". |
| `ANTHROPIC_API_KEY` | The Claude engine for probes and the writer behind classification, proposal and the digest. |
| `OPENAI_API_KEY` | The ChatGPT engine (Responses API with web search). |
| `PERPLEXITY_API_KEY` | The Perplexity engine (sonar). |
| `XAI_API_KEY` | Optional. When set, Grok joins the engine list. |
| `EXA_API_KEY` | Reserved for a search fallback; not read yet. |

Repository variable: `AEO_MAX_USD_PER_RUN`, the spend ceiling on estimates per run.

## Layout

```
src/index.ts          the CLI
src/config/run.ts     engines, caps, model ids, the price table
src/schema/           packet types and validator; the context shape
src/clients/          Control Center, Fireflies, one client per engine, the offline twins
src/pipeline/         the eight stages and run.ts
src/lib/              cost ledger, domains, text cleaning, week, logs
scripts/check-config.mts   CI guard: engines known, caps positive, no em dash in src or docs
tests/                one test per stage, the packet, the CLI, the clients, the fixtures
docs/                 the contract, STATE, BUILD-LOG, NEVER-PUBLISH, history
```
