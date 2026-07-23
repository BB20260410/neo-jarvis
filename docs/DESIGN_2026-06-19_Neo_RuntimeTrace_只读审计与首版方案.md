# Neo Runtime Trace 只读审计与首版方案

更新时间：2026-06-19

## 边界

本文件定义 `observe -> can_execute -> act -> verify -> learn` 的 trace 设计、当前代码落点和 Slice B 最小实现。

当前阶段不做：
- 不重启或接管 live `51835`。
- 不改 `src/loop`、`src/permissions`、`src/security`、`src/webhook` 的执行语义。
- 不写 memory-v2。
- 不读取 `evals/neo/private_holdout` 内容。
- 不做候选 patch 评分或自改代码执行。

## 当前已有证据链

| Trace 阶段 | 现有代码 / artifact | 当前能力 | 缺口 |
|---|---|---|---|
| observe | `server.js` 中 `NoeIncidentEscalator.observe`、`NoeSelfEvolutionTrigger.observe`、`noeCapabilityTrigger.observe`、`EpisodicTimeline.record({type:'observation'})` | 多个观察入口已经存在，但入口分散 | 没有统一 trace id，也没有统一阶段枚举 |
| can_execute | `src/loop/ActPipeline.js` 的 `budgetPreflight`、`permissionPreflight`、`selfEvolutionGate`、`contextSufficiencyPreflight` | 已经按预算、权限、自进化、安全上下文做执行前判定 | 判定结果只嵌在 act payload/audit 中，没有统一流水线视图 |
| act | `ActPipeline.propose/process/#executeReal`、`src/loop/ActStore.js`、`appendEvent(noe_act_dry_run/noe_act_executed)` | act 生命周期和 dry-run / real execution evidence 已存在 | observe 与 act 的因果链弱，部分入口无法回溯到观察源 |
| verify | `src/runtime/NoeActionEvidence.js`、`validateNoeActionEvidence`、`NoeGoalCheckpoints`、`scripts/noe-action-semantic-trace-snapshot.mjs` | action evidence、semanticTrace、goal checkpoint workflow、read-only snapshot 都已存在 | verify 结果没有统一映射回 observe/can_execute/learn |
| learn | `src/cognition/NoeStepExpectationBridge.js`、`NoeLearningHook`、`NoeMemoryCandidate*`、`NoeThinkLessonPersist` | 已有失败分类、surprise/lesson/candidate 入口 | learn 必须走 candidate，不允许直接长期记忆写入；当前 trace 不统一表达该约束 |

## 现有只读 runtime 证据

`scripts/noe-action-semantic-trace-snapshot.mjs` 已能只读扫描 `panel.db`：
- 读取表：`noe_acts`、`noe_goal_checkpoints`、`noe_ticks`。
- 输出：`output/noe-action-semantic-trace/*.json`。
- 策略：read-only、无 owner token、无模型调用、不导出 raw semantic values。

最近 `output/noe-action-semantic-trace/latest.json` 显示：
- `actionSemanticTraceReady: true`
- `checkpointSemanticTraceReady: true`
- `expectationTraceAlignmentObserved: true`
- `actionCoverage.withSemanticTrace: 14`
- `checkpointCoverage.withSemanticTrace: 12`
- `expectationTicks.semanticTraceActionEvents: 80`

这证明 Neo 已有局部 action semantic trace，但还不是统一 runtime trace。

## RuntimeTrace v1 数据形状

```json
{
  "schemaVersion": 1,
  "traceId": "rt-<stable-id>",
  "rootRef": "goal:<id>|act:<id>|episode:<id>|manual:<id>",
  "stage": "observe|can_execute|act|verify|learn",
  "stageDetail": "budgetPreflight|permissionPreflight|selfEvolutionGate|contextSufficiencyPreflight|...",
  "ts": 0,
  "at": "2026-06-19T00:00:00.000Z",
  "source": "noe_loop|goal_system|act_pipeline|expectation_resolver|learning_hook|manual_audit",
  "entity": {
    "type": "goal|act|checkpoint|tick|candidate",
    "id": ""
  },
  "status": "started|passed|blocked|completed|failed|skipped",
  "summary": "",
  "refs": [],
  "policy": {
    "runtimeTouched": false,
    "runtimeSemanticChange": false,
    "memoryV2Writes": false,
    "liveRestart": false,
    "privateHoldoutRead": false,
    "secretValuesReturned": false
  },
  "redaction": {
    "prompts": "excluded",
    "rawStreams": "excluded",
    "memoryBodies": "excluded",
    "lessonBodies": "excluded",
    "ownerTokens": "excluded",
    "secrets": "excluded"
  },
  "metrics": {},
  "sha256": ""
}
```

