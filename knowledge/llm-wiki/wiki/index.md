# Noe LLM Wiki Index

Updated: 2026-06-06

## Pages
- [Karpathy LLM Wiki Pattern](./karpathy-llm-wiki-method.md) — replicate, P0
- [Noe LLM Wiki Operating Model](./noe-llm-wiki-operating-model.md) — replicate, P0
- [Obsidian As Optional Human UI Layer](./obsidian-optional-ui-layer.md) — defer, P1
- [Open Source Triage For Noe Knowledge Workflows](./open-source-triage-for-noe-knowledge.md) — borrow, P0

## Operating Rule

Put durable sources in `raw/`, run `npm run wiki:ingest`, then run `npm run wiki:lint`. Do not manually maintain page lists unless lint says a generated link is wrong.

## Intake Queue

- Add source notes, transcripts, research summaries, or durable decisions to `raw/`.
- Keep Obsidian optional until a real vault and Local REST API key exist.
