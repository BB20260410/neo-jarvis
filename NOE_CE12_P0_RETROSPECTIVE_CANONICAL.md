# CE12 P0 复盘优化事实源

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：11. 复盘优化  
本轮接管：Claude 当前不可用，GPT-Codex 以单模型接管完成 CE11。MiniMax M3 在线中文侧补审仍记为后续补审点。  
事实源关系：本文件承接 `NOE_CE12_P0_ACCEPTANCE_CANONICAL.md`、`NOE_CE12_P0_EVIDENCE_INDEX.md` 和 `NOE_CE12_P0_DOCS_CANONICAL.md`，不回退 CE01-CE10，不替代需求事实源。  
当前口径：CE12 P0 产品化基础已通过验收；完整 Jarvis 产品未完成。

## 0. 取舍裁定

1. 本轮只做 CE11 复盘优化，不新建项目、不新建房间、不回退 CE01-CE10。
2. 旧质量门文字仍提示“代码开发未完成”和“第 300 次阶段返工”，该提示是 CE05 前循环残留。当前 CE10 事实源已经给出 `verify:p0` 7/7、`verify:p0:acceptance` 59/59 和真实 51835 主路径 14/14 的验收证据，因此本轮不回退代码开发阶段。
3. 本轮不执行删除、外发、批量移动、真实危险工具 handler 或原项目写入。
4. 开源候选矩阵沿用并核对 `NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs` 的只读 GitHub 元数据审计结果。2026-06-02 本轮尝试刷新该审计时 GitHub GraphQL 返回 EOF，未生成新输出；因此保留同日缓存证据 `output/noe-phase11-open-source-audit.json`，并把“审计脚本需要 per-repo retry / partial fallback”列为改进项。

## 1. 提前停止 / 提前交付原因裁定

裁定：此前“阶段验收通过”被误读成“完整 Jarvis 产品交付”，主因不是某个模型单点偷懒，而是工程阶段门、验收门、产品级 DoD 三层语义没有隔离。

| 原因 | 证据/表现 | 修正 |
|---|---|---|
| 阶段语言过强 | 多轮写“通过”“可推进”“验收通过”，但没有同句声明“完整 Jarvis 产品未完成”。 | 所有结论拆成 `stage_status` 和 `product_status` 两句。 |
| Brain UI Lite 被当成完整体验 | 可见 UI、截图、Tick 通过被误读成 Voice/Social/Act/真实工具均完成。 | UI 证据只证明当前主路径；产品能力必须逐条对 DoD。 |
| 多 canonical 并存 | Phase10/Phase11、Claude/GPT 独立稿并列，后续成员容易挑错入口。 | CE12 后以 `NOE_CE12_P0_*` 为当前入口，旧 Phase 文件仅作历史参考。 |
| 自动质量门残留旧状态 | 旧提示仍说“代码开发未完成”，与 CE10 当前验收事实冲突。 | 以最新验收命令和证据 JSON 裁定，不因旧 CE05 文案回退。 |
| 成员提案阶段掉线 | Claude/M3/Gemini 不可用时，旧流程容易等待签字或反复提案。 | 三轮后推进/接管；无硬风险时允许 solo takeover，并记录补审点。 |
| 验证偏工程而非产品 | `verify:p0` 能证明 P0 工程门，不能证明 Voice/Social/完整 Jarvis。 | 产品级 DoD 独立存在，禁止把 P0 通过写成产品完成。 |

结论：CE12 P0 可验收，但只能表述为“产品化基础可继续验收”。完整 Jarvis 产品仍缺 Voice、Social I/O、真实工具 handler、长期记忆策略、Electron 正式分发和完整可观测性。

## 2. 错误经验清单

