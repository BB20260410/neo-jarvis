# Neo Phase 5 PlanValidator Dry-Run v1

更新时间：2026-06-19

## 边界

本切片只做统一 plan metadata dry-run gate。

本切片只做：
- 校验 plan validator dry-run record。
- 生成 `output/noe-plan-validator-dry-run/**` 报告。
- 记录 `planRef`、`planSha256`、`sourceReportRefs`、rollback/risk refs、policy flags、validator checks。
- CLI 只读复验 `sourceReportRefs` 中的 `output/**` JSON report 是否 `ok:true`。

本切片不做：
- 不执行 plan。
- 不 apply patch。
- 不运行 git/gh/PR。
- 不运行 evaluator。
- 不调用模型/API。
- 不触碰 live `51835`。
- 不写 memory-v2。
- 不写 GraphMemory。
- 不安装 CausalRisk runtime gate。
- 不读 secret/private_holdout。
- 不改 package/evaluator/security/permission。

## 产物

- 模块：`src/candidates/NoePlanValidatorDryRun.js`
- CLI：`scripts/noe-plan-validator-dry-run.mjs`
- 单测：`tests/unit/noe-plan-validator-dry-run.test.js`
- 报告目录：`output/noe-plan-validator-dry-run/**`

## 关键约束

- 所有 plan、source、rollback、risk、evidence 都只能以 ref/hash 出现。
- `sourceReportRefs` 必须非空，且 CLI 只读复验每个 source report 的 `ok:true`。
- 已知 dry-run source report 家族必须匹配 validatorVersion：candidate patch、archive、scorecard、PR repair、PlanValidator。
- refs 必须停留在 `output/**`，拒绝 `.env*`、owner token、private_holdout、package/lockfile、`.git/**`、`.noe-panel/**`、`src/eval/**`、`src/loop/**`、`src/webhook/**`、security/permission/evaluator/self-evolution/51835/MemoryV2/GraphMemory write/CausalRisk runtime gate 相关路径。
- `result.executed/applied/committed/pushed/published/runtimeTouched/memoryWritten` 必须显式 false。
- `policy.noPlanExecution/noPatchApply/noGit/noGh/noExternalPublish/noEvaluatorRun/noModelApiCall/noLive51835/noMemoryV2Write/noSecretRead/noPrivateHoldoutRead/noPackageScriptChange/noEvaluatorChange/noSecurityOrPermissionChange/noGraphMemoryWrite/noCausalRuntimeGate` 必须显式 true。
- `plan_review_ready` 只能在 required checks 全过、无 blockers、dry-run policy 成立、且 `readyAfterGate:true` 时出现。

## Gate

进入任何后续切片前仍需：
- 子代理审核 PlanValidator dry-run。
- 多模型 gate。

即使通过，也只授权下一 dry-run/schema/report 工作，不授权执行 plan、GraphMemory 写入或 CausalRisk runtime gate。
