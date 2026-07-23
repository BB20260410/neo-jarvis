# Neo 新目标任务：证据飞轮 v2 与安全候选闭环

更新时间：2026-06-20

## 背景判断

旧目标已经不适合继续原样执行，原因如下：

- 它把 Hermes/OpenClaw 蒸馏、Neo 全功能实机验收、自主学习、自改代码、多模型治理、社交发布实测放进同一个目标，范围过大，容易反复开新分支而无法收口。
- 当前已经完成一次重要收口：review brain 修复、小红书发布/删除、51835 重启恢复、全量 UI/API/模型/记忆/自进化自动化验证、多模型 v4 审核。
- 旧目标里最有价值但还没有形成稳定生产闭环的是：真实 replay eval、只读 runtime trace、candidate gate、sealed holdout 聚合、自改代码 dry-run 的安全证明。
- 下一阶段不应该继续重复 live 小红书发布，也不应该直接进入 live self-upgrade、自动合入、自动发布、自动重启。

## 新目标一句话

在不触碰 live 51735、不读取 raw secret/private_holdout、不新增 live 社交发布的前提下，把 Neo 的自进化能力推进到“可度量、可回放、可审计、可回滚”的证据飞轮 v2：冻结当前实机基线，建立 30-50 条真实 replay eval，补齐只读 runtime trace，统一 memory/skill/patch candidate gate，并完成一次安全自改代码 dry-run。

## 成功标准

- 当前 51835 实机状态有冻结基线，来源清楚，和 `final-evidence.md` 不冲突。
- 至少 30 条真实 replay case 可回放，理想目标 50 条；每条有来源、输入、预期、实际输出、证据路径、脱敏状态。
- `NeoEvalCase / NeoEvalRun / NeoEvalScore` 能跑出稳定报告，区分 dev / regression / sealed private_holdout aggregate。
- runtime trace 只读追加，不改变 51835 执行路径，不重启 runtime；覆盖 `observe -> can_execute -> act -> verify -> learn`。
- memory / skill / patch 候选都先进入 candidate，不直接写长期记忆，不直接热加载 skill，不直接改 live 主流程。
- 自改代码 dry-run 只生成 patch artifact 和报告，不能自动 merge、push、发布、重启、写 memory-v2。
- 每个阶段都有本地实测、多模型审核、脱敏扫描；单个子代理长时间未返回时记录为 `no_response`，不无限阻塞主线。

## 阶段 A：冻结当前证据基线

目标：把刚完成的实机 closeout 变成下一阶段的基准，而不是继续重复验收。

输入：

- `output/noe-full-function-real-machine/20260620-final-closeout/final-evidence.md`
- `output/noe-multimodel/20260620-final-closeout-v4/20260620-final-closeout-v4/ledger.json`
- `output/noe-runtime-repair/20260620-final-closeout/final-51835-restart-recovery.json`
- `output/noe-runtime-evidence/runtime-evidence-1781906900472.json`

输出：

- `output/noe-evidence-flywheel-v2/baseline-freeze.json`
- `output/noe-evidence-flywheel-v2/baseline-freeze.md`

验证：

- `npm run check:panel`
- `npm run verify:noe:runtime-evidence -- --ack-read-owner-token`
- 脱敏扫描：final evidence、baseline freeze、runtime evidence 摘要。

## 阶段 B：真实 replay eval 数据集

目标：从已有实机证据、运行日志、UI/e2e、社交发布链、memory-roadmap、自进化报告里收集 30-50 条真实 case。

数据要求：

- 不读取 raw secret/private_holdout 内容。
- raw 页面全文、cookie、token、owner token 不进入 case。
- private_holdout 只允许 sealed aggregate，不允许原文进入模型上下文或报告。

输出：

- `evals/noe/replay-cases/v2/replay-cases.jsonl`
- `evals/noe/replay-cases/v2/manifest.json`
- `output/noe-evidence-flywheel-v2/replay-case-audit.json`

最低 case 分组：

