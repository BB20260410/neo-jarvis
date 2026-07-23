# Neo Phase 5 GraphMemory / PlanValidator / CausalRiskGate Boundary Decision

更新时间：2026-06-19

## 结论

本阶段只做边界决策，不新增运行时写路径。

| Capability | Decision | Reason |
| --- | --- | --- |
| GraphMemory | defer external adoption; only future dry-run/report allowed | Neo 已有 `MemoryCore`、`NoeKnowledgeGraph`、`NoeMemoryConflictPolicy`、`NoeMemoryUtilityLite`。直接加第二套 graph memory 会造成 split-brain 记忆、重复写入和 body/secret 泄漏风险。 |
| PlanValidator | allow next as dry-run/schema/report only | 现有 candidate patch、archive、scorecard、PR repair 都有各自 gate，但缺统一 plan-level validator。下一步可只做元数据校验和报告，不接执行链。 |
| CausalRiskGate | defer runtime gate; offline report only after more trace/eval evidence | `NoeRuntimeTrace` 和 `NeoEvalSchema` 已有 evidence substrate，但因果判断需要足够 trace、对照和失败归因。现在不能把相关性包装成因果 gate。 |

## Evidence From Current Code

- `src/memory/NoeKnowledgeGraph.js` 已有实体表、关系表、`stats/search/oneHop` 和 file-index ingest。
- `src/memory/MemoryCore.js` 已接入 `decideMemoryConflict`。
- `src/memory/NoeMemoryConflictPolicy.js` 已输出 `merge/supersede/keep_both/ignore/needs_review` 这类确定性事实更替决策。
- `src/memory/NoeMemoryUtilityLite.js` 已做 read-only utility candidate，不写 MemoryCore、不写 memory-v2、不输出 memory body。
- `src/runtime/NoeRuntimeTrace.js` 已有 `observe -> can_execute -> act -> verify -> learn` append-only trace schema 和 snapshot。
- `src/eval/NeoEvalSchema.js` 已有 dev/regression/private_holdout 分层，禁止 candidate 访问 private holdout。
- Phase 4/5 已完成 candidate patch、archive、scorecard、PR repair 四个 dry-run gate。

## Boundary Rules

GraphMemory:
- 不新增外部 graph memory 服务。
- 不新增 MemoryCore/NoeKnowledgeGraph 写路径。
- 不在 live DB 上为边界报告实例化会 `ensureSchema()` 的 `NoeKnowledgeGraph` 写路径；只读取既有报告、schema/source 或专用临时库测试。
- 不读取 memory body 生成报告。
- 后续最多做 `output/**` 下的 temporal graph/memory-link dry-run report，且必须 candidate-only。

PlanValidator:
- 只允许下一步做 `NoePlanValidatorDryRun` 类的 schema/report。
- 输入只能是 refs 和 policy flags，不接收 raw prompt、diff、patch、command output、PR body、memory body。
- 只验证 plan metadata，不运行 plan、不调用 patch apply、不执行 git/gh、不调用 evaluator/model/API。
- 必须复验上游 gate report 的 `ok:true`、validatorVersion 和 ref consistency。

CausalRiskGate:
- 不接 runtime act / patch / memory write / live 51835。
- 只允许离线读取 `output/noe-runtime-trace/**`、NeoEval dev/regression 报告和 dry-run reports。
- 只能输出 risk hypothesis / evidence gap / recommended next instrumentation，不能声称已证明因果。
- 没有足够对照样本时，decision 必须是 `insufficient_evidence` 或 `defer_runtime_gate`。

## P0/P1 Risks

P0:
- 新增第二套 graph memory 写路径导致长期记忆分裂。
- CausalRiskGate 进入 runtime，阻止或放行真实行动，但证据只是相关性。
- PlanValidator 调用真实执行器、patch apply、git/gh、evaluator、live 51835 或 memory-v2。
- 报告中出现 memory body、prompt、diff、command output、secret/private_holdout 路径。

P1:
- PlanValidator 只看候选自报，不复验上游 gate report。
- GraphMemory report 读取并输出 body/title/content。
- GraphMemory 报告把现有 one-hop KG 夸大成 Graphiti 级时序因果记忆。
- CausalRisk report 没有标注 evidence gap，把弱证据写成确定结论。
- 新增 package/evaluator/security/permission 变更。

## Next Allowed Slice

如果继续推进，只允许：
- `PlanValidatorDryRun` schema/report。
- 输出目录：`output/noe-plan-validator-dry-run/**`。
- 上游：candidate patch / archive / scorecard / PR repair / runtime trace / NeoEval reports 的 refs。
- 不授权：GraphMemory 写入、CausalRisk runtime gate、patch apply、真实 git/PR、evaluator execution、model/API call、live 51835、memory-v2、secret/private_holdout。