| 编号 | 错误经验 | 本轮改法 |
|---|---|---|
| L-01 | 把阶段验收通过写成产品完成。 | 所有 CE12 文档保留“完整 Jarvis 产品未完成”硬句。 |
| L-02 | 用截图替代能力证明。 | 截图只作为 UI 可见证据；能力仍看 API、状态机、日志和安全不变量。 |
| L-03 | 让多模型签字流程拖住推进。 | Claude 不可用时由 GPT-Codex 接管；MiniMax M3 只对硬风险阻断。 |
| L-04 | 把旧质量门文字当成当前事实。 | 当前事实以最新磁盘文件和命令 exit code 为准。 |
| L-05 | `latest.json` 容易被 fast run 覆盖。 | 验收文档固定引用时间戳 full-run JSON，不只依赖 latest。 |
| L-06 | 开源审计脚本网络 EOF 会中断整批。 | 后续给审计脚本加 retry、partial save 和 failed-row 标记。 |
| L-07 | Browser/iab 不可用反复解释。 | 固化为已知约束，UI 验证降级到项目 Playwright。 |
| L-08 | MiniMax 在线 patch-only 未形成完整 proposal，且 Mavis/OpenCode 曾因 `permissionMode=bypassPermissions` 允许 bash/read。 | 已新增 M3 建议员模式；Mavis/OpenCode 本地 executor 默认禁用，M3 只根据精选上下文输出建议，不执行。 |
| L-09 | 旧 Phase 文件和 CE12 文件入口混杂。 | README 以 CE12 文件为先读入口，后续可归档旧 Phase 文档。 |
| L-10 | 原项目工作树状态容易混入 Noe 验收。 | Noe 产品工作只验 Noe 目录；原项目未提交改动单独裁定，不混入 Noe 产品口径。 |

## 3. Neo 产品级 Definition of Done

以下全部满足之前，不允许说“Neo / Neo 贾维斯完整产品完成”。

| 编号 | DoD | 产品级验收口径 | CE12 当前状态 |
|---|---|---|---|
| DOD-01 | 单一事实源 | README、handoff、evidence、acceptance 指向同一当前入口，旧文件被标历史或归档。 | 部分满足，旧 Phase 文件仍多。 |
| DOD-02 | 运行隔离 | Node22 gate；Noe 51835 可起停；原项目 51735 不受影响；测试 HOME/DB 隔离。 | P0 已满足。 |
| DOD-03 | Act Pipeline | plan/propose/approval/dry-run/evidence/retry/cancel 全链路；危险 handler 默认禁用。 | P0 地基满足，真实 handler 未接。 |
| DOD-04 | Memory M1/M2 | source、confidence、ttl、hide/merge trace、recall eval、本地文件索引、隐私边界。 | 只满足基础 memory/focus。 |
| DOD-05 | Brain UI 执行可视化 | act queue、当前 act、审批、权限、失败原因、预算、日志入口稳定可见。 | P0 已满足。 |
| DOD-06 | Voice | 本地 voice 输入/输出至少一条主路径可复现，默认不外发。 | 未完成。 |
| DOD-07 | Social I/O | 只读 social I/O 原型通过；任何外发必须明确审批。 | 未完成。 |
| DOD-08 | Electron 正式化 | appId/name/icon/menu/log/启动退出/打包 smoke；签名公证路线明确。 | smoke 满足，签名公证未做。 |
| DOD-09 | Observability | 本地 trace/log/error timeline；默认不上传；外部遥测需隐私审查。 | 部分满足。 |
| DOD-10 | 自动化证据 | 单元、集成、功能、文档、验收、Electron、secret/boundary gate 都可一键复现。 | P0 已满足。 |
| DOD-11 | 安全边界 | secret gate；危险操作审批/阻断；候选项目不全量复制；原项目不污染。 | P0 已满足。 |
| DOD-12 | 用户可用性 | 用户能理解当前状态、下一步、失败原因、成本、日志和可回滚方式。 | 仍需产品化打磨。 |

## 4. 开源候选矩阵

