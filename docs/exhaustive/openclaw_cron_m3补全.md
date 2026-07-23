# M3 补全分析 openclaw_cron

# OpenClaw 定时任务 / 隔离 Agent 调度 —— Noe 可借鉴点逐文件分析

下面六个文件全在 `openclaw/src/cron/`，构成一条完整的"定时调度 → 命令执行 → 投递路由 → 预览/校验 → 活跃跟踪"的流水线。每节按 **职责 → 关键机制 → Noe 可优化/改进/完善的点** 三段式展开，所有改进点都绑定到 Noe 现有能力（consensus、自我进化、freedom 发布链、MemoryCore/FTS/FocusStack/知识图谱、治理审批审计、四档模型路由、语音视觉）。

---

## 1. `delivery-plan.ts`（8499 B）

### 职责
把 cron job 的 `delivery` 字段（`mode/channel/to/threadId/accountId`）和失败通知目的地 `failureDestination`，从"用户写的原始配置"归一化成"运行时可执行的投递计划"，输出两个核心 plan：`CronDeliveryPlan`（主投递）和 `CronFailureDeliveryPlan`（失败回退）。

### 关键机制
1. **`mode` 别名归一化**：CLI 历史词 `deliver` 在运行时统一映射成 `announce`，保留向后兼容（`deliver → announce → webhook → none → undefined` 链式判定）。
2. **channel 前缀反推**：当 `channel` 缺省或为 `last`，但 `to` 形如 `slack:C123` 时，自动反推 `channel="slack"`——避免用户写一遍前缀又要再写一遍 channel。
3. **跨模式目标失效**：job-level 把全局默认的 `to` 带入 webhook 模式会污染语义（聊天地址 ≠ URL），所以 `mode` 从 announce 切到 webhook 时主动清空 `to`。
4. **detached output job 默认 announce**：`sessionTarget` 为 `isolated / current / session:*` 的 `agentTurn/command` 任务，若没显式配置投递，默认 `announce` 让结果回到发起会话。
5. **分层合并的"显式声明 vs 隐式未传"区分**：用 `hasJobChannelField = 'channel' in jobFailureDest` 这种 `hasOwnProperty` 检测，让"显式置 undefined 清空"和"完全没声明 → 继承全局"行为分开。

### Noe 可优化/改进/完善的点
1. **Noe 的 "freedom 社交发布链"目前若没拆"投递计划层"，加定时/延迟发布会牵一发动全身。** 建议直接把 cron delivery plan 的 `mode ∈ {announce, webhook, none}` 抽到 Noe 的发布 dispatcher，让"内容生成"和"目的地路由"解耦——未来加"定时朋友圈 / 定时邮件 / 定时 Discord webhook"不需要改核心。
2. **Noe 的"治理/审批/审计"目前缺 dry-run 预览面板。** 审批前用同一套 `resolveCronDeliveryPlan` + 配套的 `resolveDeliveryTarget({dryRun:true})`（见文件 3），把"实际会发到 X 频道/收件人，失败会回退到 Y"渲染到审批卡上，降低误操作。
3. **`deliver → announce` 别名模式**值得 Noe 学：四档模型路由当前若存在历史命名（如 `quick → fast`），CLI/API 兼容层用 schema transform 强迁比 deprecation 友好。
4. **`sessionTarget` 的 isolated/current/session:* 三态** 启发 Noe 的 FocusStack：当前任务执行上下文（"在和 Alice 对话时开的 / 独立后台跑 / 绑定到某个 memory session"）做成一样的三元，self-evolution 闭环跑后台任务就能决定"产出回到哪"。
5. **`'channel' in jobFailureDest` 区分"显式 undefined"和"未声明"**：Noe 的治理配置覆盖层（job-level 覆盖 global）若遇到"取消这个审批人"语义，现在通常用 `null/undefined` 混用导致歧义，建议学此文件用 `hasOwnProperty` 检测显式声明来区分"清空"和"继承"。

---

## 2. `command-runner.ts`（5516 B）

### 职责
跑 cron 的 `command` 类型负载（不启动 agent/model，只执行 shell 命令），返回结构化的 `CronRunOutcome` + `CronRunDiagnostics`。是 OpenClaw 调度器里"非 AI 任务"那一支的执行器。

