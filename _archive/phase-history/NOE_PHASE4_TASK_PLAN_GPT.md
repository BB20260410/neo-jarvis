# Noe / Neo 贾维斯 阶段 4 任务分配与排期 - GPT 独立方案

生成时间：2026-06-02（Asia/Shanghai）
工作区：`/Users/hxx/Desktop/Neo 贾维斯`
阶段：4. 任务分配与排期
输入基线：`NOE_PHASE3_TECH_DESIGN_CANONICAL.md`
范围红线：只在 Noe 工作区实施；不改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`；不全量复制 BaiLongma；不接入未审计的工具执行能力；Voice/Social 保持 P2 延后。

## 1. 阶段 4 结论

同意进入后续代码开发，但必须按 M0 到 M8 串行推进，P0 未过不得抢跑 Brain UI 以外的体验增强，更不得提前启用工具执行、Voice 或 Social I/O。

本阶段排期目标是把阶段 3 canonical 方案拆成可逐项验收的任务队列。每个任务都必须有负责人、输入文件、交付文件、阻塞点、验收命令和通过门槛。

## 2. 角色分工

| 角色 | 主责 | 不负责 |
|---|---|---|
| GPT / Codex（builder） | 代码开发、脚本落地、窄验证、修复回归、写阶段交接 | 不越过 approval/secret/原项目边界 |
| Claude（designer/judge，可用时） | 复核架构一致性、查并行事实源漂移、裁定是否推进 | 不要求重写已通过的 P0 方案 |
| Gemini CLI（verifier） | 只读审计、安全风险复核、路径污染和不可逆操作检查 | 普通优化建议不阻断阶段切换 |
| 用户 | 只在高风险点裁定：开启工具执行、接入外部账号、Voice/Social 对外写入 | 不需要为普通代码小步修改逐项批准 |

## 3. 执行顺序与任务队列

| 顺序 | 任务 ID | 任务 | 负责人 | 主要交付物 | 依赖 | 验证门 |
|---:|---|---|---|---|---|---|
| 0 | M0-PREP | 锁定代码开发基线与排期文件；复跑 secret/phase3 门 | GPT | 本文件、验证输出 | 阶段 3 canonical | `node NOE_PHASE2_SECRET_GATE.mjs`、`node NOE_PHASE3_VERIFY.mjs` 均 PASS |
| 1 | M1-ISO | 端口和原项目隔离实测 | GPT 实施，Gemini 复核 | `NOE_M1_ISOLATION_SMOKE.mjs` 结果记录 | 51835 空闲或可解释 | 51835 真启停，51735 PID 前后不变，受保护 API 返回 401 |
| 2 | M2-DB | 添加 Noe v2 迁移表：`noe_memory`、FTS、`noe_focus_stack`、`noe_tools` | GPT | `src/storage/SqliteStore.js` 迁移、schema 单测 | M1 PASS | 迁移单测 PASS；现有 schema/route 单测不回归 |
| 3 | M3-MEM | MemoryCore 最小实现：write/recall/hide/bumpHit，FTS 不可用时 LIKE 降级 | GPT | `src/memory/MemoryCore.js`、`tests/unit/memory-core.test.js` | M2 PASS | 写入、召回、项目隔离、软删除、FTS/LIKE 两路径 PASS |
| 4 | M4-FOCUS | FocusStack 最小实现：push/refresh/pop/restore，pop 沉淀 memory | GPT | `src/memory/FocusStack.js`、`tests/unit/focus-stack.test.js` | M3 PASS | refresh 计数、pop 摘要、重启恢复、沉淀 memory PASS |
| 5 | M5-LOOP | NoeLoop 最小闭环：默认 disabled、start/stop/status/tick、本地零额度 tick | GPT | `src/loop/NoeLoop.js`、loop 单测 | M3/M4 PASS | 默认不烧额度；重入锁、abort、连续错误 stop、budget pause PASS |
| 6 | M6-API | 新增 `/api/noe/*` 路由并接 owner-token | GPT | `src/server/routes/noe.js`、server 路由挂载、路由单测 | M3/M4/M5 PASS | 未带 token 返回 401；memory/focus/loop health 基本接口 PASS |
| 7 | M7-BRAIN | Brain UI Lite 只读面板：Loop、Focus、思考流、Memory、审批/健康 | GPT 实施，Claude/Gemini 视觉与安全复核 | `public/src/web/brain-ui.js`、必要 CSS/入口挂载、截图证据 | M6 PASS | 51835 页面可见；不遮挡现有主流程；移动/桌面无明显重叠 |
| 8 | M8-TOOLS | ToolRegistry manifest-only：注册、风险分级、默认 disabled、invoke 阻断链 | GPT，Gemini 安全复核 | `src/capabilities/ToolRegistry.js`、工具单测 | M6 PASS | 未知/disabled 403；deny/ask/allow 状态机单测；ActivityLog 记录 |
| 9 | P2-CONTRACT | Voice/Social/Jarvis 体验只写接口契约和后续 TODO，不接外部账号 | GPT | 文档小节或 TODO 清单 | M7/M8 PASS | secret 门 PASS；没有真实 token；没有外部写入代码 |

## 4. 排期与检查点

排期按 T 日滚动，不绑定自然日期，避免多成员异步时因时区漂移造成误判。

| 检查点 | 预计窗口 | 必须完成 | 推进条件 |
|---|---|---|---|
| CP0 | T+0 | M0-PREP | secret 门和 phase3 门 PASS，本文件落盘 |
| CP1 | T+0.5 | M1-ISO | 51835 真启停且 51735 零影响 |
| CP2 | T+1 | M2-DB + M3-MEM | schema 加法迁移、MemoryCore 单测 PASS |
| CP3 | T+2 | M4-FOCUS + M5-LOOP | Focus/Loop 单测 PASS，默认零额度 |
| CP4 | T+3 | M6-API | owner-token、路由、health 聚合 PASS |
| CP5 | T+4 | M7-BRAIN | 浏览器截图/人工可读证据 PASS |
| CP6 | T+5 | M8-TOOLS + P2-CONTRACT | 工具默认禁用、安全链路 PASS，Voice/Social 不抢跑 |

## 5. 阻塞点与处理

| 阻塞点 | 判定 | 处理 |
|---|---|---|
| 51835 已被其他 Noe 进程占用 | M1.0 fail | 不 kill 未知 PID；记录 PID 和命令行，用户或运行者确认后重跑 |
| 51735 PID 改变 | M1.5 或 M1.7 fail | 停止推进，先确认是否误伤原项目 |
| Node 版本导致 better-sqlite3 ABI 报错 | 启动或测试失败且出现 NODE_MODULE_VERSION | 切 Node 22.x 或 `npm rebuild better-sqlite3`，不改业务代码 |
| FTS5/trigram 不可用 | MemoryCore 探针 fail | 启用 LIKE 降级，记录为 P1 优化，不阻断 P0 |
| secret 门命中真实凭据 | `NOE_PHASE2_SECRET_GATE.mjs` fail | 立即停止，先脱敏/外置 secret 后再继续 |
| 工具执行需要外部账号或高危权限 | M8 invoke 需要真实执行 | 本阶段只做到 manifest/审批/阻断，不调用真实外部工具 |

## 6. 各工程闭环阶段落地方式

1. 用户想法：继续以 `NOE_PHASE1_目标契约_CANONICAL.md` 作为边界，不回到 Xike Lab 稳定项目。
2. 需求分析与拆解：继续以 `NOE_PHASE2_REQUIREMENTS_CANONICAL.md` 的 UR/FR/NFR/Q 为验收输入。
3. 技术方案设计：只采用 `NOE_PHASE3_TECH_DESIGN_CANONICAL.md`，并行草稿只作参考，不得引入独立库或外部 MQ。
4. 任务分配与排期：本文件给出 M0 到 M8 队列、模型分工、排期、阻塞点和检查点。
5. 代码开发：从 M1 到 M8 串行开发，每步小提交面，优先加法文件和局部路由。
6. 单元测试：每个新增领域模块必须有对应 `tests/unit/*`，先模块单测再全量 `npm test`。
7. 集成测试：M1 隔离、M6 owner-token、M7 UI、M8 approval/permission/audit 链路逐项测。
8. 功能验证：用 51835 实例验证 loop、memory、focus、Brain UI、工具阻断的最小 Jarvis 闭环。
9. 文档编写：每个检查点更新阶段记录或上下文交接，记录命令输出和未解风险。
10. 交付验收：以文件 diff、测试输出、截图/浏览器证据、secret 门 PASS 作为验收证据。
11. 复盘优化：复盘范围漂移、额度风险、工具安全、UI 可理解性和多成员协作成本。

## 7. 阶段 4 完成门槛

- 任务粒度可以逐项执行和验收。
- M1 到 M8 的依赖顺序清楚，P2 不抢跑。
- 每项有明确负责人、交付物和验证门。
- 明确哪些问题会阻断推进，哪些只是后续优化。
- 当前阶段不写产品代码、不改 schema、不启动外部账号能力，只交付排期和可执行队列。

## 8. 本阶段实测命令

```bash
pwd
node NOE_PHASE2_SECRET_GATE.mjs
node NOE_PHASE3_VERIFY.mjs
git -C BaiLongma-audit rev-parse HEAD
git -C BaiLongma-audit status --short
wc -l NOE_PHASE4_TASK_PLAN_GPT.md
```

裁定：阶段 4 从 GPT 视角可推进。下一阶段代码开发应先执行 M1-ISO，再进入 M2-DB/M3-MEM；任何成员试图先做 Voice/Social、真实工具执行或 BaiLongma 全量复制，都应视为范围漂移。
