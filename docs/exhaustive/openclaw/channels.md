# OpenClaw src/channels (M3补全)

# OpenClaw `src/channels/` 逐文件分析 + Noe 优化建议

> 范围:`account-snapshot-fields.ts` / `allowlists/resolve-utils.ts` / `ack-reactions.ts` / `allowlist-match.ts` / `account-inspection.ts` / `account-summary.ts` / `allow-from.ts`
> 视角:本地优先 AI 助手 Noe(consensus/自我进化/freedom 发布链/记忆 FTS+焦点栈/治理/四档路由),目标是**改造这套 channel 抽象的弱点**而非重写它。

---

## 1. `account-snapshot-fields.ts` — 凭据脱敏投影层

### 职责
运行时账户对象 → 公开快照的**再脱敏边界**。负责从 raw account record 抽取 `*Source / *Status` 元数据,过滤掉 `token / secret` 等凭据本体,供 CLI / status API / plugin SDK 读取。

### 关键机制
- **CREDENTIAL_STATUS_KEYS 常量枚举**(5 个键):`tokenStatus / botTokenStatus / appTokenStatus / signingSecretStatus / userTokenStatus`,凭据"是否有 + 是否可解"用三态(`available / configured_unavailable / missing`)表达,这是 OpenClaw 自己的 enum,不是布尔。
- **三层推断函数**:
  - `resolveConfiguredFromCredentialStatuses` (L64-82):任一状态非 missing 即 true,适合"任何凭据都能跑"的通道。
  - `resolveConfiguredFromRequiredCredentialStatuses` (L88-104):只在 required key 集合内求 AND,适合"多凭据缺一不可"的通道。
  - `hasConfiguredUnavailableCredentialStatus` (L110-119):专用于"已配但本进程拿不到"的诊断分支。
- **统一读取器家族**:`readBoolean / readNumber / readNullableNumber / readStringArray / readCredentialStatus`,所有读取都先过 `isRecord` 守卫,失败返回 `undefined`。
- **投影层** `projectCredentialSnapshotFields`:返回 `Pick<Partial<ChannelAccountSnapshot>, ...>`,TypeScript 层面就只暴露 9 个字段,这是**类型系统当防火墙**的典型用法。
- 配合 `stripUrlUserInfo`(L5)做 URL 凭据脱敏,处理 `https://bot:xxx@api.x` 这种藏在 URL 里的密码。

### Noe 优化/改进点
1. **缺审计追踪,凭据访问可观测性为零**。`hasResolvedCredentialValue` 被任何 SDK 调用者调用都不会留痕,Noe 应在焦点栈里插入"敏感字段访问事件",经治理档路由到本地 audit log,**不联网、可脱敏导出**。
2. **三态字符串到处硬编码**。`"available" | "configured_unavailable" | "missing"` 在 5 处用裸字符串,枚举演进不向后兼容。Noe 改造:抽 `CredentialStatus` const + `asCredentialStatus()` 守卫,自我进化模块可自动 lint 新增 status 字符串。
3. **类型投影与运行时不联动**。`projectCredentialSnapshotFields` 编译期保证只返回 9 个字段,但如果 `ChannelAccountSnapshot` 新增了字段(比如 `webhookUrl`),`Pick<...>` 必须手动改。Noe 改造:用 `Omit<ChannelAccountSnapshot, "secret" | "token">` + 动态禁字段黑名单,黑名单由治理模块管理(发布链中可提案修改)。
4. **`readStringArray` 丢失类型**:`value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : ""))`,数字被静默接受再 normalize,容易把 `123` 误当 string。Noe 应改成"先 string-ify 抛错"或"显式 narrow"。
5. **没有字段访问限频**。CLI `status` 命令一秒钟调 1000 次这个投影,每次都走 5 个 key 循环 + 5 个 raw credential 字段扫描。Noe 的**记忆 FTS 缓存层**可加 `projectCredentialSnapshotFields` 结果的 short-TTL 缓存,key = `(accountId, configVersion)`。
6. **`stripUrlUserInfo` 只处理一个字段,实际上 `token` / `appToken` / `signingSecret` 这些字符串本身**也可能在某些 channel 里被误填成 URL(`mongodb://...`),Noe 应把所有字符串字段过一遍 URL 检测,匹配上就走 userinfo 脱敏。

---

## 2. `allowlists/resolve-utils.ts` — 允许列表解析与规范化

