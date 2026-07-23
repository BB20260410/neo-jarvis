---
title: Karpathy LLM Wiki Pattern
concept: karpathy-llm-wiki-method
updated: 2026-06-06
decision: replicate
priority: P0
tags: [noe-llm-wiki, method, local-first, markdown]
---

# Karpathy LLM Wiki Pattern

## Summary
Karpathy's useful pattern is not another heavy RAG stack. It is a compiled knowledge layer: raw source material remains append-only, while an AI maintains durable concept pages, links, an index, and an append-only maintenance log. At query time the assistant reads the compiled pages first, then only falls back to broad search when the wiki is missing evidence.

## Why It Helps Noe
- It cuts repeated research: durable concepts are compiled once instead of rediscovered on every conversation.
- It keeps the main storage plain Markdown, so Noe can read it, users can inspect it, and no vector database becomes the source of truth.
- It fits Noe's existing stack: SQLite memory handles conversation facts, file index handles broad desktop recall, and LLM Wiki handles curated high-value knowledge.

## Replication
- Keep `knowledge/llm-wiki/raw/` append-only.
- Compile raw notes into `knowledge/llm-wiki/wiki/*.md`.
- Maintain `wiki/index.md` and `wiki/log.md` automatically.
- Add lint checks for orphan pages, broken links, and missing source references.
- Avoid importing a full external compiler until Noe has enough pages to justify the overhead.

## Risks
- If every transcript is dumped into raw, the wiki becomes noise. Only durable decisions, research, reusable methods, and accepted patterns should enter.
- If concept pages are manually curated forever, maintenance cost rises. Deterministic ingest/lint is the first automation layer; LLM-assisted summarization can be added later behind approval.

## Sources
- [raw:raw/2026-06-05-karpathy-llm-wiki-method.md](../raw/2026-06-05-karpathy-llm-wiki-method.md)
- [Karpathy LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [atomicstrata/llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler)
- [AgriciDaniel/claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)

## Open Questions
When the wiki grows past roughly a few hundred concept pages, evaluate hybrid retrieval over wiki pages instead of loading pages directly.
