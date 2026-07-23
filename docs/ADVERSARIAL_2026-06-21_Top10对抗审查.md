# ADVERSARIAL 2026-06-21 — Neo 贾维斯 Top 10 对抗审查报告

> 审查员:Mavis 协调 **6 个对抗审查 worker 并行**(覆盖真实性 / 可行性 / 原则对齐 / 方法论 / 风险 / 计划现实性)
> 审查时间:2026-06-21
> 审查对象:`docs/RESEARCH_2026-06-21_开源自改提升10选1.md` 报告中的 **Top 10 选 1 + 4 阶段融合计划**
> 用户根本原则:**「我们是开发者,要的就是不要设置限制,不要过度设置安全,我们要做的就是给 Neo 贾维斯最大的空间和自由的权限,让他成长」**
> 任务:**不留情面挑刺,留真正对 Neo 有用的项目**

---

## 0. 一句话总览

原 Top 10 选 1 报告 **6 维度对抗审查后,真正可直接借鉴的只有 2 个(dspy / smolagents,需剥离),其余 8 个全部需要"借壳"策略**(借抽象借设计,不接 API/不绑中心化)。原 4 阶段计划 **完全推倒重做**:从 14 个借鉴压缩到 3-5 个,串行化 + 团队化。

---

## 1. 6 维度对抗审查结果

| 维度 | 审查员 | 总条数 | P0 数 | 原报告可信度 | 关键发现 |
|---|---|---|---|---|---|
| **W1 真实性** | General v1 | 35 | 7 | **45%** | borrow_score 公式失真 + stars 数据陈旧 + 维护状态未审查 |
| **W2 可行性** | General v2 | 50 | 27 | **20-30%** | 大量借鉴点 Neo 已有等价或超集能力,Python→Node 移植被低估 3-5 倍 |
| **W3 原则对齐** | General v3 | 33 | 7 | **0% 真干净** | 10 个项目**全部**存在伪自由问题(无 1 个真干净) |
| **W4 方法论** | General v4 | 44 | 8 | **名单凑巧对** | letta "7x" 数学错(上限 6);公式 5/10/3 让 cross_count 占 60% 影响力 |
| **W5 风险** | General v5 | 50 | 6 | **偏乐观** | Polyform Shield Noncompete / PolyForm Free Trial 30 天 / autogen 被 MAF 取代 |
| **W6 计划** | General v6 | 39 | 17 | **30-40%** | 与 Neo P0-P10 解放版直接撞车,14 借鉴里 6 个与 Neo 内部已规划能力重复 |
| **总计** | 6 worker | **251** | **72** | 综合 **25-35%** | 几乎所有 Top 10 都需要"借壳"策略 |

---

## 2. 6 维度关键发现(W1-W6 摘要)

### W1 真实性挑战(可信度 45%)

**35 条对抗 JSONL,P0×7**

- **letta-ai/letta "7x" 错** — 6 worker 最多 6x,差 1 = 多算 10 分综合分
- **borrow_score 全部 = 5 是评分通胀** — 199/952 项目集中在 5 分
- **stars 权重 3 过小** — transformers 145k stars / ollama 100k stars 行业基座被压制到 30+ 名
- **21 个项目 license 不一致**(autogen / OpenInterpreter 等连协议类型都报错)
- **101 个项目 stars 不一致**(letta 12k-19k / OpenHands 33k-65k 翻倍)
- **建议淘汰 3 个**:openai/swarm、microsoft/autogen、mem0ai/mem0

### W2 可行性挑战(可信度 20-30%)

**50 条对抗 JSONL,P0×27**

- **8 个借鉴点建议直接淘汰**:#1/#2/#3/#5/#6/#8/#9/#10
- **2 个降级**:#4 物理拆分 / #7 仅借签名概念
- **0 个保留原方案**
- 关键发现:
  - Neo 已有 **NoeFreedomAdapters 2146 行**已超载,不应再加 adapter
  - **Python→Node 移植成本被低估 3-5 倍**
  - 大量借鉴点 Neo 已有等价或超集能力
  - Letta L0/L1/L2 与 MemoryCore 已有分层重叠

### W3 用户原则对齐挑战(0 个真干净)

**33 条对抗 JSONL,P0×7**

