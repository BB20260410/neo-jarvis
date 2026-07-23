# 集群协同完成度审计

更新时间: 2026-05-31

## 结论

`cross_verify` 已从“双模型互验”升级为“集群协同”: 面向单一项目目标,具备启动前预检、11 阶段工程闭环、多 AI 对等互审、代码驱动证据门禁、验收返工、复盘优化、交付包、归档和 Activity 审计。

当前审计结论: 已满足本轮目标的主体闭环要求。代码驱动阶段已从“声明式硬证据可通过”收紧为“必须绑定成功 Agent Run 证据才允许交付”;其中安全白名单内的 `node --check <相对路径>` 会自动真实执行,成功后自动绑定证据,失败则触发返工/暂停。启动前预检已从“adapter 名字存在”收紧为“adapter 已注册、具备 `chat()` 能力、并能通过轻量 live ping”。集群协同还具备启动前调用量/Token 复杂度估算,过大的模型集群会被预检阻断。

## 用户目标映射

| 用户要求 | 当前实现 | 证据 |
|---|---|---|
| 工程化、闭环式、多 AI 智能体协作 | `CrossVerifyDispatcher` 串行推进 11 个工程阶段,每阶段多成员并行提案、互审、显式签字 | `src/room/CrossVerifyDispatcher.js` |
| 围绕单一项目目标 | task list 和 preflight 均要求 topic/project goal | `buildClusterEngineeringTaskList`, `buildClusterPreflight` |
| 用户想法到复盘优化全流程 | `CLUSTER_ENGINEERING_STAGES` 固定 11 阶段: idea 到 retrospective | `src/room/CrossVerifyDispatcher.js` |
| 代码驱动 | implementation/unit/integration/functional_validation 有硬证据要求,且交付前必须绑定成功 Agent Run 证据 | `CODE_DRIVEN_STAGE_EVIDENCE`, `buildEvidenceRequirement`, `clusterEvidenceLinks` |
| 测试兜底 | 单测覆盖调度、预检、返工、报告、交付包、归档; e2e 覆盖 UI 主路径 | `tests/unit/*`, `tests/e2e/panel-ui-walkthrough.mjs` |
| 最终交付 | 生成 manifest、Markdown report、package index、download API、archive API | `buildClusterDeliveryManifest`, `buildClusterDeliveryReportMarkdown`, `buildClusterDeliveryPackage`, `rooms.js` |
| 可审计 | 归档写入 Activity: `cluster.delivery.archived` | `src/server/routes/rooms.js`, Activity UI |
| 证据透明 | 区分声明式硬证据和 Agent Run 已验证证据;缺 Agent Run 绑定时交付门禁阻断,避免把模型文本伪装成已执行事实 | `cluster-evidence-integrity-v1` |
| 成员原生能力 | GPT/Claude/Gemini 不共享一套公共 Skill;每个 adapter 声明并注入自己的原生运行时、账号配置、插件/工具/MCP 能力边界 | `RoomAdapter.getNativeCapabilities`, `injectSkillsToMessages`, `CrossVerifyDispatcher._call` |

## 关键能力清单

1. 启动前预检

- API: `GET /api/rooms/:id/cluster-preflight`
- live ping API: `GET /api/rooms/:id/cluster-preflight?live=1`
- UI: `🧪 闭环预检`
- 启动门禁: `/api/rooms/:id/debate` 对 `cross_verify` 强制执行预检,阻断时返回 `409 cluster_preflight_blocked`
- adapter 门禁: 启用成员不仅要 `adapterId` 已注册,还必须能从 `roomAdapterPool.get(adapterId)` 取到具备 `chat()` 的 adapter;否则返回 `adapter_unavailable=<id>:chat_unavailable`
- live ping 门禁: 启动集群协同时会对每个启用成员发起受超时保护的轻量 `chat()` 探活;失败时返回 `409 cluster_live_check_blocked`,避免进入 11 阶段后才全红
- execution budget 门禁: 启动前按成员数、11 阶段、互审轮次估算最坏调用量和 Token;超出硬阈值时返回 `execution_budget:*` 阻断项,避免大型集群一键启动后失控

