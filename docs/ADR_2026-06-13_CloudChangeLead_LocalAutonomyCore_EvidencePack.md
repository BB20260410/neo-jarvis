# ADR: Cloud Change Lead + Local Autonomy Core 第一批实现边界

日期: 2026-06-13
状态: 草案 v0.1
作者: Neo 项目 owner 决策记录；来源: owner / GPT5 / M3 / Codex 多轮方案校准

## 背景

Neo 当前已有本地三角色模型路由，是后续功能性自我模型、自主运行和自我改造能力的基础之一。owner 于 2026-06-13 明确提出新的协作目标:

> 云端主导 owner 前台改造任务，本地是不断思考的大脑。

因此第一批实现要同时支持云端强模型主导改造、本地常驻自治、真实执行证据闭环，而不是继续停留在方案讨论。

## 决策

D1. 云端可主导 patch plan / diff。

D2. 本地负责 apply / test / verify / rollback / evidence。

D3. EvidencePack 只读，只负责 assemble / redact / validate / serialize。

D4. PatchTransaction 负责写事务，包括 parsePatch / checkPreconditions / apply / rollback / recordDiff。

D5. EvidenceReconciler 负责验证和完成判定，包括 verify / compareClaimsToEvidence / decideSucceeded。

D6. Mission Contract 增加 leader / executor / reviewers / cloudContextPolicy / patchAuthority / localAutonomy。

D7. 3 个云端开关独立: FG / BG / PRIVATE。

D8. Provider 走 registry + live preflight + capability tags，不硬编码某家模型。

D9. P8-M0A + L0A 并行起步，第一版就支持 leader=cloud。

D10. 成功指标是真实完成、证据闭环、失败恢复、成本可控、前台体验和后台持续运行，不是云端占比。

D11. 默认开关分阶段: 开发期 FG=0 / BG=0 / PRIVATE=0；产品期 FG=1 / BG=0 / PRIVATE=0。

D12. full_project_allowed 不作为常规模式；优先 selected_files + EvidencePack + redacted snippets。

## 反对意见与举证条件

- 如果反对 D3，必须给出能覆盖 rollback、secret redaction、claim-evidence 对账、失败恢复的测试设计。
- 如果反对 D11，必须说明 owner 前台云端优先如何兑现。
- 如果反对 D10，必须说明为什么云端占比比结果指标更重要。
- 如果反对 D1-D2，必须给出“云端如何体现主导改造但不是顾问”的具体设计。

## PoC 五门验收

1. mock cloud 能生成 patch plan。
2. 本地能组装 redacted EvidencePack。
3. 本地能 apply 一个安全 patch。
4. 测试失败能 rollback。
5. 云端声称完成但 evidence 不足时不得 succeeded。

## 依赖项

- API key 未确认前必须用 mock provider。
- 测试目标必须只读/安全: 不删文件、不改 secrets、不发布。
- 首个真实 provider 由 ProviderRegistry + live preflight + 当前可用 API key 决定；MiniMax M3、Anthropic、OpenAI、Google 都只是候选 provider，不写死。

## 实现顺序

第一批最小闭环必须优先在 2-3 天内跑通 mock cloud PoC:

- Mission Contract / Store / EvidencePack / NoeTaskOutput / ProvenanceTag / CloudPolicy。
- CloudProviderRegistry / CloudAdapter mock provider / capability tags。
- PatchTransaction / EvidenceReconciler。
- `npm run noe:mission:poc` 跑通 PoC 五门。

后续再接真实 provider、owner 前台真实任务 PoC 和长时间真跑统计。

## 哲学边界

- 不承诺“证明 Neo 有真实意识”。
- 但认真建设、验证和改进功能性自我模型、自主目标、长期记忆、反思、行动闭环和自我改造能力。
- 存在性问题不作为工程验收目标；工程验收只看可观察能力、证据闭环和可恢复执行。
