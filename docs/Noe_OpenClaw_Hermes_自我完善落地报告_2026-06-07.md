# Noe OpenClaw / Hermes 自我完善阶段性落地报告

日期：2026-06-07

说明：这是 Neo / Noe 在 `/Users/hxx/Desktop/Neo 贾维斯` 内的阶段性落地记录，不表示完整自我进化闭环已经完成。完整闭环仍以 production consensus ledger、runtime report、post-review、retrospective 和 memory writeback evidence 为准。

## 落地范围

本次从 OpenClaw 和 Hermes 的源码设计中提炼并落地到 Noe：

- NoeDoctor：只读体检 CLI 和 `/api/noe/doctor`，输出结构化 findings。
- TaskFlow 账本：`NoeTaskFlowStore` 和 `scripts/noe-taskflow.mjs`，用于记录自我进化步骤和证据。
- Lane Queue：`NoeLaneQueue`，按 workspace/session/model 等 lane 串行化任务。
- Context Scrubber：`NoeContextScrubber`，统一清洗 hidden context、internal channel 和密钥样式文本。
- Tool Guardrail：`ToolCallGuardrailController`，识别重复失败和无进展工具循环。
- Background Review：`NoeBackgroundReview`，只生成 memory/skill/action proposal，不直接写入。
- Lane Queue Preemption：`NoeLaneQueue` 支持 `background/normal/user` 优先级；用户任务可协作式抢占同 lane 后台任务，只设置 `cancelRequested`，不杀进程。
- Skill Curator：`SkillCurator` 和 `scripts/noe-skill-curator.mjs`，支持 pinned/stale/archive_candidate 分类，默认 dry-run。
- Context Engine：`NoeContextEngine`，把 memory/focus/fileIndex 统一装配成上下文包。
- Gateway Protocol：`NoeGatewayProtocol`，定义 connect/request/response/event/heartbeat frame，侧效请求要求 idempotency key。
- ACUI-lite Cards：`NoeAcuiCardStore`、`/api/noe/acui/cards/*` 和 `cognitive-acui-lite.js`，支持任务/计划/权限/证据/复审/回滚/阻断卡片的 show/update/patch/hide，并以脱敏 context-only 摘要回流上下文。
- Active Memory：`NoeActiveMemory`，在主回复前构造 `<memory-context>` 预回忆块，并默认只面向直接会话。
- Focus Conclusion：`NoeActiveMemory` 支持 `focus_conclusion` 写入与“刚刚/上一轮/昨天/前天/上周”中文时间词召回；写入默认阻断，必须有用户确认或 validated consensus ledger 形态的 `consensusAck`。
- Local Council 健康分类：ledger 新增 `modelHealth`，区分 `model_unloaded`、`invalid_json_response`、provider 错误。
- Supply-chain doctor：NoeDoctor 增加 `package-lock.json` lockfile 检查。

## 当前仓库内验证证据

- `npm run test:p0:unit`：294/294 passed（拆提交前基线）。
- `npm run verify:noe:self-evolution`：190/190 passed（拆提交前基线）。
- `npm run verify:noe:full-current -- --include-managed --skip-live --skip-cognitive`：11/11 passed（拆提交前基线）。
- Local council smoke ledger：`output/noe-local-council/local-council-finalanswer-smoke-1780865327722/ledger.json`，包含真实 provider evidence、`crossReviews`，`finalAnswer` 不含 internal channel / reasoning-only 标记。
- 本轮拆提交过程中各功能组已分别跑 targeted tests，最终以最新全量验证为准。

## 代码审查修复

- 修复 `NoeDoctor` 解析 `git status --short` 时错误 trim 行首空格，避免路径首字符丢失。
- 修复 MiniMax CLI 缺失兜底文案，保持测试契约中的 `not found`。
- 修复 `ContextEngine` 把 `<memory-context>` 当输出清洗导致记忆未进入模型上下文的问题。
- 调整 `StreamingContextScrubber`，避免未闭合 hidden block 在分片 flush 时提前暴露。
- 补充 local council 模型健康分类，避免只保存原始 HTTP 错误。

## 剩余风险

- LM Studio `/models` 不能证明模型已加载；真实可用性只能通过实际调用或后续 readiness probe 验证。
- 裸开页面仍会出现受保护接口轮询错误，必须使用启动输出的链接或 owner-token 注入流程。
- Skill Curator 当前没有可策展的 Noe skills，因此只验证了 dry-run 管线。
- 这不是外部发布、系统清理或自动写长期记忆授权；敏感动作仍要走 Noe 高风险授权边界。
