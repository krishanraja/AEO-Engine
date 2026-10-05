# AEO-Engine: state

Status: Current
Owner: Krish Raja
Last verified: 2026-09-21 against `npm test`, `npm run typecheck` and `npm run check:config` (74 of 74 tests pass)

## Live

Nothing. No scheduled run has happened and no packet has reached Control Center.

## Built, not proven

- The pipeline end to end (`src/pipeline/00-context.ts` to `70-ship.ts`, composed in `run.ts`), proven only against `tests/fixtures` by `tests/cli.test.ts`, which runs the CLI offline and compares the venture packet to `tests/fixtures/expected/packet.ctrl.json` on every field but `run_id` and `generated_at`. The comparison now takes `--week` so the fixture's `week_start` stays fixed; before that fix it expired every Monday and had been failing since 2026-09-14 unnoticed.
- The live clients (`src/clients/`): Control Center (context, ingest with one retry on 429, command patch, usage meter POST), Fireflies (GraphQL), Perplexity, OpenAI Responses with web search, Anthropic Messages with web search (the probe path gets a four-minute timeout rather than the 120s default, because a probe turn can run up to five hosted web searches before composing an answer), xAI with live search. Each is exercised in `tests/clients.test.ts` against a faked `fetch`, never against the service.
- The usage meter (`src/lib/usage.ts`, `POST /api/aeo/meter`): sums every Anthropic response's token usage, cache fields included, by stage and model and posts it after the run. It deliberately never turns tokens into dollars, that stays Control Center's job. Only the Anthropic clients feed it; Perplexity, OpenAI and xAI usage is not reported yet. Proven only against `tests/usage.test.ts`, never against a live run.
- The workflow `.github/workflows/aeo-weekly.yml`: schedule, manual dispatch, repository dispatch from Control Center's Run-now, three attempts.
- The price table in `src/config/run.ts` is a spend cap estimate, not a bill, the usage meter above is a first step toward a real one, and the first live ledger (a dry run prints it) is still where the cap itself gets tuned.
- Model ids and tool types to confirm on the first live run: the OpenAI Responses API model for web search, and the Anthropic web search tool type paired with the Anthropic model id.

## Waiting

- Repository secrets: `CONTROL_CENTER_URL`, `AEO_ENGINE_SECRET`, `FIREFLIES_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and optionally `XAI_API_KEY`, `EXA_API_KEY`. Repository variable `AEO_MAX_USD_PER_RUN`.
- `CLAUDE_CODE_OAUTH_TOKEN` for `.github/workflows/docs-steward.yml`.
- Control Center's `AEO_DISPATCH_TOKEN` so Run-now can reach this repo.

## Known limits

- The demand score has no prompt-volume corpus behind it; every row's labels say so. Google volume enters only through Control Center's striking-distance rows.
- Recommendations for an aspiration mean "questions where the aspiration is absent"; the useful output for that kind is the playbook.
- `probes_skipped_cap` counts pairs skipped by the USD cap only. Queries beyond the per-subject cap of 20 simply carry no probes.