说明：
- `stage` 保持五阶段规范名；`can_execute` 映射到现有 `ActPipeline` preflight / gate 体系。
- `stageDetail` 保存本地词汇，例如 `budgetPreflight`、`permissionPreflight`、`selfEvolutionGate`、`contextSufficiencyPreflight`，避免查询时丢掉现有语义。
- `runtimeTouched` 表示 live runtime / 端口 / 进程层触碰；`runtimeSemanticChange` 表示执行语义变化。Slice B 两者都必须为 `false`。
- `redaction` 使用 `excluded` 枚举，不使用 `rawPromptIncluded: false` 这类可能暗示可为 true 的字段。
- `metrics` 仅允许数字、布尔、小型结构和无空白的短机器标签/ID/路径片段；自然语言字符串、疑似 raw prompt / stdout / stderr / DOM / memory body / lesson body / card body 的字符串都会替换成 `[redacted-runtime-trace-value]`。

## 首版实现路线

### Slice A：只读 trace design/audit

当前可执行范围只到这里：
- 只读扫描已有 DB / output artifact。
- 生成设计文档和 coverage 报告。
- 不插入 live runtime hook。
- 不修改 ActPipeline、PermissionGovernance、安全模块。

验收：
- 设计文档列出五阶段映射。
- 子代理复核通过。
- 多模型 gate 只授权下一步 append-only 实现，不授权 51835 操作。

### Slice B：append-only trace writer

已由 `output/noe-multimodel/20260619-runtime-trace-design-gate/ledger.json` 授权；该授权只覆盖 append-only writer + read-only snapshot，不覆盖 runtime restart、自改代码、private_holdout、memory-v2 或候选 patch scoring。

已新增而不是改执行语义：
- `src/runtime/NoeRuntimeTrace.js`
- `scripts/noe-runtime-trace-snapshot.mjs`
- `tests/unit/noe-runtime-trace.test.js`
- `tests/fixtures/noe-runtime-trace/golden-runtime-trace.json`

写入策略：
- 默认写 `output/noe-runtime-trace/runtime-trace-*.jsonl`。
- 不写 `panel.db` 第一版，避免迁移和 live runtime schema 风险。
- 只从调用点传入已经脱敏的 stage summary、refs、policy、metrics。
- 单文件默认上限 5 MiB；超过后按时间戳轮转到新 JSONL。当前实现不自动删除旧文件，避免误删历史证据。
- writer 通过串行 queue 写入；写入失败返回 `ok:false`，不抛异常，调用方可 fail-open。
- writer / reader / snapshot outDir 都拒绝指向 `evals/neo/private_holdout`，也拒绝路径逃出给定 root。
- snapshot CLI 只读 JSONL 输入并写 snapshot artifact；不读 DB、不访问 live `51835`、不调用模型、不读 `evals/neo/private_holdout`。

当前未做：
- 未把 writer 接入 `ActPipeline`、`NoeWorkspace`、`NoeLearningHook` 或任何 live runtime hook。
- 未修改 `src/loop`、`src/permissions`、`src/security`、`src/webhook` 的执行语义。

可选 hook 点：
- `ActPipeline.process`：记录 `can_execute` 判定结果。
- `ActPipeline` dry-run / executed event 后：记录 `act`。
- `buildNoeActionEvidence` / `validateNoeActionEvidence` 周边：记录 `verify`。
- `NoeStepExpectationBridge` / candidate review 周边：记录 `learn`，但只记录 candidate ref，不写 memory-v2。

禁止 hook 点：
- `src/security/*`
- `src/permissions/*` 的决策逻辑内部
- `src/webhook/*`
- consensus 脚本
- evaluator / holdout 读取路径
- `package.json scripts`
- live 51835 启停路径

## 风险

| 风险 | 等级 | 控制 |
|---|---:|---|
| trace 写入把敏感 payload 落盘 | P0 | 复用 `NoeContextScrubber`，只允许 summary/ref/metrics，禁止 raw prompt、memory body、owner token |
| trace 被候选 patch 当成 reward target | P1 | trace 路径层拒绝 private_holdout，score 仍由 evaluator 独立计算 |
| hook 改变执行路径 | P0 | append-only writer 必须 fail-open，写入失败不能改变 act 状态 |
| 直接写 memory-v2 | P0 | learn 阶段只写 candidate ref，不写长期记忆 |
| 与现有 action semantic trace 重复 | P2 | v1 不替代现有脚本，只做五阶段汇总视图 |

## 下一步门禁

进入任何 runtime hook 前必须再过：
- 子代理复核 Slice B 实现和测试结果。
- Codex / Claude / M3 consensus：明确只授权具体 hook 点，不授权 runtime restart、自改代码、private_holdout、memory-v2、候选 patch scoring。
- 必须证明 hook 写入失败不改变 `ActPipeline` / loop 状态。