2. 11 阶段工程闭环

- 用户想法
- 需求分析与拆解
- 技术方案设计
- 任务分配与排期
- 代码开发
- 单元测试
- 集成测试
- 功能验证
- 文档编写
- 交付验收
- 复盘优化

3. 多 AI 对等协作

- 2+ 成员
- 每阶段独立提案
- 集体互审
- 全员 `agree=true` 才进入下一阶段
- 不一致最多多轮修订,超过后升级阻断

4. 代码驱动证据门禁

- 代码开发要求文件或命令证据
- 单元测试要求命令证据
- 集成测试/功能验证要求命令或运行/UI 证据
- 硬证据不足会触发自动修复;仍不足则暂停
- 交付清单包含 `evidenceIntegrity`,明确标注当前硬证据是否只是成员输出中声明的命令/文件/UI证据
- `verifiedRunEvidenceStageCount` 只统计 4 个代码驱动阶段,非代码阶段的 Agent Run 绑定会进入 `nonCodeVerifiedRunEvidenceStages`,但不能替代代码开发/单测/集成/功能验证证据
- `verifiedRunEvidenceStageCount` 必须覆盖 4 个代码驱动阶段,否则 `deliveryGate` 写入 `agent_run_evidence_incomplete=x/4` 并阻断交付
- 交付门禁未通过时,房间最终状态保持 `paused` 并广播 `cross_verify_paused:delivery_gate_blocked`,避免 11 阶段跑完但交付不可用时被误标为完成
- API `POST /api/rooms/:id/cluster-evidence-links` 用于把阶段绑定到成功的 Agent Run 执行记录
- 手动绑定 Agent Run 证据时会校验归属:如果 Agent Run 明确属于其它 room 或其它 task,直接拒绝,避免跨项目/跨阶段证据污染当前交付门禁
- 手动重复绑定同一 `stageId + agentRunId` 时返回幂等结果 `duplicate: true`,不重复追加 `clusterEvidenceLinks`,也不重复写 Activity
- 自动绑定 Agent Run 证据也会校验归属:adapter 返回的 `agentRunId` 必须属于当前 room,且 taskId 与当前阶段任务一致,否则不会写入 `clusterEvidenceLinks`
- Agent Run 证据计数只把成功/未失败的 tool result 计入有效工具证据;明确 `failed/error/blocked/approval_required/cancelled/timeout` 的工具结果不会单独放行代码驱动证据门禁
- 交付清单最终统计也会过滤历史脏链接: `runStatus` 明确非 `succeeded` 或 `evidenceCount/tool/archive/artifact` 全为 0 的 `clusterEvidenceLinks` 不会计入 `verifiedRunEvidenceStageCount`
- 手动绑定 Agent Run 证据后会立即重算 `clusterWorkflowAudit` / `clusterDeliveryManifest` / `clusterDeliveryReportMarkdown` / `clusterDeliveryPackage`;当 4 个代码驱动阶段证据补齐且交付门禁通过时,房间会从 `paused` 推进到 `done`
- 证据补齐导致交付门禁首次通过时,后端广播 `cluster_delivery_ready`;前端会 toast 提示并刷新房间,避免用户必须手动刷新才看到 `done/ready`
- `CrossVerifyDispatcher` 已接入 `agentRunStore`;代码驱动阶段的 adapter 调用如果返回 `agentRunId`,且该 Agent Run 成功并有 tool/archive/artifact 证据,会自动写入 `clusterEvidenceLinks`
- 代码驱动阶段已增加保守自动验证器:只从阶段证据中提取安全的 `node --check <相对路径>` 命令,用本机 Node 真实执行语法检查,生成 Agent Run tool result;成功才自动绑定,失败不会进入交付门禁
- 每个成员调用前会注入自己的原生能力边界:
  - Claude: 通过 Claude Code CLI 执行,保留 Claude Code 账号级能力、settings/hooks、原生工具链和 MCP
  - GPT: 通过 Codex CLI 执行,保留 Codex/GPT 账号级能力、Codex CLI 可见的 AGENTS/skills/profiles/plugins/MCP,并接入 Codex App 插件桥接协议
  - Gemini: 通过 Gemini CLI 执行,保留 Gemini CLI OAuth 会话、模型能力和 CLI 实际开放的检索/工具能力
