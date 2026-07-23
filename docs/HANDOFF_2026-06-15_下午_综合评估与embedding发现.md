# Claude 任务交接：Neo 综合评估 + embedding 间歇失效发现

生成：2026-06-15 下午 Asia/Shanghai
接手对象：Claude / 下一窗口
仓库：`/Users/hxx/Desktop/Neo 贾维斯`
上一份：`docs/HANDOFF_2026-06-15_Claude_Neo_v4索引与运行证据审计.md`（上午窗口）

## 先读结论

目标仍未完成，**不要标完成**。`goal-completion-audit`：`achieved=false`、`strictBlockerCount=3`。

本窗口是"继续任务"接手上午的 v4 索引与运行证据审计，做了三件实事：①纠正面板状态 ②12 域综合评估 ③挖出并实测坐实一个真实运行 bug（语义记忆 embedding 间歇失效），且把它和 AGI 觉醒瓶颈关联成一个待验证假设。

## 环境约束（owner 本窗口明确，务必遵守）

- **其他窗口正在评测模型**；owner **已暂时关闭 Neo 面板**。
- **不要动 LM Studio / Ollama / 任何本地模型**；**不要重启 Neo 面板**。
- 因此本窗口后半段全部改为纯只读文件工作，未触碰任何运行时。

## 本窗口做了什么

### 1. 纠正面板状态（上午 HANDOFF 已过时）
上午写"面板 51835 不可达"，本窗口 12:00 实测**已恢复 live**（uptime 692s+，health/readiness 200）。据此重跑整条审计链刷新到当前真相：
- route probe 恢复 21/25 候选 / 53 个 401 auth surface（取代面板挂时的 request_failed=53）。
- goal audit 刷新 `panelHealthOk=true`/`panelReadinessOk=true`，但 `achieved=false`、3 blocker 不变。
- 在 `output/noe-audit/v4-plan-runtime-gap-2026-06-15.md` 顶部加了 12:05 复验勘误段。
（注：之后 owner 关闭了面板，现在面板状态又变为"关闭"，上面的 live 读数是 12:xx 快照。）

### 2. 复验 AGI 觉醒核心链
期望→预测失败→harvestSurprise→curiosity 链：`decisiveUnknownRate` 0.982→0.976、failed=0、surpriseGoals=0。**面板重启未解决**，瓶颈在 judge/evidence linkage，非基础设施。

### 3. 12 域综合评估（workflow 10 域 + 补 agent 2 域）
全局 **live ~88 / code-ready ~70 / dead-scaffold ~10**。完整报告：
**`output/noe-audit/comprehensive-runtime-truth-eval-2026-06-15.md`** ← 下窗口先读这份。
- cognition：44 文件零孤儿，单点瓶颈卡死觉醒链；GWT/审议/VAD/SelfTalk 真 live。
- agents-skills：房间底座/MCP/Plugin live；能力自举链代码全+安全门齐但 `NOE_CAPABILITY_ACQUISITION` 默认 OFF 未通电；4 处纯 scaffold（McpAggregator/SkillCurator/SkillDraftApply/Rollback）。

### 4. ⭐ 实测坐实的真实运行 bug：语义记忆 embedding 间歇失效
- panel.db 666 条向量里 **648 条（97%）是 Ollama qwen3-embedding:0.6b 的 1024 维**；18 条 hash-128 fallback。
- Ollama.app **按需唤醒、非常驻**（`OLLAMA_KEEP_ALIVE` 未设=5min idle 卸载；实测进程被命令唤醒才起）。
- Ollama 离线时 Neo 查询退回 hash-128 → 与 1024 维库 dim mismatch → `src/embeddings/VectorIndex.js:31` 作者注释明说"整张表过滤掉→零命中"。
- 即 **语义记忆主体召回间歇失效，只剩 FTS 字面兜底**。配置 `NoeMemorySemanticConfig.js` 默认就指向 ollama qwen3-embedding @11434，**代码没问题，是服务没常驻**。

### 5. 强假设（embedding ↔ judge 同根因，待验证）
judge `avgSemanticCoverage=0.044`、`insufficient_direct_evidence=276` → 若 judge 的 evidence linkage 走同一套语义召回，则 embedding 失效可能正是 decisiveUnknownRate 0.976 的根因。**验证法**：Ollama 常驻在线后重跑 `node scripts/noe-expectation-judge-blocker-audit.mjs`，看 decisiveUnknownRate 是否显著下降。未证实前不要当因果。

## 下窗口最该做的（等 owner 解除"别动本地模型"约束后）

1. **【可自主·最高性价比】让 Ollama 常驻**：`OLLAMA_KEEP_ALIVE=-1` 或登录项保活 → 端到端验证语义召回恢复（本地、可逆、5min 可验证）。
2. **验证 #5 假设**：Ollama 在线后重测 decisiveUnknownRate。若降→修 embedding 即解锁觉醒链。
3. 若假设不成立，再单独攻坚 judge/evidence linkage（碰 src/cognition 是分量动作，需 owner 在场）。

## 当前未提交改动（重要：分清归属，别误回滚）

本窗口只新增/改了**审计产物与文档**，未碰任何 src/ 代码逻辑：
- 改：`output/noe-audit/v4-plan-runtime-gap-2026-06-15.md`（加勘误段）
- 重跑刷新：`output/noe-audit/{goal-completion,natural-runtime-evidence,weak-route-surface-probe,weak-runtime-remaining-lane,expectation-judge-blocker,surprise-learning}-audit-2026-06-15.*` + `output/noe-runtime-evidence/`
- 新增：`output/noe-audit/comprehensive-runtime-truth-eval-2026-06-15.md`、本交接文档

**工作树里另有一大批 src/（cognition/loop/runtime/voice/server/memory）+ tests 的 M 改动、删 scripts/XikeLab.app、新增 benchmark/ 与几十个 scripts/tests untracked 文件——那些是前序/别窗口的工作，不是本窗口产物，不要回滚、不要 commit。**

## 不要踩的坑

- 不要动 LM Studio / Ollama / 本地模型 / 重启面板（owner 本窗口明确，其他窗口在评测）。
- 不要把 #5 当已证因果；不要把 atlas/line-semantics 当逐行语义签核。
- 不要回滚工作树里别窗口的改动；noe-main owner 惯例不 push。
- 不读 .env / room-adapters.json / secret。
