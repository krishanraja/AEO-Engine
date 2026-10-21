---
repo: krishanraja/AEO-Engine
product: AEO-Engine
as_of: 2026-10-21
head: 96b81af
lifecycle: building
production_url: none
state_doc: docs/STATE.md
history_log: docs/history/LOG.md
truth_files: [docs/packet.schema.json]
authority_order: [docs/packet.schema.json, docs/PACKET.md, docs/STATE.md, README.md, docs/BUILD-LOG.md]
steward: https://github.com/krishanraja/ai-harness/blob/main/docs/steward/RUNBOOK.md
never_publish: [any credential or secret name beyond the README table, any call participant name or email, any transcript text or theme paraphrase, any prospect company name or room target, any engine answer snapshot, any cost ledger figure]
---
# AEO-Engine: where it is right now

## What it is

AEO-Engine is the fortnightly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. A Node and TypeScript pipeline on GitHub Actions, it asks the AI assistants the questions those buyers ask, records who is cited and whether we are, reads the week's calls for what buyers said, scores the demand behind each question, and POSTs one packet per subject to Control Center (`docs/packet.schema.json`), which turns the recommendations into content ideas. It holds no subject list of its own; Control Center's registry is the input.

## Who it is for and why it matters for Mindmake

Krish reads the digest on Monday and acts the same week. The packet answers, per venture, "which buyer question are we invisible on, and who is cited instead"; per prospect, "what would this company's leaders see if they asked an assistant about their own problem, and is Mindmake in it"; per aspiration, "which of their pages get cited, and why". For the room_face buyer (a senior leader at a PE or VC backed media, adtech, publishing or data business, quietly behind on what is coming) the machine is proof that one person can run demand research on AI agents with the evidence left in: every number in a digest is measured that run, every unknown stays unknown, and a failed engine call writes nothing rather than a guess. Angles a writer can use: the OS reads its own calls and refuses to name anyone in them; the demand score says out loud that there is no prompt-volume corpus and scores from proxies; the run has a price cap it counts against, not a bill it discovers.

## Where it is right now (as of 2026-10-21)

- **Building.** The pipeline, the four engine clients, the Control Center and Fireflies clients, the validator, the cost ledger, the usage meter and the research workflow (fortnightly since 2026-10-15) are written and typecheck. `npm test` runs the whole pipeline against fixtures with no network and compares the venture packet field by field to `tests/fixtures/expected/packet.ctrl.json`, now pinned to a fixed week so the comparison does not expire every Monday.
- **Not proven live.** No run has hit a real engine, Fireflies or Control Center yet. The model ids, the web search tool types, the price table and the new usage meter are the first things to check from the first live ledger (`docs/STATE.md`).
- **Contract.** `docs/packet.schema.json` is identical to Control Center's copy; the validator here also carries the rules Control Center enforces beyond the schema (a venture names its product slug, a Monday `week_start`, empty themes unless the status is ok, unique query ids).
- **Aim.** `docs/NORTH_STAR.md` (Krish, 2026-10-18): by January 2027, Mindmake and its products are cited first on the buyer questions the ventures answer, and the engine can show the week each one was won. Not reached; nothing is live yet.
- **Growth engine protocol.** Control Center registered this engine as `aeo-engine` on 2026-10-18 (`docs/CONTROL-CENTER-BRIEF.md`). Since 2026-10-19 the engine runs the loop: a daily `cc-growth-directive` workflow with no paid key, and one report at the end of each research run. `docs/GET-GOING.md` records that the first live daily run on 2026-10-19 succeeded (attempt journaled, directive read, report sent and read back), and that day's report was `degraded` with no proposals; STATE.md still says no live report has been sent (see Do not trust). The packet ingest is unchanged.
- **Autonomy.** Ruled 2026-10-19: the engine proposes a plan, Krish approves, it builds up to go-live and asks him to review, then goes live itself only on his approved go-live decision. Protocol 1.2.0 (which includes the 1.1.0 stages) is copied into `docs/control-center/`; the loop is not built yet (`docs/GET-GOING.md`, Step 1).
- **Get going.** Saying "Get going" in this repository runs the next unticked step of `docs/GET-GOING.md`. No step is ticked yet.
- **Waiting.** Repository secrets and the `AEO_MAX_USD_PER_RUN` variable; the `CLAUDE_CODE_OAUTH_TOKEN` secret for the docs steward.

## What changed recently