审计边界：只读公开元数据，不 clone、不复制代码、不引入依赖、不接真实工具执行。  
证据文件：`output/noe-phase11-open-source-audit.json`。  
缓存审计时间：`2026-06-02T01:37:15.095Z`，`rows=21`。  
本轮刷新尝试：`node NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs`，GitHub GraphQL EOF 于 `docling-project/docling`，未覆盖旧缓存。  

| 能力类 | 项目 | 链接 | 许可证 | 核心能力 | Neo 适配价值 | 风险 | 成本 | 原型裁定 |
|---|---|---|---|---|---|---|---|---|
| Agent Memory | mem0 | https://github.com/mem0ai/mem0 | Apache-2.0 | memory mutation / retrieval policy | 长期记忆策略参考 | Python/service/vector assumptions | M | P1 narrow spike |
| Agent Memory | Letta | https://github.com/letta-ai/letta | Apache-2.0 | stateful agents | 上下文纪律参考 | 范围过大 | H | P2 concept |
| RAG / File Index | LlamaIndex | https://github.com/run-llama/llama_index | MIT | ingestion / chunking / retrieval | 本地文件索引参考 | 框架面大 | M | P1 API-pattern |
| File Index | Unstructured | https://github.com/Unstructured-IO/unstructured | Apache-2.0 | document partitioning | 复杂文档解析 | Python ETL 依赖 | M | P1 parsing |
| File Index | Docling | https://github.com/docling-project/docling | MIT | PDF/table/layout conversion | PDF 结构化 | packaging 体积 | M | P1 comparison |
| Vector Store | Qdrant | https://github.com/qdrant/qdrant | Apache-2.0 | vector DB | FTS5 之外召回候选 | 额外服务 | M | P1 local switch |
| Vector Store | Chroma | https://github.com/chroma-core/chroma | Apache-2.0 | embedding store | 快速 memory/RAG 试验 | Python/persistence | M | P1 alternative |
| Vector Store | LanceDB | https://github.com/lancedb/lancedb | Apache-2.0 | embedded vector search | 本地嵌入式候选 | Node 集成待证 | M | P1 embedded |
| Search | Meilisearch | https://github.com/meilisearch/meilisearch | NOASSERTION | keyword/hybrid search | 搜索 UX 参考 | 独立服务偏重 | M | P2 only |
| Knowledge Graph | GraphRAG | https://github.com/microsoft/graphrag | MIT | graph RAG pipeline | 离线图谱总结 | 批处理重 | H | P2 research |
| Knowledge Graph | Graphiti | https://github.com/getzep/graphiti | Apache-2.0 | temporal KG | 用户/项目关系记忆 | schema/服务依赖 | M | P1 narrow KG |
| Knowledge Graph | FalkorDB | https://github.com/FalkorDB/FalkorDB | NOASSERTION | graph DB | 图数据库参考 | 外部服务负担 | M | P2 reference |
| Orchestration | LangGraph | https://github.com/langchain-ai/langgraph | MIT | durable graph state | Act Pipeline 状态机参考 | 过早替换 NoeLoop | M | P1 pattern |
| Orchestration | AutoGen | https://github.com/microsoft/autogen | CC-BY-4.0 | agent orchestration | 协作参考 | license/code-use 需复核 | H | 暂不原型 |
| Orchestration | CrewAI | https://github.com/crewAIInc/crewAI | MIT | role agents | 房间 UX 参考 | 容易空转互聊 | M | P2 concept |
| Electron | electron-builder | https://github.com/electron-userland/electron-builder | MIT | packaging | 已在 devDependencies | 签名/公证未做 | L | P0 already |
| Electron | Electron Forge | https://github.com/electron/forge | MIT | packaging workflow | builder 阻断时备选 | 切换 churn | M | P2 fallback |
| Observability | OpenTelemetry JS | https://github.com/open-telemetry/opentelemetry-js | Apache-2.0 | traces | loop/tool/memory span | exporter 泄露风险 | L | P1 local-only |
| Observability | electron-log | https://github.com/megahertz/electron-log | MIT | local logs | packaged app 日志 | 只有日志无 trace | L | P1 local logs |
| Observability | Sentry JS | https://github.com/getsentry/sentry-javascript | MIT | error reporting | 崩溃上报候选 | 外发遥测需审查 | M | P2 only |
| Tool Market | MCP servers | https://github.com/modelcontextprotocol/servers | NOASSERTION | tool protocol examples | manifest 形状参考 | license 不明/真实执行危险 | M | P2 manifest only |

