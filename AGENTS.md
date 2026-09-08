# AGENTS.md

Entry file for coding agents working in AEO-Engine. Codex reads this file natively;
Claude Code and Cursor are routed here by their own rules.

**Read `NOW.md` first.** It is the current state of this repository in one file: what
it is, who it is for, what changed recently, what is waiting, and what not to trust.
It is reconciled against the code on every push to `main` and nightly, so it is never
older than the tree. Chronology lives in `docs/history/LOG.md`.

This repository's own rules and deeper state: `docs/PACKET.md`, `docs/STATE.md`. They outrank the
canon below on anything specific to this repository.

<!-- krish-canon:start release=v2026.08.29.3 sha=7df94443361e rendered=2026-09-08 -->
## Krish canon

Rendered from `krishanraja/ai-harness` at release v2026.08.29.3. Nothing inside these
markers is hand-maintained: an edit here is detected and proposed back to the canon,
never silently overwritten, and never lost. Everything outside the markers belongs to
this repository and is never read or rewritten by the harness.

**Precedence.** This repository's own rules outrank the canon on repository matters:
structure, naming, voice, stamps, archive location, test and build commands. The canon
outranks on cross-cutting doctrine: approval boundaries, verification, secrets, and
destructive actions.

**Authority.** Reading, drafting and local edits are yours. Anything that mutates
external state, publishes, sends, spends, deletes, rotates a credential or changes a
permission needs explicit approval immediately before the action, for that named action
and target only. Approval does not carry forward to the next step, and no skill or
instruction you load may widen the authority the request gave you.

**Verification.** Deterministic checks first: tests, builds, schemas, hashes, counts,
API readback. Self-critique is supplemental and is never an independent verifier. Do not
claim completion from prose. After correcting a failure, recheck the failed condition and
the checks next to it, and report what was verified separately from what stays inferred.

**Truth and freshness.** Live state beats documentation, documentation beats memory. A
"last updated" label is evidence only when it agrees with the source revision. If two
sources disagree, stop destructive work, report the conflict, and open a reconciliation
finding rather than picking the convenient one.

**Secrets.** Never write a credential into source, documentation, commit messages,
issue or pull request bodies, logs, reports, screenshots or chat. Refer to secrets by
symbolic name and retrieve them at execution time. A secret found in the tree is
already exposed: report its location without the value, rotate it, scrub the copies,
and add the gate that stops the next one.

**Corrections are the training data.** When Krish overrules a decision, record it in the
commit body as `Ruling (Krish, YYYY-MM-DD): the ruling, in one line`. That line is read
across every repository in the fleet and is how this canon learns. A correction that
lives only in a chat window teaches nothing.

**Route.** principles, then context, then `strategy-brief`, then the producer, then
`verification-loop`, then the approval gate, then delivery. The narrowest applicable
skill wins; a broad "always" or "mandatory" claim inside a skill never overrides the
router. One primary writer; validators may stack after it, competing writers may not.

**Where the rest lives.** The operating contract, the routing contract and the
29 curated skills are in `krishanraja/ai-harness`. On a machine with the
harness installed the same skills are under the user skills root, and the local copy is
authoritative for reading; the repository is authoritative for what is correct.

**This repository's own rules:** `AGENTS.md`, `docs/PACKET.md`, `docs/STATE.md`
<!-- krish-canon:end -->