### 职责
Allowlist 解析工具:**去重 + 解析后映射**。把用户输入的 `allowFrom`(可能是 name / @username / 数字 ID)合并成最终运行用的规范化 ID 列表。

### 关键机制
- **`dedupeAllowlistEntries`** (L19-33):trim + 小写归一化 + Set,保序,**第一出现胜出**(不后置覆盖)。这是正确选择 — 用户期望"先写的赢"。
- **`mapAllowFromEntries`**:来自 `openclaw/plugin-sdk/channel-config-helpers`,是跨 channel 的统一规范化器(把数字 / 字符串统一成 string)。
- **`buildAllowlistResolutionSummary`** (L46-67):把解析结果拆 3 桶:
  - `resolvedMap`:`input → T`,供后续 lookup
  - `mapping`:`formatResolved` 字符串,诊断输出
  - `unresolved`:解析失败的原文,需要人类修
  - `additions`:仅 ID,供配置写回
- **`canonicalizeAllowlistWithResolvedIds`** (L92-115):用 canonical ID 替换原文,**保留 `*` 通配**(L105-107 注释明确说"wildcard 是策略值,不是 lookup target",非常关键)。
- **`patchAllowlistUsersInConfigEntries`**:支持 `merge` / `canonicalize` 两种策略,`merge` 保留原文+追加 ID,`canonicalize` 只留 ID。

### Noe 优化/改进点
1. **小写归一化对非拉丁 ID 不安全**。`normalizeLowercaseStringOrEmpty` 用 `toLowerCase()`,在 `tr / de / az` 等有 `İ / I / ı` 区分的语言里会碰撞。Noe 改造:用 NFKC + locale-safe lowercase(`@openclaw/normalization-core` 可以扩展),并对带非 ASCII 的 ID 走**严格匹配路径**(焦点栈里登记"歧义 ID"待人工核实)。
2. **`mergeAllowlist` 与 `canonicalizeAllowlistWithResolvedIds` 都用 `dedupeAllowlistEntries`,但语义不同**:merge 后 ID 和原文可能并存(被 Set 去重),canonicalize 后只剩 ID。Noe 的**自我进化模块**应通过 property test 验证两种策略的"幂等性 + 不丢配置项"不变量。
3. **`resolveAllowlistIdAdditions` 内部再做了一次小写归一化逻辑(隐含)**,而 `canonicalize` 内部用 `normalizeOptionalString` 保留大小写。两条路径归一化规则不一致,Noe 应抽出"统一 trim + case-fold"工具,供两个函数共用。
4. **无容量上限,允许列表暴增时 OOM**。`Map` / `Set` 不限,恶意插件可以塞 100 万条。Noe 改造:加 `MAX_ALLOWLIST_SIZE = 10_000`,超限触发**治理事件**(需本地管理员确认)。
5. **没有 `*` 的 source 标记**。当一个账号从某 channel 撤销时,`canonicalize` 会把它从配置中**完全删除**(因为 `resolved?.resolved && resolved.id` 走 false 分支),没有 tombstone。Noe 改造:加 `unresolved` 永远保留配置项,只在 `canonicalize` 模式下**显式标记 `unresolved=true`**,用 `// 注释行` 写回配置文件,freedom 发布链可据此回滚。
6. **解析快照无 TTL**:解析后 ID 长期有效,但用户可能改名 / 退群。Noe 应在记忆 FTS 里给"用户 ID 解析记录"加 `resolvedAt` + 30 天 TTL,过期后**自动降级到 unresolved**。

---

## 3. `ack-reactions.ts` — 通道级 ack 表情回执策略

### 职责
控制"哪些入站消息应该回一个表情"(`👀 / 👍`),以及"回复送达后怎么清理"。跨 channel 共享的状态机。

### 关键机制
- **`AckReactionScope` 6 态枚举**:`all / direct / group-all / group-mentions / off / none`,注意 `off` 和 `none` 都被识别为关闭(冗余但向后兼容)。
- **`shouldAckReaction` 通用 gate** (L41-67):6 路分支,`group-mentions` 模式有 3 个先决条件(`isMentionableGroup / requireMention / canDetectMention`),全部满足后才看 `effectiveWasMentioned` 或 `shouldBypassMention`。
- **`shouldAckReactionForWhatsApp` 复用通用路径** (L74-93):把 WhatsApp 的 `mentions` 模式**翻译成通用 `group-mentions` 参数**,这是漂亮的桥接模式,保证两个 channel 的"activation bypass"语义同步。
- **`createAckReactionHandle`** (L108-138):eager send + Promise wrapping,**同步抛错转异步 reject**(L125-128),调用方用统一的 `ackReactionPromise: Promise<boolean>` 即可,不关心 send 是 sync throw 还是 async reject。
- **`removeAckReactionAfterReply`** (L145-165):只在 `removeAfterReply && ackReactionPromise && ackReactionValue` 三个条件全真时清理,且**只在 send 成功时才 remove**(L156-159,失败不调用 `remove()` 避免 API 限频错误)。

