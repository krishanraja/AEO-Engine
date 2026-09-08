# Build log

Dated entries, newest first. Each one says why it was done, what failed or would have failed without it, and the mechanism. Control Center's build-signal ingest reads this file; keep names of people, prospects and secrets out of it.

## 2026-09-08

### The contract before the code

Why: the packet is the only thing Control Center trusts from this repo, and a pipeline built first and fitted to a schema later leaks its internals into the contract. The schema (`docs/packet.schema.json`) was written first and is identical on both sides.

Failure it prevents: a packet that passes here and fails there. Control Center's ingest enforces rules the JSON schema cannot say (a venture names its product slug, a Monday week, empty themes unless ok, unique query ids, a recommendation must point at a packet query, kind-specific playbook and hook). `src/schema/packet.ts` carries the same rules, so a 400 from ingest means a bug in the validator, not a surprise.

Mechanism: a hand-written validator with no dependencies (`validatePacket`), a walk over every string for the three content rules (no em dash, no email, no @handle), and a test that proves each refusal fires.

### Offline twins for every client

Why: a weekly run with four paid engines cannot be tested by running it. Every client (Control Center, Fireflies, the four engines, the model writer) has an interface and an offline implementation that reads a fixture keyed by a short hash of the request. The pipeline never knows which it has.

Failure it prevents: a green test suite that never exercised the pipeline, and a first live run that discovers the scoring is wrong at the price of a full Sunday's calls.

Mechanism: `src/clients/offline.ts`; a missing fixture throws `MissingFixture` naming the path. `tests/cli.test.ts` runs the real CLI offline and compares the venture packet to `tests/fixtures/expected/packet.ctrl.json` on every field but `run_id` and `generated_at`. Query ids are minted from a hash of the subject and the normalised query in offline mode (random uuids live) so the comparison holds.

### Prospects are read from their own side

Why: a prospect is a company Krish wants to sell to. Probing "how do I hire an AI advisor" would measure nothing that company's leaders ever ask. The proposal prompt says a prospect query is what that company's senior leaders would ask an assistant about their own strategic problem, never about Mindmake, and the read is whether Mindmake or Krish appears in the answer they would see (`krish_hits_domains` is Mindmake's domains for a prospect, the subject's own for the other kinds).

Failure it prevents: a packet that flatters the venture and says nothing usable in an approach.

### The digest model writes prose, the table supplies the numbers

Why: the growth council's rule ("every number you write must appear in the evidence") is the right rule, and the cheapest way to enforce it is structural. The model returns titles, angles, evidence lines, whys and a hook; the pipeline attaches the demand, the engines and the query ids from the score table, drops any recommendation whose id is not in the recommend set, and fills any it skipped from the deterministic writer.

Failure it prevents: a recommendation for a question that was never probed; a demand number rounded for effect.

Mechanism: `src/pipeline/60-digest.ts`; on any model failure the same fields come from the score table and `digest_writer` says `fallback`. The offline prospect fixture has no digest fixture on purpose, so the CLI test proves the fallback path every run.

### Fireflies down is not a quiet week

Why: a missing key or a failed call that reads as "no calls" would silently drop the transcript proxy from every score and look like a normal week. `themes_status` has a value for it and the calls count is zero, zero.

Mechanism: every Fireflies failure surfaces as `FirefliesUnavailable`; `gatherTranscripts` maps it to the status; nothing else in the run stops.

### Names never reach a model

Why: transcripts carry participant names and emails, and the packet is read on the Growth tab with the anon key. Speakers are renumbered (Speaker 1, Speaker 2) before the classifier or the theme writer sees a line, every output string is scrubbed of emails, handles and the subject's never-say terms, and a transcript is referred to only by an eight-character hash.

### The cap is counted, not discovered

Why: a map that grows to two hundred questions must not become a two-hundred-call bill. Every paid call is charged against an estimate before it is made; when the next call would cross the cap the run keeps going but asks nothing more, and counts every skipped query and engine pair in `probes_skipped_cap`.

Mechanism: `src/lib/cost.ts`; the price table in `src/config/run.ts` is an estimate to tune from the first live ledger, which the dry run prints.

### Theme overlap needs three shared words

Failure found: with two shared words, "ai" and one other word matched nearly every query to some theme in a corpus where every question mentions AI, so transcript evidence attached to questions no call had raised. Three shared non-stop words keeps the true matches in the fixture and drops the rest. It is still a proxy, and the labels say so.
