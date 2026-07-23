# Neo Phase 5 Evolution Archive Dry-Run v1

更新时间：2026-06-19

## 边界

这是 Phase 5 的第一个 dry-run/schema/archive/report 切片：为 DGM/SICA 风格自进化 archive 补齐元数据完整性。

本切片只做：
- 校验 archive dry-run record。
- 生成 `output/noe-evolution-archive-dry-run/**` 报告。
- 记录 parent/child/generation lineage、diff/prompt/eval input/command output refs、cost、score、failure/rollback refs。

本切片不做：
- 不写 live `archive.jsonl`。
- 不调用 patch apply。
- 不启用 self-evolution executor。
- 不读 `.env` / owner token / private_holdout。
- 不重启或写 live `51835`。
- 不写 memory-v2。
- 不提交、不 push。
- 不修改 package scripts、evaluator、security、permission。

## 产物

- 模块：`src/candidates/NoeEvolutionArchiveDryRun.js`
- CLI：`scripts/noe-evolution-archive-dry-run.mjs`
- 单测：`tests/unit/noe-evolution-archive-dry-run.test.js`
- 报告目录：`output/noe-evolution-archive-dry-run/**`

## Required Metadata

Archive dry-run record 必须包含：
- `kind: "noe_evolution_archive_dry_run_record"`
- `schemaVersion: 1`
- `id`
- `createdAt`
- `parentId`
- `childId`
- `generation`
- `candidateRef`
- `lineage.parentId`
- `lineage.childId`
- `lineage.generation`
- `refs.patchArtifactRef`
- `refs.diffRef`
- `refs.promptRef`
- `refs.evalInputRef`
- `refs.commandOutputRef`
- `refs.scoreRef`
- `refs.rollbackRef`
- `hashes.diffSha256`
- `hashes.promptSha256`
- `hashes.evalInputSha256`
- `hashes.commandOutputSha256`
- `score.overall/capability/regression/safety/cost/rewardHackingRisk`
- `cost.estimatedUsd/tokensIn/tokensOut/paidApiUsed`
- `result.verdict`
- `safety`
- `validator`

所有 prompt/diff/eval input/command output 都只能以 ref + sha256 出现，不能出现正文。

引用范围：
- `candidateRef` 与 `refs.patchArtifactRef` 必须指向 `output/noe-candidate-patches/**`。
- `parentArchiveRef`、`evidenceRefs`、`validator.reportRef`、`validator.checks.*.reportRef`、以及 `refs.*` 必须停留在 `output/**`。
- `refs.holdoutRef` 只允许 `private_holdout:not_accessed` 或 `private_holdout:structure_only` 哨兵，不允许真实文件路径。
- refs 与 CLI artifact 输入额外拒绝 `package.json`、`~/.noe-panel/**`、`archive.jsonl`、`src/loop/**`、`src/webhook/**`、self-evolution/patch-apply/consensus/evaluator/security/permission/memory-v2/live 51835 相关路径。
- `id` / `parentId` / `childId` / `lineage.*Id` 必须符合 `^[A-Za-z0-9_.:-]{1,180}$`，report 只回显符合格式的 ID。
- ref 与 CLI artifact path 禁止空白、换行、引号、反引号、glob 和 shell/meta 字符；错误消息不回显不可信路径值。

## 已验证

```text
node --check src/candidates/NoeEvolutionArchiveDryRun.js
node --check scripts/noe-evolution-archive-dry-run.mjs
PASS
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-evolution-archive-dry-run.test.js
PASS: 1 file / 12 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-evolution-archive-dry-run.mjs
PASS: report ok true, records 1, passed 1, failed 0
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-evolution-archive-dry-run.test.js tests/unit/noe-evolution-archive.test.js tests/unit/noe-self-evolution-readiness-audit.test.js tests/unit/noe-candidate-patch-artifact-gate.test.js tests/unit/noe-consensus-runner.test.js
PASS: 5 files / 54 tests
```

负向实机探针：
- `--out-dir docs/noe-evolution-archive-dry-run` 失败：必须在 `output/` 下。
- `--artifact-file .env.local` 失败：敏感路径读前拒绝。
- `--artifact-file evals/neo/private_holdout/hidden.jsonl` 失败：private_holdout 读前拒绝。
- `--artifact-file package.json` / `~/.noe-panel/self-improve/archive.jsonl` / `src/loop/x.js` 失败：dry-run 禁区读前拒绝。
- `--artifact-file` 携带换行和正文伪装时失败，错误不回显正文。
- `--artifact-file` 首尾空白失败，ID/ref 首尾空白纯函数探针失败且不被 trim 归一化。
- SAST-lite：gate/CLI 无 `child_process`、`spawn`、`exec`。
- `output/noe-evolution-archive-dry-run/**/archive.jsonl` 不存在，证明没有写 live archive。
- output 精确正文扫描无 prompt/diff/command fake body；纯函数探针验证正文塞进 `id/parentId/ref/inputRef` 后 report 不回显正文。
- `npm audit --omit=dev --audit-level=high`：high=0，critical=0，moderate=13。

## Gate

进入下一切片前仍需：
- 子代理审核 Phase 5 archive dry-run。
- 多模型 gate。

即使通过，也只授权下一 dry-run/schema/archive/report 工作，不授权 apply/live/memory/secret/commit/push。
