# Noe LLM Wiki Rules

This folder is a local-first knowledge layer for Noe.

## Structure

- `raw/`: append-only source material. Do not rewrite or delete source notes.
- `wiki/`: curated concept pages maintained by an AI or user.
- `wiki/index.md`: the directory of maintained concept pages.
- `wiki/log.md`: append-only maintenance log.

## Ingest Rules

1. Read new files under `raw/`.
2. Create or update one concept page per durable concept under `wiki/`.
3. Preserve source references with local file paths or URLs.
4. Update `wiki/index.md` when a concept page is added, renamed, or retired.
5. Append one entry to `wiki/log.md` for every ingest or lint action.

Default command:

```bash
npm run wiki:ingest
npm run wiki:lint
```

## Page Rules

- Keep page titles stable.
- Prefer concise sections: summary, facts, links, open questions.
- Use Markdown links between related wiki pages.
- Do not store secrets, raw API keys, credentials, private tokens, or `.env` values.
- If a source is uncertain, label it as uncertain instead of treating it as fact.

## Lint Rules

Every maintenance pass should check:

- orphan wiki pages not referenced by `wiki/index.md`;
- broken local links;
- pages with no source references;
- duplicate concept pages;
- stale open questions.

## Burden Rules

- Keep Obsidian optional until a real vault and Local REST API key exist.
- Do not add background watchers, launchd jobs, or plugin installs unless manual ingest becomes a repeated burden and the user explicitly approves.
- Prefer small deterministic scripts before LLM summarization or external services.