### 关键机制
1. **双超时**：`timeoutSeconds`（总时长，默认 10 min）+ `noOutputTimeoutSeconds`（无输出时长）。后者 0 表示"实际无限大"，落到 `EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647`（~24.8 天），**不是 0**——避免 `setTimeout` 把 0 当作立即触发。
2. **`killProcessTree: true`**：用进程树杀避免 shell fork 出孙子进程后泄漏，Windows 上尤其关键（PowerShell/cmd 起的子进程经常脱离父进程）。
3. **退出语义枚举化**：`status ∈ {ok, error, skipped}`，终止原因细分 `timeout | no-output-timeout | signal | exitcode`，每种有对应 human 消息。
4. **结构化诊断条目**：`{ ts, source:"exec", severity, message, exitCode, signal, truncated }`，UI 可以直接渲染时间线。
5. **输出截断元数据**：单独记录 `stdoutTruncatedBytes / stderrTruncatedBytes`，审计能知道这次输出是不是被截了，避免"看上去成功但其实只跑了前 1MB"。

### Noe 可优化/改进/完善的点
1. **Noe 是 Electron，主进程 spawn 子进程做"自我进化闭环"或"知识图谱重建"时**，目前若直接 `child_process.spawn`，Windows 上 `node → 子 node → git` 会形成孤儿进程，关 Noe 后还残留。建议 Noe 复用 OpenClaw 的 `runCommandWithTimeout` + `killProcessTree:true` 封装所有管理脚本入口（`./scripts/regen-kg.js`、`./scripts/memory-rebuild.js` 等）。
2. **双超时机制（总时长 + 无输出时长）** Noe 缺。Self-evolution 闭环跑"反思 → 优化 prompt → 重新索引"这种长任务时，单独"无输出"超时能发现"模型卡死"而非"单纯慢"——建议给 Noe 的后台 agent loop 加 `noOutputTimeoutMs`，触发后强制 kill 当前回合并写 audit。
3. **`EFFECTIVELY_UNBOUNDED_TIMEOUT_MS = 2_147_483_647` 的细节** 是 OpenClaw 的隐藏坑修复：Node `setTimeout` 实际接受的最大值约为 2³¹-1 ms（~24.8 天），超出会被 clamp 成 1 ms。Noe 在"用户配置里说永不超时"时也应该硬编码到 `Int32_MAX`，而不是传 0 或 Infinity。
4. **结构化 `diagnostics.entries[]`**：Noe 的 MemoryCore 审计日志目前若是自由文本，建议改成这种数组结构（每条带 `ts/source/severity/truncated/exitCode`），UI 渲染时间线和聚合都方便，且 FTS 索引能精确定位 "exitCode != 0 的条目"。
5. **`buildCommandSummary` 的 stdout+stderr 拼接**：Noe 如果让用户配的 shell 命令跑 self-evolution（比如 `git pull && npm run rebuild`），失败时把 stdout/stderr 分别落库就能用 MemoryCore 的 FTS 搜"上一次失败的错误信息"——比纯自由文本检索准得多。
6. **`signal:${params.signal}` 这种把 signal 名序列化成 toolName 字段**：Noe 审计可以借用，让"被 SIGTERM / SIGKILL 杀掉的"和"exit code 1"在聚合查询时能用同一个 string field 区分。

---

## 3. `delivery-preview.ts`（3912 B）

### 职责
纯前端用，dry-run 构造 cron 投递的展示卡片 `{label, detail}`，**不真发消息**，但调用完整的目标解析（包括 `dryRun:true` 的 channel router），让 UI 看到的失败路径与运行时一致。

### 关键机制
1. **完整复用运行时路径**：`resolveCronDeliveryPreview` 内部调用 `resolveDeliveryTarget(..., {dryRun:true})`，UI 上看到的"无路由"和运行时"无路由 → fail-closed" 行为一致——**关键是不另写一套解析**。
2. **webhook 模式特殊处理**：不解析 channel 目标，只展示 `webhook:URL`，因为 webhook 投递不需要 channel router，强行走路由器只会引入伪失败。
3. **失败-封闭语义显式化**：`"last -> no route, will fail-closed: <err>"` 直接告诉用户"这次会失败"，而不是运行时静默扔掉。
4. **并行批量**：`resolveCronDeliveryPreviews` 用 `Promise.all` 同时解析所有 job 的 preview，避免 cron 列表渲染时串行 await 卡 UI。

