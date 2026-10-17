<!-- krish-repo-context:start brain=5ca09cc3df52 sha=cfb8aa6a64b7 -->
# AEO-Engine: operating context

Generated from the central ai-harness brain. This is a route inventory, not a certification of current architecture. Read the section for the work at hand; repository-owned sources establish current facts. The nightly publisher rechecks source paths and named commands. This file grants no product action or spending authority.

## Sources and system boundaries

- Purpose and system boundaries (orientation): `README.md`.
- Current repository state (state): `NOW.md`.
- PACKET (orientation): `docs/PACKET.md`.
- STATE (state): `docs/STATE.md`.
- NEVER PUBLISH (privacy): `docs/NEVER-PUBLISH.md`.
- index (orientation): `src/index.ts`.
- run (orientation): `src/pipeline/run.ts`.
- Repository commands (verification): `package.json`.
- Required bootstrap source (orientation): `docs/history/LOG.md`.

## Workflows

### research: Question selection, probes, evidence and packet handoffs

Read: `README.md`, `docs/PACKET.md`, `docs/STATE.md`, `src/pipeline/run.ts`, `docs/NEVER-PUBLISH.md`.
Checks: `npm test`; `npm run typecheck`; `npm run check:config`.
Run only within existing authority. Check inputs, the owning stage, and the downstream artifact actually consumed.

### experiment: Compare conditional findings and choose the next bounded test

Read: `README.md`, `docs/PACKET.md`, `docs/STATE.md`.
Checks: `npm run run -- --offline --dry --subject ctrl`.
Run only within existing authority. Check inputs, the owning stage, and the downstream artifact actually consumed.

## Accepted operating knowledge

- Preserve the accumulated goal and accepted decisions when a revision changes one dimension. Identify the requested delta and explain material trade-offs among soft goals; only an explicit scoped owner decision supersedes an accepted requirement. [administration.preserve-intent@1; family]
- Locate the authoritative sources, stage owner and verification route for the work. Verify the downstream result actually consumed, and diagnose the owning layer when a failure repeats. [administration.verify-owning-system@1; family]
- Preserve an experiment's conditions, observed outcome and uncertainty. An unsuccessful trial is evidence for that setting; it does not automatically prohibit a tactic, audience or another repository's work. [administration.experimental-learning@1; family]
- Record verified outcomes and corrections with source identity and scope. Keep observations, assistant claims and inferred preferences separate from accepted requirements. An observation cannot approve itself or expand operating authority. [administration.evidence-and-acceptance@1; family]

## Learning and decisions

Keep an accumulated working brief: goal, accepted decisions, requested delta, conditions, unresolved questions and observed outcome. A narrow revision preserves other decisions. Distinguish an explicit owner instruction from an interpretation, and a failed experiment from an operational defect. Read native feedback/experiment records for the specific task; a result for another audience or stage is not a prohibition here.

The brain retains evidence and proposals separately. Newly observed evidence never approves itself. When a failure repeats, diagnose missing knowledge, interpretation, retrieval, stale instructions, ignored guidance or the owning code before adding another rule.

Acceptance: brain-repository-administration-v1. Effective knowledge IDs and their acceptance references are in ai-harness `brain/knowledge.jsonl`. Source inventory revision: `c9604510ec56339fbb52a0bd1be7a03ee0107c4f`.
<!-- krish-repo-context:end -->
