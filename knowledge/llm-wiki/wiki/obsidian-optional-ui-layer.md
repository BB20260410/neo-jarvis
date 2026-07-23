---
title: Obsidian As Optional Human UI Layer
concept: obsidian-optional-ui-layer
updated: 2026-06-06
decision: defer
priority: P1
tags: [noe-llm-wiki, obsidian, mcp, optional]
---

# Obsidian As Optional Human UI Layer

## Summary
Obsidian is valuable when it stays a human-facing Markdown workbench: backlinks, graph view, properties, Web Clipper, templates, and plugin UI make notes easier to inspect. For Noe automation, Obsidian should be optional. Noe should not depend on the app being open unless the user actively keeps a vault. The lowest-burden MCP route is now the Local REST API plugin's built-in Streamable HTTP MCP endpoint, not a separate third-party MCP server.

## Why It Helps Noe
- If a real vault exists, Noe can write durable notes directly into a tool the user can browse visually.
- Obsidian MCP can provide note read/write/search/frontmatter/tag operations without inventing a custom note UI.
- If no vault exists, forcing Obsidian adds setup and runtime burden; Noe's own Markdown wiki is enough.

## Replication
- Do not auto-install plugins or write fake API keys.
- If the user provides a vault and Local REST API key, prefer a Noe `http` MCP server entry for the plugin's built-in endpoint: `http://127.0.0.1:27123/mcp/` or `https://127.0.0.1:27124/mcp/`, with `Authorization: Bearer <api-key>`.
- Use `@cyanheads/obsidian-mcp-server` only as a fallback when the built-in MCP is unavailable or folder-scoped read/write policy is needed.
- Use only safe note operations first: get/list/search/append/patch/frontmatter/tag. Keep command execution and delete disabled.
- Copy only low-burden Obsidian ideas now: frontmatter fields, backlinks, source links, and template files.
- Run `npm run obsidian:mcp:check` before any runtime config change; it is read-only and prints no API key values.

## Risks
- Local REST API requires Obsidian running and a plugin key; this is an external-state dependency.
- HTTPS uses a self-signed certificate. Noe should use the local HTTP endpoint only on `127.0.0.1`, or trust the certificate before using HTTPS.
- Some plugins execute JavaScript or system commands. Templater is useful but must remain a user-side optional tool, not Noe's automation substrate.
- Copilot and Smart Connections overlap with Noe's own AI/retrieval stack; installing them just to look advanced would add burden.

## Sources
- [raw:raw/2026-06-05-obsidian-optional-ui-layer.md](../raw/2026-06-05-obsidian-optional-ui-layer.md)
- [Obsidian community plugins help](https://help.obsidian.md/extending-obsidian/community-plugins)
- [Obsidian Web Clipper help](https://help.obsidian.md/web-clipper)
- [Obsidian properties help](https://help.obsidian.md/properties)
- [Obsidian backlinks help](https://help.obsidian.md/plugins/backlinks)
- [Obsidian graph view help](https://help.obsidian.md/plugins/graph)
- [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server)
- [brianpetro/obsidian-smart-connections](https://github.com/brianpetro/obsidian-smart-connections)
- [SilentVoid13/Templater](https://github.com/SilentVoid13/Templater)
- [blacksmithgu/obsidian-dataview](https://github.com/blacksmithgu/obsidian-dataview)

## Open Questions
Wait for a valid local vault and Local REST API key before adding any Obsidian MCP runtime config. Current local readiness is intentionally blocked until `npm run obsidian:mcp:check` passes.
