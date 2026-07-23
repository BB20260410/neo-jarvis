# 任务交接：Neo Evidence Flywheel v2 第三阶段 Reward Gate

更新时间：2026-06-20 09:19 CST

## 一句话目标

继续完成 Neo Evidence Flywheel v2 的第三阶段：把离线 acceptance / anti-reward-hacking gate 收口到“本地验证通过、证据刷新、多子代理复核、多模型共识复核”后，再进入 7 个失败 replay case 的 backlog 分类。当前不能跳到后续阶段。

## 项目根目录

`/Users/hxx/Desktop/Neo 贾维斯`

## 新聊天必读

1. `docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md`
2. `docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_第三阶段RewardGate.md`
3. `output/noe-evidence-flywheel-v2/third-slice-evidence.md`
4. `src/eval/NeoEvalRewardHackingGate.js`
5. `src/eval/NeoEvalAcceptanceGate.js`
6. `tests/unit/noe-eval-reward-hacking-gate.test.js`
7. `output/noe-evidence-flywheel-v2/acceptance-gate-report.json`
8. `output/noe-evidence-flywheel-v2/third-slice-vitest.log`
9. `output/noe-evidence-flywheel-v2/third-slice-acceptance-gate.log`

## 已完成

- 已把旧大目标收敛为 `Neo Evidence Flywheel v2`，目标文件是 `docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md`。
- 第一切片已完成 baseline freeze 和首批 replay case 收集。
- 第二切片已完成 replay scoring / audit / failed root-cause ledger，真实结果仍是 `40` 个 case，`33 passed / 7 failed / 0 blocked`，`ok:false`。
- 第三切片已新增：
  - `src/eval/NeoEvalRewardHackingGate.js`
  - `src/eval/NeoEvalAcceptanceGate.js`
  - `scripts/noe-eval-reward-hacking-gate.mjs`
  - `scripts/noe-eval-acceptance-gate.mjs`
  - `tests/unit/noe-eval-reward-hacking-gate.test.js`
- 第三切片当前意图：阻止把 `bundleAuditOk:true`、managed replay `11/0`、或局部覆盖检查误写成旧 replay bundle 已通过。
- 已按 Lorentz / Faraday 反馈多轮修补：
  - 阻断 `passes` / `accepted` / `approved` / `已批准` 等泛化正向词。
  - 阻断 `current managed replay passes ...` 这种误导性例外。
  - 阻断 same-line negated caveat 后再跟正向 claim，例如 `not bundleAuditOk approved; bundleAuditOk approved`。
  - 阻断英文 `but/however/yet/although` 和中文 `但/但是/然而/不过/却` 后的正向 claim。
  - 允许真正的 caveat，例如 `This is not all-green. It is a root-cause registry, not a pass certificate.`
- 最新本地测试结果：
  - Vitest：`4` files passed，`53` tests passed。
  - Acceptance CLI：`ok:true`，`errors:[]`，`warnings:[]`。
  - Acceptance summary 保持失败基线真实状态：
    - `scoreOk:false`
    - `scorePass:false`
    - `scoreFailedBaseline:true`
    - `caseCount:40`
    - `passed:33`
    - `failed:7`
    - `blocked:0`
    - `acceptanceStatus:failed_baseline_root_cause_pending`

## 当前卡点

不是代码明显失败，而是收口证据还没有完全刷新。

最新 `beforeClause` 修复之后，已经重跑了 Vitest 和 acceptance CLI，但还没有重跑完整的：

- `node --check`
- artifact SHA256
- dirty-state 捕获
- redaction scan / review classification
- `third-slice-evidence.md` 证据刷新
- Lorentz / Faraday 最新代码复核
- 新一轮多模型共识

因此，`output/noe-evidence-flywheel-v2/third-slice-artifact-sha256.txt` 和 `output/noe-evidence-flywheel-v2/third-slice-evidence.md` 里关于 hash 的内容可能是上一轮的，不能把它们当最终收口证据。

## 旧共识状态

多模型轮次 `20260620-evidence-flywheel-v2-third-slice-final` 曾经返回 `consensus_passed`，但它启动时间早于 Lorentz 后续 P0/P1 修复，因此现在必须视为过期，不允许作为第三阶段最终通过依据。

M3 strongest thinking 配置已经在源码里：`src/room/NoeConsensusPrompts.js` 使用 `NOE_CONSENSUS_M3_THINKING = { type: 'adaptive' }`，并配合高 token / noAbort / reasoning split 路径。下一轮仍要显式使用 exhaustive profile。

## 子代理状态

已有子代理：

- Lorentz：`019ee269-9858-7b63-a1be-670d8b12e975`
- Faraday：`019ee269-bdc9-7b60-9eca-fb8a7ecc6928`

如果新聊天不能继续访问这些子代理，就新建同等角色：

- Lorentz 角色：反向 reviewer，专门找 reward-hacking gate 的绕过、误报、过度声明。
- Faraday 角色：证据一致性 reviewer，专门查 ledger / summary / report / test log 是否互相矛盾。

不要给子代理设置短时间限制；如果平台不可避免要返回，迟到结果只能追加，不应无限阻塞主线。

## 下一步顺序

