# Noe / Neo 贾维斯 CE11 复盘优化 - GPT 独立交付

> 历史独立稿说明：本文件保留上一轮 GPT 交付证据。CE11 当前唯一 canonical 事实源为 `NOE_PHASE11_RETROSPECTIVE_CANONICAL.md`，当前验证入口为 `NOE_PHASE11_RETROSPECTIVE_VERIFY.mjs`。

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
边界：只在 Noe 目录工作；没有修改原项目目录；没有 clone 或复制候选开源项目代码；没有接入真实工具 handler。

## 0. 本轮裁定

CE01-CE10 的阶段验收可以作为当前原型证据链，但不能再被表述为完整 Jarvis 产品已交付。当前真实状态是：Noe 已有 Brain UI Lite、NoeLoop 最小闭环、Memory Core、Focus Stack、ToolRegistry 安全门、owner-token 路由、单元/集成/功能验证和文档/验收门；但 Voice、Social I/O、Act Pipeline、真实工具 handler、长期记忆策略、Electron 正式化和完整可观测性仍未完成。

本轮 CE11 结论：阶段 11 通过的含义是“复盘闭环与下一轮优化路线明确”，不是产品完成。后续进入新的产品化迭代时，必须按本文的 Neo 产品级 Definition of Done 重新验收。

## 1. 为什么提前停止 / 提前交付的原因裁定

1. 阶段验收语言被产品交付语言覆盖：CE05-CE10 多次写出“通过、可推进、验收通过”，但没有同时标注“这是阶段门，不是完整产品 DoD”。
2. Brain UI Lite 的可见 UI 被误读为 Jarvis 体验完成：阶段 8 的真实浏览器主路径证明了可用原型，不证明 Voice、Social、Act Pipeline 或真实工具执行可用。
3. 显式需求和路线需求混在一起：REQ-6 Voice/Social/Jarvis 被阶段 10 正确标成 P2 延后，但“验收通过”没有足够醒目地表达“P2 未完成”。
4. 多成员文档并发制造了事实源噪声：多个 `PHASE10/PHASE11` 文件并存，容易让后续成员挑错入口。
5. 旧规则文案残留：旧的“不允许因轮数/输出上限停止”与新监督规则“最多 3 轮，3 轮后裁定推进/列硬阻断”冲突。
6. 验证门偏工程，不偏产品：已有门能证明代码链路和安全边界，但缺少产品级 DoD 门来阻止“阶段绿灯 = 产品完成”的表述。

裁定：这不是单个模型“偷懒停止”，而是阶段门、验收门、产品 DoD 三层语义没有分离。直接修复方式是建立本文的产品级 DoD、下一轮路线和交付状态闭环。

## 2. 错误经验清单

- 不要把 CE 阶段通过描述成完整 Jarvis App 完成。
- 不要用 UI 截图替代产品能力边界；截图只能证明可见主路径。
- 不要让多个 canonical 并存；下一轮每阶段只认一个 source of truth，其余文件必须标明参考或废弃。
- 不要在 Node 26 下随手跑验证；Noe 当前有效运行时是 `.nvmrc=22.22.2`。
- 不要继续引用已知坏的 `tests/e2e/noe-brain-ui.e2e.mjs`，它曾暴露 `@playwright/test` 未安装和选择器错误。
- 不要在工具市场、MCP server、Voice/Social 尚未审计前接入真实执行能力。
- 不要用历史共识替代当前命令证据；每次交付验收至少跑本阶段门、secret gate 和关键前置门。
- 不要把外部项目 clone 到主产品树；候选调研只读元数据和文档，原型另设明确 sandbox。

## 3. Neo 产品级 Definition of Done

产品级 DoD 必须全部满足，才允许说“Neo / Neo 贾维斯产品完成”：