- 集群协同模式下默认禁用共享 `room.skills` 注入,避免 GPT/Claude/Gemini 三个成员一起拿到同一个公共 Skill/插件提示而串用能力;如果某个原生插件只存在于 GPT/Codex,不会假装 Claude/Gemini 也有
- Codex App 插件桥接规则:如果插件/连接器已在 Codex CLI 运行时真实暴露,GPT 成员可直接调用;如果只存在于 Codex 桌面聊天上下文,必须输出 `CODEX_APP_PLUGIN_REQUEST` 块,等待外层代理执行,不得伪造工具结果
- 自动绑定会广播 `cluster_evidence_auto_linked`,并按 `stageId + agentRunId` 去重

5. 成本/时延治理

- `buildClusterExecutionBudgetEstimate` 估算成员数、阶段数、最大互审轮次、live ping 调用、最坏调用量和最坏 Token
- 默认 2-3 模型集群正常通过;过大的 7+ 模型集群会在启动前被 `cluster_preflight_blocked` 阻断
- 预检结果包含 `budgetEstimate`,便于 UI 和交接文档解释为什么被挡
- `clusterRuntimeTelemetry` 在运行中累计真实模型调用次数、成功/失败数、tokensIn、tokensOut、totalTokens、总时延、平均时延、最大时延和按 adapter 聚合数据
- 每次模型调用后广播 `cluster_runtime_metric`,前端可直接接入进度条和成本/时延面板
- `clusterRuntimeBudgetStatus` 在运行中检查调用数、总 Token、平均时延是否接近或超过阈值
- 超过硬阈值时广播 `cluster_runtime_budget`,中止当前 abort signal,并把房间状态置为 `paused`,防止继续失控消耗
- 成员故障转移:
  - 运行中某成员因掉线、spawn/network 错误、超时、额度/限流等失败时,记录到 `clusterDroppedMembers` / `clusterMemberFailovers` / `task.memberFailovers`
  - 后续阶段自动排除已掉线成员,避免反复调用同一个不可用模型
  - 剩余成员收到故障转移上下文,要求自动覆盖掉线成员职责
  - 只剩一个成员时进入 `cv_solo_takeover` 单模型接管模式,继续完成阶段和后续交付
  - 主动用户中断与成员掉线分离;用户 abort 只会暂停,不会触发自动接手并误标完成

6. 验收返工

- 验收阶段对前序阶段生成验收表
- 失败或证据不足时自动回到失败阶段返工
- 自动返工上限: 5 次
- 上游返工会让下游阶段失效并重跑

7. 最终交付资产

- `clusterDeliveryManifest`
- `clusterDeliveryReportMarkdown`
- `clusterDeliveryPackage`
- `objectiveCompletionAudit`
- 下载 API:
  - `GET /api/rooms/:id/cluster-delivery-package/manifest/download`
  - `GET /api/rooms/:id/cluster-delivery-package/report/download`
- 归档 API:
  - `POST /api/rooms/:id/cluster-delivery-package/archive`
- 归档 artifact 安全下载 API:
  - `GET /api/rooms/:id/cluster-delivery-package/archive/:archiveId/artifacts/:artifactKind/download`
  - 仅允许读取 `clusterDeliveryArchives` 记录过的 `output/noe/cluster-delivery/*` 文件
  - 下载时重新计算 sha256,与归档记录不一致则拒绝

8. Activity 审计

- 归档后写入 `cluster.delivery.archived`
- 手动补齐 Agent Run 代码证据并使交付门禁首次通过后写入 `cluster.delivery.ready`
- Activity 详情展示 `Cluster Delivery Archive`
- 记录归档路径、artifact 数量、manifest fingerprint 和每个 artifact 的 sha256
- artifact 下载响应包含 archive id、artifact kind、sha256 header,便于 UI/治理中心反查

## 当前验证证据

