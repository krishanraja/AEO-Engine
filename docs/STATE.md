# AEO-Engine: state

Status: Current
Owner: Krish Raja
Last verified: 2026-10-27 against `npm test` (101 of 101 tests pass), `npm run check:config`, `npm run typecheck` and the code at a8a1fd1; the Live section against GitHub Actions run history and job logs read on 2026-10-27

## Live

The code and the tests cannot prove this section. It rests on this repository's GitHub Actions run history and job logs, read on 2026-10-27, and it says only what those show.

- **The daily directive loop.** `.github/workflows/cc-growth-directive.yml` first ran by hand on 2026-10-19 and has run every day since at about 05:10 UTC, woken by Control Center's `cc-growth-directive` dispatch. Every scheduled day succeeded. One extra dispatch on 2026-10-23 failed with `report_conflict`, which is the designed refusal of a second report for one UTC day (Known limits).
- **The fortnightly research run.** `.github/workflows/aeo-weekly.yml` has run on its Sunday schedule and finished successfully on 2026-09-27, 2026-10-04, 2026-10-11 and 2026-10-25; 2026-10-18 was an off week and skipped the research job. In the two runs whose job logs were read (2026-10-11 and 2026-10-25) every subject job logged its packet posted to Control Center and its usage reported. In the 2026-10-25 run the report job also delivered one protocol report (status `ready`), read it back by digest and closed the attempt as succeeded. The next scheduled run is Sunday 2026-11-08 (ISO week 45).
- **Docs steward.** `docs(steward)` commits by claude[bot] landed on 2026-10-19, 2026-10-21, 2026-10-22, 2026-10-23 and 2026-10-27 (`git log`), and `.github/workflows/docs-steward.yml` fails without `CLAUDE_CODE_OAUTH_TOKEN`, so that secret is set.
- **Not read from here:** what Control Center holds (the packets, the digests, whether `queries_cited_first` is now a measured number and what it is), any spend, which repository secrets other than the Control Center ones are set, and why some engine calls failed (`probe_failed` appears in some subject jobs).

## Built, not proven

"Proven" in this section means proven offline by the tests named. The research workflow, the clients and the protocol loop have since run live (above), so for them "not proven" means no check of their live output against a ledger or a live packet is recorded in this repository.

- The pipeline end to end (`src/pipeline/00-context.ts` to `70-ship.ts`, composed in `run.ts`), proven only against `tests/fixtures` by `tests/cli.test.ts`, which runs the CLI offline and compares the venture packet to `tests/fixtures/expected/packet.ctrl.json` on every field but `run_id` and `generated_at`. The comparison now takes `--week` so the fixture's `week_start` stays fixed; before that fix it expired every Monday and had been failing since 2026-09-14 unnoticed.
- The live clients (`src/clients/`): Control Center (context, ingest with one retry on 429, command patch, usage meter POST), Fireflies (GraphQL), Perplexity, OpenAI Responses with web search, Anthropic Messages with web search (the probe path gets a four-minute timeout rather than the 120s default, because a probe turn can run up to five hosted web searches before composing an answer), xAI with live search. Each is exercised in `tests/clients.test.ts` against a faked `fetch`, never against the service.
- The usage meter (`src/lib/usage.ts`, `POST /api/aeo/meter`): sums every Anthropic response's token usage, cache fields included, by stage and model and posts it after the run. It deliberately never turns tokens into dollars, that stays Control Center's job. Only the Anthropic clients feed it; Perplexity, OpenAI and xAI usage is not reported yet. Proven only against `tests/usage.test.ts`, never against a live run.
- The workflow `.github/workflows/aeo-weekly.yml`: schedule (Sundays on odd ISO weeks, fortnightly since 2026-10-15), manual dispatch, repository dispatch from Control Center's Run-now, two attempts per subject five minutes apart. The schedule and the protocol report have run live (above); no Run-now dispatch has been seen in the run history since 2026-09-08.
- The price table in `src/config/run.ts` is a spend cap estimate, not a bill, the usage meter above is a first step toward a real one, and the first live ledger (a dry run prints it) is still where the cap itself gets tuned.
- The growth engine protocol (`src/clients/growthEngine.ts`, `src/protocol/`, `.github/workflows/cc-growth-directive.yml`, and the plan and report jobs of `aeo-weekly.yml`), proven only against the in-process stand-in in `tests/protocol.test.ts`: the digest of the worked example, the schema, attempt started then terminal, replay, readback, a 409 read back and not retried, a 401 as a failed attempt, no redirect followed, and the token absent from every log line. The daily directive path holds no paid key. It has since run live (above). The autonomy loop of protocol 1.1.0 (plan, go-live, check-in) is not built: `docs/GET-GOING.md` Step 1. The engine sends 1.0.0 reports and accepts any 1.x directive.
- The voice pass (`src/pipeline/65-voice.ts`, protocol 1.5.0): when the directive's `taste` holds at least one approved rule, one wording-only call per subject rewords the digest's titles, angles, watch whys and hook, and the digest's own wording is kept whole if the answer adds, drops or reorders an item or adds a number. Proven only against `tests/taste.test.ts`, never against a live run.
- Model ids and tool types to confirm from the live logs (the first live runs have happened, and no confirmation is recorded here): the OpenAI Responses API model for web search, and the Anthropic web search tool type paired with the Anthropic model id.

## Waiting

- Repository secrets: `CONTROL_CENTER_URL`, `AEO_ENGINE_SECRET`, `FIREFLIES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and optionally `XAI_API_KEY`, `EXA_API_KEY`. Repository variable `AEO_MAX_USD_PER_RUN`. The live research run could not have posted packets without `CONTROL_CENTER_URL` and `AEO_ENGINE_SECRET`, and the protocol loop could not have run without `CONTROL_CENTER_ENGINE_TOKEN` and the variable `CONTROL_CENTER_URL`, so those four are set. Whether the rest, and the spend variable (the workflow falls back to 25 without it), are set cannot be read from here.
- The first measured `queries_cited_first`: read the 2026-10-25 report's value back from Control Center and set its target (`docs/GET-GOING.md`, Steps 3 and 6). The next research run is Sunday 2026-11-08.
- Control Center's `AEO_DISPATCH_TOKEN` so Run-now can reach this repo (no Run-now dispatch has been seen since 2026-09-08).

## Known limits

- The demand score has no prompt-volume corpus behind it; every row's labels say so. Google volume enters only through Control Center's striking-distance rows.
- Recommendations for an aspiration mean "questions where the aspiration is absent"; the useful output for that kind is the playbook.
- `probes_skipped_cap` counts pairs skipped by the USD cap only. Queries beyond the per-subject cap of 20 simply carry no probes.
- `queries_cited_first` uses "at least one assistant's first citation is ours" as its rule. That rule is the engine's reading of the objective, not a ruling; a stricter one (every assistant, or a majority) is a one-line change in `src/protocol/measure.ts`.
- A second full research run on the same UTC day gets a 409 on its protocol report, because one full run a day has one `run_id`. The attempt fails with `report_conflict`; the packets still land.