### Noe 优化/改进点
1. **`params.remove()` 无超时**。channel API 卡死时,`removeAckReactionAfterReply` 永远不会 resolve,内存里堆积挂起 Promise。Noe 改造:加 `removeTimeoutMs = 5_000`,超时后强制 resolve 并发治理告警。
2. **没有重试**。Slack / Discord 的 `reactions.add` 第一次失败(限频 429)后,这里直接放弃,用户看不到 👀。Noe 改造:加指数退避重试(2 次),与 Noe 四档路由的**网络质量档**联动(网络差时延更长重试)。
3. **ack reaction 链路无 tracing**。send / remove 都没带 `requestId`,日志里看不到"哪个 messageId 的 ack 走了哪条路径"。Noe 改造:`createAckReactionHandle` 接受 `traceId` 参数,内部挂在 Promise 上,`remove()` 日志携带相同 traceId。
4. **状态机是硬编码 if-else**,新增 scope 要改 4 处(general / WhatsApp / 注释 / 类型)。Noe 改造:把 scope 解析抽成查表 `SCOPE_TABLE: Record<Scope, (ctx) => boolean>`,自我进化模块可自动生成测试覆盖矩阵。
5. **没有优先级控制**。同时有 100 条消息入站,`createAckReactionHandle` 会立刻并发 100 个 `send()`,channel API 限频会把所有都打回。Noe 改造:接 Noe **四档路由的低优先级档**,对 ack reaction 做 token-bucket 限流(每秒 5 次)。
6. **`shouldBypassMention` 只在 group-mentions 路径检查**(L65-66),但其他 channel 可能也想要 bypass,没有抽象。Noe 改造:把 bypass 提到通用 gate 顶层,让所有 mention-requiring 路径共享。

---

## 4. `allowlist-match.ts` — 允许列表匹配原语

### 职责
**编译 + 匹配**层。把原始 `allowFrom` 数组编译成 `CompiledAllowlist`(`Set` + `wildcard` flag),然后对一组 candidate 做线性扫描匹配。

### 关键机制
- **`compileAllowlist`** (L41-46):O(n) 一次扫描,产出 `{ set, wildcard: set.has("*") }`。`Set.has` 是 O(1) lookup。
- **`compileSimpleAllowlist`** (L48-55):旧式接口,把 `string | number` 全部 `String()` + 小写,过滤空值。
- **`resolveAllowlistCandidates`** (L57-72):**顺序敏感**的 candidate 匹配,第一个命中的胜出,带 `matchKey / matchSource` 元数据 — 多个 source 的优先级是"candidates 数组顺序"。
- **`resolveCompiledAllowlistMatch`** (L78-90):先做"empty list → false"、"wildcard → true"两个快路径,再走 candidate 匹配。
- **`resolveAllowlistMatchSimple`** (L102-126):legacy 路径,支持 `allowNameMatching` 选项(注意 L117 用 `satisfies` 强制类型,这是好实践)。
- **match 元数据**:`formatAllowlistMatchMeta` 输出 `matchKey=xxx matchSource=xxx`,供 status / 日志使用。

