# Noe 阶段 2「需求分析与拆解」需求清单

生成时间：2026-06-01  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：2. 需求分析与拆解  
目标：把 Noe + BaiLongma 融合目标拆成可验收需求；本阶段不写产品代码、不覆盖审计稿、不修改原项目目录。

## 1. 只读复核基线

- Noe 目标契约：`NOE_PHASE1_目标契约_CANONICAL.md`
- BaiLongma 审计稿：`NOE_BAILONGMA_ARCH_AUDIT.md`
- 审计稿当前基线（脱敏后）：`wc -l` = 130 行；SHA-256 = `3cb9e198b1c90b2dc8abfab20ce98e8d019d32ba89fbbe39e3370e0055dc3a41`（取代含明文 doubaoKey 的旧版；旧版已脱敏，**不得回退**）
- 绑定基线不死锚易抖动的审计稿 SHA（该文件为多写入热点），改以两条可复跑/不可变的不变量为准：① BaiLongma 镜像 HEAD = `de78c6f761…`（不可变，见下行）；② 全部 `.md` 交付物无真实密钥，由 `node NOE_PHASE2_SECRET_GATE.mjs` 退出码 0 保证（见 R-07 / R-09）
- BaiLongma 镜像：`BaiLongma-audit/`，HEAD = `de78c6f761bd98a0fe406f0e78da80199ddf8d45`，`git status --short` 无输出
- 抽查事实：`package.json`、`src/index.js`、`src/db.js`、`src/memory`、`src/context`、`src/ui/brain-ui`、`src/voice`、`src/social`、`src/capabilities/marketplace`、`electron`、`config.json`、`LICENSE` 均在工作区镜像内存在
- Noe 基线：`package.json` = `noe@2.1.0`；默认端口 `51835`；数据/owner-token 默认位于 `~/.noe-panel`

## 2. 用户需求

1. 用户要接手并长期演进的是 Noe / Neo 贾维斯，不是原 Xike Lab 稳定项目。
2. 用户要以 Noe 为主产品底座，吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。
3. 用户不要硬拼两个项目，不要全量复制 BaiLongma，不要不审计就接工具执行能力。
4. 用户要所有阶段都有文件、命令或运行证据，且每条需求都有可验证验收口径。

## 3. 需求清单

### R-00 P0 工作区与只读边界
- 类型：非功能 / 治理
- 需求：所有本阶段读写只发生在 `/Users/hxx/Desktop/Neo 贾维斯`；原项目目录仅作为边界说明，不开发、不修改；BaiLongma 只使用工作区内镜像 `BaiLongma-audit/`。
- 验收：`pwd` 输出 Noe 工作区；`git -C BaiLongma-audit status --short` 无输出；本阶段新增/修改文件只包含 Noe 阶段文档或验证脚本。
- 依赖：无。

### R-01 P0 BaiLongma 审计复核基线
- 类型：功能 / 审计
- 需求：先复核现有 `NOE_BAILONGMA_ARCH_AUDIT.md`，不得覆盖重写；后续设计只能引用已由镜像文件验证过的事实。
- 验收：记录审计稿 `wc -l`、SHA-256、BaiLongma HEAD；抽查重点路径存在；若审计稿变化，先重新登记基线再继续。
- 依赖：R-00。

### R-02 P0 端口与数据隔离
- 类型：非功能 / 运行隔离
- 需求：Noe 必须独立运行在 `51835`，不占用、不停止、不污染原项目 `51735`；Noe 数据继续走 `~/.noe-panel`。
- 验收：运行 `node NOE_M1_ISOLATION_SMOKE.mjs` 或等价脚本，证明 51835 可启动并返回 HTTP 200，owner-token 未授权请求返回 401，启动前/运行中/停止后 51735 PID 不变。
- 依赖：R-00、R-01。

### R-03 P0 NoeLoop 最小闭环
- 类型：功能 / 核心闭环
- 需求：实现 Noe 自己的可启停 TICK loop；默认空跑或本地状态轮询，不自动调用真实 LLM、不执行工具、不消耗额度。
- 验收：单元测试覆盖 start/stop/status/tick 计数、并发启动幂等、abort/watchdog；测试中 mock 掉模型适配器并断言真实 adapter 未被调用。
- 依赖：R-02。

### R-04 P0 Memory Core
- 类型：功能 / 数据
- 需求：建立 Noe 自己的记忆核心，至少区分 user memory、project memory、task memory、focus memory、evidence memory；不得直迁 BaiLongma 整库 schema。
- 验收：schema/migration 单测通过；写入、读取、关键词召回、按项目隔离、软删除或隐藏策略均有测试；数据落在 Noe 自有存储层，不写入 BaiLongma 镜像。
- 依赖：R-01、R-03。

### R-05 P1 Focus Stack
- 类型：功能 / 上下文管理
- 需求：为 NoeLoop 和 Memory Core 提供当前任务焦点栈，支持 push、refresh、pop、压缩摘要，并能回填到记忆。
- 验收：单测覆盖焦点入栈、重复命中计数、弹栈压缩、重启后恢复；验收用例能证明旧焦点不会污染新任务上下文。
- 依赖：R-03、R-04。

### R-06 P1 Brain UI Lite
- 类型：功能 / UI
- 需求：在 Noe 主 UI 中做轻量 Brain 视图，展示 loop 状态、当前焦点、思考流、记忆召回、工具审批和系统健康；不整页搬 BaiLongma `brain-ui`。
- 验收：存在可访问路由或面板入口；Playwright 或等价浏览器验证能看到 loop/focus/memory/tool/health 五类状态；截图证明 UI 未遮挡现有主流程。
- 依赖：R-03、R-04、R-05。

