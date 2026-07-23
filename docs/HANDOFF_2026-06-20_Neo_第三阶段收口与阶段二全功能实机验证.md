# 任务交接：Neo Evidence Flywheel v2 第三阶段收口 + 阶段二全功能实机验证

更新时间：2026-06-20 CST

## 一句话

第三阶段 Reward Gate 已收口（多模型共识 passed + ledger verify PASS）；阶段二全功能实机验证完成（5538 测试 HEAD 全绿 + 621 功能清单 + 89.9% 真单测覆盖 + 核心 e2e 实操 + 三立场交叉审核），整体可用性裁决=可用。

## 阶段一成果：第三阶段 Reward Gate 收口

- 重跑全套验证：node --check 18/18、Vitest **59 passed**（reward-hacking gate，含 3 轮加固新增 6 个 TDD 测试）、acceptance gate `ok:true` 保持失败基线 `33/7/0`、SHA256/dirty-state 刷新、redaction `high=0`。
- **计划外重大修复**：reward-hacking gate 实测有一连串真实绕过（失败基线能被洗成"通过"）。3 轮架构演进（连词补全→结构判定→**子句切分 + pass-trigger 隐式边界 + normalize**）+ 2 个 P1（deny 双否定 / 单字"没"）。Lorentz **三轮**反向复审确认**无 P0** + Faraday 证据一致性 **PASS**。
- gate 最终 hash：`85693029b5ce55a581be26c2ab673334637b22a3b21a920f6797c93ea18b91d6`（`src/eval/NeoEvalRewardHackingGate.js`，untracked）。
- 多模型共识 `20260620-evidence-flywheel-v2-third-slice-final-rerun` = **consensus_passed**（codex/claude/m3，approvals 3/2）+ **ledger verify PASS**，旧 round `...-final` 已标 stale 取代。
- 7 个 failed replay case backlog 分类：refresh_artifact 1 / expected_negative_policy 4 / pinned_historical_regression 2，**0 当前代码缺陷**（`output/noe-evidence-flywheel-v2/failed-replay-backlog-categorization.json`）。
- 证据入口：`output/noe-evidence-flywheel-v2/third-slice-evidence.md`（含完整加固历程 + 残留限制诚实声明）。

## 阶段二成果：全功能实机验证

- 全代码清单：8 域 fan-out（Opus 4.8），**621 功能**，每功能含 entry/category/envFlag/howToVerify/可离线性（`output/noe-full-function-stage2/feature-inventory.{md,json}` + `feature-flat.json`）。
- 全量测试基线：`npm test` 真跑 **5538 测试，HEAD committed 全绿**（脏工作区 3 失败=别窗在制品，见下）。
- 核心模块 e2e 实操真跑通：自改代码 candidate-patch dry-run、self-evolution plan/loop/cycle（215 检查）、进化 holdout、自主学习体检、好奇产出、记忆候选 gate、认知运行时（人脸 512 embedding/M3 路由/认知页）。
- 三立场交叉审核（offline）：实证审计=concerns（纠正了根因归属点名错）/ 缺陷排查=pass（5 gate 55+ 反向边界 0 崩溃，3 个 P2）/ 覆盖率校验=concerns（**真单测覆盖 558/621=89.9%**，24 个 .js 盲区）。
- 最终裁决：**可用**；诚实口径 = 89.9% 单测 + 核心 e2e + gate 压测，**不宣称逐个 621 功能都做过实机操作**。
- 报告入口：`output/noe-full-function-stage2/stage2-real-machine-verification-report.md` + `stage2-cross-review.json`。

### 贯穿性发现（非缺陷）
自主学习/好奇闭环「写入端旺盛、取用端弱」：831 学习卡仅 18% 被用、surprise_lesson 召回 hit_count=0。功能可用，属效能短板，与 owner 已知 lesson 召回优化方向一致。

## 待补 backlog（非阻断，建议下一切片）

- **P1 单测盲区（24 个 .js 模块，优先安全边界）**：`noeOwnerGate`（机主门禁）、`openai-compat`（OpenAI 兼容网关）、`issue-license`（License 签发）三件无单测、风险最高；其次 4 个 HTTP 路由 + 纯函数模块（TaskGraph/squad-limits/OutputQualityGate/MemoryPolicy/NoeConsensusPrompts）。
- **P2 边界缺陷（3 个，缺陷排查实测，无 live 可利用）**：①`NoeExpectationLedger.resolve()` 非法 outcome 静默消费预测（建议加白名单校验）②`NoeGoalSystem.add()` 漏过纯空白步骤（建议 trim 判空）③`NoeConsensusGate` 对 `__proto__` model 投票静默丢弃（建议记 invalid_model）。
- **P2 清单卫生**：feature-inventory 4 处 dangling test-file 引用 + 26 个 .mjs CLI 无回归测试。

## 工作区状态 / 未提交工作

- 本会话第三阶段 gate 工作：`src/eval/`、`scripts/noe-eval-*.mjs`、`src/candidates/`、相关 `tests/unit/*` 全 **untracked（`??`）**，未 commit（owner 惯例不 push）。
- 别窗（Codex）在制品：`src/runtime/NoeFreedom*`、`src/room/NoeConsensus*`（Gate/Round/Runner/Ledger）等 **modified（`M`）**，导致上述 3 个测试在脏工作区失败——**非本会话职责，全程未碰**。
- 证据产物：`output/noe-evidence-flywheel-v2/`（第三阶段）+ `output/noe-full-function-stage2/`（阶段二）全部落地（output/ 已 gitignore）。

## 红线遵守

全程未碰 live 51835/51735、未读 raw secret/.env、未新增 live 社交发布、未改 scorer/schema 强行让失败 case 通过、未删改别窗在制品。gate 的每次改动方向均为「更严格拦截伪通过」（与红线"不强行通过"相反）。
