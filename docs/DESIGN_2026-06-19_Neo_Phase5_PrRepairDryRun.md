# Neo Phase 5 PR Repair Dry-Run v1

更新时间：2026-06-19

## 边界

这是 Phase 5 的第三个 dry-run/schema/archive/report 切片：为 PR 型自修复建立 metadata-only gate。

本切片只做：
- 校验 PR repair dry-run record。
- 生成 `output/noe-pr-repair-dry-run/**` 报告。
- 记录 branch 名称建议、patch artifact ref、draft PR description ref、validation report ref、rollback ref、risk report ref。
- 记录 cost、policy、validator checks 和 ready-for-human-review 元数据。

本切片不做：
- 不创建真实 git branch。
- 不运行 `git commit` / `git push`。
- 不调用 `gh`、GitHub API、邮件或任何外发 PR/消息。
- 不应用 patch。
- 不运行 evaluator。
- 不读 `.env` / owner token / private_holdout。
- 不调用模型或付费 API。
- 不写 live `archive.jsonl`。
- 不重启或写 live `51835`。
- 不写 memory-v2。
- 不修改 package scripts、evaluator、security、permission。

## 产物

- 模块：`src/candidates/NoeEvolutionPrRepairDryRun.js`
- CLI：`scripts/noe-evolution-pr-repair-dry-run.mjs`
- 单测：`tests/unit/noe-evolution-pr-repair-dry-run.test.js`
- 报告目录：`output/noe-pr-repair-dry-run/**`

## Required Metadata

PR repair dry-run record 必须包含：
- `kind: "noe_evolution_pr_repair_dry_run_record"`
- `schemaVersion: 1`
- `id`
- `createdAt`
- `parentId`
- `childId`
- `generation`
- `candidateRef`
- `archiveReportRef`
- `scorecardReportRef`
- `holdoutRef: "private_holdout:not_accessed"`
- `branch.proposedName/baseRef/branchCreated/existingBranchChecked`
- `artifacts.patchArtifactRef/draftPrDescriptionRef/validationReportRef/rollbackRef/riskReportRef`
- 每个 artifact ref 对应的 sha256
- `cost`
- `result.verdict/readyForHumanReview` 和 `branchCreated/patchApplied/prOpened/externalPublished/runtimeVerified/memoryWritten/committed/pushed:false`
- `policy`
- `validator`

所有 PR body、patch body、diff、命令输出、stdout/stderr、prompt 和 secret 值都不能出现在 record 或 report 中，只能以 ref/hash 出现。

## 关键约束

- `candidateRef` 与 `artifacts.patchArtifactRef` 必须指向 `output/noe-candidate-patches/**`。
- `archiveReportRef` 必须指向 `output/noe-evolution-archive-dry-run/**`。
- `scorecardReportRef` 必须指向 `output/noe-evolution-scorecard-dry-run/**`。
- draft PR、validation、rollback、risk reports 必须指向 `output/noe-pr-repair-dry-run/**`。
- 其它 evidence/report refs 必须停留在 `output/**`。
- refs 与 CLI record 输入拒绝 `package.json`、`package-lock.json`、`.git/**`、`~/.noe-panel/**`、`archive.jsonl`、`src/eval/**`、`src/loop/**`、`src/webhook/**`、self-evolution/patch-apply/patch-rollback/consensus/evaluator/security/permission/memory-v2/live 51835/gh publish 相关路径。
- `id` 必须符合 `^[A-Za-z0-9_.:-]{1,180}$`。
- branch 建议必须符合 `codex/noe-*` 安全子集，禁止空白、`..`、`//`、`@{`、尾随 `/`、尾随 `.` 和 `.lock`。
- ref 与 CLI path 禁止空白、换行、引号、反引号、glob 和 shell/meta 字符；错误消息不回显不可信路径值。
- `paidApiUsed:false`、`modelCalls:false` 必须显式成立。
- `branchCreated:false`、`patchApplied:false`、`prOpened:false`、`externalPublished:false`、`committed:false`、`pushed:false` 必须显式成立。
- `dry_run_ready` 只能在 required validator checks 全部通过、无 blockers、dry-run policy 成立、且 `readyForHumanReview:true` 时出现。
- CLI 必须只读复验上游 `output/**` 报告：candidate patch gate、archive dry-run、scorecard dry-run 都必须是 `ok:true` 且 validatorVersion 与当前代码常量一致。
- 同义上游 refs 必须一致：`artifacts.patchArtifactRef` 和 `validator.checks.candidatePatchGate.reportRef` 对齐 `candidateRef`，archive/scorecard check refs 分别对齐 `archiveReportRef` 与 `scorecardReportRef`。

## 初始验证目标

- Syntax：模块和 CLI `node --check`。
- Focused unit：PR repair dry-run 单测。
- CLI smoke：默认 smoke record 写入 `output/noe-pr-repair-dry-run/**`。
- 上游报告复验：candidate/archive/scorecard 任一报告 `ok:false` 或 validatorVersion 不匹配时，PR repair report 必须 `ok:false`，且只输出通用错误。
- Related regression：candidate patch artifact gate、archive dry-run、scorecard dry-run、consensus runner。
- 负向探针：非 output outDir、`.env.local`、private_holdout、`package.json`、`package-lock.json`、`src/eval/**`、首尾空白 path、换行正文伪装 path、unknown flag、symlinked output。
- 安全扫描：无 `child_process`、`spawn`、`exec`、`fetch`；无 fake body 泄漏；无高信号 secret；无 live `archive.jsonl`。

## Gate

进入下一切片前仍需：
- 子代理审核 PR repair dry-run。
- 多模型 gate。

即使通过，也只授权下一 dry-run/schema/archive/report 工作，不授权 apply/live/memory/secret/commit/push/真实 PR。
