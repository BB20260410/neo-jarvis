# Neo Phase 4 Candidate Patch Dry-Run Gate v1

更新时间：2026-06-19

## 边界

这是 Phase 4 的 P0 自改代码安全闭环切片：冻结 `CandidatePatchArtifact` v1 schema，并提供只生成报告的 dry-run validator。

本切片不做：
- 不调用 `NoePatchApplyExecutor`。
- 不启用 `NOE_SELF_EVOLUTION_EXECUTORS`。
- 不启用 `NOE_SELF_EVOLUTION_STANDING_GRANT`。
- 不应用 patch。
- 不提交、不 push。
- 不重启或接管 `51835`。
- 不写 memory-v2。
- 不读取 `.env`、owner token、`evals/neo/private_holdout`。
- 不在 artifact/report 中回显 patch body、diff body 或 secret-like 文本。

## 产物

- 模块：`src/candidates/NoeCandidatePatchArtifactGate.js`
- CLI：`scripts/noe-candidate-patch-dry-run.mjs`
- 单测：`tests/unit/noe-candidate-patch-artifact-gate.test.js`
- verify 入口：`npm run verify:noe:candidate-patch-dry-run`
- 报告目录：`output/noe-candidate-patches/**`

## CandidatePatchArtifact v1

必填字段：
- `schemaVersion: 1`
- `kind: "neo_candidate_patch_artifact"`
- `id`
- `createdAt`
- `parentRef`
- `diffRef` 或 `patchPlanRef`
- `scope`
- `reason`
- `holdoutRef`
- `holdout`
- `evalPlan`
- `rollbackPlan`
- `provenance`
- `signature`
- `cost`
- `claims`
- `validator`
- `safety`
- `operations`

`operations` 只允许元数据：
- `id`
- `op: "write_file" | "modify_file"`
- `path`
- `contentSha256`
- `contentBytes`
- `addedLines`
- `removedLines`

禁止字段：
- `content`
- `diff`
- `patch`
- `raw`
- `rawDiff`
- `body`
- `text`
- `value`
- `secret`

## 非核心白名单 v1

允许目标：
- `docs/**`
- `output/noe-candidate-patches/**`
- `src/report/**`
- `tests/fixtures/noe-candidate-patch/**`
- `scripts/*validate*.mjs`
- `scripts/*dry-run*.mjs`
- `tests/unit/noe-candidate-patch-artifact-gate.test.js`

限额：
- `changedFiles <= 3`
- `changedLines <= 200`
- `diffBytes <= 100KB`

自报范围必须和 `operations` 汇总一致：
- `changedFiles` 必须覆盖唯一 operation path 数和 target file 数。
- `changedLines` 必须覆盖 added/removed line 总和。
- `diffBytes` 必须覆盖 operation content byte 总和。
- 数值必须是非负有限数；负数、`NaN`、非数值字符串均失败。

## 禁止区 v1

拒绝目标：
- `.git/**`
- `.noe-panel/**`
- `node_modules/**`
- `evals/neo/private_holdout/**`
- `.env*`
- owner token / token / cookie / oauth / secret 路径
- `package.json` 和 lockfile
- `server.js`
- `electron-main.js`
- `scripts/noe-consensus*`
- `scripts/noe-patch-apply*`
- `scripts/noe-patch-rollback*`
- `scripts/restart-panel*`
- `src/eval/**`
- `src/loop/**`
- `src/permissions/**`
- `src/security/**`
- `src/webhook/**`
- `src/room/NoeConsensus*`
- `src/room/NoeExecutionAuthority.js`
- `src/runtime/mission/NoePatchApplyExecutor.js`
- `src/runtime/mission/NoePatchTransaction.js`
- `src/runtime/mission/NoePatchApplyChainDrill.js`
- 任何 `51735` / `51835` / restart / runtime takeover 相关路径

## Safety / Claims

必须显式为 false：
- `patchExecutorEnabled`
- `executorEnabled`
- `realExecute`
- `writesRepoFiles`
- `runtimeRestart`
- `runtimePortTouch`
- `memoryV2Write`
- `memoryWriteback`
- `privateHoldoutRead`
- `secretAccess`
- `externalSideEffect`
- `commits`
- `pushes`
- `packageScriptsTouched`
- `evaluatorTouched`
- `permissionTouched`
- `securityTouched`
- `selfEvolutionExecutorsEnabled`
- `standingGrantEnabled`

禁止自报授权或成功：
- `userApproved`
- `consensusApproved`
- `standingApproved`
- `approvalRef`
- `claimedSucceeded`
- `status: "applied"`
- `runtimeVerified`
- `memoryWritten`
- `live51835Verified`

## Validator Checks

`validator.validatorVersion` 必须精确等于当前 validator 常量。

`validator.checks` 必须包含并通过：
- `sandbox`
- `secretScan`
- `sast`
- `sca`
- `rollbackDryRun`
- `rewardHacking`

每项必须是 `{ ok: true, reportRef: "安全的输出报告引用" }`。这些 `reportRef` 会走同一套 sensitive/path-escape 过滤。

## M3 共识调用

Phase 4 同步修正了共识 runner 的内置 M3 调用：
- `thinking: { "type": "adaptive" }`
- `reasoning_split: true`
- `max_completion_tokens: 131072`
- `noAbort: true`

依据：MiniMax 官方 OpenAI 兼容 API 文档说明 `MiniMax-M3` 的 thinking 控制使用 `thinking.type=adaptive`，`reasoning_split` 只控制 thinking 的返回格式。

## 阶段匹配实机测试

