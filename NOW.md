---
repo: krishanraja/AEO-Engine
product: AEO-Engine
as_of: 2026-09-09
head: 4f824108
lifecycle: building
production_url: none
state_doc: docs/STATE.md
history_log: docs/history/LOG.md
truth_files: [docs/packet.schema.json]
authority_order: [docs/packet.schema.json, docs/PACKET.md, docs/STATE.md, README.md, docs/BUILD-LOG.md]
steward: https://github.com/krishanraja/control-center/blob/main/docs/steward/RUNBOOK.md
never_publish: [any credential or secret name beyond the README table, any call participant name or email, any transcript text or theme paraphrase, any prospect company name or room target, any engine answer snapshot, any cost ledger figure]
---
# AEO-Engine: where it is right now

## What it is

AEO-Engine is the weekly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. A Node and TypeScript pipeline on GitHub Actions, it asks the AI assistants the questions those buyers ask, records who is cited and whether we are, reads the week's calls for what buyers said, scores the demand behind each question, and POSTs one packet per subject to Control Center (`docs/packet.schema.json`), which turns the recommendations into content ideas. It holds no subject list of its own; Control Center's registry is the input.

## Who it is for and why it matters for Mindmake

Krish reads the digest on Monday and acts the same week. The packet answers, per venture, "which buyer question are we invisible on, and who is cited instead"; per prospect, "what would this company's leaders see if they asked an assistant about their own problem, and is Mindmake in it"; per aspiration, "which of their pages get cited, and why". For the room_face buyer (a senior leader at a PE or VC backed media, adtech, publishing or data business, quietly behind on what is coming) the machine is proof that one person can run demand research on AI agents with the evidence left in: every number in a digest is measured that run, every unknown stays unknown, and a failed engine call writes nothing rather than a guess. Angles a writer can use: the OS reads its own calls and refuses to name anyone in them; the demand score says out loud that there is no prompt-volume corpus and scores from proxies; the run has a price cap it counts against, not a bill it discovers.

## Where it is right now (as of 2026-09-09)

- **Building.** The pipeline, the four engine clients, the Control Center and Fireflies clients, the validator, the cost ledger and the weekly workflow are written and typecheck. `npm test` runs the whole pipeline against fixtures with no network and compares the venture packet field by field to `tests/fixtures/expected/packet.ctrl.json`.
- **Not proven live.** No run has hit a real engine, Fireflies or Control Center yet. The model ids, the web search tool types and the price table are the first things to check from the first live ledger (`docs/STATE.md`).
- **Contract.** `docs/packet.schema.json` is identical to Control Center's copy; the validator here also carries the rules Control Center enforces beyond the schema (a venture names its product slug, a Monday `week_start`, empty themes unless the status is ok, unique query ids).
- **Waiting.** Repository secrets and the `AEO_MAX_USD_PER_RUN` variable; the `CLAUDE_CODE_OAUTH_TOKEN` secret for the docs steward.

## What changed recently

- 2026-09-08 **One job per subject, because a subject is independent of every other subject.** Why: asking one question's assistants together bought back most of an hour and it was still not enough. The next live run finished its first product in twenty-six minutes with four to go, so five products in one job is over two hours against a job killed at fifty-five minutes: every run would have landed one product and lost the other four. A subject reads its own context, asks its own questions and posts its own packet, sharing nothing but the spend ceiling, so the honest shape is a matrix. A `plan` job asks Control Center which subjects are active and divides `AEO_MAX_USD_PER_RUN` between them; `research` fans out three at a time with `fail-fast: false`, so a subject that fails fails alone. The timeout is ninety minutes rather than fifty-five because an attempt, a wait and a retry is about fifty-seven, and the old hour would have killed the retry rather than the work.
- 2026-09-08 **Absence is not opportunity, so a recommendation now has to say why he can win it.** Why: the first output was rejected for a vanilla understanding of what is on offer and for recommending topics huge businesses are going to own. The machine was recommending whatever it was absent from, and a question owned by a social network, a video platform, a national business title or a big consultancy is a wall rather than a gap. `GET /api/aeo/context` now carries the business canon, and the digest runs three questions over every query before recommending it: who owns this answer now, what does he have that those hosts structurally cannot have, and can the person asking move a decision on their own. The answer to the second is the new `why_you_can_win`; what fails goes to the new `not_worth_chasing` with the hosts that own it and one plain sentence. A null reason is carried rather than hidden, and the deterministic fallback never writes one.
- 2026-09-08 **The first live run did not fit in the hour, so the assistants now answer together.** Why: the first real dry run asked five products, twenty questions each, three assistants, one call after another, and was still going at fifty minutes against a job killed at fifty-five. Three hundred hosted web searches at several seconds each is forty minutes before a single model call, and the offline suite never caught it because a fixture answers instantly. One question's assistants now run together; the questions stay sequential so the spend cap stays exact.
- 2026-09-08 **The digest writes in a voice that was already on file.** Why: Krish asked whether the machine could learn who inspires him and what he wants to sound like, and would rather say it once than repeat it. He already had, on the Content side of Control Center: the krish-voice body in `system_config.content_voice_block`, and the ten writers he rates in `content_creators`, each with the move he rates them for. The context route now sends both and `digestSystem()` builds the prompt from them, with the voice held to register only so it can never loosen the evidence rules, and the people never named to the model.
- 2026-09-08 **The engine exists.** Why: the AEO research agent Krish described has to run unattended every Sunday and end in an action, and Control Center already holds every input (subjects, the map's buyer questions, striking-distance keywords, four weeks of probes, last week's digest). The whole repo lands in one day: the contract first, then clients with offline twins so the pipeline can be tested without spending, then the stages as pure functions with the clients injected. Decisions worth knowing: prospects are probed on their own leaders' questions and read for Mindmake's presence; query ids carry across weeks by a normalised match so trends are honest; the digest model writes prose only and every number comes from the score table; a missing Fireflies key is reported as unavailable, never as a quiet week. Mechanism and failures: `docs/BUILD-LOG.md`.

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

## Do not trust

Nothing at the moment.