## 5. P0 / P1 / P2 后续优先级

### P0 - 下一轮立即减少返工

| ID | 行动项 | 验收口径 |
|---|---|---|
| P0-01 | 把 CE12 入口继续收敛到 README、handoff、evidence、acceptance、retrospective 五个文件。 | `verify:p0:docs` 或新文档门能确认旧 Phase 文件不再作为当前入口。 |
| P0-02 | 给 `NOE_PHASE11_OPEN_SOURCE_AUDIT.mjs` 加 retry、partial output、failed-row 标记。 | 单个 GitHub EOF 不导致整批失败，输出包含失败原因。 |
| P0-03 | 固化 `verify:p0:full` 与 `verify:p0:fast` 的 latest 文件分流。 | fast 不覆盖 full latest；验收永远引用 full timestamp。 |
| P0-04 | M3 建议员模式接线。 | M3 可输出优化意见、风险、缺口和 patch 建议；shell/read/write/delete/move/apply_patch/tool_calls 全部 blocked_safety；Mavis/OpenCode executor 默认不启动。 |
| P0-05 | 把 Browser/iab 不可用写成稳定约束。 | 文档不再每轮重复解释；UI 证据默认 Playwright。 |

### P1 - 产品化能力升级

| ID | 行动项 | 验收口径 |
|---|---|---|
| P1-01 | Memory M1：source/confidence/ttl/hide/merge trace。 | 单测 + recall eval 报告；UI 可见来源和可信度。 |
| P1-02 | Local file index：SQLite FTS 先行，比较 LlamaIndex/Docling/Unstructured。 | 只读索引本地测试目录，输出来源引用，不外发。 |
| P1-03 | Act Pipeline retry/cancel HTTP 端到端补强。 | 集成报告覆盖 retry 失败与 retry 成功。 |
| P1-04 | Electron 命名/图标/日志正式化。 | app metadata 不残留 Xike；smoke 仍 PASS。 |
| P1-05 | Local-only observability。 | trace/log 本地可见，exporter disabled by default。 |

### P2 - 完整 Jarvis 体验

| ID | 行动项 | 验收口径 |
|---|---|---|
| P2-01 | Voice 输入/输出。 | 本地语音主路径可复现，不外发。 |
| P2-02 | Social I/O 只读原型。 | 只读拉取/展示通过；外发路径必须审批。 |
| P2-03 | Tool marketplace manifest。 | 只接 manifest/permission/audit，不接真实 handler。 |
| P2-04 | 外部遥测和 Sentry。 | 隐私审查和用户开关完成前不启用。 |
| P2-05 | Knowledge Graph / LangGraph pattern spike。 | 不替换 NoeLoop，只验证窄状态机/关系记忆模式。 |

## 6. 房间 / 阶段 / 交付状态闭环

| 层级 | 当前裁定 | 后续规则 |
|---|---|---|
| 房间状态 | CE01-CE10 已有验收证据；CE11 本文件闭环复盘。 | 不新建房间，不回退旧阶段，除非发现 secret、路径污染、数据破坏等硬风险。 |
| 阶段状态 | CE12 P0 通过验收；当前阶段为复盘优化。 | 每阶段最多 3 轮，第 3 轮必须推进、降级接管或列硬阻断。 |
| 产品状态 | 产品化基础可验收，完整 Jarvis 未完成。 | 任何交付结论必须同时写阶段状态和产品状态。 |
| 磁盘状态 | 大量前序未提交产物存在，本轮不清理。 | 不使用 `git reset --hard`；不删除并行成员成果。 |
| 原项目边界 | 原项目 51735 仅作隔离参照，不是 Noe 开发目标。 | Noe 验收只写 Noe 目录；原项目未提交改动另案裁定。 |
| 危险操作 | 当前只允许 dry-run、awaiting_approval、blocked_safety。 | 删除、外发、批量移动、真实工具执行必须等用户明确确认。 |