- **10 个项目全部存在伪自由问题**(无 1 个真干净)
- **8 种 issue_type**:pseudo_freedom / hidden_sandbox / opt_out_default / paywall_advanced / vendor_lock / governance_filter / telemetry_default_on / policy_restricted
- **关键发现**:
  - **vendor_lock 最普遍(8/10)** — OpenAI 官方 / Microsoft / MetaGPT / HF 都强绑中心化
  - **hidden_sandbox 次之(5/10)** — dspy Responsible AI / smolagents E2B / browser-use 默认 sandbox
  - **4 个淘汰**:AutoGPT(GPT-4 wrapper 募捐)、MetaGPT(SOP 组织纪律)、swarm(OpenAI deprecated + 中国 API 封禁)、mem0(记忆 vendor lock)
  - **4 个降级**:letta / OpenHands / autogen / browser-use(只借局部抽象)
  - **2 个建议保留**:dspy + smolagents(但也需剥离 Responsible AI / E2B sandbox)

### W4 数据方法论挑战(公式有偏,名单凑巧对)

**44 条对抗 JSONL,P0×8**

**关键复算**:
- 6 份 JSONL 共 **765 个去重项目**(原报告 1293 含 341 已有 corpus)
- **letta 7x 错**(数学上限 = 6 worker = 6x,差 1 即多算 10 分)
- **101 个项目 stars 不一致**(letta 12k-19k / OpenHands 33k-65k 翻倍)
- **21 个项目 license 不一致**
- **70+ 项目 borrow_score 不一致**(评分者间无 rubric)

**实际 Top 10 名单与原报告一致**(结论凑巧对了),但:
- letta 综合分 107.6 → 实际 97.6
- OpenHands / browser-use / dspy 分差 <0.5 不可区分
- 公式 5/10/3 让 cross_count 占 60% 影响力

**建议公式重构**(5 维):
```
bs×3 + cross×8 + log10(stars)×8 + license_free×5 + neo_fit×5
```

### W5 风险深度挑战(偏乐观)

**50 条对抗 JSONL,P0×6**

**6 个 P0 级风险**:
- **Polyform Shield Noncompete** — 部分项目被绑
- **PolyForm Free Trial 30 天** — 有时间限制
- **openai/swarm 官方弃坑** — OpenAI 团队转去搞 Agents SDK
- **autogen 被 MAF 取代** — Microsoft 推出 agent-framework 替代 autogen
- **autogen 双 license 文件** — 协议混乱
- **supply chain 跨项目叠加** — 多项目同时引入 CVE 风险

**建议 4 个项目慎重或放弃**:AutoGPT / OpenHands enterprise / openai/swarm / microsoft/autogen

**建议 5 个可用但需 sandbox/fork/lock 版本**:letta / dspy / smolagents / MetaGPT / browser-use

**新增 3 个风险维度**:governance trajectory / Chinese compliance / vendor lock

### W6 融合计划现实性挑战(可信度 30-40%)

**39 条对抗 JSONL,P0×17**

**致命伤**:
- 与 Neo P0-P10 解放版直接撞车
- **14 个借鉴里 6 个与 Neo 内部已规划能力重复**
- 阶段 1 "5 个借鉴 13 天" = 单人每天 1 个借鉴,不现实

**建议**:
- **重排序**:解放版为主轴,借鉴为加速器
- **砍到 3-5 个借鉴**
- **加过滤器**:borrow_score≥4 + 无强 gate + 不与 Neo 重复
- **串行化**:每月 1 借鉴
- **团队化**:招募 1 collaborator 或多模型协作分担

**重做后可信度可达 60-70%**

---

## 3. 共识矩阵(6 worker 对每个项目的判断)

