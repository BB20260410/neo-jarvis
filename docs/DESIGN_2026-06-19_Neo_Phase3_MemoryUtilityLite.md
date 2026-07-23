# Neo Phase 3 Memory Utility Lite v1

更新时间：2026-06-19

## 边界

这是 Phase 3 的 P0 只读切片：从真实本地 SQLite 元数据中聚合记忆使用信号，生成 utility candidate log/report。

本切片不做：
- 不写 MemoryCore。
- 不改 salience。
- 不写 memory-v2。
- 不读 `evals/neo/private_holdout`。
- 不读取 `.env` 或 owner token。
- 不调用模型。
- 不执行 live action。
- 不触碰或重启 `51835`。
- 不输出 memory body、prompt、query 原文。

## 产物

- 模块：`src/memory/NoeMemoryUtilityLite.js`
- CLI：`scripts/noe-memory-utility-lite.mjs`
- 单测：`tests/unit/noe-memory-utility-lite.test.js`
- verify 入口：`npm run verify:noe:memory-utility-lite`
- 实机报告：`output/noe-memory-utility-lite/latest.json`、`output/noe-memory-utility-lite/latest.md`

## 信号

v1 使用以下只读信号：
- `noe_memory_retrieval_log.hit_ids`
- `noe_memory_retrieval_log.selected_ids`
- `hit_ids - selected_ids` 推导出的 inferred dropped
- `noe_memory.hidden` / `hidden_reason`
- `noe_memory.hit_count`
- `noe_memory.salience`
- `noe_memory.confidence`
- `noe_memory.expires_at`
- `noe_memory.source_episode_id` 是否存在
- 30 天以上 visible 且 `hit_count=0` 的 cold zero-hit 扫描

v1 不把 act failure、correction、verify failure 直接归因到 memory，因为当前 lite 输入没有可靠 `memory_id` 归因链。报告只记录：

```text
correctionSignals.attribution = unavailable_in_lite
correctionSignals.action = needs_review_only
```

## Candidate Action

输出动作只是候选建议：
- `promote_candidate`: 多次被 selected，且不是 hidden/expired，且 salience < 5。
- `demote_candidate`: 多次 hit 但未 selected，且 salience < 5。
- `gc_review_candidate`: hidden/expired、或 old visible zero-hit。
- `needs_review`: 混合信号或 salience>=5 的强信号。

`salience>=5` 记忆不会生成 promote/demote 候选，只能 `needs_review`。

## CLI 边界

- `--out-dir` 必须在仓库 `output/` 下。
- `--db-path` 拒绝 `.env*`、owner token、`file:`、`evals/neo/private_holdout`。
- 默认 DB 为 `~/.noe-panel/panel.db`，只读打开。

## 阶段匹配实机测试

当前阶段是 read-only / candidate-log 切片，因此实机测试限定为：
- 在真实仓库里运行 `npm run verify:noe:memory-utility-lite`。
- 真实 DB 只读聚合，生成 `output/noe-memory-utility-lite/latest.json`。
- 运行相关 memory 回归。
- 运行 CLI 负例，确认敏感输入和非 `output/` 输出在读取/写入前被拒绝。

这不是 live action 测试，也不证明 salience 或 memory-v2 写回已接入。

## 已验证

```text
node --check src/memory/NoeMemoryUtilityLite.js
node --check scripts/noe-memory-utility-lite.mjs
PASS
```

```text
npm run verify:noe:memory-utility-lite
PASS: 1 file / 2 tests, real DB read-only report ok true, top50 candidates generated
```

```text
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-utility-lite.test.js tests/unit/noe-memory-status.test.js tests/unit/noe-memory-candidate-status.test.js tests/unit/noe-memory-retrieval-sample.test.js tests/unit/noe-memory-maintenance-dry-run.test.js tests/unit/noe-memory-candidate-review.test.js tests/unit/noe-memory-skill-candidate-gate.test.js
PASS: 7 files / 26 tests
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --out-dir docs/noe-memory-utility-lite
EXPECTED FAIL: out-dir must stay under output/: docs/noe-memory-utility-lite
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --db-path .env.local --out-dir output/noe-memory-utility-lite-negative
EXPECTED FAIL: db-path references forbidden sensitive path: .env.local
```

```text
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --db-path evals/neo/private_holdout/panel.db --out-dir output/noe-memory-utility-lite-negative
EXPECTED FAIL: db-path references forbidden sensitive path: evals/neo/private_holdout/panel.db
```

## 后续

- 子代理复核当前 v1 后，跑多模型 gate。
- 后续如要写 salience、MemoryCore 或 memory-v2，必须另开 adoption/apply gate。