## 7. 11 阶段工程闭环衔接

1. 用户想法：Noe 是当前主产品底座，不是原 Xike Lab 稳定项目。
2. 需求分析与拆解：继承 CE12 7 个 P0 和非目标，不把 Voice/Social 纳入 P0。
3. 技术方案设计：Node22 gate、ActPipeline、Brain UI、Electron smoke、patch-only adapter 的加法接线有效。
4. 任务分配与排期：T1-T7 已执行；下一轮只按 P0/P1/P2 行动项扩展。
5. 代码开发：CE05 当前已由聚合器和验收门证明，不因旧质量文字回退。
6. 单元测试：P0 单测当前 40/40；后续补 Memory/Act retry 分支。
7. 集成测试：CE07 18/18；后续补 retry HTTP 和更多真实 UI 操作。
8. 功能验证：CE08 真实 51835 14/14；后续证明 Voice/Social/Jarvis 体验。
9. 文档编写：CE09 83/83；后续瘦身旧 Phase 文件和统一入口。
10. 交付验收：CE10 59/59；后续产品验收必须套第 3 节 DoD。
11. 复盘优化：本文件输出原因裁定、错误经验、DoD、候选矩阵、P0/P1/P2、闭环方案。

## 8. 本轮已直接落地

1. 新增 `NOE_CE12_P0_RETROSPECTIVE_CANONICAL.md` 作为 CE12 后置复盘事实源。
2. 新增 `NOE_CE12_P0_RETROSPECTIVE_VERIFY.mjs`，把复盘要求做成机读门。
3. `package.json` 新增 `verify:p0:retro`。
4. `README.md` 增加 CE11 复盘入口和验证命令。
5. `NOE_CE12_P0_EVIDENCE_INDEX.md` 增加 CE11 证据切片。
6. 修复 CE11 复盘验证门中的旧 `48/48` 验收数字，改为当前 `verify:p0:acceptance` 实际输出 `59/59`，关闭本轮真实发现的 retro 门失败。
7. 新增 `src/room/MiniMaxSuggestionRouter.js`、`src/room/MiniMaxSuggestionPipeline.js`、`scripts/m3-suggest.mjs`、`tests/unit/minimax-suggestion-router.test.js`、`tests/unit/minimax-suggestion-pipeline.test.js`、`NOE_M3_SUGGESTION_ONLY.md` 和 `NOE_PRODUCT_NEXT_PLAN.md`，把 MiniMax M3 从“patch-only 补审点”改造为 suggestion-only 建议员，同时默认禁止 Mavis/OpenCode 本地执行器。

## 9. CE11 裁定

CE11 复盘优化通过的标准是：形成能减少下次返工的具体行动项，并明确防止“阶段验收通过 = 产品完成”的再次误判。

当前裁定：CE11 可通过。  
产品裁定：完整 Jarvis 产品仍未完成。  
下一步：按第 5 节 P0 优先级执行，不触碰原项目，不接危险真实工具。

## P1 当前复盘补充 - 2026-06-02

- 当前事实源：`NOE_CE12_P0_DOCS_CANONICAL.md`；完整 Jarvis 产品未完成。
- 经验更新：M3 的最佳定位是 suggestion-only / cheap-work-router，而不是平权本地执行器。它适合日志摘要、证据链整理、P0/P1 缺口扫描、中文体验审计和 patch plan。
- 风险更新：Mavis/OpenCode 本地执行器在无硬沙盒前不得无人值守启动；权限必须由代码层 allowlist、watchdog、diff gate 兜底。
- 证据更新：full/fast/partial latest 必须分离，避免快速检查覆盖正式验收结果。
