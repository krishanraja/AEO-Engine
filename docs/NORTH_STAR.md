# North Star

Status: Current
Owner: Krish Raja
Last verified: 2026-11-12

> By January 2027, when a buyer asks an AI assistant the questions Krish's ventures answer, Mindmake and its products are cited first, and this engine can show the week each one was won.

Set by Krish on 18 October 2026. It is not reached yet. It is what every session in this repository works toward.

## The number

**Share of tracked buyer questions where Mindmake or one of its products is the first citation**: 50% by 25 January 2027, on a linear weekly ladder. The first honest reading becomes week one, and the ladder is drawn from it.

**What the share counts** (Ruling, Krish, 2026-11-12): "the share counts the questions asked that fortnight (1 of 100 = 1% on 8 Nov); questions not asked stay unknown rather than lost." The denominator is the questions this engine actually put to the AI assistants in its newest research fortnight, across every venture and prospect it researched; a question it did not ask (a subject that failed, a pair the spend cap stopped) is unknown, never counted as a question lost. An aspiration is another company's site and is never counted. Control Center measures it from the probes this engine's packets wrote (`READERS['aeo-engine']` in Control Center's `api/_northStarRefresh.ts`) and writes the state line below.

**Whose questions** (Ruling, Krish, 2026-11-12): "AEO-Engine becomes the one specialist that every venture's growth engine calls for its AI-answer work." Each venture's engine asks this engine for its own product's buyer questions through the protocol (1.22.0), and they count toward this share once asked.

```yaml north-star-metric
metric: "Share of tracked buyer questions where Mindmake or one of its products is the first citation"
unit: %
direction: up
target: 50
deadline: 2027-01-25
ladder_shape: linear
source: "The newest research fortnight: questions cited first over questions asked, read by Control Center from this engine's probes"
status: active
ladder: pending-baseline
```

Urgency (U1 to U5) is worked out every week from where the number stands against that week's target, by [the harness contract](https://github.com/krishanraja/ai-harness/blob/main/contract/north-star-metric.md). Set by Krish on 23 October 2026.

## How to use it

- Read it before any work, every session.
- Before you start, say which part of it the task moves. If the task moves nothing toward it, say so first and let Krish decide.
- Prefer the work that moves it furthest, and close each session by noting what moved.
- Only Krish changes this file. Record his ruling in the commit body as `Ruling (Krish, YYYY-MM-DD): ...`.
- When it is reached, say so and ask Krish for the next one.
