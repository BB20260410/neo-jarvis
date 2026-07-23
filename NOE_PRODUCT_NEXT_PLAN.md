# Neo / Neo 贾维斯后续产品计划

生成时间：2026-06-02  
当前状态：CE12 P0 产品化基础已通过验收；完整 Jarvis 产品未完成。

> 2026-06-06 更新：当前执行路线已切到 `docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md`。商业化、公开分发、增长功能、Tool marketplace、Tauri 重写暂停；本文件保留为 CE12 后续路线背景。

## 1. 下一步总判断

当前最重要的不是继续堆功能，而是把 P0 基础从“可验收工程切片”推进成“用户每天能用的产品闭环”。

优先级顺序：

1. 先收敛事实源和验证入口，避免旧 Phase 文件继续干扰。
2. 再把 M3 做成建议员，节省 Claude/GPT 额度但不降低质量。
3. 然后升级 Memory / File Index / Observability。
4. 最后推进 Voice、Social I/O、完整 Jarvis 体验。

## 2. P0 - 立即做，目标是减少返工

| ID | 任务 | 产物 | 验收口径 |
|---|---|---|---|
| P0-01 | 收敛当前事实源入口 | README、handoff、evidence、acceptance、retrospective 统一指向 CE12 | 文档门能证明旧 Phase 文件只作历史参考 |
| P0-02 | API-only M3 suggestion endpoint | 复用 `runM3SuggestionTask()`，只接收精选上下文，只输出 JSON 建议 | M3 不产生 tool_calls、不读文件、不跑 shell |
| P0-03 | Mavis/OpenCode 安全封装设计 | watchdog、tool allowlist、sandbox、diff gate 设计稿 | M3 本地 executor 永久禁用；未来非 M3 执行器另走安全设计 |
| P0-04 | verify full/fast 证据分流 | full latest 与 fast latest 分开 | fast 不覆盖完整验收证据 |
| P0-05 | 开源审计脚本容错 | per-repo retry、partial output、failed-row 标记 | 单个 GitHub EOF 不导致整批失败 |

## 3. P1 - 产品化能力升级

| ID | 任务 | 产物 | 验收口径 |
|---|---|---|---|
| P1-01 | Memory M1 | source、confidence、ttl、hide/merge trace | UI 可见来源和可信度，单测 + recall eval |
| P1-02 | 本地文件索引 | SQLite FTS 只读索引测试目录 | 可用自然语言定位文件，不外发 |
| P1-03 | Act Pipeline HTTP 补强 | retry/cancel 端到端集成 | 失败重试、取消、blocked_safety 都有 HTTP 证据 |
| P1-04 | Local-only observability | trace/log/error timeline | 本地可见，默认不上传 |
| P1-05 | Electron 正式化 | app name/icon/log/menu/启动退出 | smoke 仍通过，不残留 Xike 命名 |

## 4. P2 - 完整 Jarvis 体验

| ID | 任务 | 产物 | 验收口径 |
|---|---|---|---|
| P2-01 | Voice 输入/输出 | 本地语音主路径 | 默认不外发，用户能用语音触发主流程 |
| P2-02 | Social I/O 只读原型 | 只读拉取和展示 | 外发路径必须审批，不接真实发布 |
| P2-03 | Tool marketplace manifest | 暂停 | 当前不做，避免扩大攻击面和维护成本 |
| P2-04 | Knowledge Graph spike | 项目/文件/任务关系图 | 不替换 NoeLoop，只验证窄关系记忆 |
| P2-05 | 分发路线 | 暂停 | 当前不做商业化或公开分发 |

## 5. 不做清单

- 不把 M3 变成主开发成员。
- 不让 Mavis/OpenCode 无人值守读文件或跑 shell。
- 不把 P0 通过写成完整 Jarvis 产品完成。
- 不接真实外发、删除、批量移动。
- 不把 BaiLongma 全量复制进 Neo。
- 不在原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 继续做 Neo 产品开发。

## 6. 推荐下一轮执行顺序

1. P0-01 文档入口收敛。
2. P0-02 API-only M3 suggestion endpoint，复用已落地的 `MiniMaxSuggestionPipeline`。
3. P0-04 full/fast evidence 分流。
4. P1-01 Memory M1。
5. P1-02 本地文件索引。

这样做的原因：先把协作和证据成本降下来，再加长期记忆和文件理解，最后再进入 Voice/Social 这种高成本体验层。

## P1 当前执行优先级 - 2026-06-02

- 当前事实源：`NOE_CE12_P0_DOCS_CANONICAL.md`；完整 Jarvis 产品未完成。
- P1.1：收敛 README / handoff / evidence / acceptance / retrospective 当前入口。
- P1.2：把 M3 suggestion pipeline 接成内部 endpoint：`POST /api/noe/m3/suggest`。
- P1.3：分离 full / fast / partial 验收 evidence latest，避免 fast 覆盖 full。
- P1.4：升级 Memory M1：confidence、TTL/expiry、merge trace、hide reason。
- P1.5：做本地文件只读索引：默认工作区内文本索引，只读、无删除、无移动、无外发。
