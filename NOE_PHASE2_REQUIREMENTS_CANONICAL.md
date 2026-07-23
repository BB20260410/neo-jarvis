# Noe / Neo 贾维斯 — 阶段 2「需求分析与拆解」CANONICAL

生成时间：2026-06-01
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：2. 需求分析与拆解
结论：阶段 2 需求拆解已收敛为本文件；可推进到阶段 3「技术方案设计」。

## 0. 本轮修订结论

- 采纳对方反馈 1：复核 `NOE_BAILONGMA_ARCH_AUDIT.md`，当前 `doubaoKey` 值为 `<REDACTED>`；不在任何阶段 2 文档中复述原值。
- 采纳对方反馈 2：修正 `NOE_PHASE2_REQUIREMENTS_拆解_Claude.md` 的“审计稿内已脱敏”表述，补记“上一轮曾被指出未脱敏，当前已按 secret 卫生处理”。
- 采纳对方反馈 3：将窄 secret 扫描纳入本阶段验收证据；扫描范围覆盖 `NOE_BAILONGMA_ARCH_AUDIT.md`、阶段 2 需求稿和 canonical 稿。
- 采纳对方反馈 4：本文件作为阶段 2 唯一 canonical 事实源；`NOE_PHASE2_REQUIREMENTS.md` 与 `NOE_PHASE2_REQUIREMENTS_拆解_Claude.md` 仅保留为成员独立稿。
- 本轮没有修改原项目目录 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`；没有复制 BaiLongma 代码进 Noe；没有接入任何工具执行能力。

## 1. 只读复核基线

| 项 | 本轮实测事实 | 验收口径 |
|---|---|---|
| 当前目录 | `/Users/hxx/Desktop/Neo 贾维斯` | `pwd` 输出必须是 Noe 工作区 |
| BaiLongma 镜像 | `BaiLongma-audit/`，HEAD `de78c6f761bd98a0fe406f0e78da80199ddf8d45` | `git -C BaiLongma-audit rev-parse HEAD` |
| 镜像状态 | `git -C BaiLongma-audit status --short` 无输出 | 只读审计镜像不能有改动 |
| 审计稿 | `NOE_BAILONGMA_ARCH_AUDIT.md`，130 行，SHA-256 `3cb9e198b1c90b2dc8abfab20ce98e8d019d32ba89fbbe39e3370e0055dc3a41` | `wc -l` 与 `shasum -a 256` 可复核 |
| Secret 状态 | 审计稿 `doubaoKey` 当前为 `<REDACTED>` | 窄 secret 扫描必须 PASS |
| Noe 基线 | `noe@2.1.0`；目标端口 `51835`；Noe 数据根 `~/.noe-panel` | 阶段 3/4 设计不得漂回原项目 `51735` |

## 2. 用户需求

| ID | 需求 | 验收口径 |
|---|---|---|
| UR-1 | 接手并长期演进的是 Noe / Neo 贾维斯，不是原 Xike Lab 稳定项目。 | 所有阶段文档均以 Noe 为主语；原项目仅作边界参考。 |
| UR-2 | Noe 做主产品底座，吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O、工具市场思路。 | 技术方案必须逐项标明“吸收思路 / 延后 / 拒绝”，不得整仓硬拼。 |
| UR-3 | 先只读审计 BaiLongma，再设计融合路线。 | 阶段 3 只能引用审计稿或镜像行号已验证的事实。 |
| UR-4 | 不全量复制 BaiLongma，不搬密钥，不在未审计前接入工具执行能力。 | Secret 扫描 PASS；工具执行默认 disabled；任何 exec/fetch/file-write 必须经过权限设计。 |
| UR-5 | Noe 必须能独立在 `51835` 启动且不影响原项目 `51735`。 | 阶段 3/4 必须保留 `NOE_M1_ISOLATION_SMOKE.mjs` 或等价隔离验收。 |
| UR-6 | 用户需要可观察的 Jarvis 体验：知道 loop 在做什么、为什么停下、需要什么授权。 | Brain UI Lite 或等价面板必须显示 loop、memory、focus、tool approval、health 状态。 |

## 3. 功能需求

| ID | 优先级 | 需求 | 验收口径 | 依赖 |
|---|---|---|---|---|
| FR-00 | P0 | 工作区边界：所有读写只发生在 `/Users/hxx/Desktop/Neo 贾维斯`；不得修改原项目目录。 | `pwd` 为 Noe；`git status --short -- NOE_PHASE2_REQUIREMENTS_CANONICAL.md NOE_PHASE2_REQUIREMENTS_拆解_Claude.md NOE_BAILONGMA_ARCH_AUDIT.md` 只显示 Noe 内阶段文件。 | 无 |
| FR-01 | P0 | 审计复核：BaiLongma 事实来自 `BaiLongma-audit/` 与 `NOE_BAILONGMA_ARCH_AUDIT.md`，不得重新覆盖审计稿。 | 记录审计稿行数、SHA、BaiLongma HEAD；镜像 `status --short` 无输出。 | FR-00 |
| FR-02 | P0 | Secret 卫生：BaiLongma 配置中的真实或疑似凭据不得进入阶段文档、Noe 配置或 git diff。 | `node NOE_PHASE2_VERIFY.mjs` 输出 `secretScan.findings=[]`；`doubaoKey` 只允许 `<REDACTED>` 或占位说明。 | FR-00、FR-01 |
| FR-03 | P0 | 端口与数据隔离：Noe 使用 `51835` 与 `~/.noe-panel`，不得占用或停止原项目 `51735`。 | `node NOE_M1_ISOLATION_SMOKE.mjs` 或等价脚本证明 51835 HTTP 200、未授权 401、51735 PID 前中后不变。 | FR-00 |
| FR-04 | P0 | NoeLoop 最小闭环：实现 Noe 自己的可启停 TICK loop，默认空跑或本地状态轮询。 | 单测覆盖 start/stop/status/tick 计数、并发启动幂等、abort/watchdog；mock 证明默认不调用真实 LLM。 | FR-03 |
| FR-05 | P0 | Memory Core：建立 Noe 自己的 user/project/task/focus/evidence memory，不直迁 BaiLongma 整库 schema。 | migration/schema 单测通过；写入、读取、关键词召回、项目隔离、软删除或隐藏策略均有测试。 | FR-01、FR-04 |
| FR-06 | P1 | Focus Stack：支持 push、refresh、pop、压缩摘要，并可沉淀到 Memory Core。 | 单测覆盖入栈、重复命中计数、弹栈压缩、重启恢复；旧焦点不会污染新任务。 | FR-04、FR-05 |
| FR-07 | P1 | Brain UI Lite：展示 loop 状态、当前焦点、思考流、记忆召回、工具审批、系统健康。 | Playwright 或等价浏览器验证五类状态可见；截图证明 UI 未遮挡现有主流程。 | FR-04、FR-05、FR-06 |
| FR-08 | P1 | 工具市场与执行权限：吸收 marketplace 思路，但所有 manifest 和执行能力进入 Noe 审批、审计、权限治理。 | 未知工具默认不可执行；高风险工具无 approval 被阻断并写审计；有 approval 时只执行白名单动作。 | FR-01、FR-04 |
| FR-09 | P1 | Jarvis 体验整合：用户能看到任务发起、loop 状态、memory 召回、审批阻断和恢复。 | 端到端用例覆盖任务→loop→memory→Brain UI→审批阻断/恢复；失败态有 UI 或日志证据。 | FR-04、FR-05、FR-07、FR-08 |
| FR-10 | P2 | Voice：核心闭环稳定后再引入本机 ASR/TTS；不得复制 BaiLongma 明文 key 配置模式。 | 默认关闭；启用需要显式本机配置；secret 扫描 PASS；语音 smoke 可独立通过。 | FR-07 |
| FR-11 | P2 | Social I/O：微信、Discord、webhook 等外部连接器不得默认自动发消息。 | 未配置凭据时 connector disabled；所有对外写动作需 owner-token、权限分级、审计日志；集成测试证明默认不会对外发送。 | FR-05、FR-07 |

## 4. 非功能需求

| ID | 优先级 | 需求 | 验收口径 |
|---|---|---|---|
| NFR-SEC-1 | P0 | 本地优先，仅监听 `127.0.0.1`，复用 owner-token、Origin 白名单、路径沙箱和 body limit。 | 安全路由单测或 smoke test 通过；未授权请求返回 401。 |
| NFR-SEC-2 | P0 | 不把 BaiLongma 密钥、token、私钥、cookie 搬入 Noe。 | secret 扫描 PASS；diff 中无真实凭据。 |
| NFR-COST-1 | P0 | 后台 loop 默认不烧模型额度；真实 LLM 调用必须经过预算闸门。 | 单测 mock adapter，断言默认无真实付费 API 调用；预算超限自动停。 |
| NFR-ISO-1 | P0 | 不污染原项目，不改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。 | 本阶段工具读写目标只在 Noe；后续若需对照原项目，只读且先说明。 |
| NFR-REV-1 | P0 | 可逆性：不得执行无关 `git reset --hard`、`git checkout --`、`git clean`。 | 变更集中在阶段文件和后续明确模块；`git status --short` 可审计。 |
| NFR-DEP-1 | P1 | 不新增依赖，除非技术方案列明必要性、替代方案和验证成本。 | 阶段 3 若需依赖，必须给 package diff、理由和回滚方式。 |
| NFR-PERF-1 | P1 | Memory、FTS、embedding、loop 不显著拖慢现有面板启动和交互。 | 阶段 7 集成测试记录启动时间、关键接口响应、loop 空跑开销。 |
| NFR-TEST-1 | P0 | 每个 P0/P1 模块都要有窄单测，UI 变更要有浏览器或截图证据。 | 单测、集成测试、功能验证阶段均输出命令和结果。 |
| NFR-DOC-1 | P0 | 每阶段保留可交接文档，避免 compact 后丢上下文。 | 更新 canonical 需求、技术方案、验证报告或 `上下文交接.md`。 |

## 5. 依赖关系与优先级

```text
FR-00 工作区边界
  -> FR-01 审计复核
  -> FR-02 Secret 卫生
  -> FR-03 端口与数据隔离
  -> { FR-04 NoeLoop, FR-05 Memory Core }
  -> FR-06 Focus Stack
  -> FR-07 Brain UI Lite
  -> FR-08 工具市场权限
  -> FR-09 Jarvis 体验整合
  -> { FR-10 Voice, FR-11 Social I/O }
