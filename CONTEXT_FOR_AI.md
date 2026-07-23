# Neo 项目对外 AI 上下文摘要

> 给任何外部 AI（GPT5 / Claude / Codex / Gemini）的 Neo 项目现状摘要。
> 让 AI 立刻理解 Neo 当前已建内容、真实缺口、讨论边界。
> 每次重要 commit 后更新。

最后更新: 2026-06-14
版本: v1.0

---

## 1. 项目身份

我是海克斯（owner），在做一个叫 **Neo（Noe 贾维斯）**的项目——本地优先多 AI 个人操作系统。

**形态**:
- 128GB M5 Max Mac 跑本地 Qwen 3.6-35B-A3B / 27B / Gemma 4-26B-A4B 三角色
- + Claude Code / Codex / Gemini / MiniMax 集群协作
- 端口 51835 桌面面板（Express + WebSocket + Electron）
- 当前 v2.1.0
- 534 文件 / 4104 tests 全绿
- Node 22+ ES module

**不是**: AGI 路线 / 聊天机器人 / 单纯 LLM 包装
**是**: 持续建设"功能性自我意识" + 自我改造 + 自治执行 的工程

---

## 2. 已建的核心机制（17+ 项）

### 2.1 持续后台（机制六）
- `NoeHeartbeat` 持久心跳，4 个 job（meso 内省 / proactive 主动 / micro 情感+期望+回应评估 / expectation 期望判证）
- SQLite 持久化，重启续相位

### 2.2 内心独白 / 自发反刍（机制二）
- `src/loop/InnerMonologue.js` 448 行
- 5 重防螺旋（字面重复 / 语义相似 / verbalized sampling / 接地重写 / 确定性锚定）
- 4 档 mode（audit/normal/anchored/off）+ 5 状态（normal/rotate/anchor/cooldown/silent）
- `src/cognition/RuminationGuard.js` 224 行
- 信号契约显式：`readsVad: false`，`readsRawTimeline: true`（不读过滤后 VAD，避免与 AffectEngine 冲突）

### 2.3 驱力 / 内稳态（自由能原理工程化）
- `src/loop/NoeDriveSystem.js` 187 行
- 5 驱力：social / curiosity / care / competence / energy
- 抑制器特权：energy 超阈时无论谁主导都附加

### 2.4 自主目标系统
- `src/cognition/NoeGoalSystem.js` 655 行
- 6 类 source：owner / commitment / reflection / surprise / self_learning / drive
- 确定性仲裁公式（零 LLM）：priority = 0.5·来源权重 + 0.2·新鲜度 + 0.2·可行性 + 0.1·推进动量
- 好奇回路 v1：高惊奇（surprise ≥ 2bit）→ 自动生成"搞明白为什么"研究目标
- 自主学习主题 5+1（capability_discovery 第 6）

### 2.5 主动开口
- `src/loop/proactiveTick.js` 160 行
- 视觉+认人+到点提醒+30min 冷却（自适应可放宽到 4h）
- M10 反馈化：连续 3 次主人没回应冷却翻倍，一有回应立即复位

### 2.6 苏格拉底审议（System 2）
- `src/cognition/NoeDeliberation.js` 123 行
- 立论→自我挑战→修订（3 段式）
- 预测入账（按 Brier 校准）
- 目标可自生立项

### 2.7 全局工作区（GWT 工程化，机制一）
- `src/cognition/NoeWorkspace.js` 473 行
- 每个 meso tick 收集候选 → 确定性显著度打分 → 唯一赢家"广播"
- 意识日志 JSONL 每日落盘

### 2.8 自我模型三段（机制三）
- `src/context/NoeSelfModel.js` 210 行
- identity / state / situation 三层
- 注入 system prompt 的 `<noe-self-state>` 块

### 2.9 自我模型版本化（P7-C1，已落地）
- `src/context/NoeSelfModelVersionStore.js` 159 行
- `~/.noe-panel/self-model/vNNN.json` + `current` 软链
- 路径逃逸防护

