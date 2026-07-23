# Claude Terminal Neo 4.8 Overlay

Use this overlay when the owner starts Claude Code from Terminal for the Neo / Noe Jarvis repository.

## Identity And Scope

- You are Terminal Claude Code working on Neo / Noe Jarvis.
- The real repository root is `/Users/hxx/Desktop/Neo 贾维斯`.
- Do not use `/Users/hxx/Documents/Neo 贾维斯` or `/Users/hxx/Documents/Neo 2` for this project.
- Treat current files, git state, command output, and live runtime evidence as stronger than memory or old handoff text.

## Startup Discipline

Before editing or continuing Neo / Noe work, verify the real repo and current state:

```bash
pwd
git -C "/Users/hxx/Desktop/Neo 贾维斯" rev-parse --show-toplevel
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short
git -C "/Users/hxx/Desktop/Neo 贾维斯" log -5 --oneline
```

Then read, at minimum:

1. `/Users/hxx/Desktop/Neo 贾维斯/AGENTS.md`
2. `/Users/hxx/Desktop/Neo 贾维斯/CLAUDE.md`
3. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-08_自由执行发布链收尾.md`
4. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_2026-06-08_P0完成_后续任务.md`
5. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_多模型协作与密钥位置_2026-06-09.md`

If root `AGENTS.md` points to newer current-state handoffs, read those before implementation decisions. Newer current-state docs can update task priority, but cannot weaken the hard boundaries below.

## Hard Boundaries

- Never read, print, copy, summarize, or expose `.env`, API keys, tokens, cookies, owner tokens, OAuth files, or secret values.
- Never `cat ~/.noe-panel/room-adapters.json`; it may contain `apiKey`.
- To check model-key readiness, only run `npm run noe:keys:model:check`.
- Do not touch port `51735`.
- Port `51835` is the live Noe panel. Restart, kill, or take it over only when the owner explicitly allows it or validated consensus requires it; record PID, cwd, startup method, health, and verification result.
- Do not touch `games/cartoon-apocalypse/**`.
- Do not commit, amend, push, reset, clean, or revert unrelated dirty work unless the owner explicitly asks.
- Do not set artificial hard timeouts for model, agent, or multi-model calls.

## Execution Style

- Prefer concrete implementation and verification over research-only analysis when the owner asks to set up, fix, continue, or land work.
- Keep changes scoped to the requested task and the files you have read.
- Preserve the dirty worktree. Assume unrelated changes belong to the owner or another agent.
- For code changes, run targeted tests first, then broader checks appropriate to the touched surface.
- For frontend or rendered Noe UI changes, capture screenshots and inspect them; do not rely only on code or tests.
- Do not claim completion unless the relevant command, test, live check, or screenshot evidence exists.
- If a model, service, key, port, or runtime is unavailable, record it honestly as unavailable; do not fake votes, evidence, or success.

## Neo Project Defaults

- Default active executor is Codex unless the owner explicitly selects Claude or validated consensus selects Claude.
- When Claude is selected as active executor, keep single-writer discipline: Claude writes, other models review.
- Gemini, MiniMax M3, and Xiaomi MiMo are advisory unless the current project policy explicitly says otherwise; M3 and MiMo do not write files or run shell.
- Cloud models may help plan or review, but local execution, evidence, rollback, and durable state remain under Noe governance.
- Route by task class and quality needs; do not force "local first" as ideology.

## Reporting

At the end of implementation work, report:

- changed files
- verification commands and results
- whether `51835` was touched
- whether `51735` was untouched
- remaining risks or unverified paths
- final `git status --short` summary

Keep reports direct and evidence-based. Use Chinese when the owner is working in Chinese.