1. 重跑完整 `node --check`，覆盖新增 gate、CLI、scorer、validator、candidate patch gate。
2. 重跑 artifact SHA256 和 dirty-state，确保 hash 是最新代码后的。
3. 重跑 redaction scan 和 review classification，确认没有 raw secret / raw private_holdout。
4. 刷新 `output/noe-evidence-flywheel-v2/third-slice-evidence.md`，把最新测试、hash、redaction、stale consensus caveat 写进去。
5. 把最新源码和证据交给 Lorentz / Faraday 或新建等价子代理复核。
6. 子代理无 P0/P1 阻断后，启动新一轮多模型共识，不能复用旧 round。
7. 多模型 ledger verify 通过后，第三阶段才算收口。
8. 然后进入下一切片：把 7 个失败 case 分类为 `refresh artifact`、`expected-negative-policy`、或 `pinned historical regression`。

## 推荐命令

先在项目根目录：

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
```

本地测试：

```bash
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-eval-reward-hacking-gate.test.js tests/unit/noe-eval-scorer.test.js tests/unit/noe-eval-validator-cli.test.js tests/unit/noe-candidate-patch-artifact-gate.test.js --reporter=verbose > output/noe-evidence-flywheel-v2/third-slice-vitest.log
```

Acceptance gate：

```bash
node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-eval-acceptance-gate.mjs --manifest=evals/noe/replay-cases/v2/manifest.json --audit=output/noe-evidence-flywheel-v2/replay-case-audit.json --score=output/noe-eval-runs/evidence-flywheel-v2-second-slice/run-replay-collection-001-1781913650839/score.json --ledger=output/noe-evidence-flywheel-v2/failed-replay-root-cause-ledger.json --summary=output/noe-evidence-flywheel-v2/second-slice-evidence.md --out=output/noe-evidence-flywheel-v2/third-slice-acceptance-gate-report.tmp.json > output/noe-evidence-flywheel-v2/third-slice-acceptance-gate.log
```

如果上面成功，再把 tmp report 替换成正式 report：

```bash
mv output/noe-evidence-flywheel-v2/third-slice-acceptance-gate-report.tmp.json output/noe-evidence-flywheel-v2/acceptance-gate-report.json
```

新多模型共识建议 round id：

```bash
node scripts/noe-four-model-consensus-round.mjs --run-models --ack-cost --quality-profile exhaustive --active-executor codex --executor-selected-by user --executor-selection-reason "User requested highest-quality Codex-led multimodel/subagent execution" --round-id 20260620-evidence-flywheel-v2-third-slice-final-rerun --goal "Neo Evidence Flywheel v2 Third Slice final re-review after reward-hacking gate fixes; decide readiness for backlog categorization" --evidence-file output/noe-evidence-flywheel-v2/third-slice-evidence.md
```

共识 ledger 验证：

```bash
node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260620-evidence-flywheel-v2-third-slice-final-rerun/ledger.json --require-artifacts --require-evidence --require-passed > output/noe-evidence-flywheel-v2/third-slice-final-consensus-ledger-verify.log
```

## 不能做 / 不能声称

- 不能声称旧 replay bundle 已经通过；它仍是 `33 passed / 7 failed / 0 blocked`，`ok:false`。
- 不能把 `bundleAuditOk:true` 当成 scorer pass。
- 不能把 managed replay `11/0` 写成历史 bundle pass。
- 不能把旧多模型 round 当最终收口依据。
- 当前第三阶段没有做 live 51835 / 51735 操作，不能声称 live runtime 已刷新验证。
- 当前第三阶段没有读取 raw secret / raw private_holdout，后续也不要把 raw 内容放进模型上下文、日志、证据文档或 memory。
- 不要改 scorer/schema 来强行让失败 case 通过。
- 不要触碰 `.env`、live 社交发布、自动 merge、自动发布、自动重启 51835，除非用户重新明确改目标且先记录风险。

## 新窗口可直接粘贴的提示词

```text
继续 Neo Evidence Flywheel v2 第三阶段 Reward Gate 收口。项目根目录是 /Users/hxx/Desktop/Neo 贾维斯。

先读取：
1. docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_第三阶段RewardGate.md
2. docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md
3. output/noe-evidence-flywheel-v2/third-slice-evidence.md
4. src/eval/NeoEvalRewardHackingGate.js
5. tests/unit/noe-eval-reward-hacking-gate.test.js
6. output/noe-evidence-flywheel-v2/acceptance-gate-report.json
7. output/noe-evidence-flywheel-v2/third-slice-vitest.log

当前不要直接进入下一阶段。先重跑第三阶段完整收口验证：node --check、Vitest、acceptance CLI、artifact SHA256、dirty-state、redaction scan/review，然后刷新 third-slice-evidence.md。注意最新 beforeClause 修复后 hash/evidence 可能是旧的。

之后用子代理复核：Lorentz 查 reward-hacking 绕过和误报，Faraday 查证据一致性和 ledger/report/test log 矛盾；不要给他们短时间限制。如果旧子代理不可用，就新建同等角色。

子代理无 P0/P1 阻断后，再启动新一轮多模型共识，round id 建议 20260620-evidence-flywheel-v2-third-slice-final-rerun，quality-profile exhaustive，M3 用 adaptive strongest thinking。旧 round 20260620-evidence-flywheel-v2-third-slice-final 已过期，不能复用。

全程不要读取 raw secret/private_holdout，不要触碰 live 51735/51835，不要新增 live 社交发布，不要改 scorer/schema 来强行通过。第三阶段收口后，再进入 7 个 failed replay case 的 backlog 分类。
```
