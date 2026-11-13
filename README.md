# AEO-Engine

The fortnightly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. Every other Sunday it asks the AI assistants (Perplexity, ChatGPT, Claude, and Grok when a key exists) the questions those buyers ask, records who gets cited and whether we do, scores the demand behind each question, and ships one packet per subject to Control Center, which turns the recommendations into content ideas and the probes into the Growth tab's evidence. It keeps no list of its own: every subject, domain and competitor comes from Control Center, so adding a company there is the whole onboarding.

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

The pipeline per subject (`src/pipeline/`): `00-context` reads Control Center and applies Krish's ruled domain corrections (`config/own-domains.json`); `10-transcripts` lists the last fourteen days of Fireflies calls, attributes each to one subject with one model call, and writes five to ten themes with paraphrase-only evidence (Fireflies is a retired route since 2026-11-13: the research workflow passes no key, so this stage reads no calls and every packet says `fireflies_unavailable`); `20-gap` tallies who is cited where we are absent; `30-propose` asks for 25 to 40 questions and carries last week's ids, with a venture engine's requested questions first; `40-probe` asks every engine, requested questions first, up to the per-subject limit (25 since 2026-11-13, raised to hold every requested question plus five, never above 30) and the USD cap, and measures each answer's first citation before the packet's cleaning; `50-score` scores demand out of 100 from three measured proxies; `60-digest` writes the recommendations, watch list and (per kind) the approach hook or the playbook, with a deterministic fallback; `65-voice` rewords those drafted lines in Krish's approved voice rules, only when the directive carries at least one, and never decides or scores anything; `70-ship` validates and POSTs. Every client has an offline twin that reads `tests/fixtures`, so the same pipeline runs with no network. A prospect's questions are what that company's leaders would ask an assistant about their own problem; the read is whether Mindmake or Krish appears in the answer they would see.

## Reporting to Control Center (growth engine protocol)

