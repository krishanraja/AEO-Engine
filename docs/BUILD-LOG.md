# Build log

Dated entries, newest first. Each one says why it was done, what failed or would have failed without it, and the mechanism. Control Center's build-signal ingest reads this file; keep names of people, prospects and secrets out of it.

## 2026-09-08 (later still): absence is not opportunity

The first output was read and rejected. The verdict was that the
recommendations showed a very vanilla understanding of what is on offer, and
that there is no competing with the huge businesses that are going to own some
of those topics.

That was a design fault, not a tuning problem. The machine recommended
whatever it was absent from, and absence is not opportunity. A question we are
missing from because a social network, a video platform, a national business
title or a big consultancy owns the answer is a wall, not a gap: that answer
was won by format and reach rather than by an argument, and one piece will not
displace it. Every week the old rule was in force it would have spent a week
of writing on a category term a jobs board or a consultancy already holds.

So a recommendation now has to pass a winnability judgement before it is made.
`GET /api/aeo/context` carries `krish.canon`, the business canon that says the
positioning, what is sold, exactly who the buyer is and what the business
refuses to say. `digestSystem()` appends a WINNABILITY section carrying the
opening 7000 characters of it (the part with the positioning and the buyer)
and three questions to ask of every query: who owns this answer now, read from
the cited hosts; what does he have that those hosts structurally cannot have,
taken from the canon; and can the person asking move a decision on their own.
The answer to the second is written into `why_you_can_win` on each
recommendation. "He knows a lot about this" is not an answer, and a query with
no answer is not a recommendation.

What fails goes into `not_worth_chasing` at packet top level, up to six
entries, each naming the hosts that own the answer and one plain sentence with
no hedging. On a bad week this is the more useful half of the packet: being
told to skip a question costs nothing, and chasing one that a platform owns
costs a week.

Two failures the design had to answer. A null `why_you_can_win` is now the
signal that the digest could not justify itself, so it is carried rather than
used to silently drop the row: a hidden failure would read as a quiet week
instead of a bug, and the count is logged as `digest_unjustified`. And the
deterministic fallback must not fake the judgement it cannot make. It can
answer the first question from the cited hosts alone, so it moves out any
query where more than half of them are large general platforms (a short,
deliberately obvious list of social networks, video platforms, national
business titles, encyclopaedias and the big consultancies) and says in
`why_not` that nothing beyond who is cited was judged. It cannot answer the
other two, so it writes `why_you_can_win: null` on everything that survives
and lets the reader see it next to `digest_writer: fallback`. A majority of
hosts rather than a single hit, because one social link beside two specialists
is still an answer a specialist won and a specialist can take.

Both fields are additive: `schema_version` stays 1 and a packet written before
the gate still validates without them. The validator checks that every
`not_worth_chasing` entry names a query the packet actually carries, that it
names it once, and that it is not also a recommendation, because a question
cannot be both the thing to make and the thing to skip.

## 2026-09-08 (later): the first live run did not fit in the hour

Found in production, not in a test. The first real dry run asked five
products, twenty questions each, three assistants, one call after another,
and was still going at fifty minutes against a job that is killed at
fifty-five. Nothing shipped.

The arithmetic was always there to be done: three hundred hosted web
searches at several seconds each is forty minutes before a single model call.
The offline suite never caught it because a fixture answers instantly.

Fixed by asking one question's assistants together, since they have nothing
to say to each other. Roughly a third of the wall time. The questions stay
sequential on purpose: the spend cap is checked and charged before a question
is asked, and keeping that decision on one thread is what makes the cap exact
rather than approximate. Engine order in the packet is preserved, so a packet
does not change shape with the weather, and a failed call still writes
nothing and is still counted.

Every client already carries a 120 second timeout, so a hung assistant cannot
hold the group open.

## 2026-09-08: the digest writes in a voice that was already on file

Krish asked whether the machine could learn who he is inspired by and what he
wants to sound like, and said he would rather drop it once than repeat it.

He already had, twice, on the Content side of Control Center. The krish-voice
body lives in `system_config.content_voice_block` and grounds every content
call; `content_creators` holds the ten writers he rates, each with the move he
rates them for, five of which the Tuesday scrape reads every week.

So `GET /api/aeo/context` now carries both, and `digestSystem()` in
`src/pipeline/60-digest.ts` builds the prompt from them: the opening of the
voice block (6000 characters, the part that carries register and the kill
list, because a digest writes titles and angles rather than finished pieces),
then the moves without the names.

Two rules that matter. The voice is appended after the two evidence rules and
is told in the prompt that it governs register only, so a style instruction
can never loosen "every number must appear in the evidence". And the people
are never named to the model: it borrows the move, not the byline, because a
recommendation that reads as somebody else's is worse than a plain one.

Both fields are optional. An older Control Center, or a failed read, gives a
plain digest rather than one written in a voice the machine invented.

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
