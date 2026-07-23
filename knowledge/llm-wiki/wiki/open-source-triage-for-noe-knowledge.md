---
title: Open Source Triage For Noe Knowledge Workflows
concept: open-source-triage-for-noe-knowledge
updated: 2026-06-06
decision: borrow
priority: P0
tags: [noe-llm-wiki, github, huggingface, triage]
---

# Open Source Triage For Noe Knowledge Workflows

## Summary
Live GitHub metadata on 2026-06-05 shows several mature projects around Karpathy-style wiki compilation and Obsidian AI workflows. The useful action for Noe is selective borrowing, not wholesale adoption. `claude-obsidian` and `llm-wiki-compiler` validate the compiled-wiki direction; Obsidian Local REST API's built-in MCP is the lowest-burden optional bridge; `obsidian-mcp-server` is a fallback; `haiku.rag` validates persistent ingest queues but overlaps with Noe's existing LanceDB/SQLite stack.

## Why It Helps Noe
- It prevents duplicated engineering: we replicate small patterns that remove work, not complete products that create another system to maintain.
- It gives a concrete reject list, so future agents do not keep re-researching the same attractive but heavy options.
- It records current open-source evidence near the implementation, making future audits cheaper.

## Replication
- Replicate now: raw-to-wiki compile, generated index, append-only log, source links, lint gates.
- Borrow later: persistent ingest queue with retries from `haiku.rag` if raw ingestion becomes frequent enough to justify it.
- Optional only: Obsidian Local REST API built-in MCP, Smart Connections, Templater, Dataview.
- Fallback only: `@cyanheads/obsidian-mcp-server` when the built-in MCP cannot satisfy Noe's policy needs.
- Reject for now: full external wiki compiler, full RAG stack, Obsidian Copilot agent mode, any plugin requiring a paid cloud feature or extra always-on service.

## Risks
- GitHub star counts and activity drift; re-check before adopting code.
- Licenses differ. MIT/Apache patterns are easier to copy; AGPL plugins should remain user-installed tools unless legal review approves code integration.
- Hugging Face model pages were searched, but direct API access from this machine failed with TLS errors. No new embedding model is required for this phase because Noe already has a local embedding/file-index path.
- A third-party Obsidian MCP server adds another runtime. Prefer the Local REST API plugin's own `/mcp/` endpoint when it is available.

## Sources
- [raw:raw/2026-06-05-open-source-triage.md](../raw/2026-06-05-open-source-triage.md)
- [AgriciDaniel/claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)
- [atomicstrata/llm-wiki-compiler](https://github.com/atomicstrata/llm-wiki-compiler)
- [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server)
- [ggozad/haiku.rag](https://github.com/ggozad/haiku.rag)
- [brianpetro/obsidian-smart-connections](https://github.com/brianpetro/obsidian-smart-connections)
- [logancyang/obsidian-copilot](https://github.com/logancyang/obsidian-copilot)
- [SilentVoid13/Templater](https://github.com/SilentVoid13/Templater)
- [blacksmithgu/obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview)
- [Qwen/Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)
- [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)

## Open Questions
If Noe's wiki grows beyond manual-size review, compare `llm-wiki-compiler` eval ideas against Noe's own lint output before importing any package.
