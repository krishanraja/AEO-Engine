---
repo: krishanraja/AEO-Engine
product: AEO-Engine
as_of: 2026-11-20
head: 74cce06
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

AEO-Engine is the fortnightly answer-engine research machine for Krish Raja's ventures, the companies he wants to sell to, and the companies he wants to be like. A Node and TypeScript pipeline on GitHub Actions, it asks the AI assistants the questions those buyers ask, records who is cited and whether we are, reads the fortnight's calls for what buyers said, scores the demand behind each question, and POSTs one packet per subject to Control Center (`docs/packet.schema.json`), which turns the recommendations into content ideas. It holds no subject list of its own; Control Center's registry is the input.

## Who it is for and why it matters for Mindmake

Krish reads the digest on Monday and acts the same week. The packet answers, per venture, "which buyer question are we invisible on, and who is cited instead"; per prospect, "what would this company's leaders see if they asked an assistant about their own problem, and is Mindmake in it"; per aspiration, "which of their pages get cited, and why". For the room_face buyer (a senior leader at a PE or VC backed media, adtech, publishing or data business, quietly behind on what is coming) the machine is proof that one person can run demand research on AI agents with the evidence left in: every number in a digest is measured that run, every unknown stays unknown, and a failed engine call writes nothing rather than a guess. Angles a writer can use: the OS reads its own calls and refuses to name anyone in them; the demand score says out loud that there is no prompt-volume corpus and scores from proxies; the run has a price cap it counts against, not a bill it discovers.

## Where it is right now (as of 2026-11-20)

<!-- north-star-state {"week_of":"2026-11-16","week_target":1,"current":1,"current_as_of":"2026-11-14","current_source":"AEO-Engine's research as Control Center holds it (growth_geo_probes and growth_aeo_subjects): questions where a product of ours is the first citation, over the questions asked in the newest research fortnight; a question not asked stays unknown, never lost (Ruling, Krish, 2026-11-12), read by Control Center","urgency":1,"urgency_reason":"at 100% of this week's target"} --> **North Star number: U1, on pace.** Share of tracked buyer questions where Mindmake or one of its products is the first citation: 1%, against 1% this week, on the way to 50% by 25 January 2027. Steady, and one proposal a week that would raise the ceiling.