### Noe 可优化/改进/完善的点
1. **Noe 治理/审批面板可以加"动作预览"层**：现在审批通常是"批准 / 拒绝"两按钮，但没人知道批准后会发生什么。借鉴 `resolveCronDeliveryPreview`，每次审批动作前 dry-run 一次"实际执行计划"（"会发到 #ops 频道"、"会读 3 个 MemoryCore 表"、"会调用 self-evolution.run()"），UI 直接渲染到审批卡上。
2. **`dryRun` 标记贯穿整条管道**：OpenClaw 把 `dryRun:true` 传给 `resolveDeliveryTarget`，让底层路由也走 dry-run 模式（不真连 channel）。Noe 的 freedom 发布链也建议加 `dryRun` 穿透参数，从 `cron → dispatch → publish` 一路透传，避免预览和运行时不一致。
3. **`formatDeliveryDetail` 区分 `last / 显式 / 失败`**：Noe 的"焦点 stack 当前会话"可以做成类似 UI 描述——"消息将发到当前焦点会话（用户 Alice 的桌面端）"或"目标已显式锁定为 iPad，会忽略焦点"，比纯 ID 直观得多。
4. **`Promise.all` 并行预览** 是基础但 Noe 多个 cron 面板一次渲染时若串行 `await` 会卡——直接套这个模式。
5. **fail-closed 文案**："will fail-closed" 这套语义 Noe 治理层可以用——所有"无路由 / 无权限 / 无审批人"路径都让用户/审计看到"这条不会真跑"，而不是返回成功。
6. **`Promise.all + Object.fromEntries(entries)` 的批量映射** Noe 的 MemoryCore 批量 recall、Knowledge Graph 批量节点查询都可以套用同一模式，比 `for...of + await` 快得多。

---

## 4. `delivery-field-schemas.ts`（2514 B）

### 职责
把用户输入（CLI 参数 / API body / 配置文件）通过 Zod 解析、归一化成窄类型运行时值。是 OpenClaw 整个 cron 子系统的"输入卫生层"。

### 关键机制
1. **`preprocess` 链**：先 `trim → lowercase` 再校验，让 `"SLACK"`、`"  slack "`、`" Slack "` 三种写法都通过——这是 Zod 用户常忽略的"输入卫生"层。
2. **`parseOptionalField` 宽容策略**：`schema.safeParse(value)` 失败时返回 `undefined`，**不抛错**。让"字段如果合法就用，不合法就当没设"成为默认行为，避免单字段错导致整个 job 创建失败。
3. **`DeliveryThreadIdFieldSchema = union(string, number)`**：thread id 跨平台（Slack 字符串 / Discord 数字 / Telegram 数字）用 union 收，运行时按 channel 分发时再判类型。
4. **`TimeoutSecondsFieldSchema = number().finite().nonnegative()`**：`Infinity`、`NaN`、`-1` 一律拒，避免配置文件里一个错值把整个 cron 搞死。
5. **`mode` 别名 transform（`deliver → announce`）**：在 schema 层做兼容转换，不污染调用点。

### Noe 可优化/改进/完善的点
1. **Noe 的"治理配置"和"用户配置" 现在若用裸 Zod 直接 `.parse()`，单个字段错会让整个配置加载失败。** 直接把 `parseOptionalField` 模式套到 Noe 的 config schema：用户配错一项不影响其他项启动，只是相关功能降级；配套日志里写"字段 X 值 Y 非法，已忽略"。
2. **`preprocess(trim → lowercase)` 的字段 schema 工厂**：Noe 现在若 channel 名称、agent id、tag、记忆标签等自由文本字段各写一遍 preprocess，会重复。建议 Noe 抽出 `LowercaseNonEmptyStringFieldSchema`、`TrimmedNonEmptyStringFieldSchema`、`FiniteNonnegativeNumberFieldSchema` 三个工厂，所有 Zod 字段统一复用，行为一致。
3. **`DeliveryThreadIdFieldSchema = union(string, number)` 启发 Noe 的"消息标识跨平台"**：Noe 的 freedom 发布链如果要持久化消息 ID（用于去重 / 关联 thread），Slack/Discord/Telegram/邮件各自的 ID 类型不同，统一 union 后在 dispatcher 层按 channel 分流。
4. **`mode` 别名 transform（`deliver → announce`）**：Noe 早期命名若要改（比如模型路由档位 `quick` 改名为 `fast`），同样用 `.transform` 兼容层在 schema 层做，而不是改所有调用点。
5. **安全默认值**：`TimeoutSecondsFieldSchema.nonnegative()` 启发 Noe 的所有"用户配置的数字字段"都加 `.finite().nonnegative()`，特别 self-evolution 循环次数、consensus quorum size、memory window size 这种——避免 `"infinity"` 导致死循环。
6. **Zod 失败策略选择**：Noe 的"治理/审批"输入解析应当**严格**（`.parse()`，让审批表单缺字段就报错），而"用户自由配置"应当**宽容**（`parseOptionalField` 模式，降级而非阻断）。区分这两种语义不要混用。