```

- P0 必须先过：FR-00、FR-01、FR-02、FR-03、FR-04、FR-05，以及所有 P0 NFR。
- P1 是核心产品闭环：FR-06、FR-07、FR-08、FR-09。
- P2 延后且单独评审：FR-10、FR-11；不得在核心闭环前抢跑。

## 6. 缺口问题

| ID | 缺口 | 影响 | 关闭口径 |
|---|---|---|---|
| Q-1 | Memory Core 是并入现有 `src/storage/SqliteStore.js`，还是建独立 Noe memory store？ | FR-05 | 阶段 3 给出 schema diff、迁移策略、测试路径。 |
| Q-2 | NoeLoop 是 server 内嵌模块还是独立 worker？ | FR-04、FR-09 | 阶段 3 给出进程模型、状态机、停止策略、预算闸门接入点。 |
| Q-3 | FTS5 trigram 与 embedding 是否同阶段落地？ | FR-05 | 阶段 3 默认先设计 FTS5；embedding 若涉及付费或本地模型，单独列成本与隐私。 |
| Q-4 | Brain UI Lite 挂现有路由还是新 tab？ | FR-07 | 阶段 3 给组件边界、路由、状态源和截图验收方式。 |
| Q-5 | 工具市场 manifest 如何映射 Noe 现有权限系统？ | FR-08 | 阶段 3 给 manifest schema、风险等级、approval 流程和审计字段。 |
| Q-6 | Voice/Social 凭据如何装载与回滚？ | FR-10、FR-11 | 进入 P2 前给 secret 装载、默认禁用、审计日志、撤销策略。 |
| Q-7 | 集群协同和 NoeLoop 是否会互相触发或抢预算？ | FR-04、NFR-COST-1 | 阶段 3 明确 loop 与 room/agents 的互斥或调度协议。 |

## 7. 工程闭环 11 阶段落地

1. 用户想法：已由 `NOE_PHASE1_目标契约_CANONICAL.md` 固定目标、边界、红线。
2. 需求分析与拆解：本文件给出用户需求、功能需求、非功能需求、验收条件、依赖、缺口；每条需求都有可验证口径。
3. 技术方案设计：下一阶段围绕 Q-1 至 Q-7 输出模块路径、数据流、schema、权限门、测试策略。
4. 任务分配与排期：按 P0 → P1 → P2 串行；P0 未通过不得做 Voice/Social。
5. 代码开发：从 NoeLoop、Memory Core 开始，只在 Noe 目录开发，不复制 BaiLongma 整仓。
6. 单元测试：NoeLoop、Memory、Focus、权限门、secret 卫生均要有窄单测或脚本。
7. 集成测试：验证端口隔离、owner-token、数据目录、memory recall、Brain UI、工具审批。
8. 功能验证：用端到端任务证明 Jarvis 体验可观察、可暂停、可恢复。
9. 文档编写：持续更新 canonical 文档、技术方案、验证报告和交接文件。
10. 交付验收：每阶段必须给文件证据、命令输出、测试结果；涉及 UI 必须给截图或浏览器证据。
11. 复盘优化：复盘范围漂移、安全面、额度消耗、后台 loop 干扰、UI 可理解性和多成员协同成本。

## 8. 本阶段验收命令

```bash
pwd
wc -l NOE_BAILONGMA_ARCH_AUDIT.md NOE_PHASE2_REQUIREMENTS_CANONICAL.md NOE_PHASE2_REQUIREMENTS_拆解_Claude.md
shasum -a 256 NOE_BAILONGMA_ARCH_AUDIT.md NOE_PHASE2_REQUIREMENTS_CANONICAL.md NOE_PHASE2_REQUIREMENTS_拆解_Claude.md
git -C BaiLongma-audit rev-parse HEAD
git -C BaiLongma-audit status --short
node NOE_PHASE2_VERIFY.mjs
```

阶段 2 裁定：本文件满足“需求清单、验收标准、依赖关系、缺口问题”四项交付物；每条需求都有可验证验收口径；本轮 secret 阻断已修复并有扫描证据。建议进入阶段 3「技术方案设计」。