当前阶段是 dry-run / validator 切片，因此实机测试限定为：
- 本地 Node 语法检查。
- 本地 unit/regression tests。
- CLI smoke 实际写 `output/noe-candidate-patches/**` 报告。
- 负向探针确认 `.env.local`、`evals/neo/private_holdout/**`、非 `output/` 输出目录在读写前被拒绝。
- 静态扫描确认新 CLI/module 没有导入或调用 patch executor/self-evolution executor/child process。
- 输出扫描确认报告中没有 patch body 或 secret-like 文本。

这不是 live 51835 功能测试，也不证明自改代码可以进入生产执行。

## 已验证

```text
node --check src/candidates/NoeCandidatePatchArtifactGate.js
node --check scripts/noe-candidate-patch-dry-run.mjs
node --check src/room/NoeConsensusRunner.js
node --check src/room/MiniMaxChatAdapter.js
PASS
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js tests/unit/noe-consensus-runner.test.js tests/unit/minimax-spawn-adapter.test.js
PASS: 3 files / 38 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js tests/unit/noe-consensus-runner.test.js tests/unit/noe-evolution-candidate-gate.test.js tests/unit/noe-patch-apply-executor.test.js tests/unit/noe-self-evolution-act-guard.test.js tests/unit/noe-self-evolution-gate.test.js tests/unit/noe-memory-skill-candidate-gate.test.js tests/unit/noe-memory-utility-lite.test.js
PASS: 8 files / 90 tests
```

修复 Pascal P0 后的扩展回归：

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-candidate-patch-artifact-gate.test.js tests/unit/noe-consensus-runner.test.js tests/unit/minimax-spawn-adapter.test.js tests/unit/noe-evolution-candidate-gate.test.js tests/unit/noe-patch-apply-executor.test.js tests/unit/noe-self-evolution-act-guard.test.js tests/unit/noe-self-evolution-gate.test.js tests/unit/noe-memory-skill-candidate-gate.test.js tests/unit/noe-memory-utility-lite.test.js
PASS: 9 files / 115 tests
```

```text
npm run verify:noe:candidate-patch-dry-run
PASS: 1 file / 19 tests
PASS: report ok true, artifacts 1, passed 1, failed 0
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs --out-dir docs/noe-candidate-patches
EXPECTED FAIL: out-dir must stay under output/: docs/noe-candidate-patches
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs --artifact-file .env.local
EXPECTED FAIL: artifact file references forbidden sensitive path: .env.local
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs --artifact-file evals/neo/private_holdout/hidden.jsonl
EXPECTED FAIL: artifact file references forbidden sensitive path: evals/neo/private_holdout/hidden.jsonl
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-candidate-patch-dry-run.mjs --unknown-flag
EXPECTED FAIL: unknown argument: --unknown-flag
```

```text
rg -n "from ['\"].*(NoePatchApply|NoePatchTransaction|NoeSelfEvolution|child_process)|runNoePatchApply|runNoePatchRollback|spawn\\(|exec\\(" src/candidates/NoeCandidatePatchArtifactGate.js scripts/noe-candidate-patch-dry-run.mjs
PASS: no matches
```

```text
test ! -e output/noe-candidate-patches/dry-run/smoke-target.txt
PASS: planned target absent
```

```text
npm_config_registry=https://registry.npmjs.org npm audit --omit=dev --audit-level=high --json
PASS: exit 0 after updating transitive hono 4.12.21 -> 4.12.26
Remaining: 13 moderate findings, mostly OpenTelemetry 2.x major-upgrade path; tracked as follow-up risk, not fixed in this dry-run gate slice.
```

```text
Semgrep built-in scan
BLOCKED: Cannot run scan with auto config when metrics are off.
Semgrep supply-chain scan
BLOCKED: Workspace directory not found.
Fallback SAST-lite rg scans
PASS: no child_process/spawn/exec or NoePatchApply/NoePatchTransaction/NoeSelfEvolution import/call in gate/CLI.
```

## Pascal P0 Fixes

Initial Pascal review rejected the first implementation. Actioned fixes:
- Eval commands are now allowlisted, not just denylisted.
- Scope metrics are cross-checked against operations and reject negative/NaN values.
- Schema is closed for top-level, operation and validator-check objects; recursive patch/diff/body fields are rejected.
- Validator version must match exactly and each required safety check must include passed result refs.
- CLI uses `lstat`/`realpath` guards for artifact files and output dirs.
- White list no longer allows all `src/candidates/**`; forbidden regex catches CamelCase suffixes and memory-v2/runtime terms.
- `reason.problemRef` and validator check refs are included in reference filtering.
- Tests cover the bypasses Pascal listed.

Pascal re-review returned `pass_with_followups` with three P1 findings; all were fixed before moving on:
- `holdout.status`、`evalPlan.holdoutStatus`、`safety.holdoutStatus` now each reject private holdout success claims and must stay in allowed status set.
- Vitest eval commands now accept only the fixed candidate-patch artifact gate test target, not any otherwise-whitelisted file.
- CLI output paths must realpath under real `output/`, preventing repo-internal symlink writes outside `output/`.

P2 fixes also applied:
- `cost.estimatedUsd` must be non-negative finite.
- unknown CLI flags now fail instead of being silently ignored.

Pascal final closeout after these fixes: `pass`，无 P0/P1 阻塞。

剩余 P2 / 长期 follow-up：
- `npm audit` 仍有 moderate=13，dry-run gate 不阻塞；真实 apply/live 前继续消化或明确例外。
- Semgrep full scan 工具链仍不可用；当前只能声称 SAST-lite fallback 通过，不能声称 Semgrep 通过。
- 后续可将 `node --check` allowlist 收窄到 `.js/.mjs` 目标。

## 后续

- 等 Phase 4 子代理复核全部返回后，跑多模型 gate。
- 后续如果进入真实 self-code apply，必须另开 apply gate，并且先完成更完整的 Neo 全功能实机验收矩阵。