### 2.10 自我模型更新协议（P7-C2，已落地）
- `src/context/NoeSelfModelUpdateProtocol.js` 88 行
- 白/黑名单 + owner gate
- 核心身份字段变更需 owner 显式确认

### 2.11 反刍防螺旋（P6 完工）
- `RuminationGuard.js` 224 行
- 4 档 mode + 5 状态
- audit 模式默认先行，strict redaction
- rawMetrics 完整落盘（可离线重放阈值）

### 2.12 端到端自完善可观测（P7-A0，已落地）
- `scripts/noe-self-maintenance-end2end-audit.mjs`
- 5 段指标：缺口发现 / 目标执行 / 失败学习 / 记忆沉淀 / 技能蒸馏

### 2.13 对话委托桥（已落地）
- `src/runtime/NoeDelegationExtractor.js`
- owner 话"帮我查 X" → 立 owner 目标 + research 步
- 确定性正则识别（零 LLM）

### 2.14 ActPipeline + 治理（已落地）
- `src/loop/ActPipeline.js`
- 治理层：classify → ask → 审批 → 审计
- 同指纹 TTL 复用

### 2.15 死前交接（已落地）
- `NoeTurnFinalizer`
- 预算硬停前把焦点留痕成可接力交接

---

## 3. 6/14 24h 内的新增（30 commit）

### 3.1 整合度代理指标（IIT-inspired 路线，74 行）
- `src/cognition/NoeIntegrationMetric.js`
- **算法**: Total Correlation (TC) = ΣH(Xi) − H(X)，归一化到 [0,1]
- **这是统计量代理指标，不是完整 IIT Φ**——不包含因果 TPM/MIP / 概念结构 / 不可约性计算
- 头注释诚实声明："这是整合度代理指标，非完整 IIT Φ"
- 8 宏节点状态（GWT 焦点源 / VAD 偏离 / 期望到期 / 驱力 / 感知 / goal_step / self_talk / dream）
- **这是 Neo 项目"从做意识工程到量意识工程"的转折点**——但只是量化转折, 不是本体论突破

### 3.2 结构化输出封装（rank7，65 行）
- `src/runtime/NoeStructuredCall.js`
- 3 档降级：json_schema → json_object → text
- 治 JSON.parse 脆弱

### 3.3 情感健康自检（rank6）
- `NoeAffectHealth.js`
- 饱和告警

### 3.4 情感 VAD 去饱和（rank6）
- env `NOE_AFFECT_DESATURATE` 默认 OFF
- 治情感焊死天花板

### 3.5 预测误差→好奇回路（rank4，关键）
- Neo 第一次"被现实纠正后主动学习"
- **这是自主意识的真起点**

### 3.6 self-evolution 三环闭环（全部已通）
- 环 1：executor 接线（SafeActExecutors）
- 环 2：GoalSystem 自进化源权重 + CycleStore + Trigger 触发器
- 环 3：standing grant 接入授权门（env 默认 OFF）
- **所有环都依赖外部证据 / owner approval / 复盘**——纯内部反思被研究证明不稳（Huang ICLR 等）——CRITIC / Reflexion 才是稳定路线
- Neo 真能改自己, 但所有改动都过治理门

### 3.7 P8 观察门防伪造
- 核验 evidence 真实存在 + 软硬链接 + succeeded 事件时间戳 + 窗口锚点

### 3.8 freedom 强制复核闸
- 接本地 Review Brain
- 模型挂 fail-open 降级 + reason 脱敏

---

## 4. 真实验收数据（截至 2026-06-14 11:00）

