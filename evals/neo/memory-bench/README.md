# Neo 记忆召回基准（P6 · memory-bench）

> **诚实溯源（owner 禁假数据）**：本目录所有题与语料是 **LongMemEval / LOCOMO 体例的【风格自造】** 集，
> 完全本地合成，**不是、也绝不冒充原 LongMemEval / LOCOMO 公开题集**。每个 case 标
> `source.kind: memory_retrieval_log` + `source.provenance: "longmem-style-synthetic"`。

## 是什么
把一批「LongMem 风格」的提问灌进 Neo 的**真召回链**（`NoeMemoryRetriever.retrieve` → `MemoryCore.recall/recallFused`，
FTS + 可选 ollama 语义向量），用 **execution-based** 方式判分（比对召回到的 memory id / 内容，**不**用 LLM 当裁判），
报 **pass^k**（每题跑 k 次，k 次全过才算过）+ Wilson 95% 置信区间。

## 结构
- `fixtures.json` —— 被召回的「对话/笔记历史」语料（fixture 记忆，非 secret）。
- `cases/case-memory-bench-<type>-<id>.json` —— 题（NeoEval case schema + `bench` 评分契约）。
  - 题型四类均衡：`single_hop` / `multi_hop` / `temporal`（配 P5 双时态 valid_from/valid_to）/ `adversarial`（高相似干扰 / 否定 / 不同编号实体 / 负样本）。
  - 中英混合。
  - `bench.query` = 提问；`bench.expectedIds` = 标准答案记忆；`bench.disallowedIds` = 不许召回的对抗干扰项；`bench.expectEmpty` = 负样本（应一条都不召回）。

## 跑
```bash
# 合成模式（干净 temp db，确定可复现，CI 用）：真召回链 + ollama 语义
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-bench.mjs --mode=synthetic --embed=ollama --k=5
# live-copy 基线（真实记忆当 distractor）——先做只读副本，绝不碰 live db：
sqlite3 ~/.noe-panel/panel.db ".backup /private/tmp/p6a.db"
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-bench.mjs --mode=live-copy --db=/private/tmp/p6a.db --embed=ollama --k=5
# 纯 FTS（无语义）：--embed=none
# 反向探针（防作弊）：--probe=wrong（喂错记忆→分掉）/ --probe=stub（断链→分0）
```

## 反向探针（防"永远满分"）
- `--probe=wrong`：期望 id 换成不存在的 → pass^k 从基线骤降到只剩负样本题（证明真比对召回内容）。
- `--probe=stub`：retriever 换成永远空召回 → 真题全 0，只有负样本题过（证明断链不报假高）。
- 单题 k 次全失败 → pass^k=0；空题集不崩（见单测）。

## 边界
- 评分纯函数在 `src/memory/NoeMemoryBenchScoring.js`；IO/编排在 `src/memory/NoeMemoryBenchRunner.js`（DI，不自己 new db）。
- report 只含 id/count/分数，**不含记忆 body / secret / owner token**。
- 确定性说明：FTS-only 或 ollama 嵌入稳定时召回确定，pass^k == pass@1（`flaky=0`）；report 同时给 pass@1 与 flaky 量化非确定性。
- 默认 walk 跳过本子树（见 `scripts/noe-eval-validate.mjs` 的 `WALK_SKIP_DIRS`），cases 仍可 `--check-artifacts` 显式校验。