### Noe 优化/改进点
1. **`Set.has` 只能精确匹配,前缀匹配没索引**。当 `allowFrom` 含大量 `prefixed-id:xxx` 模式时,每次匹配 O(n)。Noe 改造:为 `prefixed-*` 模式建**trie**,prefixed 走 trie 精确前缀扫描,把 `matchSource` 仍标为 `prefixed-id` / `prefixed-name`。
2. **`allowNameMatching` 容易误判**。`senderName` 是用户可改的,重名攻击 / 改名逃逸都可能绕过。Noe 改造:硬性要求"displayName + ID"双因素匹配,单一 name 命中**只记 `matchKey=name` 不算 allowed**。治理模块可配置为严格模式。
3. **candidate 顺序隐式编码优先级,但没文档化**。`{ value: senderId, source: "id" }, { value: senderName, source: "name" }` 的顺序决定哪个优先。Noe 改造:把 candidate 顺序抽成 `MATCH_PRIORITY: Source[]`,自我进化时跑 property test 验证优先级不变。
4. **没有 match sampling**。诊断日志里 `formatAllowlistMatchMeta` 在每次匹配都拼字符串,高频匹配时 GC 压力。Noe 改造:在 1% 采样率下打 match metadata,采样配置由治理模块控制。
5. **`compileAllowlist` 重复调用**。每个 inbound message 都 `compileSimpleAllowlist(allowFrom)`,但 `allowFrom` 一年不变。Noe 改造:在**记忆 FTS 里缓存 compiled allowlist**,key = `(channelId, accountId, configHash)`,配置变更时失效。
6. **`wildcard` 优先级硬编码**:先 `empty → false`,再 `wildcard → true`,再 candidate。如果用户写 `["*", "user1"]` 会全部放行(通配优先),`["user1", "*"]` 也是全部放行(通配先匹配),但 `["user1"]` 不放行 `user2` — 行为正确,但**没显式断言**。Noe 改造:加 invariant test 跑 16 种组合,自我进化模块纳入回归基线。

---

## 5. `account-inspection.ts` — 通道账户检查编排

### 职责
**编排层**:组合 plugin hook、read-only fallback、凭据状态三路信息源,产出 `{ account, enabled, configured }` 三元组。

### 关键机制
- **`inspectChannelAccount`** (L29-39):`plugin.config.inspectAccount ?? inspectReadOnlyChannelAccount` 链式 fallback,前者优先级高。
- **`resolveInspectedChannelAccount`** (L48-87):
  - **双重 inspection**:`sourceInspectedAccount`(源 config)和 `resolvedInspectedAccount`(已解析 config)分别查一次。
  - **`useSourceUnavailableAccount` 智能选择**(L57-62):当 source 检测出 `configured_unavailable` 而本进程 `hasResolvedCredentialValue = false` 时,**回退到 source snapshot**。注释 L55-56 写得很清楚:"status can distinguish 'configured' from 'missing'"。
  - 三态决策:`enabled` 和 `configured` 各自 fallback — `selectedInspection?.enabled ?? resolveChannelAccountEnabled(...)`。
- **错误沉默**:所有异步 inspection 失败时不会 reject,直接走 fallback(L28 `??`)。

### Noe 优化/改进点
1. **没有 circuit breaker**。一个慢 plugin 的 `inspectAccount` 卡 30s,会让整个 status 端点 timeout。Noe 改造:为每个 plugin 加熔断器(3 次失败 → 60s 直接 fallback),治理模块可调阈值。
2. **双重 inspection 串行,无缓存**。每次 `openclaw status` 都跑 `source + resolved` 两遍。Noe 改造:用**记忆 FTS** 缓存 `(pluginId, accountId, configHash) → { source, resolved }`,configHash 变更时失效。
3. **`useSourceUnavailableAccount` 是 4 个 boolean AND,逻辑嵌套深**。Noe 改造:抽成纯函数 `pickSnapshotForStatus({ source, resolved, sourceHasUnavailable, resolvedHasValue, sourceConfiguredFlag, resolvedConfiguredFlag }) → 'source' | 'resolved'`,自我进化模块可对该函数做 property test。
4. **没有超时**。`plugin.config.inspectAccount` 可能是网络调用(查 bot info),没超时控制。Noe 改造:套 `Promise.race([inspectAccount, timeout(5000)])`,超时发治理告警。
5. **错误聚合缺失**。批量 status 查询(100 个账号)时,一个失败会让外层 catch 吞掉整批。Noe 改造:改成 `Promise.allSettled`,错误单独收集,freedom 发布链可据此发"plugin 健康度"事件。
6. **类型断言滥用**:`as AccountInspectionFields`(L52-53)是 unsafe cast,如果 plugin 返回 `null` / `undefined` 都能"通过"。Noe 改造:用 `isAccountInspectionFields` type guard 替代。

---

## 6. `account-summary.ts` — 通道账户快照构建

### 职责
**输出层**:把 `account` + `cfg` + `plugin` 组合成 `ChannelAccountSnapshot`,供 CLI / gateway / status 渲染。**安全性的最后一道门**。