- 2026-10-21 **Control Center's protocol moves to 1.2.0, and Krish's list takes one ask per engine at a time.** Why: Ruling (Krish, 2026-10-21): "his list shows one ask per growth engine at a time, a go-live first, then a check-in, then a plan." So this engine adds no second ask of a kind that already waits, and a proposal about a person, stage or room Control Center already holds (`subject_ref`) gives way to its copy. The copy is additive and adds a "Versions" rule: accept any 1.x back and send the version you speak, because on 2026-10-19 Legibility and Mindmake required exactly 1.0.0 and "stopped for two days" (the commit says this engine already accepted newer versions). Only the protocol copy and its two schemas changed (#21); no engine code. `docs/control-center/ENGINE-PROTOCOL.md`.
- 2026-10-19 **The engine is told to run autonomously, and its build plan moves into the repository.** Why: Krish ruled "the engine shows me what it is going to do, I approve, it gets up to go-live and asks me to review", and that autonomy is "given where it is deserved", so the engine checks in at least weekly and he has a low tolerance for poor creative output. Protocol 1.1.0 adds a proposal's stage (plan, go_live, check_in) and his amended version. Ruling (Krish, 2026-10-19): he opens the repository and says "Get going"; no pasted prompts. `docs/GET-GOING.md` holds the build as a checklist, written from the first live report, which was `degraded` because `queries_cited_first` had no research run to measure it and the objective has no target. A dry run on GitHub also stopped keeping a packet, because artifacts on a public repository are downloadable (#18). `AGENTS.md`, `docs/GET-GOING.md`, `docs/control-center/ENGINE-PROTOCOL.md`.
- 2026-10-19 **The engine reports through the growth engine protocol, and a directive cannot start a paid run.** Why: Krish asked every engine to adopt its brief now. The daily `cc-growth-directive` wake-up runs its own workflow, which holds no paid key: it says when the research last ran and next runs and reads `queries_cited_first` back from the last research report, or reports it unknown with a reason. Each research run ends in one report for the whole run, built from per-job counts sealed to the workflow run because this repository's artifacts are public. Tested against a local stand-in only. `README.md`, `docs/BUILD-LOG.md`.
- 2026-10-18 **Control Center asks every growth engine to run one protocol loop, and this engine now has an aim.** Why: Krish ruled that all engines report through one protocol (ADR-038 in Control Center) so Growth > Engines can show them side by side. The brief (PR #15) says the packet ingest "stays exactly as it is" and adds a started attempt, a directive pull, one report per run with `queries_cited_first` (no target yet) and a terminal attempt, with unknown as `value: null` and never zero. The same day Krish set the North Star (PR #14): cited first by January 2027, with the week each was won on show. Nothing of the client is built yet. `docs/CONTROL-CENTER-BRIEF.md`, `docs/NORTH_STAR.md`.
- 2026-10-15 **The research runs fortnightly, not weekly.** Why: the run cost $9.08 on 4 October and $9.87 on 11 October (Control Center's `meter_daily`, `aeo-probe`), about a fifth of the fleet's model spend that week. Ruling (Krish, 2026-10-15): "happy with the fortnightly AI visiblity check". The Sunday schedule now runs on odd ISO weeks only (the next run is week 43, 25 October); a dispatch from Control Center or the Actions button still runs at once. A digest's "since last run" now compares with the run two weeks before.
- 2026-09-21 **The engine can say what it actually spent.** Why: `lib/cost.ts` charges an estimate against the cap before every call so a map growing to 200 questions cannot quietly become a 200-call invoice, but its own comment says those numbers are estimates, so it was the only cost figure the engine could produce. The new `UsageMeter` reads the `usage` object off every Anthropic response and sums it by stage and model instead: a paused search turn is billed as its own request so each one is counted, not just the last; a refusal is billed for the tokens it read, so it is recorded before the throw; and the meter reports last, after a failure too, because a run that died on its third subject still paid for the first two. It posts to `POST /api/aeo/meter` and deliberately never turns tokens into dollars, that stays Control Center's `_prices.ts`, the one price table in the fleet. Only the Anthropic clients feed it for now; Perplexity, OpenAI and xAI usage stays unreported rather than priced in the wrong currency. `docs/STATE.md`.
- 2026-09-21 **A Claude probe gets four minutes instead of two, because a search turn is not a model turn.** Why: the 2026-09-20 re-run lost six probes on circle and seven on ctrl, every one a `timeout after 120000ms`, not an auth failure or the spend cap. The web search tool allows up to five searches in one turn, and two minutes suits a model answering from context, not one running five searches first. The four-minute deadline is on the probe path only; the JSON writer keeps its 120s default on purpose, since a slow call there is a fault rather than a search. Ruling (Krish, 2026-09-20): raise the claude probe timeout.
- 2026-09-21 **The offline suite's golden packet stopped going red on its own.** Why: `week_start` is `mondayOf(now)`, so the fixture comparison had been failing on that one field since 2026-09-14 with nothing else regressed, unnoticed because CI had not run on this repo since 2026-09-08. The comparison now takes `--week` so it pins the fixture's week and still covers the whole packet, with no shelf life.

## What is next and what is waiting on Krish

- Next: the first live dry run (`--dry --out`) against Control Center's context to read a real packet, then tune the price table from the ledger it prints, then the first Sunday run.
- Waiting on Krish: the eight secrets and the spend variable on the repository; confirming the OpenAI model name for the Responses API web search before the first live run (`src/config/run.ts`).

## Read next

1. `docs/packet.schema.json`: the contract. Everything the engine produces validates against it.
2. `docs/PACKET.md`: the contract in plain English, field by field, and the week timing.
3. `docs/STATE.md`: what is live, what is built but not proven, what is waiting.
4. `README.md`: how it runs, the stages, the secrets by name.
5. `docs/BUILD-LOG.md`: the why, the failure and the mechanism behind each change.
6. `docs/NEVER-PUBLISH.md`: what a writer may not take from this repo.
7. `docs/NORTH_STAR.md`: the aim Krish set; only he changes it.
8. `docs/CONTROL-CENTER-BRIEF.md` and `docs/control-center/ENGINE-PROTOCOL.md`: the growth engine protocol this engine is asked to report through.

## Do not trust

- Whether anything is live. `docs/GET-GOING.md` (2026-10-19) says the first live daily report succeeded; `docs/STATE.md` (same day) says nothing is live and no live report has been sent. The code cannot settle it, and neither can the steward. Waiting on Krish to confirm which STATE.md section the daily directive run belongs in.
- `docs/CONTROL-CENTER-BRIEF.md` status line still says tested against a stand-in only; `docs/GET-GOING.md` Step 0 is the pending correction.