| 项目 | W1 真实性 | W2 可行性 | W3 原则 | W4 方法论 | W5 风险 | W6 计划 | **共识** |
|---|---|---|---|---|---|---|---|
| **letta-ai/letta** | ⚠️ 公式错 | ❌ 已有重叠 | ⚠️ 付费墙 | ⚠️ 跨方向错 | ⚠️ fork 需求 | ⚠️ 撞 Neo | **降级**(借分层抽象,自实现) |
| **All-Hands-AI/OpenHands** | ✅ OK | ❌ Docker 重 | ⚠️ enterprise | ✅ OK | ⚠️ enterprise | ❌ 工作量大 | **降级**(借 RTK,避 Docker) |
| **Significant-Gravitas/AutoGPT** | ⚠️ 转型 platform | ❌ 代码重 | ❌ GPT-4 募捐 | ⚠️ 评分 | ❌ 弃坑风险 | ❌ 已转型 | **淘汰** |
| **openai/swarm** | ❌ 弃坑 | ❌ 极简教育 | ❌ OpenAI 封禁 | ✅ OK | ❌ 弃坑 | ❌ 与 Neo 撞 | **淘汰** |
| **microsoft/autogen** | ⚠️ license 错 | ❌ Python 重 | ⚠️ UserProxy | ⚠️ license 错 | ❌ MAF 取代 | ❌ 频繁变 | **淘汰** |
| **geekan/MetaGPT** | ✅ OK | ❌ SOP 重 | ❌ 组织纪律 | ✅ OK | ⚠️ 国内合规 | ❌ 输出大 | **降级**(借 SOP 抽象,自实现) |
| **stanfordnlp/dspy** | ✅ OK | ⚠️ 概念移植 | ⚠️ Responsible AI | ✅ OK | ⚠️ sandbox 需剥离 | ⚠️ 学习曲线 | **保留**(借签名抽象,自实现) |
| **browser-use/browser-use** | ✅ OK | ⚠️ 真无 sandbox | ⚠️ 默认 sandbox | ✅ OK | ⚠️ fork 需求 | ⚠️ Playwright 集成 | **降级**(借架构,自接 Playwright) |
| **mem0ai/mem0** | ⚠️ 数据陈旧 | ❌ vendor lock | ❌ vendor lock | ✅ OK | ⚠️ vendor lock | ❌ 撞 Neo 已有 | **淘汰** |
| **huggingface/smolagents** | ✅ OK | ⚠️ Python 重 | ⚠️ E2B sandbox | ✅ OK | ⚠️ fork 需求 | ✅ OK | **保留**(借 CodeAgent 抽象,自实现) |

**共识结论**:
- **直接淘汰 4 个**:AutoGPT / openai/swarm / microsoft/autogen / mem0ai/mem0
- **降级借壳 4 个**:letta / OpenHands / MetaGPT / browser-use
- **保留 2 个**:dspy / smolagents(但需剥离)

---

## 4. 真正 Top 10(对抗筛选后)

### 4.1 共识保留(2 个,需剥离)

#### ⭐ dspy — 保留度 85%
- **保留原因**:Stanford 学术中立 + 自改进 prompt 抽象 + 评分稳定
- **需剥离**:
  - Responsible AI 模块
  - DSPy Assertions(强干预)
  - 默认 dspy.OpenAI 绑定
- **借鉴策略**:借签名抽象 + 优化器模式,自实现 + 适配本地模型
- **工作量**:2-3 周(概念移植)
- **Neo 子系统**:`src/room/CrossVerifyDispatcher.js` 引入 dspy 风格 prompt 签名

#### ⭐ smolagents — 保留度 80%
- **保留原因**:HF 官方轻量 + CodeAgent 抽象清晰
- **需剥离**:
  - E2B sandbox(默认 Docker)
  - HF Hub 绑定
  - 默认 OpenAI / HF Inference API
- **借鉴策略**:借 CodeAgent 抽象(让 LLM 写代码调工具)+ 自接本地 ollama
- **工作量**:1-2 周(adapter 集成)
- **Neo 子系统**:`src/runtime/NoeFreedomAdapters.js` 引入 CodeAgent 模式

### 4.2 降级借壳(4 个,只借抽象)

#### ⚠️ letta-ai/letta — 降级到 60%
- **保留原因**:分层 context 概念清晰
- **需剥离**:
  - sleep-time compute(付费)
  - Letta Cloud API
  - Stateful agent server(避免引入)
- **借鉴策略**:借 L0/L1/L2 分层抽象,自实现 + 不开付费墙
- **工作量**:2-3 周
- **Neo 子系统**:`src/memory/MemoryCore.js` 升级分层(已有重叠,需谨慎)

#### ⚠️ OpenHands — 降级到 55%
- **保留原因**:RTK 压缩 + 端到端 PR 流程
- **需剥离**:
  - Docker 镜像 3GB+
  - OpenHands enterprise(商业)
  - 默认 sandbox
- **借鉴策略**:借 RTK 概念 + 端到端 PR 流程,自实现
- **工作量**:4-6 周
- **Neo 子系统**:`src/loop/NoeSelfEvolutionExecutors.js` 引入端到端 PR(但与 Neo P0-3 撞,需重排)

#### ⚠️ MetaGPT — 降级到 50%
- **保留原因**:SOP 角色池抽象清晰
- **需剥离**:
  - 软件公司 SOP 模板
  - 组织纪律(不需)
  - 大量输出(overkill)
- **借鉴策略**:借 SOP 角色池抽象,自实现轻量版
- **工作量**:2-3 周
- **Neo 子系统**:`src/runtime/NoeFreedomAdapters.js` 引入角色池(但该模块已超载,需先瘦身)

