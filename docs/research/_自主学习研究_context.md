# Neo 自主学习「空耗」诊断 + 研究问题（喂多模型子代理）

## 背景：Neo 是什么
本地多 AI 个人 OS（Jarvis 风），有这些自主认知器官（均已落地、默认在跑）：
- **预测闭环**：NoeExpectationLedger（对世界下注 p → 到期判证 outcome → surprise=-log2(p_实际) → harvestSurprise 立研究目标）
- **好奇回路**：surprise≥2bit 的落空 → 自动立 source=surprise 的研究目标
- **目标系统**：NoeGoalSystem（9 源仲裁，active≤2，深思推进）
- **长期记忆**：noe_memory（FTS5×向量双路 RRF，skill_distill 蒸馏技能）
- **深思**：NoeWorkspace/NoeDeliberation（System2 苏格拉底三段 + 预测下注）
- **自主动手**：freedom executor（browser.dom JXA 真操控 / shell / 34 工具全门管线）

## 观察到的「空耗」现象（owner 实证 + 数据坐实）
近 24h Neo 的自主学习行为：
- **只 6 个写死的 URL，却打开了 88 次**（每个 github topics 页重复 ~14 次）：ai-agent / computer-use / agent-memory / langgraph / llm-agent / mcp-server
- **6 个写死的主题，每个反复立 13-21 次同样的目标**（"让 Noe 的记忆会冲突处理"立了 21 次）
- 开浏览器 tab 从不关，累积
- 蒸馏的 skill_distill 记忆开头各异、**本质同质**（全是"先搜索→再读→再扫描"的方法论套话，非页面真知识）

## 根因（已读代码确认）
1. `src/cognition/NoeLearningTopics.js`：`NOE_LEARNING_TOPICS` **硬编码 6 个主题**（Object.freeze），每个绑死一个 github topics URL。
2. `src/cognition/NoeGoalSystem.js maybeSeedAutonomousLearning`：`topicCursor = goalCountBySource('self_learning')`（累计数只增）→ `learningTopicAtCursor(cursor % 6)` → **6 个主题永久轮回**；`continuousLearning`（默认 ON）让一个目标 done 后**立即接下一轮**（无间隔无冷却）；去重只防"未关"目标，done 的循环回来照立。
3. browser.open **无关 tab 逻辑**。
4. **无收敛/无饱和判定/无进步度量/无主题拓展**——不判断"这主题我学够了吗""这次有新东西吗"。

## 本质判断
**勤奋的原地打转、伪学习**：一直在动（开浏览器、读内容、蒸馏记忆），但学同样 6 主题、读同样页面、蒸馏同质方法论——**无知识增量、无主题拓展、无收敛**。是"学习的形式"在空转，不是"学习的实质"在发生。

## 研究问题（请深入分析 + 给 Neo 可落地方案）
1. **怎么避免空耗/原地打转**？业界（curiosity-driven exploration / intrinsic motivation / RND / ICM / Schmidhuber compression progress / novelty search）怎么解决"重复探索同样的东西"？
2. **怎么真正持续学习 + 知识增量**？（continual learning / open-ended learning / Voyager 式技能库自演化 / curriculum）怎么做到：探索新领域 + 学完收敛 + 真沉淀可复用知识 + 不灾难性遗忘？
3. **topic 怎么从"写死 6 个"变"动态生成"**？怎么基于 surprise/好奇/owner 兴趣/读到的新概念动态选下一个学什么？
4. **怎么度量"真学到了"**？什么信号能区分"真知识增量" vs "重复蒸馏同质方法论"？
5. **基于 Neo 现有架构（surprise/expectation/好奇/记忆/目标/深思）的最小可落地改造**，分阶段、可证伪、不引入新空耗、防 reward hacking。

请给：①根因是否还有遗漏 ②业界真实方案（带出处）③Neo 具体落地设计（文件/数据流/判据）④反例与风险（会不会引入新空耗）。
