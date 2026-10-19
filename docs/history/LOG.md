# History log

Newest first. Entries are written by the docs steward (see the steward link in
`NOW.md`) and by people doing the same job by hand. Nothing in this file
describes current behaviour; `NOW.md` and `docs/STATE.md` do. Files moved here
keep their body verbatim under a Historical banner.

## 2026-10-19

- reconciled at `6c7aafe`: four commits since the last pass, the growth engine protocol client and workflows, the dry-run artifact removal, the autonomy ruling with protocol 1.1.0, and `docs/GET-GOING.md`. `NOW.md` gains the autonomy and Get going lines and names a conflict between `docs/GET-GOING.md` and `docs/STATE.md` on whether anything is live; `docs/STATE.md` was edited the same day by its owner and is left as written.

## 2026-10-18

- reconciled at `bd7dfef`: seven commits since the last pass, the North Star, the Control Center growth engine brief and protocol copy, canon syncs and the repository-administration files. `docs/STATE.md` re-stamped after `npm test` (74 of 74), `npm run typecheck` and `npm run check:config` passed, and now lists the unwritten protocol client under Waiting. `AGENTS.md`, `CLAUDE.md` and `docs/HARNESS_CONTEXT.md` left alone, they belong to other writers.

## 2026-10-16

- reconciled at `da6e04f`: two canon block syncs in `AGENTS.md` (v2026.10.06.3 and v2026.10.15.2), no documentation consequence; `head` and `as_of` advanced only. `docs/STATE.md` keeps its 2026-09-21 stamp because its test claim was not re-run in this pass.

## 2026-10-15

- reconciled at `7ff2dc9`: four commits since the last pass, the fortnightly schedule (`.github/workflows/aeo-weekly.yml`), its wording in `README.md`, `NOW.md` and `docs/STATE.md`, and the docs steward workflow now calling `krishanraja/ai-harness`. The prose was already updated with the code and was checked against the workflow diff; `head` and `as_of` advanced. `docs/STATE.md` keeps its 2026-09-21 stamp because its test claim was not re-run in this pass.

## 2026-10-06

- reconciled at `9ba95fd`: two commits since the last pass, a canon block sync in `AGENTS.md` and a test fixture update for the publication's new address (`tests/`), neither with a documentation consequence; `head` and `as_of` advanced only.

## 2026-09-08

- rolled from NOW.md: **One job per subject, because a subject is independent of every other subject.** Why: asking one question's assistants together bought back most of an hour and it was still not enough. The next live run finished its first product in twenty-six minutes with four to go, so five products in one job is over two hours against a job killed at fifty-five minutes: every run would have landed one product and lost the other four. A subject reads its own context, asks its own questions and posts its own packet, sharing nothing but the spend ceiling, so the honest shape is a matrix. A `plan` job asks Control Center which subjects are active and divides `AEO_MAX_USD_PER_RUN` between them; `research` fans out three at a time with `fail-fast: false`, so a subject that fails fails alone. The timeout is ninety minutes rather than fifty-five because an attempt, a wait and a retry is about fifty-seven, and the old hour would have killed the retry rather than the work.
- rolled from NOW.md: **Absence is not opportunity, so a recommendation now has to say why he can win it.** Why: the first output was rejected for a vanilla understanding of what is on offer and for recommending topics huge businesses are going to own. The machine was recommending whatever it was absent from, and a question owned by a social network, a video platform, a national business title or a big consultancy is a wall rather than a gap. `GET /api/aeo/context` now carries the business canon, and the digest runs three questions over every query before recommending it: who owns this answer now, what does he have that those hosts structurally cannot have, and can the person asking move a decision on their own. The answer to the second is the new `why_you_can_win`; what fails goes to the new `not_worth_chasing` with the hosts that own it and one plain sentence. A null reason is carried rather than hidden, and the deterministic fallback never writes one.
- rolled from NOW.md: **The first live run did not fit in the hour, so the assistants now answer together.** Why: the first real dry run asked five products, twenty questions each, three assistants, one call after another, and was still going at fifty minutes against a job killed at fifty-five. Three hundred hosted web searches at several seconds each is forty minutes before a single model call, and the offline suite never caught it because a fixture answers instantly. One question's assistants now run together; the questions stay sequential so the spend cap stays exact.
- rolled from NOW.md: **The digest writes in a voice that was already on file.** Why: Krish asked whether the machine could learn who inspires him and what he wants to sound like, and would rather say it once than repeat it. He already had, on the Content side of Control Center: the krish-voice body in `system_config.content_voice_block`, and the ten writers he rates in `content_creators`, each with the move he rates them for. The context route now sends both and `digestSystem()` builds the prompt from them, with the voice held to register only so it can never loosen the evidence rules, and the people never named to the model.
- rolled from NOW.md: **The engine exists.** Why: the AEO research agent Krish described has to run unattended every Sunday and end in an action, and Control Center already holds every input (subjects, the map's buyer questions, striking-distance keywords, four weeks of probes, last week's digest). The whole repo lands in one day: the contract first, then clients with offline twins so the pipeline can be tested without spending, then the stages as pure functions with the clients injected. Decisions worth knowing: prospects are probed on their own leaders' questions and read for Mindmake's presence; query ids carry across weeks by a normalised match so trends are honest; the digest model writes prose only and every number comes from the score table; a missing Fireflies key is reported as unavailable, never as a quiet week. Mechanism and failures: `docs/BUILD-LOG.md`.
- decision (Krish, 2026-09-08): the repo is created with the contract (`docs/packet.schema.json`) as its first file, and every stage is tested offline against fixtures before any live call is made. The history starts here; there is nothing older to roll in.
