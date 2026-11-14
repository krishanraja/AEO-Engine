Status: The meter's billing rows for ChatGPT, Grok and Gemini probes now carry the search calls each provider bills per call (OpenAI web_search_call items, xAI sources used, Gemini grounding queries) as search_calls; Perplexity's request fee stays priced per call at the meter (audit ai-cost-6 and content-engine-3, AEO side).
Next: content-engine prices those rows (gpt-5, grok-4, gemini-3.6-flash tokens and search fees) in _prices.ts; then read 22 November's meter_daily against the ledger's spent_usd.
North Star check (2026-11-14): holds.
Changed: Non-Anthropic probe rows carry search_calls, so the meter can price the per-search fees once it holds the rates.