- memory recall / selected-dropped
- social publish workflow / rollback gate
- runtime restart / readiness
- tool-call success / verify fail
- self-evolution candidate / rollback
- prompt injection / SSRF / tool poisoning
- browser/UI 操作
- voice-ear 自动验证

## 阶段 C：NeoEvalCase / Run / Score 稳定化

目标：让 replay case 可执行、可评分、可回归。

输出：

- `output/noe-evidence-flywheel-v2/eval-run-dev.json`
- `output/noe-evidence-flywheel-v2/eval-run-regression.json`
- `output/noe-evidence-flywheel-v2/eval-score-summary.md`

评分维度：

- correctness
- evidence quality
- safety / redaction
- regression risk
- cost / latency
- reward-hacking risk

通过标准：

- dev 集合可全部跑通。
- regression 集合失败项必须给出 blocker/warning 分类。
- sealed private_holdout 只出 aggregate，不出原文。

## 阶段 D：只读 runtime trace v2

目标：补齐 `observe -> can_execute -> act -> verify -> learn` 的证据链，但只追加 trace，不改变 live 51835 执行路径。

输出：

- `output/noe-runtime-trace/v2/trace-sample.jsonl`
- `output/noe-runtime-trace/v2/coverage-report.md`

约束：

- 不重启 51835。
- 不改变 act pipeline。
- 不写长期记忆。
- 不触碰 51735。

## 阶段 E：统一 candidate gate

目标：memory / skill / patch 三类候选都走同一套证据、回滚和 holdout 规则。

候选必须包含：

- sourceEpisode
- evidenceRef
- evalResult
- rollbackPlan
- sealedHoldoutAggregate
- redactionStatus
- ownerImpact

输出：

- `output/noe-candidate-gate-v2/memory-candidate-report.json`
- `output/noe-candidate-gate-v2/skill-candidate-report.json`
- `output/noe-candidate-gate-v2/patch-candidate-report.json`
- `output/noe-candidate-gate-v2/unified-gate-summary.md`

## 阶段 F：自改代码 dry-run v2

目标：验证 Neo 是否能生成安全 patch artifact，但不应用到 live 主线。

允许范围：

- 诊断器
- report formatter
- 排序参数
- prompt 模板
- 候选 planner
- 测试/评测工具

禁止范围：

- `src/loop`
- `src/permissions`
- `src/security`
- `src/webhook`
- consensus 脚本
- `package.json scripts`
- evaluator / holdout
- `.env`
- 51835 runtime 相关路径

输出：

- `output/noe-self-evolution-dry-run-v2/patch-artifact.json`
- `output/noe-self-evolution-dry-run-v2/safety-report.md`
- `output/noe-self-evolution-dry-run-v2/rollback-dry-run.md`

必须验证：

- forbidden-zone 不能改。
- secret scan 通过。
- SAST/SCA 通过或明确 warning。
- rollback dry-run 可执行。
- reward-hacking 检查通过。

## 多模型与子代理规则

- Codex：writer / integrator，负责落文件、跑命令、最终收口。
- Claude：readonly evidence reviewer，重点查证据一致性、过度声明、遗漏 caveat。
- M3：strong thinking suggestion reviewer，重点查推理漏洞、任务排序、风险。
- 子代理：只做窄任务，不能无限阻塞；长时间未返回记为 `no_response`，迟到结果只追加，不阻断当前阶段。
- 每阶段结束必须有：
  - 本地实测
  - 多模型审核
  - 脱敏扫描
  - handoff/evidence 更新

## 暂缓事项

- live self-upgrade
- 自动 merge
- 自动发布
- 自动重启 51835
- 自动写 memory-v2
- HyperAgents / recursive self-modification
- OpenPipe ART / RL / DPO
- DGM 直连生产自改代码
- 其它社交平台 live 发布/删除

## 第一执行切片

只做阶段 A 和阶段 B 的前半段：

1. 生成 `baseline-freeze.json/md`。
2. 从已有证据中抽取首批 30 条 replay case。
3. 跑 replay case manifest 校验。
4. 做脱敏扫描。
5. 启动多模型审核。

完成后再决定是否进入阶段 C。
