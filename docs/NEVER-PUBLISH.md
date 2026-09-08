# Never publish

What a writer, a content agent or a build-signal ingest may not take from this repo or its output. The reason is on each line; the rule stands without it.

- **Any credential or secret value.** Nothing here should ever hold one; if one appears in a log, a fixture or a commit, that is an incident, not a fact to quote.
- **Any secret name beyond the README's table.** The table exists so the names can be set once; they are not content.
- **Any call participant's name, email address or handle.** Transcripts are read to find themes. Speakers are renumbered before a model sees them, every output string is scrubbed, and the validator refuses a packet carrying an email or a handle. A packet never carries a transcript id either, only an eight-character hash.
- **Any transcript text.** Evidence is paraphrase only, capped at 200 characters, and stays inside the packet.
- **Any theme paraphrase or call reference.** They describe private conversations, even paraphrased.
- **Any prospect's company name, room target, title or trigger signal.** A prospect is a company Krish wants to sell to; the read exists to help the approach, not to announce it. Packets carry a slug, never the name.
- **Any engine answer snapshot or citation list.** They are measurements for the Growth tab, not quotes.
- **Any figure from a cost ledger or a packet's stats.** Spend is Krish's to disclose.

Allowed: that the machine exists, what it measures, how it scores, how it refuses to guess, and anything in `NOW.md` under "What it is" and "Who it is for".