### 关键机制
- **`buildChannelAccountSnapshot`** (L19-32):
  1. 调 `plugin.config.describeAccount(account, cfg)` 让 plugin 自己描述
  2. **然后**调 `projectSafeChannelAccountSnapshotFields(account)` 投影安全字段
  3. spread 顺序: `{ enabled, configured, ...projected, ...described, accountId }`
  4. **风险点**:`described` 在 projected 之后,如果 plugin 的 describe 返回 secret 字段(误用),spread 顺序会让 `described` 覆盖(不会,这里 spread 顺序是 later-wins,**`...described` 是最后写**)
- **`formatChannelAllowFrom`** (L40-51):委托给 `plugin.config.formatAllowFrom`,无则用通用 `normalizeStringEntries`。
- **`resolveChannelAccountEnabled`** (L57-65):`plugin.isEnabled ?? (account?.enabled !== false)`。**`!== false` 语义**意味着 undefined 视为 enabled。
- **`resolveChannelAccountConfigured`** (L70-86):`plugin.isConfigured ?? (readAccountConfiguredField ? account.configured !== false : true)`。**`readAccountConfiguredField = false` 时,任何 account 都算 configured**,这是"非 status 路径别读这个字段"的优化。

### Noe 优化/改进点
1. **spread 顺序是 later-wins,但注释里没说**。`buildChannelAccountSnapshot` 把 `...described` 放在 `...projected` 之后,**plugin describe 的字段会覆盖投影层**。如果 plugin 写了一个新 secret 字段(没在投影黑名单里),它就泄漏到 snapshot。Noe 改造:把 `...described` 移到 `...projected` 之前,并加 runtime 断言"described 不包含 forbidden keys"。治理模块可配置黑名单。
2. **没有 snapshot schema 校验**。返回的 `ChannelAccountSnapshot` 没有 `validate` 步,如果 plugin describe 返回畸形对象(循环引用 / Symbol),下游 JSON.stringify 爆炸。Noe 改造:在 `buildChannelAccountSnapshot` 末尾过 `safeStringify` 或 JSON schema 验证。
3. **`resolveChannelAccountConfigured` 的 `readAccountConfiguredField` 标志是 leaky abstraction**。调用方要"知道"这个 flag,才能正确决定"我是不是在 status 路径"。Noe 改造:把 status 路径抽成 `buildStatusSnapshot()` / `buildRuntimeSnapshot()` 两个函数,内部各管各的 fallback,flag 消失。
4. **enabled 同步 / configured 异步 不对称**。`resolveChannelAccountEnabled` 是 sync(可能阻塞 IO,如果 plugin `isEnabled` 里有 IO),`resolveChannelAccountConfigured` 是 async。Noe 改造:统一 async,并允许 plugin 声明"I/O 密度",让四档路由决定走本地 cache 还是直接调。
5. **`describeAccount` 的输出没有任何防护**。plugin 可以返回任意对象,即使 plugin 是 trusted 的,版本升级时也可能引入新字段。Noe 改造:把 `describeAccount` 输出过 `pick(safeKeys)` 投影,安全字段白名单由治理模块维护(freedom 发布链可提案修改白名单)。
6. **`!== false` 默认 enabled 是沉默的**。新写 plugin 的人不会想到"我不显式 set enabled 字段就是 enabled"。Noe 改造:加 warning log 当 `enabled === undefined`,自我进化模块可把这条 warning 升级为 lint error。

---

## 7. `allow-from.ts` — 通道 allowFrom 策略

### 职责
**DM / group 允许列表合并** + `accessGroup:` 命名空间解析。channel 插件最常用的策略入口。

### 关键机制
- **`ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:"`** (L9):字符串前缀标记,让 `allowFrom` 同时支持"用户 ID"和"访问组名"两种引用。
- **`parseAccessGroupAllowFromEntry`** (L17-25):trim + 切片 + 二次 trim,空 name 返 null。
- **`mergeDmAllowFromSources`** (L31-40):DM 策略感知 — `dmPolicy === "allowlist" || "open"` 时**忽略** `storeAllowFrom`(配对存储),其它策略合并。这是关键安全决策:open / allowlist 模式下不读存储,避免存储里的过期 ID 误放行。
- **`resolveGroupAllowFromSources`** (L46-58):group 优先,fallback 到 DM,**`fallbackToAllowFrom === false` 时返空**(不给 group 用 DM 列表)。
- **`firstDefined`** (L64-69):**保留 falsy 值**(`false / 0 / ""`)vs undefined 的区分 — 这是替代 `??` 的工具,因为 `??` 也会把 `null` 当"无值"。
- **`isSenderIdAllowed`** (L75-85):三态决策:`!hasEntries → allowWhenEmpty` / `hasWildcard → true` / 否则精确 `entries.includes(senderId)`。