| 编号 | DoD | 验收口径 |
|---|---|---|
| DOD-1 | 状态闭环 | 房间状态、阶段状态、磁盘交付物、下一步任务和阻断项都落到单一 handoff/canonical 文档；禁止多入口漂移。 |
| DOD-2 | 运行隔离 | Node 22 fail-fast；51835 可启动；51735 原项目不受影响；测试使用临时 HOME/DB；结束后无残留常驻服务。 |
| DOD-3 | NoeLoop + Act Pipeline | 不只是 tick；必须有 plan/propose/approve/execute/evidence/retry/cancel 全链路，真实工具 handler 默认关闭且逐项审计。 |
| DOD-4 | Memory 升级 | 当前 FTS/Focus 只是 M0；产品级需有长期记忆策略、来源、过期/隐藏/合并、文件索引、召回评估和隐私边界。 |
| DOD-5 | Brain UI 执行可视化 | 不只是 health/memory/tick；必须显示队列、当前 act、审批、工具权限、失败原因、成本/预算和可复现日志。 |
| DOD-6 | Voice / Social I/O | 至少一条本地 voice 输入/输出路径和一条只读 social I/O 原型通过；默认不可外发，外发需用户确认。 |
| DOD-7 | Electron 正式化 | Noe appId/productName/图标/菜单/启动/退出/日志/打包 smoke 通过；Xike 残留命名清理；签名/公证路线明确。 |
| DOD-8 | Observability | 本地 trace/log/error timeline 可见；默认不上传；任何外部遥测需要隐私审查和开关。 |
| DOD-9 | 自动化证据 | 单元、集成、功能、打包 smoke、secret gate、边界 gate 全部给出命令、exit code、截图/日志路径。 |
| DOD-10 | 安全边界 | secret gate PASS；候选代码不全量复制；原项目不污染；危险操作等待用户明确确认。 |

## 4. 开源候选矩阵

只读审计方式：`NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs` 使用 `gh repo view` 和 `gh api repos/:owner/:repo/license` 读取公开元数据，写入 `output/noe-phase11-open-source-audit.json`。没有 clone 候选仓库，没有复制候选代码。

| 项目 | 链接 | 许可证 | 活跃度 | 核心能力 | Neo 适配价值 | 风险 | 成本 | 原型 |
|---|---|---|---|---|---|---|---|---|
| mem0 | https://github.com/mem0ai/mem0 | Apache-2.0 | stars 57328, pushed 2026-06-01 | agent memory | 长期记忆策略参考 | Python/service/外部向量假设 | M | P1 |
| Letta | https://github.com/letta-ai/letta | Apache-2.0 | stars 23080, pushed 2026-05-14 | stateful agents | 上下文窗口和 memory discipline | 范围过大，易变成第二产品 | H | P2 concept |
| LlamaIndex | https://github.com/run-llama/llama_index | MIT | stars 49829, pushed 2026-05-29 | RAG/file index | 本地文件索引和评估参考 | 框架面过大 | M | P1 |
| LangGraph | https://github.com/langchain-ai/langgraph | MIT | stars 33583, pushed 2026-06-02 | graph orchestration | Act Pipeline 状态机参考 | 过早替换 NoeLoop 会漂移 | M | P1 |
| AutoGen | https://github.com/microsoft/autogen | CC-BY-4.0 | stars 58613, pushed 2026-04-15 | agent orchestration | 协作模式参考 | license 需法务/代码使用复核 | H | 暂不原型 |
| CrewAI | https://github.com/crewAIInc/crewAI | MIT | stars 52618, pushed 2026-06-01 | role agents | 房间协作 UX 参考 | 容易回到“模型互聊” | M | P2 concept |
| Qdrant | https://github.com/qdrant/qdrant | Apache-2.0 | stars 31735, pushed 2026-06-02 | vector DB | 向量召回扩展 | 额外服务/进程 | M | P1 gated |
| Chroma | https://github.com/chroma-core/chroma | Apache-2.0 | stars 28175, pushed 2026-06-02 | embedding store | 快速 memory/RAG 试验 | Python/persistence 复杂度 | M | P1 alt |
| GraphRAG | https://github.com/microsoft/graphrag | MIT | stars 33375, pushed 2026-05-28 | graph RAG | 离线图谱总结参考 | 批处理重，不适合 P0 live loop | H | P2 research |
| Graphiti | https://github.com/getzep/graphiti | Apache-2.0 | stars 26862, pushed 2026-05-21 | temporal KG | 项目/用户记忆关系图 | schema/服务依赖 | M | P1 narrow |
| electron-builder | https://github.com/electron-userland/electron-builder | MIT | stars 14570, pushed 2026-06-02 | packaging | 已在 devDependencies，P0 打包 smoke | 签名/公证/Xike 残留 | L | P0 |
| Electron Forge | https://github.com/electron/forge | MIT | stars 7074, pushed 2026-06-01 | packaging | builder 阻断时备选 | 切换会制造 churn | M | P2 |
| OpenTelemetry JS | https://github.com/open-telemetry/opentelemetry-js | Apache-2.0 | stars 3387, pushed 2026-06-02 | traces | loop/tool/memory 本地 span | exporter 可能泄露元数据 | L | P0 local |
| Sentry JS | https://github.com/getsentry/sentry-javascript | MIT | stars 8661, pushed 2026-06-01 | error reporting | Electron 崩溃/错误上报 | 外发遥测需隐私审查 | M | P2 |
| MCP servers | https://github.com/modelcontextprotocol/servers | NOASSERTION | stars 86584, pushed 2026-05-30 | tool protocol | 工具 manifest 形状参考 | license 不明 + 真实执行危险 | M | P2 manifest only |

