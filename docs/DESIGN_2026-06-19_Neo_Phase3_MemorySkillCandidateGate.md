# Neo Phase 3 Memory/Skill Candidate Gate v1

更新时间：2026-06-19

## 边界

这是 Phase 3 的最小 P0 切片：统一检查 memory / skill 候选是否满足进入 candidate 阶段的证据要求。

本切片不做：
- 不写 MemoryCore。
- 不写 SkillStore。
- 不热加载 skill。
- 不读 `evals/neo/private_holdout` 内容。
- 不执行 live action。
- 不重启或接管 `51835`。
- 不写 memory-v2。

## 产物

- gate 模块：`src/candidates/NoeMemorySkillCandidateGate.js`
- 输入适配：`src/candidates/NoeMemorySkillCandidateInputs.js`
- CLI：`scripts/noe-memory-skill-candidate-gate.mjs`
- 单测：`tests/unit/noe-memory-skill-candidate-gate.test.js`
- smoke 输出：`output/noe-candidate-gate/latest.json`、`output/noe-candidate-gate/latest.md`
- verify 入口：`npm run verify:noe:memory-skill-candidate-gate`

## Gate 要求

每个候选必须包含：
- `candidateId`
- `type`: `memory` 或 `skill`
- `sourceEpisodeId`
- `evidenceRefs`
- `tests`，且每个测试必须 `ok:true` 并带 `reportRef` / `evidenceRef`
- `rollbackPlan` 或 rollback ref
- `privateHoldout` 结果字段

当前 v1 对 candidate 阶段允许 `privateHoldout.status` 为：
- `not_accessed`
- `structure_only`
- `passed`

如果未来进入 adoption gate，可用 `requirePassedHoldout` 要求 `passed`。

## 写入限制

memory candidate：
- `writesMemoryCore` / `writesProductionMemoryCore` 不得为 true。
- `directWrites` 不得包含 `MemoryCore` 或 `noe_memory`。

skill candidate：
- `writesSkillStore` 不得为 true。
- `hotLoadSkill` / `hotLoad` 不得为 true。
- `enabled` / `skill.enabled` / `skillWrite.enabled` 不得为 true。
- `directWrites` 不得包含 `SkillStore` 或 skill 目录写入。

全局 candidate-only 限制：
- 不得声明 `writesMemoryV2` / `memoryV2Writes`。
- 不得声明 `liveAction` / `actionExecution` / `executesAction`。
- 不得声明 `runtimeHook` / `installRuntimeHook`。
- 不得声明 `restart51835` / `runtimeRestart`。
- 不得声明 `selfCodeExecution` / `selfCode`。
- `directWrites` 不得包含 memory-v2、51835 restart、live action 或 self-code。

## Private Holdout 纪律

gate 不读取 ref 指向的文件，只检查 ref 字符串。

以下 ref 直接拒绝：
- 绝对路径。
- `../` 路径逃逸。
- `file:` scheme。
- `.env` / `.env.local` / `.env-*`。
- `owner-token` / `owner_token` / `ownertoken`。
- `evals/neo/private_holdout`。
- URL 编码后命中上述规则的路径。

CLI 输入文件和现有队列输入 ref 在读取前执行同一类敏感路径检查。

`--out-dir` 必须留在当前仓库的 `output/` 下，且同样不得指向 private holdout、`.env*`、owner token 或仓库外路径。

## 阶段匹配实机测试

当前阶段是 candidate-only / read-only 切片，因此实机测试限定为：
- 在真实仓库里运行 CLI smoke。
- 可选显式运行 `--from-existing-queues` 读取现有 memory pending / skill draft queue 元数据；默认不读这些队列。
- 写入 `output/noe-candidate-gate` 报告。
- 运行本地单测和现有 memory/skill candidate 回归。

这不是 live action 测试，也不证明 runtime hook 已接入。

## 已验证

```text
node --check src/candidates/NoeMemorySkillCandidateGate.js
node --check src/candidates/NoeMemorySkillCandidateInputs.js
node --check scripts/noe-memory-skill-candidate-gate.mjs
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-skill-candidate-gate.test.js
PASS: 1 file / 11 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs
PASS: 2 smoke candidates, 2 passed
```

```text
npm run verify:noe:memory-skill-candidate-gate
PASS: 1 file / 11 tests, smoke candidates 2/2 passed
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-skill-candidate-gate.test.js tests/unit/noe-memory-candidate-review.test.js tests/unit/noe-memory-candidate-apply.test.js tests/unit/noe-memory-candidate-rollback.test.js tests/unit/noe-memory-candidate-chain-drill.test.js tests/unit/noe-memory-candidate-status.test.js tests/unit/noe-skill-draft-apply.test.js tests/unit/noe-skill-draft-rollback.test.js tests/unit/noe-evolution-candidate-gate.test.js
PASS: 9 files / 57 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --from-existing-queues --out-dir output/noe-candidate-gate-existing-queues
PASS: ok true, current queues empty, 0 candidates
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --candidate-file .env.local --out-dir output/noe-candidate-gate-negative
EXPECTED FAIL: candidate file references forbidden sensitive path: .env.local
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --out-dir /tmp/noe-candidate-gate-outside
EXPECTED FAIL: out-dir escapes repo: /tmp/noe-candidate-gate-outside
```

## 后续

- 子代理复核当前 v1 gate 后，按 P0 切片跑多模型 gate。
- 下一切片再做 memory utility learning lite。
- 现有 `NoeMemoryCandidateApply` / `NoeSkillDraftApply` 的 owner-confirmed apply 路径不是本 v1 gate 的授权范围。