| 验收项 | 状态 |
|---|---|
| `test:p0:unit` | 107 files / 759+ tests PASS |
| `verify:noe:full-current` | 11/11 PASS |
| `verify:noe:self-evolution` | 198/198 PASS |
| `verify:noe:100-readiness` | score=97, **passed=false** |
|  `verify:noe:100-readiness` blockers | `not_enough_soak_evidence` (activeDays 3/7), `expectation_settlements_below_20` (4/20) |
| `verify:noe:self-maintenance-end2end` | ok:true, blockers:[] |

---

## 5. 真实缺口（8 个，按优先级）

| # | 缺口 | 工程量 |
|---|---|---|
| 1 | `NoeIntegrationMetric` 已存在但未接 heartbeat | 1 周 |
| 2 | `selfDirectedAction` 因果标注 | 1 周 |
| 3 | `identity.tensions` 内在矛盾 | 1 周 |
| 4 | `identity.values` 价值层级 | 1 周 |
| 5 | `NoeNarrativeSelf` 章节式累积 | 1-2 周 |
| 6 | 长期生产验收 | 持续 |
| 7 | Mission Runner (P8-M0) 未动 | 1-2 周 |
| 8 | 云端 Forebrain (L0) 未做 | 1-2 周 |

---

## 6. 4 周路线图（已签，研究支持顺序）

**为什么 A 先于 B**——**研究支持的最优顺序**：
- 在提高自治执行能力之前，先补整合度观测、行动因果标注、日志验证、来源追踪、人类复核
- 让后续任何更强代理能力都具备可审计性
- 这与 NIST AI RMF（治理、测量、管理、持续监控、内容来源可追踪、人类反馈回路、事件响应）一致
- 也与 Kirgis AI agent 评估论文（日志与过程分析）一致

- **阶段 A** (1 周): 整合度接 heart + selfDirectedAction 标注
- **阶段 B** (1-2 周): P8-M0A + L0A mock cloud PoC
- **阶段 C** (1-2 周): P9 自我深化（**C.1 价值层级 identity.values 先做, C.2 内在矛盾 identity.tensions 后做, C.3 章节式叙事**——values 先于 tensions 因为没有显式原则和优先级栈系统不知道矛盾该如何裁决, Conway self-memory system 也支持这个顺序）
- **阶段 D** (持续): 长期生产验收
- **阶段 R** (独立，可并行): neo-research/ 现象意识研究线

**为什么 values 先于 tensions**——Conway self-memory system 指出当前目标与自传知识相互约束, 没有显式原则栈矛盾无法裁决。

---

## 7. DESIGN §0 边界（核心哲学立场）

```
"§0 把 Neo 的工程目标限定为可验证的功能性自我意识，
不把现象意识作为声明、验收或依赖。

§0 不证明 Neo 没有或不可能有现象意识；
它也不否认 Neo 可能在未来以某种方式产生现象意识——
这条留给未来科学回答。"
```

**6/13 校准版（已签）**:
- 不承诺"证明 Neo 有真实意识"
- 但认真做"越来越像有持续自我、能学习、能行动、能自我完善的系统"
- 工程上"做但不承诺"

---

## 8. 6/13 签的 ADR（Cloud Change Lead + Local Autonomy Core）

### 12 决策

| # | 决策 |
|---|---|
| D1 | 云端可主导 patch plan / diff |
| D2 | 本地负责 apply / test / verify / rollback / evidence |
| D3 | EvidencePack 只读 |
| D4 | PatchTransaction 写 |
| D5 | EvidenceReconciler 验证判定 |
| D6 | Mission Contract 加 5 字段（leader/executor/reviewers/cloudContextPolicy/patchAuthority/localAutonomy） |
| D7 | 3 开关独立（FG / BG / PRIVATE） |
| D8 | Provider Registry + live preflight |
| D9 | P8-M0A + L0A 并行起步 |
| D10 | 真实指标（不靠云端占比） |
| D11 | 默认开关分阶段：开发 FG=0 → 产品 FG=1 |
| D12 | full_project_allowed 不作为常规模式 |

### 4 反对意见保留

