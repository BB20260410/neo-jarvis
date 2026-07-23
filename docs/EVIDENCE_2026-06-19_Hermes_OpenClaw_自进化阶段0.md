# EVIDENCE 2026-06-19 — Hermes/OpenClaw/Neo 自进化阶段 0

> 范围：阶段 0 统一基线 + 进入阶段 1 只读蒸馏的门禁证据。
> 约束：未重启 51835，未接管端口，未写 memory-v2，未提交，未 push，未修改 `AGENTS.md`。

## 仓库基线

| Repo | Command evidence | Result |
|------|------------------|--------|
| Neo | `git rev-parse --show-toplevel`; `git branch --show-current`; `git rev-parse --short=12 HEAD`; `git status --short --branch`; `node -p "require('./package.json').version"` | root `/Users/hxx/Desktop/Neo 贾维斯`; branch `noe-main`; HEAD `0063d9df1ebc`; ahead `origin/noe-main` by 299; dirty `M AGENTS.md` plus本轮新增 `.planning/` 和本路线 doc; version `2.1.0` |
| Hermes | 同上 + `pyproject.toml` version | root `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent`; branch `main`; HEAD `25c590ccd0c8`; dirty `?? .unity/`; package version `1.0.0`; project version `0.16.0` |
| OpenClaw | 同上 | root `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw`; branch `main`; HEAD `81eaa88ce56d`; dirty `?? .unity/`; package version `2026.6.8` |

## License / Provenance

| Repo | Evidence | Result |
|------|----------|--------|
| Hermes | `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent/LICENSE` | MIT License, Copyright 2025 Nous Research |
| OpenClaw | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw/LICENSE` | MIT License, Copyright 2026 OpenClaw Foundation |
| OpenClaw third-party notices | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw/THIRD_PARTY_NOTICES.md` | Pi / pi-mono adapted portions, MIT, Copyright 2025 Mario Zechner |

蒸馏报告只允许写能力/设计描述和文件位置，不复制外部仓源码片段。

## Runtime Snapshot

| Check | Result |
|-------|--------|
| 51835 readiness | `curl -sS --max-time 5 http://127.0.0.1:51835/api/noe/readiness` -> `ok:true`, readiness `passed`, blockers `[]`, loop/memory/fileIndex all `passed` |
| 51835 process | PID `85092`, started `Fri Jun 19 06:14:36 2026`, command `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node server.js` |
| 51735 observe-only listener | PID `71420`, TCP `127.0.0.1:51735` |
| Doctor lint | `npm run doctor:noe:lint` -> ok `true`, status `warn`, only warning is dirty worktree classification |
| Model key check | `npm run noe:keys:model:check` -> MiniMax and Xiaomi keys resolved from keychain; Gemini/OpenAI/Anthropic API keys unconfigured; no secret values printed |
| Model health | `npm run verify:noe:model-health` -> read-only, no chat/completion calls; LM Studio, Ollama, MiniMax, Xiaomi reachable; Gemini/OpenAI/Anthropic unavailable due secret unconfigured |

Important distinction: readiness `blockers:[]` is endpoint readiness evidence only. It does not close later final-acceptance blockers such as `curiosity_harvest_missing`, `affect_health_below_target`, Xiaohongshu publish-editor readiness, social fill/upload/publish proof, or owner voice ear review.

## Memory Retrieval Snapshot

只读 SQLite 摘要，不输出记忆正文：

| Query | Result |
|-------|--------|
| retrieval log table | `noe_memory_retrieval_log` exists |
| total retrieval rows | `572` |
| route aggregates | `chat: 541 rows, avg hit_ids 6.02, avg selected_ids 3.72`; `mission: 20 rows, avg hit_ids 2.55, avg selected_ids 2.25`; `reflection: 8 rows, avg hit_ids 0.625`; `maintenance: 3 rows, avg hit_ids 3.33` |
| latest rows | 最近 10 条均为 `chat`，selected count 5 或 5，部分 dropped reason 为 `over_budget` |

## Multi-Model Gate

Command:

```bash
npm run noe:consensus:round -- --goal "审核 2026-06-19 Hermes/OpenClaw/Neo 自进化蒸馏阶段0基线和总路线：是否可进入阶段1只读蒸馏；指出阻塞风险和必须先补的证据。" --evidence-file docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md --round-id 20260619-phase0-route-gate --run-models --ack-cost --active-executor codex --executor-selected-by user --executor-selection-reason "user_requested_multimodel_and_subagent_review_per_task"
```

Result:
- Status `consensus_passed`.
- Ledger: `output/noe-multimodel/20260619-phase0-route-gate/ledger.json`.
- Participants: Codex, Claude, M3.
- Dynamic quorum: available `3`, threshold `2`, approvals `3`.
- All decisions were `approve_with_changes`, not unconditional approval.

Main blockers from votes:
- Only authorized to enter Phase 1 read-only distillation, not implementation/self-code/live 51835/memory-v2 writeback/commit/push.
- Fill Hermes/OpenClaw gap tables with source references.
- Record license/provenance.
- Add Neo current capability baseline as the left side of gap analysis.
- Build NeoEvalCase/Run/Score schema and replay/private_holdout structure before any self-code implementation.

