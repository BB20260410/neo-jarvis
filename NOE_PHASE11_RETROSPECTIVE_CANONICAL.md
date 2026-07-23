# Noe / Neo 贾维斯 CE11 复盘优化 Canonical

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
本轮角色：Claude 掉线后，GPT/Codex 接手 Claude 的复盘审计与落地职责；Gemini 作为审计辅助，其上一轮指出的可复验证问题已吸收。  
硬边界：只在 Noe 目录工作；未修改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`；未全量复制候选开源项目；未接入真实工具 handler；未执行删除、外发、批量移动或不可逆操作。

## 1. 提前停止 / 提前交付原因裁定

裁定：CE01-CE10 被误读为“完整 Jarvis 产品交付”，根因不是单一成员偷懒，而是阶段验收、原型验收、产品级 DoD 三层语言没有分离。

1. 阶段门语言太像产品交付语言。多次写“通过”“可推进”“验收通过”，但没有同步写清“这是阶段性原型证据，不是完整 Jarvis App 完成”。
2. Brain UI Lite 的可见 UI 被误当成完整 Jarvis 体验。阶段 8 证明用户主路径可见，不证明 Voice、Social、Act Pipeline、真实工具 handler、长期记忆策略、Electron 正式化和可观测性已经完成。
3. REQ-6 被正确标为 P2 延后，但交付话术不够醒目。阶段 10 通过代表当前原型验收通过，不代表 P2 体验完成。
4. 多成员并发文档导致事实源漂移。`PHASE10/PHASE11` 多份报告并存，容易让后续成员误选入口。
5. 旧协作规则残留。旧的“不允许因轮数/输出上限停止”与最新“最多 3 轮，3 轮后裁定推进或列硬阻断”冲突。
6. 验证门偏工程，不偏产品。已有门能证明代码、安全和端口隔离，但不能阻止“阶段绿灯 = 产品完成”的表达错误。

因此，CE11 的完成含义是“复盘闭环、产品级 DoD、候选矩阵和下一轮路线明确”，不是完整产品交付。

## 2. 错误经验清单

| 编号 | 错误经验 | 直接改进 |
|---|---|---|
| E-1 | 把阶段验收通过写成完整产品完成。 | 每次验收结论必须同时标注“阶段状态”和“产品状态”。 |
| E-2 | 用 UI 截图替代产品能力边界。 | 截图只作为可见主路径证据；产品能力必须逐项对 DoD。 |
| E-3 | 多个 canonical 并存。 | 下一轮每阶段只允许一个 canonical source of truth，其余文件标参考/归档。 |
| E-4 | 默认 Node 26 误跑验证。 | 所有核心验证脚本加 Node 22 fail-fast 或显式使用 `.nvmrc=22.22.2`。 |
| E-5 | 继续引用已知坏 e2e。 | 修复或废弃 `tests/e2e/noe-brain-ui.e2e.mjs`，不再作为验收入口。 |
| E-6 | 未审计就讨论工具市场/真实执行。 | P0/P1 仅 manifest/approval/audit；真实 handler 必须单独审计并获用户确认。 |
| E-7 | 用历史共识替代当前证据。 | 每阶段闭环要给脚本、exit code、截图/日志或明确未执行原因。 |
| E-8 | 让模型签字流程拖住推进。 | 采用故障转移规则：Claude 不可用时由 GPT/Codex + Gemini 或 solo takeover 推进。 |

## 3. Neo 产品级 Definition of Done

只有全部满足以下 DoD，才允许说“Neo / Neo 贾维斯是产品级完成”。当前 CE01-CE10 只满足原型底座证据，不满足完整 DoD。

| 编号 | DoD | 产品级验收口径 |
|---|---|---|
| DOD-1 | 状态闭环 | 房间状态、阶段状态、磁盘交付物、下一步任务、阻断项落到单一 canonical/handoff；重复入口被索引或归档。 |
| DOD-2 | 运行隔离 | Node 22 fail-fast；51835 可启动；51735 原项目不受影响；测试用临时 HOME/DB；结束后无残留常驻服务。 |
| DOD-3 | NoeLoop + Act Pipeline | 不只是 tick；必须有 plan/propose/approve/execute/evidence/retry/cancel 全链路，真实工具 handler 默认关闭且逐项审计。 |
| DOD-4 | Memory 升级 | 长期记忆具备 source、confidence、ttl、hide/merge trace、recall evaluation、本地文件索引和隐私边界。 |
| DOD-5 | Brain UI 执行可视化 | 展示队列、当前 act、审批、工具权限、失败原因、成本/预算、日志和可复现 evidence。 |
| DOD-6 | Voice / Social I/O | 至少一条本地 voice 输入/输出路径和一条只读 social I/O 原型通过；任何外发必须用户确认。 |
| DOD-7 | Electron 正式化 | appId/productName/图标/菜单/启动/退出/日志/打包 smoke 通过；Xike 残留命名清理；签名/公证路线明确。 |
| DOD-8 | Observability | 本地 trace/log/error timeline 可见；默认不上传；任何外部遥测需要隐私审查和显式开关。 |
| DOD-9 | 自动化证据 | 单元、集成、功能、打包 smoke、secret gate、边界 gate 给出命令、exit code、截图/日志路径。 |
| DOD-10 | 安全边界 | secret gate PASS；候选代码不全量复制；原项目不污染；删除、外发、批量移动、真实工具执行必须等用户明确确认。 |

## 4. 开源候选矩阵

审计方式：`NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs` 只读调用 GitHub CLI / GitHub REST API。  
审计命令：`gh repo view <repo> --json nameWithOwner,description,url,stargazerCount,pushedAt,isArchived` + `gh api repos/<repo>/license`。  
审计证据：`output/noe-phase11-open-source-audit.json`，`auditedAt=2026-06-02T01:37:15.095Z`，`rows=21`。  
边界：未 clone 候选仓库，未复制候选代码，未引入依赖，未接入工具执行能力。

| 能力类 | 项目 | 链接 | 许可证 SPDX | 活跃度 | 核心能力 | Neo 适配价值 | 风险 | 成本 | 是否进入原型验证 |
|---|---|---|---|---|---|---|---|---|---|
| Agent Memory | mem0 | https://github.com/mem0ai/mem0 | Apache-2.0 | 57329 stars, pushed 2026-06-01 | memory mutation / retrieval policy | 长期记忆质量策略参考 | Python/service/vector-store 假设 | M | P1 窄 memory spike |
| Agent Memory | Letta | https://github.com/letta-ai/letta | Apache-2.0 | 23080 stars, pushed 2026-05-14 | stateful agents | 上下文窗口纪律参考 | 平台范围过大 | H | P2 概念参考 |
| RAG / Local File Index | LlamaIndex | https://github.com/run-llama/llama_index | MIT | 49830 stars, pushed 2026-05-29 | ingestion / chunking / retrieval | 本地文件索引和评估参考 | 框架面过大 | M | P1 API-pattern spike |
| Local File Index | Unstructured | https://github.com/Unstructured-IO/unstructured | Apache-2.0 | 14823 stars, pushed 2026-06-01 | document partitioning | 复杂文档解析参考 | Python ETL 依赖 | M | P1 parsing spike |
| Local File Index | Docling | https://github.com/docling-project/docling | MIT | 60792 stars, pushed 2026-06-01 | PDF/table/layout conversion | PDF/文档结构化参考 | packaging 体积风险 | M | P1 parsing comparison |
| RAG / Vector Store | Qdrant | https://github.com/qdrant/qdrant | Apache-2.0 | 31735 stars, pushed 2026-06-02 | vector DB | FTS5 之外的向量召回候选 | 额外服务/进程 | M | P1 local-only switch |
| RAG / Vector Store | Chroma | https://github.com/chroma-core/chroma | Apache-2.0 | 28175 stars, pushed 2026-06-02 | embedding store | 快速 memory/RAG 试验 | Python/persistence 复杂度 | M | P1 alternative |
| RAG / Vector Store | LanceDB | https://github.com/lancedb/lancedb | Apache-2.0 | 10471 stars, pushed 2026-06-01 | embedded retrieval | 本地嵌入式向量库候选 | Node 集成需证明 | M | P1 embedded spike |
| Local Search | Meilisearch | https://github.com/meilisearch/meilisearch | NOASSERTION | 57906 stars, pushed 2026-06-01 | hybrid keyword search | FTS5 不够时参考搜索 UX | 独立服务偏重 | M | P2 only |
| Knowledge Graph | GraphRAG | https://github.com/microsoft/graphrag | MIT | 33375 stars, pushed 2026-05-28 | graph RAG pipeline | 离线图谱总结参考 | 批处理重，不适合 P0 live loop | H | P2 research |
| Knowledge Graph | Graphiti | https://github.com/getzep/graphiti | Apache-2.0 | 26863 stars, pushed 2026-05-21 | temporal KG | 用户/项目记忆关系图 | schema/服务依赖 | M | P1 narrow KG |
| Knowledge Graph | FalkorDB | https://github.com/FalkorDB/FalkorDB | NOASSERTION | 4494 stars, pushed 2026-06-01 | graph DB / GraphRAG | 图数据库参考 | 外部服务负担 | M | P2 reference |
| Multi-Agent Orchestration | LangGraph | https://github.com/langchain-ai/langgraph | MIT | 33586 stars, pushed 2026-06-02 | durable graph state | Act Pipeline 状态机参考 | 过早替换 NoeLoop 会漂移 | M | P1 pattern spike |
| Multi-Agent Orchestration | AutoGen | https://github.com/microsoft/autogen | CC-BY-4.0 | 58613 stars, pushed 2026-04-15 | agent orchestration | 协作模式参考 | license/code-use 需复核 | H | 暂不原型 |
| Multi-Agent Orchestration | CrewAI | https://github.com/crewAIInc/crewAI | MIT | 52619 stars, pushed 2026-06-01 | role agents | 房间协作 UX 参考 | 易回到模型互聊 | M | P2 concept |
| Electron Packaging | electron-builder | https://github.com/electron-userland/electron-builder | MIT | 14570 stars, pushed 2026-06-02 | packaging / update | 已在 devDependencies，P0 打包 smoke 首选 | 签名/公证/Xike 残留 | L | P0 |
| Electron Packaging | Electron Forge | https://github.com/electron/forge | MIT | 7074 stars, pushed 2026-06-01 | packaging workflow | builder 阻断时备选 | 切换制造 churn | M | P2 |
| Observability | OpenTelemetry JS | https://github.com/open-telemetry/opentelemetry-js | Apache-2.0 | 3387 stars, pushed 2026-06-02 | traces | loop/tool/memory 本地 span | exporter 可能泄露元数据 | L | P0 local-only |
| Observability | electron-log | https://github.com/megahertz/electron-log | MIT | 1466 stars, pushed 2026-05-14 | local logs | packaged app 本地日志 | 只有日志无 trace | L | P0 |
| Observability | Sentry JS | https://github.com/getsentry/sentry-javascript | MIT | 8661 stars, pushed 2026-06-01 | error reporting | Electron 错误/崩溃候选 | 外发遥测需隐私审查 | M | P2 |
| Tool Marketplace | MCP servers | https://github.com/modelcontextprotocol/servers | NOASSERTION | 86584 stars, pushed 2026-05-30 | tool protocol examples | manifest 形状参考 | license 不明且真实执行危险 | M | P2 manifest only |

进入原型验证裁定：P0 只允许 `electron-builder`、`electron-log`、OpenTelemetry local-only traces 进入工程原型；P1 只做 mem0/LlamaIndex/Unstructured/Docling/Qdrant或Chroma或LanceDB/Graphiti/LangGraph 的窄 spike；AutoGen、MCP servers、Meilisearch、FalkorDB、Sentry 先做 license/privacy/safety 复核，不直接接入。

## 5. P0 / P1 / P2 下一步执行路线

### P0：状态闭环、执行可视化、Act Pipeline 地基

1. 收敛入口：指定唯一 productization canonical，索引或归档重复 Phase10/Phase11 文档。
2. Node22 fail-fast：所有核心验证脚本先检查 `.nvmrc=22.22.2` 或直接使用 Node22。
3. 废弃/修复旧 e2e：处理 `tests/e2e/noe-brain-ui.e2e.mjs` 的依赖和选择器问题。
4. Brain UI 执行可视化：新增 act queue、审批、工具状态、失败原因、成本/预算、evidence log。
5. Act Pipeline skeleton：先 dry-run handler only，实现 plan/propose/approve/evidence，不接真实危险工具。
6. Memory M1：补 source、confidence、ttl、hidden reason、merge trace、recall evaluation。
7. Electron smoke：使用现有 electron-builder 做 Noe app 启动/退出/菜单/日志/打包目录 smoke。
8. Observability local-only：OpenTelemetry span 和 electron-log 默认本地，不外发。

### P1：Memory / RAG / 图谱 / 工具市场升级

1. 本地文件索引：先 SQLite FTS + 明确来源，再比较 LlamaIndex / Unstructured / Docling。
2. 向量召回：Qdrant、Chroma、LanceDB 三选一窄 spike，必须 local-only 和可一键关闭。
3. Knowledge Graph：Graphiti 只验证项目/用户关系记忆，不迁移现有 schema。
4. Tool marketplace manifest：只做 manifest / permission / approval / audit，不接 handler。
5. 移动端 Brain UI：补真实移动交互断言，而不是只截图。

### P2：Voice / Social / 外部遥测 / 高级编排

1. Voice 输入/输出。
2. Social I/O 只读优先，外发必须用户确认。
3. Sentry 或外部 telemetry 必须先做隐私审查。
4. CrewAI / Letta / GraphRAG 只作为设计参考，不能直接吞进 Noe。

## 6. 房间 / 阶段 / 交付状态闭环方案

- 房间状态：CE01-CE10 记为阶段性 passed；CE11 记为复盘 closed；产品状态仍是 Brain UI Lite 原型通过，完整 Jarvis 产品未完成。
- 阶段状态：每阶段必须有 `canonical + verify` 或明确“非代码阶段无需 verify”的说明；代码驱动阶段必须有命令、exit code、截图/日志或未执行原因。
- 交付状态：下一轮交付报告必须分开写“阶段交付物”“产品未完成项”“P0/P1/P2 待办”。
- 故障转移：讨论最多 3 轮；第 3 轮必须裁定推进、降级接管或列硬阻断。Claude 不可用时 GPT/Codex + Gemini 继续；只剩 GPT/Codex 时允许 solo takeover，但必须记录风险和后续补审点。
- 阻断条件：只有可复验证的 secret 泄露、路径权限错误、原项目污染、数据破坏、不可逆操作、真实工具越权执行才能阻断。
- 非阻断建议：普通命名细节、额外调研欲望、追求更完整矩阵、模型签字缺席，进入 P1/P2 backlog，不拖住阶段切换。
- 危险操作：删除、外发、批量移动、真实工具执行、原项目写入必须等待用户明确确认。

## 7. 工程闭环 11 阶段衔接

1. 用户想法：Noe 是新主产品，不是原 Xike Lab 稳定项目。
2. 需求分析与拆解：继承 P0/P1/P2、secret gate、路径边界和“不全量复制 BaiLongma”。
3. 技术方案设计：in-process、SQLite、Node22、owner-token、加法不改存量仍有效。
4. 任务分配与排期：阶段 4 队列可沿用，但下一轮必须叫产品化 roadmap，不再暗示完整产品完成。
5. 代码开发：当前代码面是原型底座；下一轮先做 Act Pipeline dry-run 与 Brain UI 执行可视化。
6. 单元测试：保持当前核心覆盖，补 Act Pipeline、Memory 评估、Node22 fail-fast。
7. 集成测试：继续临时 HOME/DB/端口隔离，保留 51735 零影响断言。
8. 功能验证：阶段 8 证明主路径可见；下一轮要证明用户能看懂并控制执行过程。
9. 文档编写：文档需瘦身成单入口，历史细节归档或索引。
10. 交付验收：阶段 10 通过的是当前原型验收；产品验收必须套本文 DoD。
11. 复盘优化：本文完成原因裁定、错误经验、产品级 DoD、开源候选矩阵、P0/P1/P2 路线和状态闭环。

## 8. 本阶段已直接修复

1. 重写 `NOE_PHASE11_RETROSPECTIVE_CANONICAL.md`，拆清“提前停止原因裁定”和“错误经验清单”，并将完整 Jarvis 未完成写为硬结论。
2. 重写 `NOE_PHASE11_RETROSPECTIVE_VERIFY.mjs`，让验证契约对齐用户新增需求，而不是检查旧章节。
3. 扩展 `NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs` 到 21 个候选，覆盖 agent memory、RAG、local file index、knowledge graph、multi-agent orchestration、Electron packaging、observability 和 tool marketplace。
4. 重新生成 `output/noe-phase11-open-source-audit.json`，补齐官方链接、SPDX、stars、最近 push、审计时间和审计命令。
5. 吸收故障转移规则：Claude 掉线后由 GPT/Codex 接管；不再要求所有成员签字才能闭环。

## 9. CE11 裁定

CE11 可裁定通过：本阶段交付的是复盘优化和下一轮产品化路线，不是完整 Jarvis 产品交付。  
后续若进入产品化实现，必须先按 P0 路线收敛状态闭环、执行可视化、Act Pipeline、Memory 升级、Electron smoke 和 local-only observability。
