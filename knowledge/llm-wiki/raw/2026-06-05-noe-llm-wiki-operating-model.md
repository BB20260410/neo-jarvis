---
concept: noe-llm-wiki-operating-model
title: Noe LLM Wiki Operating Model
tags: [noe, operations, low-burden]
decision: replicate
priority: P0
---

# Noe LLM Wiki Operating Model

## Summary
Noe's low-burden knowledge workflow should be file-first and approval-light: add durable raw research, run deterministic ingest, run deterministic lint, and let Noe answer from compiled pages. The user should not maintain tags, folder maps, or plugin settings for routine use.

## Why It Helps Noe
- It gives every future agent a stable read order: `wiki/index.md`, relevant concept pages, then raw sources only when needed.
- It turns useful research into durable context without requiring Obsidian or another UI.
- It creates a lightweight acceptance gate: wiki pages must be indexed, source-linked, and lint-clean.

## Replication
- Add `npm run wiki:ingest` for raw-to-wiki compilation.
- Add `npm run wiki:lint` for orphan/source/link checks.
- Keep concept templates in `templates/` for manual additions.
- Update the research report whenever a tool is accepted, deferred, or rejected.
- Use `npm run obsidian:mcp:check` as the read-only gate before touching any Obsidian MCP runtime config.
- Do not schedule background watchers yet; manual command is lower burden and safer until the workflow proves repeated value.

## Risks
- Over-automation can create low-quality pages. Keep ingestion deterministic now; add model summarization only when the user requests a full compile pass.
- A background watcher could become a hidden runtime cost. Defer it until manual ingest becomes annoying.
- Real Obsidian MCP remains blocked until a vault, Local REST API plugin, listener, API key, and Noe MCP registration exist.

## Sources
- [Noe handoff](../../../docs/HANDOFF_2026-06-05_codex交接.md)
- [Noe knowledge method report](../../../docs/知识库方法论研究与落地_2026-06-05.md)
- [Noe follow-up audit](../../../docs/Noe后续计划完成审计_2026-06-05.md)

## Open Questions
After the first real week of use, decide whether wiki ingestion should be triggered by Noe room completion or remain manual.
