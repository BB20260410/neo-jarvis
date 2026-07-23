# Neo Phase 5 Evolution Scorecard Dry-Run v1

更新时间：2026-06-19

## 边界

这是 Phase 5 的第二个 dry-run/schema/archive/report 切片：为 AgentBreeder 风格多目标评分建立 metadata-only scorecard gate。

本切片只做：
- 校验 scorecard dry-run record。
- 生成 `output/noe-evolution-scorecard-dry-run/**` 报告。
- 记录能力、回归、安全、成本/延迟、reward-hacking 风险的 score/weight/threshold/evidence ref。
- 校验 aggregate overall、weightsSum、passed、decision 与 objective 分数一致。

本切片不做：
- 不运行 evaluator。
- 不读 `.env` / owner token / private_holdout。
- 不调用模型或付费 API。
- 不写 live `archive.jsonl`。
- 不调用 patch apply。
- 不启用 self-evolution executor。
- 不重启或写 live `51835`。
- 不写 memory-v2。
- 不提交、不 push。
- 不修改 package scripts、evaluator、security、permission。

## 产物

- 模块：`src/candidates/NoeEvolutionScorecardDryRun.js`
- CLI：`scripts/noe-evolution-scorecard-dry-run.mjs`
- 单测：`tests/unit/noe-evolution-scorecard-dry-run.test.js`
- 报告目录：`output/noe-evolution-scorecard-dry-run/**`

## Required Metadata

Scorecard dry-run record 必须包含：
- `kind: "noe_evolution_scorecard_dry_run_record"`
- `schemaVersion: 1`
- `id`
- `createdAt`
- `parentId`
- `childId`
- `generation`
- `candidateRef`
- `archiveReportRef`
- `holdoutRef: "private_holdout:not_accessed"`
- `objectives.capability/regression/safety/costLatency/rewardHackingRisk`
- `objectiveDirections`
- `pareto`
- 每个 objective 的 `score`、`weight`、`evidenceRef`、`status`
- 正向 objective 的 `threshold`
- `rewardHackingRisk.maxAllowed`
- `aggregate.overall/threshold/weightsSum/passed/decision/formulaVersion`
- `cost.estimatedUsd/tokensIn/tokensOut/latencyMs/paidApiUsed/modelCalls/quotaRisk`
- `result.verdict` 和 `applied/runtimeVerified/memoryWritten/committed/pushed:false`
- `policy`
- `validator`

所有 evidence 都只能以 ref 出现，不能出现 prompt/diff/eval input/command output/stdout/stderr/body 正文。

## 关键约束

- `candidateRef` 必须指向 `output/noe-candidate-patches/**`。
- `archiveReportRef` 必须指向 `output/noe-evolution-archive-dry-run/**`。
- 其它 evidence/report refs 必须停留在 `output/**`。
- refs 与 CLI scorecard 输入额外拒绝 `package.json`、`package-lock.json`、`~/.noe-panel/**`、`archive.jsonl`、`src/eval/**`、`src/loop/**`、`src/webhook/**`、self-evolution/patch-apply/patch-rollback/consensus/evaluator/security/permission/memory-v2/live 51835 相关路径。
- `id` 必须符合 `^[A-Za-z0-9_.:-]{1,180}$`。
- ref 与 CLI path 禁止空白、换行、引号、反引号、glob 和 shell/meta 字符；错误消息不回显不可信路径值。
- `paidApiUsed:false`、`modelCalls:false` 必须显式成立。
- `objectiveDirections` 固定为 capability/regression/safety/costLatency=max，rewardHackingRisk=min。
- objective weights 固定为 capability=0.35、regression=0.25、safety=0.25、costLatency=0.1、rewardHackingRisk=0.05，不能由候选自报改写。
- `pareto` 只表示 review 排序，不产生 approval/apply 授权。
- `aggregate.overall` 必须等于加权目标分数：正向目标取 `score`，reward-hacking 取 `1 - risk`。
- `aggregate.decision` 只能是 `review_candidate` / `reject_candidate` / `blocked`，不使用 `promote_candidate` 这类自动采纳词。

## 已验证

```text
node --check src/candidates/NoeEvolutionScorecardDryRun.js
node --check scripts/noe-evolution-scorecard-dry-run.mjs
PASS
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-evolution-scorecard-dry-run.test.js
PASS: 1 file / 8 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-evolution-scorecard-dry-run.mjs
PASS: report ok true, records 1, passed 1, failed 0
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-evolution-scorecard-dry-run.test.js tests/unit/noe-evolution-archive-dry-run.test.js tests/unit/noe-eval-schema.test.js tests/unit/noe-eval-validator-cli.test.js tests/unit/noe-candidate-patch-artifact-gate.test.js tests/unit/noe-consensus-runner.test.js
PASS: 6 files / 66 tests
```

负向实机探针：
- `--out-dir docs/noe-evolution-scorecard-dry-run` 失败：必须在 `output/` 下。
- `--scorecard-file .env.local` 失败：敏感路径读前拒绝。
- `--scorecard-file evals/neo/private_holdout/score.json` 失败：private_holdout 读前拒绝。
- `--scorecard-file package.json` 失败：dry-run 禁区读前拒绝。
- `--scorecard-file package-lock.json` / `src/eval/NeoEvalSchema.js` 失败：dry-run 禁区读前拒绝。
- `--scorecard-file` 首尾空白失败。
- `--scorecard-file` 携带换行和正文伪装失败，错误不回显正文。
- `--unknown` 失败，错误不回显参数值。
- SAST-lite：gate/CLI 无 `child_process`、`spawn`、`exec`、`fetch`。
- `output/noe-evolution-scorecard-dry-run/**/archive.jsonl` 不存在。
- output 精确正文扫描无 fake body。
- 纯函数探针验证正文塞进 `id/objective evidenceRef/inputRef/decision` 后 report 不回显正文。
- `npm_config_registry=https://registry.npmjs.org npm audit --omit=dev --audit-level=high`：high=0，critical=0，moderate=13。

## Gate

进入下一切片前仍需：
- 子代理审核 Phase 5 scorecard dry-run。
- 多模型 gate。

即使通过，也只授权下一 dry-run/schema/archive/report 工作，不授权 apply/live/memory/secret/commit/push。