### R-07 P2 Voice 本机语音
- 类型：功能 / 体验
- 需求：在核心闭环稳定后，再引入本机语音输入和 TTS；不得复制 BaiLongma 明文 key 配置模式。
- 验收：默认关闭；启用时需要显式本机配置；secret 扫描（`node NOE_PHASE2_SECRET_GATE.mjs` 退出码 0）证明 `.md`、diff、配置样例不含真实 key；语音 smoke test 可在无外部社交连接时独立通过。
- 依赖：R-06。

### R-08 P2 Social I/O
- 类型：功能 / 外部连接
- 需求：社交输入输出必须作为独立安全阶段处理；微信、Discord、webhook 等连接器不得默认自动发消息。
- 验收：所有外部 I/O 写动作必须经过 owner-token、权限分级和审计日志；未配置凭据时 connector 处于 disabled；集成测试证明默认不会对外发送。
- 依赖：R-04、R-06。

### R-09 P1 工具市场与执行权限
- 类型：功能 / 安全
- 需求：吸收 BaiLongma 工具市场思路，但所有工具 manifest、exec/fetch/file-write 能力必须进入 Noe 现有审批、审计和权限治理。
- 验收：manifest schema 校验存在；未知工具默认不可执行；高风险工具无 approval 时被阻断并写审计；有 approval 时只执行白名单动作；工具 manifest / 配置样例落盘前过 `node NOE_PHASE2_SECRET_GATE.mjs`（退出码 0），确保不引入真实密钥。
- 依赖：R-00、R-03。

### R-10 P1 Jarvis 体验整合
- 类型：功能 / 产品体验
- 需求：把 loop、memory、focus、UI、工具审批整合为可理解的 Jarvis 体验，用户能看到它在做什么、为什么停下、需要什么授权。
- 验收：端到端用例覆盖用户发起任务、loop 记录状态、memory 召回、Brain UI 展示、工具审批阻断/恢复；失败态有明确 UI 或日志证据。
- 依赖：R-03、R-04、R-05、R-06、R-09。

## 4. 依赖关系与优先级

| 顺序 | 需求 | 优先级 | 进入下一阶段前状态 |
|---|---|---|---|
| 1 | R-00 工作区与只读边界 | P0 | 必须通过 |
| 2 | R-01 审计复核基线 | P0 | 必须通过 |
| 3 | R-02 端口与数据隔离 | P0 | 技术设计前必须有运行证据 |
| 4 | R-03 NoeLoop 最小闭环 | P0 | 代码开发第一切片 |
| 5 | R-04 Memory Core | P0 | NoeLoop 后第一核心模块 |
| 6 | R-05 Focus Stack | P1 | Memory Core 后接入 |
| 7 | R-09 工具市场与执行权限 | P1 | 任何工具执行前必须完成 |
| 8 | R-06 Brain UI Lite | P1 | 核心状态稳定后做 |
| 9 | R-10 Jarvis 体验整合 | P1 | 汇总验收 |
| 10 | R-07 Voice 本机语音 | P2 | 延后 |
| 11 | R-08 Social I/O | P2 | 延后且需单独安全评审 |

## 5. 缺口问题

1. `NOE_BAILONGMA_ARCH_AUDIT.md` 内 schema 字段仍需字段级复核；关闭口径：对 `src/db.js` 表、列、FTS、索引逐项核对并回写审计稿或新增复核记录。
2. NoeLoop 的存储位置和 API 形态待技术方案确定；关闭口径：技术方案阶段给出模块路径、状态机、禁用真实 LLM 的测试策略。
3. Memory Core 是否复用 `src/storage/SqliteStore.js` 还是新建 store 待决策；关闭口径：技术方案阶段给出 schema 变更和迁移测试。
4. Brain UI Lite 是新路由还是现有面板内嵌待设计；关闭口径：技术方案阶段给出路由、组件边界和截图验收方式。
5. Voice/Social 凭据管理方式待安全评审；关闭口径：进入对应阶段前给出 secret 装载、默认禁用、审计日志和回滚策略。

## 6. 工程闭环落地

1. 用户想法：已由 `NOE_PHASE1_目标契约_CANONICAL.md` 固定目标、范围和红线。
2. 需求分析与拆解：本文件给出 R-00 至 R-10，每条需求含可验证验收口径。
3. 技术方案设计：下一阶段按 R-02 至 R-10 输出模块路径、数据流、安全门和测试策略。
4. 任务分配与排期：按 P0 到 P2 串行，P0 未过不得并行做 Voice/Social。
5. 代码开发：从 R-03 NoeLoop 开始，只在 Noe 目录实现，不复制 BaiLongma 整仓。
6. 单元测试：每个核心模块必须有窄单测；NoeLoop、Memory、Focus、权限门为必测。
7. 集成测试：端口隔离、owner-token、数据目录、审批、memory recall、Brain UI 路由逐项验证。
8. 功能验证：用端到端任务证明用户能观察 loop、memory、focus、tool approval 和失败态。
9. 文档编写：持续更新需求、技术方案、验证报告和交接文件，不覆盖审计事实源。
10. 交付验收：每阶段必须给出文件证据、命令输出、测试结果；涉及 UI 时必须有截图或浏览器证据。
11. 复盘优化：复盘范围漂移、安全面、额度消耗、后台 loop 干扰、UI 可理解性和多成员协同成本。