---

## 5. `delivery-context.ts`（2195 B）

### 职责
把"当前活跃会话的路由信息"（live `DeliveryContext`）或"会话 key 里保存的历史路由信息"（stored）转换成 cron 投递配置。是 cron 创建时"我该往哪发"这个问题的单一入口。

### 关键机制
1. **优先级链**：`currentDeliveryContext → extractDeliveryInfo(sessionKey)`。当前会话如果还在，优先用当前的；否则从 session key 反解历史。
2. **`threadId` 强制覆盖**：从 session key 解析出来的 thread id 是 canonical，会盖掉 delivery context 里 stale 的 thread 值——避免用户换设备后老 thread 还在。
3. **null on missing `to`**：`normalizeDeliveryContext` 没 `to` 就直接返回 null，**不返回半残的 plan**——避免下游误以为"配置了但部分字段空"。

### Noe 可优化/改进/完善的点
1. **Noe 的"焦点 stack + memory session"现在切换时如果只把 `currentContext` 改了，可能丢历史。** 借鉴 `resolveCronCreationDelivery` 的"优先当前 → 退到 session key"模式：用户切到新焦点时，新会话也能 fallback 到"上次对话的 channel/thread"，freedom 发布链据此选目标。
2. **`threadId` canonical 覆盖**：Noe 多端同步（Electron 桌面 + 移动 + web）时，若用户在桌面开 thread 后切到手机，MemoryCore 里人物卡/对话记录的 `threadId` 应以新设备的 canonical 为准——目前 Noe 如果保留老 threadId，会出现"上下文接不上"问题。建议在 `resolveCronCreationDelivery` 同位置加"thread 变更检测 → 写迁移日志"，让 MemoryCore 知道"这条历史记录被重新归到新 thread 了"。
3. **`null on missing to`**：Noe 的"announce 投递计划"如果 `to` 缺失就当 null 退化成"silent failure"——比 `channel:"last"` 加个空 to 更安全。配套治理规则："任何无明确目标的 announce 一律 fail-closed，需用户补 to"。
4. **`extractDeliveryInfo(sessionKey, {cfg})` 反解路径**：Noe 的 MemoryCore session key 设计可以借鉴——把 channel/thread/accountId 编码进 key，cron 调度时反解出"这个任务最初是从哪条对话来的"，审计时能完整追溯。
5. **`cronDeliveryFromContext` 的"窄类型装配"**（只把有值的字段赋到 plan 上，避免 undefined 显式落库）：Noe 的 MemoryCore 写"对话元数据"时也应该这样——只持久化非 undefined 字段，避免数据库里一堆 `threadId: null` 占空间还干扰 FTS 索引。

---

## 6. `active-jobs.ts`（1636 B）

### 职责
进程内跟踪正在跑的 cron job id 集合，提供"防重复触发"语义。是 OpenClaw 调度器跨模块协同的关键。

### 关键机制
1. **`Symbol.for('openclaw.cron.activeJobs')` 全局单例**：用 `Symbol.for` 而不是本地 `Symbol`，跨模块重载（HMR、测试 watch）共享同一份 `Set`，避免 dev 模式下双实例各跑一份。这是比 `globalThis.__xxx__` 更不易冲突的写法。
2. **`resolveGlobalSingleton` 工厂**：第一次访问 lazy 创建，后续返回同一引用。配合 `resetCronActiveJobsForTests` 测试钩子，测试间可以显式清状态。
3. **API 极简**：`markCronJobActive / clearCronJobActive / isCronJobActive / hasActiveCronJobs`，4 个函数覆盖所有需求，没有 over-engineer。
4. **`activeJobIds` 是 `Set<string>`，job id 用稳定字符串**——不是 Object 实例或 Symbol，这样日志、审计、UI 都能用同一个字符串显示。