最近一次相关验证:

```bash
node --check src/server/routes/roomStart.js
node --check src/room/RoomAdapter.js && node --check src/room/CodexAppPluginBridge.js && node --check src/room/CodexSpawnAdapter.js && node --check src/room/ClaudeSpawnAdapter.js && node --check src/room/GeminiSpawnAdapter.js && node --check src/room/skillInjector.js && node --check src/room/CrossVerifyDispatcher.js && node --check src/server/routes/rooms.js
npm run lint
npm test -- tests/unit/routes/room-start-cross-verify.test.js tests/unit/routes/rooms-list-summary.test.js tests/unit/routes/activity-routes.test.js tests/unit/cross-verify-dispatcher.test.js
npm test
PLAYWRIGHT_BROWSERS_PATH=/Users/hxx/Library/Caches/ms-playwright npm run test:e2e
node --input-type=module <<'NODE'
// real failover simulation: Claude offline + Gemini quota exhausted + GPT solo takeover
NODE
launchctl kickstart -k gui/$(id -u)/com.hxx.noe.panel51835 && sleep 2 && curl --max-time 3 -sS http://127.0.0.1:51835/api/version
```

结果:

- lint: `eslint .` 通过,0 error;保留既有 `server.js` 2 个 unused warning
- 相关单测: `46/46 passed` (`cross-verify-dispatcher`),覆盖 Agent Run 自动证据绑定、自动执行 `node --check` 成功后绑定真实工具证据、自动验证失败不绑定证据、成员原生能力注入、三模型能力隔离、集群协同禁用共享 room skill 注入、Codex App 插件桥接协议、成员掉线后剩余成员接手、只剩一个成员时单模型接管、主动 abort 不会被误判为掉线接手、自动/手动拒绝跨房间/跨任务 Agent Run 证据、拒绝只有失败工具结果的 Agent Run 证据、交付清单过滤零证据/失败状态历史链接、手动重复绑定幂等去重、手动绑定证据后重算交付门禁并记录 `cluster.delivery.ready` / 广播 `cluster_delivery_ready`、非代码阶段证据不能替代代码驱动证据、交付门禁未过时房间暂停、运行中 telemetry、运行中预算暂停、归档 artifact 安全下载、启动预检和交付门禁
- 真机混沌探针: `27/27 passed`,覆盖错误模式、少成员、缺 adapter id、未注册 adapter、adapter 无 chat、空项目目标、cwd 缺失/不是目录、超大集群预算阻断、live ping 空回复/抛错/超时、所有成员失败暂停不误完成、单成员掉线后剩余成员接手、两个成员掉线后单模型接管、评审阶段掉线接手、用户主动 abort 只暂停不接手、自动验证成功/坏语法/缺文件/危险命令跳过、缺 Agent Run 证据交付阻断、三模型原生能力隔离、完整 11 阶段真实故障转移并通过交付门禁
- 真实故障转移模拟: `passed`,模拟 Claude network offline + Gemini `RESOURCE_EXHAUSTED quota 429`;GPT 单模型接管完成 11/11 阶段,4 个代码驱动阶段 Agent Run 证据齐全,`deliveryGate=passed`,`room.status=done`
- 完整单测: `815/815 passed`
- 完整 e2e: `147/147 passed`
- 常驻服务: `{"ok":true,"version":"2.1.0","buildVersion":"0.56","appName":"Noe"}`

## 剩余风险

| 风险 | 等级 | 说明 |
|---|---:|---|
| 模型输出仍可能声明硬证据 | P3 | 已不会直接放行交付;成功 Agent Run 可自动绑定,缺绑定时 `deliveryGate` 阻断;声明式证据仅保留用于诊断 |
| 运行中成本/时延 UI 仍可增强 | P3 | 后端已记录并广播 `clusterRuntimeTelemetry` / `clusterRuntimeBudgetStatus`,且硬阈值会暂停;后续主要是更精细的前端展示 |

## 后续建议

1. 增加更精细的运行中 token/cost/latency 可视化图表。
2. 在治理中心增加集群交付归档专用筛选和批量导出入口。