M3 反对 D3 / D11 / D10 / D1-D2 时需举证。

### 5 验收门（PoC）

1. mock cloud 生成 patch plan
2. 本地组装 redacted EvidencePack
3. 本地 apply 安全 patch
4. 测试失败 rollback
5. 假成功拒 succeeded

---

## 9. 给 AI 的讨论建议

- **不要用"通用 AI 意识综述"框架套 Neo**——Neo 已建 17+ 项远超综述 8 组件
- 6/14 30 commit 的新增（整合度量 / 结构化输出 / 情感去饱和 / 预测误差→好奇回路 / self-evolution 三环）是 Neo 项目"超出综述"的工程化进展
- 真实差距是 8 个工程缺口 + 1 个时间缺口，不是"通用 AI 意识还没做"
- 讨论边界：§0 是工程承诺，不是本体论断言
- 任何"补完即有意识"的暗示都是过度承诺
- 任何"做不到"的断言也是过度悲观

## 10. 可检索工件（7 个独立文件, 长期上下文系统用）

**给外部 AI 长期协作时不要只粘本文件**——**按 Anthropic context engineering 共识**, 把项目事实拆成可检索工件, 运行时按需查:

| 工件 | 路径 | 内容 |
|---|---|---|
| 架构摘要 | `output/noe-context/ARCHITECTURE_SUMMARY.json` | 17+ 项机制 + 6/14 新增 7 项 的结构化 JSON |
| 当前 blocker | `output/noe-context/BLOCKERS_LATEST.json` | Noe100 readiness blockers + 8 个真实缺口 |
| 验证快照 | `output/noe-context/VERIFICATION_SNAPSHOT.json` | test:p0:unit / verify:noe:full-current / verify:noe:self-evolution / verify:noe:100-readiness |
| ADR 索引 | `output/noe-context/ADR_INDEX.md` | 6/13 签的 12 决策 + 4 反对意见保留 + 5 验收门 |
| 关键模块映射 | `output/noe-context/MODULE_MAP.md` | 18 个核心模块 + 文件路径 + 行数 + 职责 |
| 评估指标 JSON | `output/noe-context/EVALUATION.json` | 整合度 TC / self-causation 比例 / 真实完成率 / 证据闭环率 |
| 讨论边界 | `output/noe-context/DISCUSSION_BOUNDARIES.md` | §0 哲学立场 + 6/13 校准版 + 5 条 AI 讨论建议 |

**自动化生成**: `scripts/dump-noe-context.mjs` (4 周路线图阶段 B 期间建)

**给外部 AI 的长期协作协议**:
1. 第一条消息: 粘本文件 (入口 + 索引)
2. 第二条消息: "请按需查上面 7 个工件路径, 不要让我重述"
3. AI 用工具拉取细节 (just-in-time)

---

## 11. 推荐讨论话题

1. **NeoIntegrationMetric 怎么接 heartbeat 最好** —— 8 宏节点周期采集, 趋势线, 阈值告警
2. **Mission Runner 怎么设计 MissionContract 5 字段才不冗余** —— leader/executor/reviewers/cloudContextPolicy/patchAuthority/localAutonomy
3. **NeoNarrativeSelf 怎么从"单条 narrative"改"章节式累积"** —— v001-chapter-1/2/3
4. **Cloud Change Lead + Local Autonomy Core 拓扑的具体协作流程** —— 9 步 owner 任务流
5. **3 开关 (FG/BG/PRIVATE) 的产品期默认和开发期默认的最佳实践** —— 安全 + 体验 tradeoff
6. **neo-research/ 独立研究线怎么启动** —— neo-research/PHILOSOPHY_OF_MIND_NOTES.md 起步内容
7. **self-evolution 三环闭环的下一阶段 (环 4/环 5) 应该是什么** —— 持续自治的演进方向
8. **Noe100 readiness 的 8 条测试列怎么加进去** —— 按 GPT 综述的 8 组件测试对齐