- **Specialist, built and merged, nothing run live yet.** Rebuilt as the AI-answers specialist (Ruling, Krish, 2026-11-12): every venture's growth engine calls it for its buyer questions, asked word for word at the research run, with a gap class per question, one win kit behind strategy, and off-week verify runs only on his approved spend go-live (`docs/briefs/2026-11-13-aeo-specialist.md`). The research run of Sunday 22 November is the first proof.
- **Live, by GitHub Actions history and Control Center's stored reports (read 2026-11-12, `docs/STATE.md` "Live").** The daily `cc-growth-directive` loop has succeeded every day since 2026-10-19 and every daily report since 2026-10-26 is `ready`. The fortnightly research run has succeeded on schedule since 2026-09-27; GitHub starts it hours late. In the last full run, 2026-11-08, every subject job posted its packet and one protocol report (`ready`) was delivered and read back. The live runs ask Perplexity, ChatGPT and Claude. Not proven: any spend, and the price table and usage meter against a live ledger (`docs/STATE.md`, "Built, not proven"). The next scheduled research run is Sunday 2026-11-22.
- **Contract.** `docs/packet.schema.json` is identical to Control Center's copy; the validator here also carries the rules Control Center enforces beyond the schema (a venture names its product slug, a Monday `week_start`, empty themes unless the status is ok, unique query ids).
- **Aim.** `docs/NORTH_STAR.md` (Krish, 2026-10-18): by January 2027, Mindmake and its products are cited first on the buyer questions the ventures answer, and the engine can show the week each one was won. Not reached. The denominator is the questions asked that fortnight (1 of 100 = 1% on 8 Nov, recorded there); Control Center measures the share.
- **Growth engine protocol and autonomy.** Registered as `aeo-engine` on 2026-10-18; a daily `cc-growth-directive` workflow and one report per research run. Ruled 2026-10-19: the engine proposes a plan, Krish approves, it builds up to go-live, and it goes live only on his approved go-live decision. The copy in `docs/control-center/` is Control Center's protocol bundle 1.38.0, copied byte for byte (`tests/bundle.test.ts` checks every file's sha256; version read from `bundle.json` 2026-11-17); an instruction from Krish is acked `blocked` with when the research will reach it and is never an approval.
- **Get going.** "Get going" runs the next unticked step of `docs/GET-GOING.md`. Steps 0, 1, 2, 4, 6, 7, 8 and 9 are ticked (1, 2 and 9 built offline 2026-11-13, proof pending the 22 November run); Step 3, a target for `queries_cited_first`, is Krish's and is next.
- **Spend and housekeeping.** One research run can never spend more than 30 USD of estimates (default 30, hard max in code, shared with a subject's retry; Ruling, Krish, 2026-11-14). Every page read asks for HTML only. A weekly branch sweep (Sunday 03:17 UTC) deletes branches already on main (Ruling, Krish, 2026-11-15); its approved-list hand run is off the next step.
- **Waiting.** `XAI_API_KEY` is unset, so Grok is not asked; `EXA_API_KEY`, which no code reads yet, cannot be read from here (`docs/STATE.md`, Waiting).

## What changed recently

- 2026-11-15 3 of 13 public pages in the 15 November comparison answered the old header with Markdown or plain text and were misread; asked for HTML, two matched a browser render's headings exactly, and the third is cut by the 512 KB cap, still a known limit.
- 2026-11-15 a real-browser read changed the engine's fields on 2 of 13 readable pages, both already flagged as script-filled, and the 3 other differences were the fetch reader's own Accept header and size cap; Camoufox's added value, passing bot checks, is out of bounds.
- 2026-11-15 Branch sweep added, then taught to delete approved branches only at their reviewed commit (#58, #59); Krish took the hand run off the next step (#62).
- 2026-11-15 Camoufox was weighed for the site reader and refused after a bounded comparison; check:config now refuses it (#60).
- 2026-11-15 Page reads ask for HTML only (#61, Ruling, Krish, 2026-11-15).
- 2026-11-13 AEO-Engine became the specialist the growth engines call: honest first-citation measurement, every venture, win kits, verify runs and outcomes (Krish, 13 November).
- 2026-11-12 Krish, 2026-11-12: "make sure everything's a cohesive system and that the project documentation is 100% up to date with absolutely nothing old or misleading left in there".
- 2026-11-12 **An instruction is told when the research will reach it, and the calls cover the fortnight.** Why: Control Center carries an instruction for 7 days and the research runs fortnightly, and the daily run's ack said "press Run now", a press no Control Center page draws; one given in an off week would have lapsed unanswered. The same pass found that a seven-day calls window had left the off week's calls unread since the run went fortnightly, that the daily report on a research Sunday named the run a fortnight on before GitHub had started that day's, and that the docs still said nothing of 1.20.0 being live. `src/protocol/reports.ts`, `src/protocol/measure.ts`, `src/config/run.ts`, `docs/BUILD-LOG.md`.
- 2026-11-11 Ruling (Krish, 2026-11-11): every growth engine's state, priorities, obsessions, next steps and outstanding items are live on every place, and Krish instructs each engine through the one door and it starts at once. Each daily wake's run_id now ends in the workflow run and attempt, so a second wake the same day is not refused as a conflict.

## What is next and what is waiting on Krish

- Next (2026-11-15): on 22 November, read the research run's logs: cap_usd and the ledger total against the meter's AEO rows for that day, and the site reader's count of pages refused as non-HTML.
- Waiting on Krish: a target for `queries_cited_first` (`docs/GET-GOING.md`, Step 3); and whether Grok should be asked too, which needs `XAI_API_KEY` set (the live runs ask three assistants).
- North Star check (2026-11-15): holds.

## Read next

1. `docs/packet.schema.json`: the contract. Everything the engine produces validates against it.
2. `docs/PACKET.md`: the contract in plain English, field by field, and the week timing.
3. `docs/STATE.md`: what is live, what is built but not proven, what is waiting.
4. `README.md`: how it runs, the stages, the secrets by name.
5. `docs/BUILD-LOG.md`: the why, the failure and the mechanism behind each change.
6. `docs/NEVER-PUBLISH.md`: what a writer may not take from this repo.
7. `docs/NORTH_STAR.md`: the aim Krish set; only he changes it.
8. `docs/GET-GOING.md`: the build checklist that "Get going" works through, one unticked step at a time.
9. `docs/CONTROL-CENTER-BRIEF.md` and `docs/control-center/ENGINE-PROTOCOL.md`: the growth engine protocol this engine reports through, as Control Center briefed it (with how this repository answers 1.20.0) and a copy of its spec. The spec lives in [Control Center](https://github.com/krishanraja/control-center/blob/main/docs/app/growth/ENGINE-PROTOCOL.md); the copy lags it from its next change.

## Do not trust

- `docs/control-center/`: Control Center's protocol bundle (`docs/app/growth/protocol-bundle/`), copied byte for byte: ENGINE-PROTOCOL.md, both schemas, the worked example and `bundle.json` (version 1.38.0, each file's sha256, one `bundle_sha256`). Never edited here: a new version is a fresh copy, which `tests/bundle.test.ts` checks, and each run reports `protocol_copy` against the bundle capabilities serve (`src/protocol/bundle.ts`).
- `docs/NORTH_STAR.md`: its stamp (2026-11-12) is older than the latest code changes. The text is Krish's and stands; only he changes the file, stamp included.
- `AGENTS.md`, the Krish canon block: rendered at release v2026.11.18.7 (last synced in #66, merged). The block belongs to the harness.
- `docs/BUILD-LOG.md`: no entries between 2026-09-08 and 2026-10-19 or between 2026-10-19 and 2026-11-11, so the usage meter, the Claude probe timeout, the fortnightly schedule and the voice pass are recorded in `docs/STATE.md`, `docs/history/LOG.md` and "What changed recently" instead. Its 2026-09-08 line that every client carries a 120 second timeout no longer holds for the Claude probe path (four minutes, `docs/STATE.md`).