Beside the packet ingest, which does not change, the engine reports through Control Center's growth engine protocol as `aeo-engine`, path slug `aeo`, product `mindmake`. The protocol is [Control Center's ENGINE-PROTOCOL.md](https://github.com/krishanraja/control-center/blob/main/docs/app/growth/ENGINE-PROTOCOL.md), which is authoritative; `docs/control-center/ENGINE-PROTOCOL.md` is a copy of it, taken whole on 2026-11-12, that lags it from its next change. This engine sends protocol 1.0.0 reports, 1.20.0 reports when the directive serves the engine's state, and 1.22.0 research reports when they say which venture requests they asked, and accepts any 1.x directive. Its report validator also takes 1.1.0, a proposal's `stage` (plan, go-live, check-in) and `parent_proposal_id`, ready for the autonomy loop, and its decisions are read loosely with 1.1.0's stage and Krish's amended version and 1.6.0's `carried_out` and `reason_code` (`parseDecision` in `src/schema/report.ts`); nothing proposes a stage yet. Since 2026-11-12 it is the one AI-answers specialist every venture's growth engine calls (Ruling, Krish, 2026-11-12; registry `role: specialist`), not Mindmake's engine; Control Center shows it once, under OS, and each venture's own AI-answer standing on that venture's engine tile. The client is `src/clients/growthEngine.ts` (HTTPS only, no redirects, twenty seconds a call, the bearer in one header and never logged); the reports are built in `src/protocol/reports.ts`, sealed with a SHA-256 digest of their canonical JSON (`src/lib/canonical.ts`), and driven by `src/protocol/loop.ts` through `npm run protocol`.

- **The daily wake-up** (`.github/workflows/cc-growth-directive.yml`, on Control Center's `cc-growth-directive` dispatch around 05:10 UTC, or by hand): a started attempt, the directive, then a report that says when the last full research run reported and when the next scheduled one is, with `queries_cited_first` read back from that research run's own protocol report (free GETs, newest day first, back fifteen days). On a research Sunday the wake comes after the 04:00 slot but before GitHub starts the run, so until that run has reported, the run to come is today's. Then the readback, his decisions and the terminal attempt. This workflow holds no paid API key and never calls the research CLI, and `check:config` fails if it ever does: a directive cannot start paid research.
- **The research run** (`aeo-weekly.yml`, the schedule or a run started by hand, not a dry run): the plan job journals the started attempt and reads the directive before it reads the subject list; each research job reads the directive again, read-only and never fatal, only for Krish's approved voice rules (`taste`, protocol 1.5.0) that the `65-voice` pass applies, and leaves a counts-only summary, sealed to the workflow run (`src/lib/seal.ts`) because this repository's artifacts are public; the report job sends one report for the whole run, reads it back, reads his decisions and closes the attempt. The report carries `queries_cited_first`, one plain line per subject (ventures by name, prospects and aspirations by number only), and a `wall: spend` proposal only when the cap stopped probes.
- **Krish's instruction and the engine's state** (protocol 1.20.0, only when the directive says `features.engine_state`): both runs add the engine's priorities, Krish's quoted aims (obsessions) and next steps, read from this repository's own `docs/NORTH_STAR.md`, `NOW.md`, `AGENTS.md` and `docs/GET-GOING.md` at the run's commit (`src/protocol/state.ts`), never written by hand or by a model. His instruction (`krish_instruction`) is kept by id only; the client drops his words, because this repository and its Actions logs are public. Only paid research can act on it, and the daily run never starts paid research, so the daily run puts it first and acks it `received`, then `blocked` with a line that says when research will reach it: the next scheduled run, when that comes more than 12 hours before the instruction lapses, or else the date it lapses and the press that starts a run by hand (Run workflow on AEO weekly in GitHub Actions). Control Center carries an instruction for 7 days and the research runs fortnightly, so one given in an off week lapses before the next scheduled run unless Krish starts a run by hand. A research run with it open acks `started` (or `blocked` if the research failed, with the same when) and never `done`, which is his to say. The acks go once; later daily runs only say it is still open. An instruction never authorises a send, post or spend, and never starts paid research. Each daily wake's `run_id` ends in the workflow run and attempt, so a second wake the same day is not refused as a conflict.
- **Venture requests** (protocol 1.22.0, only when the directive says `features.answer_requests`): a venture's growth engine asks Control Center for its own product's AI-answer work (`POST answers`, its buyer questions), and this engine's directive carries the open requests (`answer_requests`, read loosely by `parseAnswerRequests` in `src/schema/report.ts`). Each research job reads them with the directive (`readAnswerRequests` in `src/index.ts`, never fatal), and a venture subject asks its own product's questions word for word, first, as seeds (`requestsFor`, stage 30), so neither the model nor the question caps drop one. The USD cap still can: a subject's share is an even split of the run's cap. A request is served when every one of its questions was put to at least one assistant (`servedBy`); its id goes into the sealed summary, and the research report carries `answers_served` at 1.22.0 with one line naming the products, never a question. A request not asked in full stays open for a later run, and the report says so by product and count, with an `answer_request_not_served` hold. Control Center marks each served. The packet takes each venture's product (`heartside`, `legibility` and `publication` beside the five before); Control Center makes a product's subject from its engine's first request.
- **`queries_cited_first`** counts the probed questions, across ventures and prospects, where at least one assistant gave one of our domains as its first citation (a venture's own domains; Mindmake's and Krish's for a prospect; with Krish's ruled corrections from `config/own-domains.json`). Since 2026-11-13 the first citation is the first source the answer cites in its text (`docs/PACKET.md`, "What a probe's citations and we_cited mean"), read before the packet's cleaning, and ChatGPT is required to search; a research report whose week begins before 7 December 2026 says so in one line. Aspirations are other companies' sites and never count. It is measured only on a full run where every counted subject reported; otherwise it is `null` with a reason, never zero. The research report also says, per subject, on how many questions we were cited anywhere, and per assistant, on how many asks it searched (counts only). The North Star share Krish reads is not this count: Control Center computes it from the packets' probes against its own lists, so the two agree only when its reader applies the same rules (`docs/CONTROL-CENTER-BRIEF.md`, "The first citation: what Control Center's reader must match").
- A 409 on a report is read back and never retried; the attempt fails with `report_conflict`. A second full research run on the same UTC day therefore conflicts with the first, by design.

Locally, against a stand-in: `npm test` runs the whole loop against an in-process server (`tests/standin.ts`) in `synthetic` mode. `npm run protocol -- directive --mode synthetic` needs `CONTROL_CENTER_URL` and `CONTROL_CENTER_ENGINE_TOKEN`; a missing one is named and the exit is 2.

## The engines and the Claude lane

Perplexity (sonar), ChatGPT (`gpt-5`, Responses API with web search) and Claude are always asked; Grok joins with `XAI_API_KEY`, and Gemini (`gemini-3.6-flash` with Google Search grounding) with `GEMINI_API_KEY`. Gemini is gated: `gemini` is not in the packet's engine enum, which is joint with Control Center and closed, so its answers are counted only in the sealed summary, beside the packets and never toward `queries_cited_first`, until Control Center's context lists `packet_features: ["engine_gemini"]` (`docs/PACKET.md`, "Gemini, the gated engine").

Claude probes run on the Claude Code subscription (Ruling, Krish, 2026-11-13), with the paid API as a switch. `AEO_CLAUDE_LANE`, a repository variable read when a run starts, says which:

| Value | What the Claude probes do |
|---|---|
| `code` | One fresh headless Claude Code session per question (`src/clients/claudeCode.ts`): a neutral system prompt that names no venture, WebSearch the only tool, no MCP server, an empty working directory and HOME, and a child environment built from an allowlist that never carries an API key. Its first event is checked and the probe fails closed on any other tool, any API key source but `none` (the value a subscription token alone reports; a missing one is refused too) or a connected MCP server. The default from the research week of 23 November. |
| `api` | The Messages API with its hosted web search, at most two searches a probe (`src/clients/anthropic.ts`). |
| `compare` | The code lane for every question, and the API lane beside it on each subject's first five questions; the two are tallied in the sealed summary (search share, inline citations, first-host agreement, the overlap of the hosts their searches returned) and the API answers never enter a packet. The default for the run of 22 November (a week starting on or before 16 November), so the lanes are read against each other before the API is switched off. |
| `code_then_api` | The code lane, and the API only for a probe the subscription's limit stopped. |

Empty or unknown means the dated default. Without `CLAUDE_CODE_OAUTH_TOKEN` every lane falls back to `api`, with one log line, so a missing secret never zeroes Claude. The CLI is installed pinned in the research job (`@anthropic-ai/claude-code@2.1.323`); a new version changes the measurement and is bumped with the tests.

Costs, in words: every paid call is charged against an estimate before it is made (`src/lib/cost.ts`); the run stops probing at the cap (`AEO_MAX_USD_PER_RUN`, default 25) and counts what it skipped, and AEO stays inside its cap of 25 dollars a fortnight. A Claude Code probe costs no API dollar: the ledger counts it at a price of zero and never stops it at the cap, and its tokens are counted against the subscription in the log and the sealed summary, never posted to the usage meter as an API row. A subscription limit (a rate limit status of `rejected`, or paid overage in use) stops that lane's probes (counted, and handed to the API only in `code_then_api`); past a warning threshold the subscription still serves, so those probes finish and are only counted. Gemini stays in its free tier: a research job stops asking it before 150 grounding queries, a retry asks it nothing, and a skipped Gemini ask is never charged. `compare` pays the API for five questions a subject. The dry run prints the ledger.

## The packet

`docs/packet.schema.json` is AeoPacket v1, the JSON this engine POSTs to `POST /api/aeo/ingest`. `src/schema/packet.ts` mirrors it in TypeScript with a hand-written validator that refuses any string carrying an email address, an @handle or an em dash. `docs/PACKET.md` explains every field and what it is for. Control Center holds an identical copy of the schema; change it here first and say why.

## Secrets, by name

Set as repository secrets (never in a file):

| Name | One line |
|---|---|
| `CONTROL_CENTER_URL` | Base URL of Control Center, for the context read, the ingest and the command patch. |
| `AEO_ENGINE_SECRET` | Bearer token Control Center expects on every packet call; also the key material that seals the per-job summaries. |
| `CONTROL_CENTER_ENGINE_TOKEN` | This engine's own growth engine protocol bearer (`gen1_`), for attempts, the directive, reports and decisions only. |
| `FIREFLIES_API_KEY` | Retired route (2026-11-13): the research workflow no longer passes it, so packets say `themes_status: fireflies_unavailable`. The code still reads it on a local run where it is set. |
| `ANTHROPIC_API_KEY` | The writer behind classification, proposal and the digest, and the Claude API lane (web search, at most two searches a probe) when `AEO_CLAUDE_LANE` asks for it or the subscription token is missing. Never given to the Claude Code child. |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Claude Code subscription token (`claude setup-token`). Used by the docs steward since October and, since 2026-11-13, by the research job's Claude probes. Never named by the daily directive workflow. |
| `OPENAI_API_KEY` | The ChatGPT engine (Responses API with web search, which every probe is required to use). |
| `PERPLEXITY_API_KEY` | The Perplexity engine (sonar). |
| `XAI_API_KEY` | Optional. When set, Grok joins the engine list. |
| `GEMINI_API_KEY` | Optional, new on 2026-11-13. When set, Gemini is asked inside its free tier, gated out of the packet (above). Sent in a header, never in a URL. |
| `EXA_API_KEY` | Reserved for a search fallback; not read yet. |

Repository variables: `AEO_MAX_USD_PER_RUN`, the spend ceiling on estimates per run; `CONTROL_CENTER_URL`, the same base URL, which the protocol steps read; `AEO_CLAUDE_LANE`, the Claude lane (above), empty for the dated default.

## Layout

```
src/index.ts          the CLI
src/config/run.ts     engines, caps, model ids, the price table
src/config/ownDomains.ts   Krish's ruled domain corrections, read from config/own-domains.json
src/schema/           packet types and validator; the context shape
src/clients/          Control Center (packets and the growth engine protocol), Fireflies, one client per engine, the offline twins
src/pipeline/         the nine stages (00 context to 70 ship, with 65 voice) and run.ts
src/protocol/         the protocol loop: measurement, the two reports, the engine's state, the loop, its CLI
src/lib/              cost ledger, usage meter, domains, text cleaning, week, logs, canonical JSON and the seal for per-job summaries
scripts/check-config.mts   CI guard: engines known, caps positive, subscription kinds at 0, Gemini inside its free tier, childEnv an allowlist, config/own-domains.json valid, no em dash in src, docs or config, no permission-skipping flag or search key in src or the workflows, no paid key or token on the directive path, no packet uploaded, the CLI pinned and run on the Node it needs, and only a job's first attempt asking Gemini in the research workflow
config/own-domains.json    which domains are Krish's and which are not, over Control Center's lists
tests/                one test per stage, the packet, the CLI, the clients, the fixtures
docs/                 the contract, PACKET, STATE, GET-GOING (the build checklist), BUILD-LOG, NEVER-PUBLISH, NORTH_STAR, HARNESS_CONTEXT, the Control Center brief and protocol copy, history
```
