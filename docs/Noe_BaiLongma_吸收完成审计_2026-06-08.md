# Noe BaiLongma 吸收完成审计

日期：2026-06-08

真实仓库：`/Users/hxx/Desktop/Neo 贾维斯`

## 结论

本轮 BaiLongma 学习吸收已经完成当前可安全落地的 P0/P1 内容。剩余 P2 内容不是“没发现价值”，而是需要新的明确授权、产品范围或更高风险治理后才能做：

- 社交外发：需要外部发布/发送授权和连接器策略。
- 工具市场：需要 trust manifest、allowlist、dry-run、rollback 和 PermissionGovernance 进一步设计。
- 私有桌面 App shell：需要独立 App 产品目标、打包/权限/启动策略。
- 启动资源感知：需要用户同意的范围，不允许扫描或提示注入 SSH、keychain、`.env`、桌面清单。

因此，当前 Noe 不再继续从 BaiLongma 提取新的低风险核心能力；后续只在用户明确开启 P2 产品方向时继续。

## 多模型研究证据

- 五模型研究 ledger：`output/noe-multimodel/bailongma-online-five-model-research-20260608000625/ledger.json`
- 研究计划：`output/noe-bailongma-research-20260607-online-five-model/final-plan.md`
- 执行 playbook：`output/noe-bailongma-research-20260607-online-five-model/detailed-execution-playbook.md`
- Gemini 3.1 Pro 补充：`output/noe-bailongma-research-20260607-online-five-model/gemini31-bailongma-rerun-20260608002500/gemini-3.1-pro-preview.txt`

## 已吸收并落地的能力

| BaiLongma 经验 | Noe 落地结果 | 关键证据 |
| --- | --- | --- |
| 可发现命令面 / `find_tool` | 命令发现、help、schema、dry-run、自然语言 route | `src/capabilities/NoeCommandSurface.js`, `src/capabilities/NoeToolRouter.js`, `src/server/routes/noeCommands.js` |
| 行动前上下文充分性 | `NoeContextSufficiencyGatherer` + ActPipeline preflight | `src/context/NoeContextSufficiencyGatherer.js`, `src/loop/ActPipeline.js` |
| stable prompt / dynamic context split | `NoeContextEngine` 统一 memory/focus/fileIndex/UI/card 上下文 | `src/context/NoeContextEngine.js` |
| ActionLog / runtime evidence | ActPipeline dry-run/realExecute 都生成 `actionEvidence` | `src/runtime/NoeActionEvidence.js`, `tests/unit/noe-action-evidence.test.js` |
| `review_work` fresh-eyes | post-review pack/runner 与 self-evolution cycle 证据链 | `src/room/NoePostReviewPack.js`, `src/room/NoePostReviewRunner.js` |
| Focus stack / `focus_conclusion` | 中文时间词召回：刚刚、上一轮、昨天、前天、上周 | `src/memory/NoeActiveMemory.js`, `tests/unit/noe-active-memory.test.js` |
| ACUI 卡片 | 状态卡片 show/update/patch/hide + context-only 脱敏回流 | `src/runtime/NoeAcuiCardStore.js`, `public/src/web/cognitive-acui-lite.js` |
| user/background queue | 用户任务协作式抢占后台任务，不杀进程 | `src/runtime/NoeLaneQueue.js`, `tests/unit/noe-lane-queue.test.js` |
| 可审计自我进化 | consensus ledger、cycle artifact、completion audit 全通过 | `scripts/noe-self-evolution-completion-audit.mjs` |
| 本地多模型讨论 | LM Studio/Ollama discovery、真实 rawOutputRef、cross-review、ledger | `src/room/NoeLocalModelCouncil.js` |
| 模型密钥稳定 | Keychain 解析和检查脚本，不把 key 写入仓库或日志 | `src/secrets/NoeProviderSecrets.js`, `scripts/noe-model-keychain-setup.mjs` |
| 项目体检 | NoeDoctor 只读检查 git、端口、锁文件、本地模型 | `src/runtime/NoeDoctor.js` |

## 明确拒绝照搬

1. 不直接复制 BaiLongma 源码。
2. 不给模型/agent/多模型调用设置人为 hard timeout。
3. 不移植宽口径 JS 工具市场和 unrestricted `exec/fetch`。
4. 不把本地 SSH、keychain、`.env`、桌面清单、安装软件清单塞进 prompt。
5. 不做未经授权的社交外发、上传、发布、删除、重启或杀进程。
6. 不引入会破坏当前 Node/runtime 的原生存储依赖。
7. 不新增绕过 `PermissionGovernance` / `ActPipeline` / `NoeConsensusGate` 的平行权限系统。

## P2 冻结项

| 方向 | 状态 | 解冻条件 |
| --- | --- | --- |
| 社交 dispatch | 冻结 | 用户明确要求接入具体渠道，并走外部发布/发送授权 |
| 工具 marketplace | 冻结 | 先完成 trust manifest、allowlist、dry-run、rollback、permission scopes |
| 私有桌面 App shell | 冻结 | 用户明确切换为 App 产品化任务 |
| 启动资源感知 | 冻结 | 用户给出允许扫描范围，且默认脱敏、只读、可审计 |

## 最终验证证据

- `npm run test:p0:unit`：51 files / 315 tests passed。
- `npm run verify:noe:self-evolution`：190/190 passed。
- `npm run verify:noe:full-current -- --include-managed --skip-live --skip-cognitive`：11/11 passed。
- 最新 full-current 报告：`output/noe-full-current/full-current-1780867863466.json`。
- `npm run audit:noe:self-evolution-completion`：11 pass / 0 incomplete / 0 blockedExternal。
- 真实密钥前缀扫描：0 命中。
- `51835` 未重启、未杀进程、未抢占。

## 当前剩余风险

- live `51835` 没做重启式实机验证；本轮遵守“不重启/不抢占”边界，只做 skip-live 验证和只读端口检查。
- 本地模型和线上模型可用性会随 LM Studio/Ollama/API 额度漂移，后续真实多模型任务仍要重新 discovery/health check。
- P2 高风险能力已经明确冻结，不能被当成本轮未完成 bug。

## 大白话版本

Noe 已经把 BaiLongma 最核心的“会行动、会找工具、会补上下文、会留证据、能被复审、能显示状态、能记住刚刚做了什么、用户来了能打断后台活”这些能力吸收进来了。

剩下那些“发微信/发飞书/装第三方工具/做桌面 App/开机扫描环境”不是没价值，而是风险和产品范围更大，不能在这一轮悄悄做。它们已经被放进冻结清单，等用户明确要做时再开。
