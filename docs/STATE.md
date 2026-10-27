# AEO-Engine: state

Status: Current
Owner: Krish Raja
Last verified: 2026-10-27 against `npm test` (101 of 101 tests pass) and the code at a8a1fd1

## Live

Nothing. No scheduled run has happened and no packet has reached Control Center.

## Built, not proven

- The pipeline end to end (`src/pipeline/00-context.ts` to `70-ship.ts`, composed in `run.ts`), proven only against `tests/fixtures` by `tests/cli.test.ts`, which runs the CLI offline and compares the venture packet to `tests/fixtures/expected/packet.ctrl.json` on every field but `run_id` and `generated_at`. The comparison now takes `--week` so the fixture's `week_start` stays fixed; before that fix it expired every Monday and had been failing since 2026-09-14 unnoticed.
- The live clients (`src/clients/`): Control Center (context, ingest with one retry on 429, command patch, usage meter POST), Fireflies (GraphQL), Perplexity, OpenAI Responses with web search, Anthropic Messages with web search (the probe path gets a four-minute timeout rather than the 120s default, because a probe turn can run up to five hosted web searches before composing an answer), xAI with live search. Each is exercised in `tests/clients.test.ts` against a faked `fetch`, never against the service.
- The usage meter (`src/lib/usage.ts`, `POST /api/aeo/meter`): sums every Anthropic response's token usage, cache fields included, by stage and model and posts it after the run. It deliberately never turns tokens into dollars, that stays Control Center's job. Only the Anthropic clients feed it; Perplexity, OpenAI and xAI usage is not reported yet. Proven only against `tests/usage.test.ts`, never against a live run.
- The workflow `.github/workflows/aeo-weekly.yml`: schedule (Sundays on odd ISO weeks, fortnightly since 2026-10-15), manual dispatch, repository dispatch from Control Center's Run-now, three attempts.
- The price table in `src/config/run.ts` is a spend cap estimate, not a bill, the usage meter above is a first step toward a real one, and the first live ledger (a dry run prints it) is still where the cap itself gets tuned.
- The growth engine protocol (`src/clients/growthEngine.ts`, `src/protocol/`, `.github/workflows/cc-growth-directive.yml`, and the plan and report jobs of `aeo-weekly.yml`), proven only against the in-process stand-in in `tests/protocol.test.ts`: the digest of the worked example, the schema, attempt started then terminal, replay, readback, a 409 read back and not retried, a 401 as a failed attempt, no redirect followed, and the token absent from every log line. The daily directive path holds no paid key. No live report has been sent.
- The voice pass (`src/pipeline/65-voice.ts`, protocol 1.5.0): when the directive's `taste` holds at least one approved rule, one wording-only call per subject rewords the digest's titles, angles, watch whys and hook, and the digest's own wording is kept whole if the answer adds, drops or reorders an item or adds a number. Proven only against `tests/taste.test.ts`, never against a live run.
- Model ids and tool types to confirm on the first live run: the OpenAI Responses API model for web search, and the Anthropic web search tool type paired with the Anthropic model id.

## Waiting

- Repository secrets: `CONTROL_CENTER_URL`, `AEO_ENGINE_SECRET`, `FIREFLIES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and optionally `XAI_API_KEY`, `EXA_API_KEY`. Repository variable `AEO_MAX_USD_PER_RUN`.
- The first live protocol report: the client is written (above) and waits on the repository secret `CONTROL_CENTER_ENGINE_TOKEN` and the variable `CONTROL_CENTER_URL`, which Control Center says are set. The first `cc-growth-directive` dispatch after this lands on main is the first live run. `queries_cited_first` stays `null` with a reason until a full research run reports through the protocol (the next scheduled one is 25 October).
- `CLAUDE_CODE_OAUTH_TOKEN` for `.github/workflows/docs-steward.yml`.
- Control Center's `AEO_DISPATCH_TOKEN` so Run-now can reach this repo.

## Known limits

- The demand score has no prompt-volume corpus behind it; every row's labels say so. Google volume enters only through Control Center's striking-distance rows.
- Recommendations for an aspiration mean "questions where the aspiration is absent"; the useful output for that kind is the playbook.
- `probes_skipped_cap` counts pairs skipped by the USD cap only. Queries beyond the per-subject cap of 20 simply carry no probes.
- `queries_cited_first` uses "at least one assistant's first citation is ours" as its rule. That rule is the engine's reading of the objective, not a ruling; a stricter one (every assistant, or a majority) is a one-line change in `src/protocol/measure.ts`.
- A second full research run on the same UTC day gets a 409 on its protocol report, because one full run a day has one `run_id`. The attempt fails with `report_conflict`; the packets still land.
