# Neo Phase 6 P2 Boundary And Final Real-Machine Test Plan

更新时间：2026-06-19

## 结论

Phase 6 只关闭边界和最终实机测试计划，不解锁执行链。

已完成的 Phase 5 只证明 dry-run/schema/report 能安全落地：archive、scorecard、PR repair、GraphMemory/PlanValidator/CausalRiskGate 边界决策、PlanValidator dry-run。它们没有授权 live self-upgrade、自动合入、自动发布、自动重启 `51835`、自动写 memory-v2、GraphMemory 写入、CausalRisk runtime gate、真实 patch apply、真实 PR、真实 evaluator/model/API 执行。

## 明确不做

- 不做 live self-upgrade。
- 不自动合入、提交、推送、开 PR 或发布。
- 不自动重启 live `51835`。
- 不自动写 memory-v2、SkillStore、GraphMemory。
- 不安装 CausalRisk runtime gate。
- 不读 secret、owner token 原文、`.env*`、`room-adapters.json`、private_holdout。
- 不把 HyperAgents、recursive self-modification、OpenPipe ART、RL、DPO、MCP-A2A 默认启用。
- 不让 DGM/SICA/AgentBreeder 风格 archive 直连生产自改代码。

## 可直接执行的最终实机测试

这些测试是本机真实命令或只读 live 探针，允许在没有额外敏感授权时执行：

| 类别 | 命令或操作 | 证明内容 | 边界 |
| --- | --- | --- | --- |
| Node/runtime | `npm run verify:node22` | 当前 Node 版本门禁 | 不改服务 |
| 基础诊断 | `npm run doctor:noe:lint` | 本机环境、dirty 状态、基础配置 | 跳过网络 |
| 模型配置 | `npm run noe:keys:model:check` | keychain 中哪些模型可用 | 不打印 key 值 |
| 模型健康 | `npm run verify:noe:model-health` | LM Studio/Ollama/MiniMax/Xiaomi 等健康快照 | 不做任务型付费调用 |
| 共识账本 | `npm run verify:noe:consensus-ledger -- --ledger <ledger> --require-artifacts --require-evidence --require-passed` | 多模型门禁 ledger 可验证 | 只读文件 |
| 当前功能总检 | `npm run verify:noe:full-current` | P0 单测、知识/交接/wiki/external readiness 默认矩阵 | 默认不读 owner token、不跑 live protected action |
| 100 readiness | `npm run verify:noe:100-readiness` | 只读 DB 汇总和 readiness 探针 | 只读 DB/live GET |
| runtime evidence | `npm run verify:noe:runtime-evidence` | 运行证据、memory runtime、认知/期待等只读证据 | 不读 secret、不调用模型 |
| memory/report | `npm run verify:noe:memory-status`、`npm run verify:noe:memory-utility-lite` | 记忆状态和 utility lite | 只读或 candidate-only 报告 |
| self-evolution dry-run | `npm run verify:noe:candidate-patch-dry-run`、各 Phase 5 dry-run CLI | 自改代码候选仍停留 dry-run | 不 apply patch |
| UI/e2e | `npm run test:e2e:raw` 或 Playwright live 只读 walkthrough | 面板页面能打开、核心 UI route 可用 | 不提交表单、不执行 protected action |
| Electron | `npm run smoke:electron` | 桌面壳能启动 smoke | 不发布、不签名 |
| SCA | `npm_config_registry=https://registry.npmjs.org npm audit --omit=dev --audit-level=high` | high/critical 依赖风险 | 不自动升级 |
| Secret/body scan | 高信号 `rg` 扫描 docs/output/src/tests | 无 raw secret、无正文泄漏 | 不读取 secret 文件 |

## 需要额外明确授权的最终实机测试

这些测试会触碰红线，必须单独说明风险并得到明确放行后才执行：

| 类别 | 需要授权的动作 | 风险 | 最小安全做法 |
| --- | --- | --- | --- |
| owner token | 读取或使用 owner token 调 protected endpoint | token 泄漏、权限误用 | 只从 keychain/授权机制读取，输出全量脱敏，不写入 docs/log/raw |
| live `51835` 写操作 | protected act、memory apply、skill apply、proposal execution | 改 live 状态或用户数据 | 用 scratch 输入，记录 rollback，先 read-only 预检 |
| 重启 live `51835` | `restart:panel`、runtime restart drill | 打断当前服务和长任务 | 先保存状态，明确窗口，失败可回滚 |
| patch apply/rollback | `verify:noe:patch-apply`、rollback drill | 改工作树、可能覆盖未提交改动 | 只在 isolated scratch branch/worktree，先 diff/backup |
| 对外发布 | `dist:publish`、GitHub/PR/社交发布 | 公开历史、外发消息、扣费 | 默认不执行 |
| 付费 API | 真实模型任务、云资源、外部 provider | 花钱或耗配额 | 单独 ack 成本和范围 |
| private_holdout | 读取隐藏集内容 | reward hacking、评测污染 | 默认永不读取；只允许 validator 拒绝路径 |

## 最终验收原则

- 先跑安全矩阵，再对子代理和多模型提交证据。
- 若安全矩阵全部通过，但敏感/live 写测试未授权，结论只能写“安全矩阵通过；敏感/live 写测试未执行”，不能写“所有功能完全无问题”。
- 若用户明确授权 owner token/live 写/重启，必须按最小范围、脱敏输出、可回滚、逐项证据执行，并在每个阶段后重新做子代理和多模型审核。
- 任何失败不改测试迁就，先修根因或记录阻塞。
