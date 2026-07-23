# Findings & Decisions

## Requirements
- 全面了解本地 Neo、Hermes、OpenClaw。
- 先审计和建证据底座，再做候选能力吸收。
- 先 dry-run，再进入 Neo 主线。
- 自改代码不能直接碰 live 51835。
- 阶段化推进，每完成一个任务就进行多模型和子代理审核，确认无阻塞问题后再继续。

## Repository Baseline
| Repo | Path | Branch | HEAD | Dirty state | Version evidence |
|------|------|--------|------|-------------|------------------|
| Neo | `/Users/hxx/Desktop/Neo 贾维斯` | `noe-main` | `0063d9df1ebc` | `M AGENTS.md`; branch ahead of `origin/noe-main` by 299 | `package.json` version `2.1.0` |
| Hermes | `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent` | `main` | `25c590ccd0c8` | `?? .unity/` | `package.json` version `1.0.0`; `pyproject.toml` project version `0.16.0` |
| OpenClaw | `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw` | `main` | `81eaa88ce56d` | `?? .unity/` | `package.json` version `2026.6.8` |

## Research Findings
- Neo repo has no existing `.planning/` directory before this task; this session created a dedicated one.
- Existing handoff for current chain: `docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md`.
- Existing analysis doc for previous OpenClaw distillation: `docs/分析_OpenClaw蒸馏_可吸收清单与P0定案_2026-06-19.md`.
- Historical memory warns not to treat source-only evidence as live 51835 proof; this remains a hard evidence boundary.
- Historical memory says Gemini was removed from core quorum after health checks; current multi-model availability still must be verified before claiming it ran.
- 51835 readiness is currently `passed`; PID `85092` started `Fri Jun 19 06:14:36 2026`; this was a read-only probe and did not restart runtime.
- `npm run verify:noe:model-health` is read-only and reported no chat/completion calls; LM Studio, Ollama, MiniMax, and Xiaomi were reachable; Gemini/OpenAI/Anthropic API keys were unconfigured.
- `npm run noe:consensus:round` for `20260619-phase0-route-gate` produced `consensus_passed` with Codex, Claude, and M3 all `approve_with_changes`.
- OpenClaw subagent concluded the valuable distillation is controlled capability assembly: proposal-first skill flow, thresholded memory/dreaming, fail-closed permission gates, sandbox principles.
- Neo subagent concluded the main gap is runtime/env/log evidence rather than absence of modules.
- Hermes and OpenClaw main licenses are MIT; OpenClaw also carries `THIRD_PARTY_NOTICES.md` for Pi / pi-mono adapted portions.
- NeoEvalCase / NeoEvalRun / NeoEvalScore schema draft exists at `docs/NEOEVAL_SCHEMA_2026-06-19.md`.
- Eval layer directories exist at `evals/neo/dev`, `evals/neo/regression`, and `evals/neo/private_holdout`; private holdout real content is ignored.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Do not touch `AGENTS.md` | It is an existing unrelated dirty file explicitly called out by the handoff. |
| Do not edit `.env` or live runtime paths in this phase | Objective says self-code changes cannot touch live 51835; phase 0/1 are evidence-only. |
| Use subagents as reviewers and focused explorers | User explicitly requested child agents and per-task review gates. |

## Resources
- `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md`
- `/Users/hxx/Desktop/Neo 贾维斯/docs/分析_OpenClaw蒸馏_可吸收清单与P0定案_2026-06-19.md`
- `/Users/hxx/Desktop/Neo 贾维斯/docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md`
- `/Users/hxx/Desktop/Neo 贾维斯/docs/NEOEVAL_SCHEMA_2026-06-19.md`
- `/Users/hxx/Desktop/Neo 贾维斯/evals/neo/README.md`
- `/Users/hxx/Desktop/Neo 贾维斯/output/noe-multimodel/20260619-phase0-route-gate/ledger.json`
- `/Users/hxx/Desktop/Neo 贾维斯/.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`

## Open Questions
- Which Neo existing scripts best support baseline audit and replay case generation without altering 51835?
- Whether current Neo consensus/multi-model runner can execute in this environment; this must be tested before relying on it as a gate.
- Which existing trace/eval files can seed the first 30-50 replay cases without leaking private data.
- First Hermes all-repo subagent was interrupted/shutdown after failing to return in time; a narrower Hermes quick-review subagent completed and supplied the P0/P1/P2 gap table.