#### ⚠️ browser-use — 降级到 55%
- **保留原因**:LLM 驱动 Playwright 抽象清晰
- **需剥离**:
  - 默认 sandbox
  - DOM 解析堆栈
- **借鉴策略**:借架构概念,自接 Playwright + 无 sandbox
- **工作量**:1-2 周
- **Neo 子系统**:`src/vision/VisionSession.js` 引入 browser adapter

### 4.3 淘汰(4 个,完全不要)

| 淘汰项目 | 原因 |
|---|---|
| **AutoGPT** | 已转型 platform + GPT-4 wrapper 募捐 + 弃坑风险 |
| **openai/swarm** | OpenAI 官方弃坑 + 中国 API 封禁 + 极简教育性质 |
| **microsoft/autogen** | 被 MAF 取代 + 双 license + Python 重 |
| **mem0ai/mem0** | vendor lock 记忆 + 撞 Neo 已有 fact-scope 自动 merge |

---

## 5. 修正版融合计划(对比原版)

### 原版 4 阶段(14 个借鉴,4-6 月)

| 阶段 | 任务 | 工期 | 借鉴项目 |
|---|---|---|---|
| 1 | 5 个借鉴 | 13 天 | mem0 + swarm + AutoGPT + browser-use + screenpipe |
| 2 | 3 个借鉴 | 6-9 周 | letta + MetaGPT + dspy |
| 3 | 2 个借鉴 | 8-12 周 | OpenHands + Voyager |
| 4 | 4 个借鉴 | 长期 | DGM + GenericAgent + autogen + moshi |

### 修正版 3 阶段(5 个借鉴,6-8 月,串行化)

| 阶段 | 任务 | 工期 | 借鉴项目 | 优先级 |
|---|---|---|---|---|
| **1 · 立即(2-3 周)** | Neo 内部清理 | 2 周 | (无借鉴) | **P0** |
| **2 · 加速(2-3 月)** | 2 个借壳借鉴 | 4-6 周 | **dspy + smolagents** | **P1** |
| **3 · 长期(3-6 月)** | 3 个借壳借鉴 + 解放版 | 12-16 周 | **letta + OpenHands + browser-use** | **P2-P3** |
| **4 · 弃用** | 4 个 | - | **AutoGPT / swarm / autogen / mem0** | ❌ 淘汰 |

### 修正版关键变化

1. **从 14 个砍到 5 个**(去掉 64%)
2. **从并行改串行**(每月 1 个,降低 context 切换)
3. **加过滤器**:borrow_score≥4 + 无强 gate + 不与 Neo 重复
4. **优先做 Neo 内部清理**(2 周,1 个借鉴都不做)
5. **团队化**:招募 1 collaborator 或多模型协作分担(Neo 1 人做不完)
6. **修正优先级**:解放版为主轴,借鉴为加速器

---

## 6. 关键发现总结(给海克斯)

### 6.1 最意外发现

1. **letta 7x 数学错**:6 worker 最多 6x,差 1 = 多算 10 分综合分
2. **10/10 项目全伪自由**:vendor_lock 最普遍(8/10),hidden_sandbox 次之(5/10)
3. **Neo 已有 6 个借鉴点重叠**:NoeFreedomAdapters 2146 行已超载,大量借鉴 Neo 内部已规划
4. **autogen 被 MAF 取代**:Microsoft 自己都放弃 autogen
5. **mem0 vendor lock**:记忆层 vendor lock 违背"自由"原则
6. **OpenAI swarm 官方弃坑**:OpenAI 团队转去搞 Agents SDK
7. **公式 5/10/3 让 cross_count 占 60%**:评分方法论本身有偏

### 6.2 共识结论(6 worker 一致)

- **直接淘汰 4 个**:AutoGPT / openai/swarm / microsoft/autogen / mem0ai/mem0
- **降级借壳 4 个**:letta / OpenHands / MetaGPT / browser-use
- **保留 2 个**:dspy / smolagents(但需剥离 Responsible AI / E2B sandbox)
- **Top 10 报告原可信度 25-35%**
- **融合计划原可信度 30-40%**

### 6.3 修正后真正 Top 5 选 1

按"通过对抗审查"程度排序:

1. **dspy 风格 prompt 签名**(借抽象,自实现)— 2-3 周
2. **smolagents CodeAgent 模式**(借 CodeAgent 抽象)— 1-2 周
3. **letta 分层 context 概念**(自实现 L0/L1/L2,不开 sleep-time)— 2-3 周
4. **browser-use GUI adapter**(自实现 Playwright 集成,无 sandbox)— 1-2 周
5. **MetaGPT SOP 抽象**(借角色池,自实现轻量版)— 2-3 周(但需先瘦身 NoeFreedomAdapters)

---

## 7. 风险与限制

### 7.1 对抗审查局限性

- **6 worker 都是 LLM,可能错杀**:评分有主观性,需保留人审
- **数据有滞后**:6 JSONL 写于 2026-06-21,projects 可能在之后变化
- **GitHub 真实状态需手工确认**:本审查用 web_search + README,无深度 git log 分析

### 7.2 真正 Top 5 也需谨慎

- **dspy 概念移植难**:Stanford API 与 Neo 本地模型不兼容,需 1+ 周调试
- **smolagents CodeAgent 风险**:LLM 写代码调工具,执行风险高(用户已表态允许)
- **letta 分层已重叠**:MemoryCore 已有短期/长期/归档,合并需要重构
- **browser-use Playwright 集成**:macOS 权限问题已踩过坑
- **MetaGPT NoeFreedomAdapters 已超载**:先瘦身再借鉴,否则越加越乱

### 7.3 修正版计划风险

- **2 周纯清理期**:可能不产生可见功能,owner 需忍受"无新东西"
- **串行化延长总工期**:5 个借鉴串行 6-8 月,vs 原 4-6 月并行
- **团队化需 owner 主动招募**:Neo 单人项目是根本限制

---

## 8. 下一步建议(给海克斯)

### 立即(2 周内)

- **A. 不启动任何借鉴** — 先做 Neo 内部清理(P0 必做 3 项:凭证 / 污染 / SIGTERM 兜底)
- **B. 决定是否采纳修正版 Top 5**:dspy / smolagents / letta / browser-use / MetaGPT
- **C. 招募 1 个 collaborator** — 串行化需要团队化

### 中期(1-3 月)

- 阶段 2 启动 2 个借壳借鉴(dspy + smolagents)
- 持续 Neo 解放版推进
- 每月底复盘

### 长期(3-6 月)

- 阶段 3 启动 3 个借壳借鉴(letta / OpenHands / browser-use)
- 阶段性回看 Top 10 评估

### 不要做的事

- ❌ 不要直接接 AutoGPT / swarm / autogen / mem0
- ❌ 不要并行 14 个借鉴
- ❌ 不要相信"借抽象 = 接 API"

---

## 9. 完整交付物清单(本次对抗审查)

| 文件 | 体量 | 用途 |
|---|---|---|
| `massive-survey/2026-06-21-adversarial-authenticity.jsonl` | 20KB / 35 条 | W1 真实性挑战 |
| `massive-survey/2026-06-21-adversarial-feasibility.jsonl` | 27KB / 50 条 | W2 可行性挑战 |
| `massive-survey/2026-06-21-adversarial-principles.jsonl` | 15KB / 33 条 | W3 原则对齐挑战 |
| `massive-survey/2026-06-21-adversarial-methodology.jsonl` | 19KB / 44 条 | W4 方法论挑战 |
| `massive-survey/2026-06-21-adversarial-risks.jsonl` | 26KB / 50 条 | W5 风险挑战 |
| `massive-survey/2026-06-21-adversarial-plan.jsonl` | 20KB / 39 条 | W6 计划挑战 |
| 6 份 `*-summary.md` | 30-65 行/份 | 6 维度对抗综述 |
| **本报告** | - | **真正 Top 10 选 1** |

**总对抗审查 JSONL**: 251 条(P0×72 / P1×80+ / P2×90+)

---

## 10. 最终结论

**原 Top 10 选 1 报告在 6 维度对抗审查后,真正对 Neo 有用的项目只有 2 个(dspy / smolagents)需"借壳"使用,4 个可降级借抽象,4 个完全淘汰。**

**修正版 Top 5 选 1 串行化 + 团队化 = 6-8 月。**

**用户原则 100% 对齐**:所有保留 / 降级项目都明确"借抽象,不接 API / 不绑中心化",无任何"加约束"私货。

**Top 10 报告原可信度 25-35% → 修正版可信度 60-70%。**

---

**对抗审查完成 · 6 worker · 251 条 JSONL · 真正 Top 5 选 1 · 修正版融合计划**

报告写于 `docs/ADVERSARIAL_2026-06-21_Top10对抗审查.md`,配套 6 份对抗 JSONL + 6 份 summary。