### Noe 可优化/改进/完善的点
1. **Noe 的 self-evolution 闭环目前若用户手动触发"立即反思" + 定时 5 分钟一次触发，可能并发跑两轮。** 直接套这个模式：定义一个全局 `Symbol.for('noe.evolution.activeJobs')` Set，每次循环开始 `markActive('self-evolve')`，结束 `clearActive`。`isActive('self-evolve')` 让定时调度器在触发前跳过——避免共识路由因同任务并发而出现"两个模型同时反思同一记忆"。
2. **Electron 主进程多窗口场景**：Noe 现在如果有多个 BrowserWindow 共享主进程，需要一个 **process-global 而不是 module-singleton** 的活跃任务集合。`resolveGlobalSingleton(Symbol.for(...))` 这种"globalThis 上的 Symbol-keyed 单例"是干净实现，比 `globalThis.__noe_state__` 那种"裸 key"更不易冲突（不同 npm 包都加 `__xxx__` 会撞）。
3. **`hasActiveCronJobs()` 这种"是否存在活跃"的快速查询** 可以加到 Noe 的"关闭前确认"流程——用户关 Electron 主窗口时若"self-evolution 跑一半"，先提示"还有 N 个后台任务未完成，是否强制退出"，比静默 kill 安全。
4. **`resetCronActiveJobsForTests`** 这种测试重置钩子 Noe 应该有：Vitest/Jest 跑并发测试时，模块状态会跨 case 泄露；通过显式 reset 函数比 `beforeEach(() => { ... })` 写散在各文件里集中，更易维护。
5. **`activeJobIds` 是 `Set<string>`，job id 用字符串**：Noe 的活跃任务标识建议统一用稳定字符串（`'self-evolve'`、`'kg-rebuild'`、`'memory-consolidate'`、`'consensus-round'`），而不是 Object 实例或 Symbol——这样日志、审计、UI 都能用同一个字符串显示，也方便 MemoryCore FTS 索引"最近一次 kg-rebuild 失败"这种查询。
6. **`markCronJobActive / clearCronJobActive` 的对称配对**：Noe 的 self-evolution / consensus round / knowledge graph 重建都应该用 `try/finally` 包裹保证 clear 一定发生——避免主进程异常时活跃集合里残留"假活跃"导致后续任务永远被跳过。建议 Noe 抽一个 `withActiveGuard(taskId, fn)` 高阶函数，统一处理。
7. **Noe 多进程架构（主进程 + 渲染进程 + utility process）** 可以扩展这个模式：`Symbol.for('noe.activeJobs')` 在每个进程内独立，但通过 IPC 同步到主进程的全局视图——这样"关 Noe 前检查所有子进程活跃任务"成为可能。

---

## 横向总结：六文件给 Noe 的一条主线建议

把六个文件的模式串起来，Noe 应当引入一条 **"任务投递 + 调度执行 + dry-run 预览 + 输入卫生 + 路由上下文 + 防重复"** 的统一基础设施（Noe 内部建议命名 `noe.task-runtime`），具体对应：

| OpenClaw 文件 | Noe 应落地的位置 | 关键收益 |
|---|---|---|
| `delivery-plan.ts` | `noe.task-runtime/plan.ts` | 把"投递路由"从"内容生成"解耦，freedom 发布链可定时化 |
| `command-runner.ts` | `noe.task-runtime/runner.ts` | self-evolution 后台任务的 Windows 进程树安全 + 双超时 |
| `delivery-preview.ts` | `noe.task-runtime/preview.ts` + 治理审批 UI | dry-run 审批，避免"批准了但实际失败" |
| `delivery-field-schemas.ts` | `noe.task-runtime/schemas.ts` | 全局输入卫生层，宽容 vs 严格两种策略区分 |
| `delivery-context.ts` | `noe.task-runtime/context.ts` | 多端同步 + 焦点切换时 threadId 规范化 |
| `active-jobs.ts` | `noe.task-runtime/active-jobs.ts` | 跨 HMR / 跨窗口的防重复，self-evolution 并发保护 |

其中 **`active-jobs.ts` + `delivery-plan.ts` 的组合** 是最高 ROI 的两个点——前者用 60 行解决并发安全，后者用单一入口解决"我要往哪发"这个语义问题，二者一起就能让 Noe 的 self-evolution + freedom 发布链 + 治理审批同时获得一致性保证。