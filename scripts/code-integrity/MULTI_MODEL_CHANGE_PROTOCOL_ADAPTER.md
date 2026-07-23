# Neo 多模型代码变更协议适配器（非 SSOT）

本文件不替代项目根的 `AGENTS.md`、`CLAUDE.md`、`docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`、最新 handoff 和验收矩阵，也不能作为新的事实源；它只把这些权威规则压缩成 Codex、Claude、Grok、Cloud 等模型都能执行的工具接线适配器。发生冲突时，以用户本轮要求和项目权威文件为准。

## 目标

不同模型可以采用不同推理方式，但交付必须具有相同的边界、代码卫生、测试真实性和可重放证据。统一的是产物契约，不要求模型“写得像同一个人”。

## 开工前必须返回的 preflight

模型在改代码前先给出一份短清单，并以本地事实填充：

1. 当前权威 checkpoint：branch、HEAD、dirty 状态摘要和最新 handoff。
2. 本切片唯一 owner/integrator；其他代理只能只读审核。
3. `allowedPaths` 与明确不碰的 active/forbidden paths。
4. 要保护的业务不变量，以及成功路径、失败路径各由哪项测试证明。
5. 风险等级：pure/static、isolated integration、runtime、live/release。
6. 计划运行的精确命令、Node 版本、数据根、端口和副作用。
7. 回滚边界；如果 preimage 漂移或测试映射缺失，必须停止而非猜测。

没有以上事实时，可以继续只读调查，不能开始跨域重构。

## 编码时共同遵守

- 新代码文件保留 `// @ts-check`、依赖注入和配套行为测试；新文件必须少于 500 行。
- 保留现有 ESLint 作为语义/安全规则权威；formatter 只负责排版，且不得全库改写。
- 不新增宽泛 `eslint-disable`、`@ts-nocheck`、`@ts-ignore`、focused/skip/todo 测试或冲突标记。
- 内部错误允许向真实边界传播；只在 route、job、IPC、I/O 等边界捕获、脱敏并保留 cause。禁止机械地给所有 async 套 try/catch。
- 不因为“风格统一”发起目录搬迁、barrel、路径别名、全量 TypeScript 或全量 import 重排。
- 产品逻辑修改必须至少有一个成功路径和一个失败路径证据；源码字符串、文件存在、Mock 或模型自述不能单独证明完成。
- 新外部条件缺失写成 `external_blocked`，不能用 skip 或默认分支伪装 PASS。
- 每个行为源码必须在数据化 impact map 中绑定成功、失败不变量及真实测试；额外传入一个无关 PASS 测试不能替代映射。
- canary、activity、diagnostic 与 gate verification 必须按 schema 和生产者 safe-run 关系验证；普通文件哈希不能冒充语义证据。
- 日志、receipt、fixture 和报告不得含 secret 原值；不读取 `.env` 或真实用户状态来“帮助测试”。

## 交付时统一证据

每个模型最终都交付同一组事实，而不是自由格式的“我已完成”：

- 实际改动文件和唯一目的；
- base/head/overlay digest 与 allowed paths；
- changed gate receipt，以及它在当前字节上的 `current` 验证；
- 机械检查、ESLint、诊断棘轮和定向行为测试结果；
- 运行态/UI/媒体任务所需的真实证据，及未验证项；
- 与其他窗口的重叠/冲突结果；
- candidate bundle 的 preimage、依赖顺序和重放前置条件；在 Bauth 与 canonical `NoeSourceDigest` 未绑定前，它不得称为可应用补丁；
- 明确结论：仅隔离实现、已进入权威基线、或仍被外部条件阻塞。

任何源码、测试、配置、基线或产物 hash 变化都会使旧 receipt 失效。下一模型必须重新验证，不能继承上一模型的聊天结论。

## 可复制给任意编码模型的提示词

```text
你正在修改 Neo。先完整读取项目根 AGENTS.md、CLAUDE.md、最新 handoff 和当前 Git 状态；不要把聊天记录当作进度事实。

先输出 preflight：当前 branch/HEAD/dirty 摘要、唯一 writer、allowedPaths、active/forbidden paths、业务不变量、成功/失败测试映射、Node/端口/数据根、副作用和回滚边界。信息不足时只做只读调查。

只实现一个可纵向验收的小切片。保护其他窗口修改，不全库格式化，不替换 ESLint，不重装 hooks，不做全量 TypeScript/目录/barrel/路径别名迁移。新代码文件必须有 // @ts-check、依赖注入、配套行为测试且少于 500 行。禁止宽泛 suppression、skip/todo/only、吞错和 secret 输出。

完成后运行当前切片的 changed gate 和真实行为测试；源码字符串、文件存在、Mock 或模型自述不能单独算完成。任何输入 hash 漂移都使旧证据失效。最终只报告实际文件、命令、结果、未验证项、风险和可重放 receipt/patch bundle；未经 owner 明确要求，不 stage/commit/push/restart/live/deploy。
```

## 接线边界

当前协议和工具只存在于独立 clone。当前 checkpoint/bundle 明确为 `productionReady:false` 的 candidate；另一窗口交付权威 checkpoint 前，不修改 `package.json`、hooks、CI、主仓规则文件或其正在开发的核心模块。接线时由唯一 integrator 复核、绑定主仓 canonical `NoeSourceDigest`，并在最新基线上重跑全部适用门禁。