进入原型验证的裁定：P0 只进 electron-builder 和 OpenTelemetry local traces；P1 只做 mem0/LlamaIndex/LangGraph/Qdrant或Chroma/Graphiti 的窄 spike；AutoGen、MCP servers 不进代码原型，先做 license/safety 复核。

## 5. P0 / P1 / P2 后续路线

### P0：状态闭环与产品化地基

1. 收敛交付入口：`NOE_PHASE11_RETROSPECTIVE_GPT.md` 可作为本轮 GPT 复盘证据；下一轮需要指定唯一 productization canonical，废弃/索引重复 Phase10/Phase11 文档。
2. 所有验证脚本加入 Node22 fail-fast，禁止默认 Node26 误跑。
3. 修掉或废弃 `tests/e2e/noe-brain-ui.e2e.mjs`。
4. Brain UI 增加执行可视化：act queue、审批、工具状态、失败原因、成本。
5. Act Pipeline skeleton：dry-run handler only，先做 plan/propose/approve/evidence，不接真实危险工具。
6. Memory M1：给每条 memory 增 source、confidence、ttl/hidden reason、merge trace、recall evaluation。
7. Electron smoke：用现有 electron-builder 做 Noe app 启动/退出/菜单/日志/打包目录 smoke。
8. OpenTelemetry local-only：记录 loop/tick/tool/memory span，exporter 默认 disabled。

### P1：能力升级

1. 本地文件索引/RAG：先 SQLite FTS + 明确来源，再选 LlamaIndex 只读模式做 spike。
2. 向量召回：Qdrant 或 Chroma 二选一，必须 local-only，可一键关闭。
3. Graphiti 窄 KG：只验证项目关系记忆，不迁移现有 schema。
4. Tool marketplace manifest：只接 manifest/permission/approval/audit，不接 handler。
5. 移动端 Brain UI 真实交互断言。

### P2：体验与外部 I/O

1. Voice 输入/输出。
2. Social I/O，只读优先，外发必须用户确认。
3. Sentry/外部 telemetry，隐私审查后再启用。
4. CrewAI/Letta/GraphRAG 仅作设计参考，不能直接吞进 Noe。

## 6. 房间 / 阶段 / 交付状态闭环方案

- 房间状态：CE01-CE10 视为阶段性 passed；CE11 以本文和 `NOE_PHASE11_RETROSPECTIVE_GPT_VERIFY.mjs` 作为 GPT 交付证据。
- 产品状态：Brain UI Lite 原型通过；完整 Jarvis 产品未完成。
- 交付清单：`NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs`、`output/noe-phase11-open-source-audit.json`、`NOE_PHASE11_RETROSPECTIVE_GPT.md`、`NOE_PHASE11_RETROSPECTIVE_GPT_VERIFY.mjs`。
- 不再回退：不要因旧 CE05 返工文字回退；不要新建房间；不要回退 CE01-CE10。
- 讨论上限：当前阶段最多 3 轮；第 3 轮必须裁定推进、降级接管或列硬阻断。
- 降级规则：Claude 不可用时 GPT/Codex + Gemini 继续；只剩一个有效模型时允许 solo takeover，但记录风险和补审点。
- 危险操作：删除、外发、批量移动、真实工具执行、原项目写入必须等待用户明确确认。

## 7. 11 阶段衔接

1. 用户想法：Noe 是新主产品，不是原 Xike Lab 稳定项目。
2. 需求分析：继续继承 P0/P1/P2 和 secret/路径边界。
3. 技术方案：in-process、SQLite、Node22、owner-token、加法不改存量仍有效。
4. 排期：阶段 4 的波次可继续，但下一轮需重命名为产品化 roadmap，不要再叫完整产品完成。
5. 代码开发：当前代码面是原型底座；下一轮先做 Act Pipeline 和执行可视化。
6. 单元测试：保持 22 tests 以上核心覆盖，并补 Act Pipeline/Memory 评估测试。
7. 集成测试：继续使用临时 HOME/DB/端口隔离，保留 51735 零影响断言。
8. 功能验证：阶段 8 证明用户主路径可见；下一轮要证明用户能看懂/控制执行过程。
9. 文档编写：文档需瘦身成单入口，历史细节归档。
10. 交付验收：阶段 10 通过的是当前原型验收；产品验收要套本文 DoD。
11. 复盘优化：本文完成原因裁定、错误经验、DoD、候选矩阵、路线和状态闭环。