### Noe 优化/改进点
1. **`ACCESS_GROUP_ALLOW_FROM_PREFIX` 是字符串前缀,易冲突**。如果用户 ID 真的以 `accessGroup:` 开头(虽然概率低),会被误判。Noe 改造:改用结构化 `{ kind: "accessGroup", name }` 对象,而非字符串前缀,持久化时再序列化为 `accessGroup:...`。
2. **`dmPolicy` 字符串硬编码**(`"allowlist" | "open"`),没有类型保护,新加 `dmPolicy = "restricted"` 时这里不会编译报错。Noe 改造:把 `dmPolicy` 类型提到 `@openclaw/normalization-core` 的 union type,所有 channel 共用。
3. **`firstDefined` 和原生 `??` 行为差异不明显**。`??` 把 `null` / `undefined` 当"无",`firstDefined` 只把 `undefined` 当"无"。`null` 经常表示"显式置空",保留它是对的,但**没注释**说明这一点。Noe 改造:加 jsdoc + 自我进化模块对该函数跑 property test。
4. **`isSenderIdAllowed` 的 `allowWhenEmpty` 参数语义不清晰**。`allowWhenEmpty: true` 和 `hasEntries: false` 同时为真时返 true,意味着"未配置时放行" — 这是 open policy 的行为,但**没人阻止**你把 `allowWhenEmpty: true` 和具体 allowlist 混用。Noe 改造:加 invariant:`hasEntries && allowWhenEmpty` 同时为真时发治理告警(可能配置错)。
5. **`mergeDmAllowFromSources` 没有去重**。`normalizeStringEntries` 去重了,但 `storeAllowFrom` 里的过期 ID 不会和 `allowFrom` 配对去重 — 同一用户配了 ID 又配了 username,两条都进 allowlist。Noe 改造:在 `merge` 阶段做 `dedupeAllowlistEntries`(复用 resolve-utils 的工具)。
6. **`resolveGroupAllowFromSources` 静默吞错**。`groupAllowFrom` 配置错误时(非数组),用 `Array.isArray && length > 0` 守卫,fallback 到 `allowFrom`。Noe 改造:对 `groupAllowFrom` 类型错误发治理告警,不要 silent fallback。

---

## 整体架构观察(Noe 视角)

| 维度 | OpenClaw 现状 | Noe 改造方向 |
|---|---|---|
| **凭据脱敏** | 类型层 + 字符串黑名单 | 焦点栈审计 + 治理模块维护的动态黑名单,freedom 发布链可提案 |
| **allowlist 解析** | 内存 Set / Map,无 TTL | 记忆 FTS 持久化,带 TTL 和 resolve-at 时间戳 |
| **plugin 可观测性** | 失败静默 fallback | 治理模块收集 failure 计数,触发熔断 + 告警 |
| **snapshot 安全** | spread 顺序隐式安全 | 白名单 + runtime assertion,plugin describe 输出过投影 |
| **状态机扩展** | 硬编码 if-else | 查表 + 自我进化的 property test 矩阵 |
| **网络调用** | 无超时 / 无重试 | 四档路由感知网络质量,自动选档 + 退避策略 |
| **跨 channel 一致性** | `mapAllowFromEntries` / `shouldAckReaction` 显式桥接 | 抽象到 `@openclaw/normalization-core` + consensus 多模型自动跑一致性 diff |

**优先级建议**(Noe 自我进化路线图):
1. 🔴 **P0**:为 `account-snapshot-fields` 加审计 + 投影白名单(安全影响最大)
2. 🟠 **P1**:为 `account-inspection` 加超时 + 熔断(可观测性)
3. 🟡 **P2**:为 `allowlist-match` 加 trie 前缀索引(性能,大量 prefix-* 模式时)
4. 🟢 **P3**:把状态机(`ack-reactions` / `allow-from`)从 if-else 重构成查表(可维护性)

每条改造都可以走 Noe 的 **freedom 发布链**:本地多模型 consensus 跑回归 → 治理模块审核 → 焦点栈验证 → 自我进化模块纳入 invariant 库。