## Subagent Gate

| Agent | Scope | Status | Key result |
|-------|-------|--------|------------|
| Neo explorer | `/Users/hxx/Desktop/Neo 贾维斯` | completed | Neo has many source-level modules; risk is runtime/env/log evidence, especially memory injection, permission, secret, self-evolution dry-run |
| OpenClaw explorer | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw` | completed | Distill controlled capability assembly: proposal-first skill flow, thresholded memory/dreaming, fail-closed tool/permission gates, sandbox principles |
| Hermes explorer | `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent` | running, narrowed | Initial manual evidence already found MemoryProvider lifecycle, relay HMAC/replay-window auth, trajectory logging |

## OpenClaw Per-Topic Evidence

This table records source-path evidence for the OpenClaw comparison. It is still a read-only distillation index; no OpenClaw code is copied into Neo.

| Topic | Source paths checked | Evidence summary | Neo distillation boundary |
|-------|----------------------|------------------|---------------------------|
| skills discovery / limits / symlink containment | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw/src/config/types.skills.ts`; `src/skills/lifecycle/workspace-skill-write.ts` | Skill config separates load/install/limits/workshop entries; workspace skill writes normalize support paths, reject unsafe symlinks unless allowlisted, and keep support files under constrained roots. | Distill path/limit/symlink discipline only; Neo keeps memory/skill changes candidate-only until separately approved. |
| Skill Workshop proposal-first | `src/skills/workshop/service.ts`; `src/skills/workshop/policy.ts` | Proposals carry draft hashes, stale checks, scan/quarantine states, rollback metadata, and lifecycle approval policy. | Distill proposal metadata and rollback discipline; do not import OpenClaw proposal storage or apply flow. |
| memory dreaming / self-improvement | `src/memory-host-sdk/dreaming.ts`; `src/memory-host-sdk/events.ts`; `VISION.md` | Memory dreaming has phase config, promotion events, recall/promotion/dream JSONL audit events, and plugin-slot governance. | Distill event/evidence discipline and thresholded durable writes; do not absorb Dreaming/REM/self-improvement narrative or automatic memory-v2 writes. |
| tool planner / descriptors / availability | `src/tools/planner.ts`; `src/tools/availability.ts`; `src/tools/descriptors.ts` | Descriptor-backed planner separates visible tools from hidden tools with diagnostics and requires executor contracts for visible entries. | Distill descriptor/availability/risky-tool classification; verify with Neo F3 tool/MCP smoke and permission hooks. |
| MCP config / tool filter | `src/config/mcp-config.ts` | MCP server config is normalized and revalidated when tool include/exclude filters or server records change. | Distill config validation and tool-filter discipline; do not default-enable MCP/A2A or serialize raw env/secret values. |
| before_tool_call / trusted policy | `src/agents/agent-tools.before-tool-call.ts`; `src/plugins/trusted-tool-policy.ts` | before_tool_call runtime handles plugin hooks, trusted policies, approval, diagnostics, and loop blocking before execution. | Distill deny-wins/fail-closed ordering and diagnostic redaction; verify against `PermissionGovernance` and freedom executor tests. |
| sandbox / runtime config | `src/config/zod-schema.agent-runtime.ts`; `Dockerfile`; `README.md` | Runtime config blocks unsafe host/container network modes, validates absolute bind mounts, and Docker build uses read-only plugin/package mounts. | Distill sandbox constraints; keep Neo self-code limited to dry-run/schema/report and no live `51835` touch. |
| plugin market / packaged ecosystem | `VISION.md`; `README.md`; `THIRD_PARTY_NOTICES.md` | OpenClaw separates core vs plugin capability, ClawHub governance, and third-party provenance notices. | Distill governance/provenance concepts only; do not import ClawHub, plugin marketplace, third-party bundled skills, or UI channel bridge. |

## Current Decision

Phase 1 may proceed as read-only distillation only.
Any implementation, self-code dry-run, live 51835 change, memory-v2 writeback, commit, push, publish, restart, or secret access requires a new gate with evidence.

## NeoEval Schema Slice

Added after the phase-0 gate:
- `docs/NEOEVAL_SCHEMA_2026-06-19.md`
- `src/eval/NeoEvalSchema.js`
- `scripts/noe-eval-validate.mjs`
- `tests/unit/noe-eval-schema.test.js`
- `evals/neo/dev/case-memory-retrieval-smoke-001.json`
- `evals/neo/dev/run-schema-smoke-001.json`
- `evals/neo/dev/score-schema-smoke-001.json`
- `evals/neo/private_holdout/.gitignore`

Verification:
- Unit test: 1 file / 6 tests passed.
- Validator over `evals/neo`: checked 3, failed 0.
- Validator with artifact existence check over smoke case: checked 1, failed 0.
- Secret scan over new schema/validator/eval docs: no matches.

Gate status:
- `20260619-neoeval-schema-gate` did not complete; Claude CLI hung and the local audit process was terminated.
- Codex vote was `approve_with_changes` and required validator, redaction rules, private_holdout discipline, artifact checks, and no runtime authorization. Those blockers were addressed locally, but full multi-model re-gate is still pending.
