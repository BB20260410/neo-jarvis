## P4 主动动手

> 阶段定位:把 Neo 的「动手」从「能开浏览器、能调 shell、能跑动作链」升级到「可靠地观察网页 + 在真实站点上完成多步任务 + 全程留证据 + 危险动作被安全门挡住」。
> 当前态(全部经 `cat src/` 实证,非推断):
> - `browser.*` 系列动手执行器存在且接线(`src/loop/SafeActExecutors.js:736-807`),但底层走 **JXA/AppleScript `do JavaScript` 打前台浏览器标签页**(`src/runtime/NoeFreedomAdapters.js:624-662` 的 `buildBrowserDomPageScript`),前台标签页不对即返 `browser_dom_host_mismatch`(line 662)——这就是观察成功率 ~72% 的根因(`tests/unit/noe-failure-modes-attribution.test.js:27` 实测 host mismatch 占 9 例最大簇)。已有 best-effort 复活(`SafeActExecutors.js:771-784` reopen 目标 URL 重试)但不稳。
> - **Playwright MCP 已存在但未接线到动手路径**:`scripts/noe-playwright-mcp-safe-server.mjs`(headless + isolated + `--block-service-workers` + `--allowed-hosts 127.0.0.1,localhost` + 黑名单 `browser_run_code_unsafe`)+ 注册脚本 `scripts/noe-ecosystem-mcp-register.mjs:44-52`(注册名 `playwright-local-safe`)。`@playwright/mcp@^0.0.76` + `playwright@^1.60.0` 已在 `package.json` deps。但 `createSafeActExecutors` 的 `freedomDeps` 在 `server.js:963` 传的是 **空 `{}`**,`browser.*` 仍走 JXA,**Playwright MCP 与动手执行器之间没有桥**。`McpClientManager` 只活在 `src/server/routes/mcp.js:18`(REST 调用),没接进 ActPipeline 的 `executors` Map。
> - 动手安全门已成型:`ExecPolicyStore`(`ACTION_CAPABILITY` 把 `browser.dom`/`desktop.pointer` 归类 + `TRUST_PRESETS.developer` 放行)、`assertBrowserSideEffectAck`(`SafeActExecutors.js:338`,危险点击词需 ack)、`ackCoordinateClick`(line 631,坐标点击需显式 ack)、ActPipeline 五门控(budget/permission/selfEvolution/contextSufficiency/realExecute,`src/loop/ActPipeline.js:209-210`)。
> - 证据沙箱判据安全 bug 已在 P0-3 修复,canonical 边界安全模式是 `src/runtime/mission/NoeEvidencePack.js:26-29` 的 `safeResolve`(`file === root || file.startsWith(root + sep)`)——本阶段所有新证据落盘必须复用这个判据,不许再写裸 `startsWith(root)`。
> - autopilot 调度器已接线(`server.js:1244` `new AutopilotScheduler`)但 schedules≈0 近空转;`diff`/`ast-grep` 依赖**未安装**(P4-4 需装)。
>
> 依赖:P0(真自改闭环,executor 路径已通)。本阶段产物全部默认 OFF(env 门控),符合宪法第 3 条。owner 钦定底线贯穿:rollback 可逆 / 不泄 secret / 社媒不重复发布 / 不乱烧配额。

---

### P4-1 Playwright MCP 桥:把 `browser.observe_page` 从 JXA 切到 Playwright(可灰度回退)

**① 目标**
让 `browser.observe_page` / `browser.dom.execute` 的底层从「JXA 打前台标签页」改为「Playwright MCP 受控浏览器」,根治 `browser_dom_host_mismatch`——Playwright 自己持有页面句柄,不依赖哪个标签页在前台,观察成功率从 ~72% 拉到 >95%。保留 JXA 路径作为灰度回退(env 切换),零回归。

**② 执行逻辑(具体到 file:line)**
1. 新建 `src/runtime/NoePlaywrightBrowserAdapter.js`:封装一个 `async runPlaywrightBrowserDom({ actions, expectedHosts, expectedUrlPrefixes, url, mcpClientManager })`,内部用 `mcpClientManager.callTool('playwright-local-safe', <tool>, args)` 调 Playwright MCP 工具(`browser_navigate` / `browser_snapshot` / `browser_click` / `browser_type` / 读正文)。返回值必须**对齐现有契约**:`{ ok, host, title, url, hostMatched, actions:[{type, ok, clicked, valueSet, contentRead, extractedText, extractedLength, ...}], pageReadiness:{...} }`,字段命名照抄 `src/runtime/NoeFreedomAdapters.js:601-624`(`sanitizeBrowserDomActionResult`)和 `:567-600`(`sanitizeBrowserDomPageReadiness`),这样上层 `assertBrowserDomResult`(`SafeActExecutors.js:360-367`)无需改。
2. host/url 匹配复用 Playwright 自带导航:Playwright 是用 `browser_navigate` 主动开 `url` 的,导航后页面就是目标页,`hostMatched` 由 adapter 比对 `page.url()` 与 `expectedHosts`(逻辑照抄 `NoeFreedomAdapters.js:621-624` 的 `matchesExpectedHost`),不再有「前台标签页不对」的窗口。
3. 在 `SafeActExecutors.js:370-381` 的 `runBrowserDomAdapter` 里加分支:`createSafeActExecutors` 新增可选入参 `browserBackend`(默认 `'jxa'`);当 `browserBackend === 'playwright'` 且 `freedomDeps.mcpClientManager` 存在时,走 `runPlaywrightBrowserDom`,否则保持现有 `runNoeFreedomAdapter` JXA 路径(逐字不变 = 回退安全)。
4. 在 `server.js:963` 把 `mcpClientManager` 注入 `freedomDeps`:当前 `createSafeActExecutors({ safeResolveFsPath, selfEvolution, capability })` 改为追加 `freedomDeps: { mcpClientManager }`(`mcpClientManager` 实例需从 `src/server/routes/mcp.js` 提升为可共享单例,或在 server.js 顶层 new 一个共享给 mcp 路由和 ActPipeline)。`browserBackend` 由 env `NOE_BROWSER_BACKEND`(默认 `'jxa'`,设 `'playwright'` 才切)。
5. Playwright MCP 的 `--allowed-hosts 127.0.0.1,localhost` 限制(`noe-playwright-mcp-safe-server.mjs:33`)对「观察公网站点」是硬阻塞:本任务范围内**只切本地/可信站点的观察**(localhost dev server、本地 Noe panel 51835 页面),公网站点观察是 P4-1b 的事(见下),不在本任务一次性放开 `--allowed-hosts`(放开公网 = 安全面变大,留给 owner 单独拍板)。

**③ 交付物标准**
- `src/runtime/NoePlaywrightBrowserAdapter.js`(`// @ts-check` + 注入式 `mcpClientManager`/`callTool` 可注入 + 配套单测)。
- `src/loop/SafeActExecutors.js` 的 `runBrowserDomAdapter` 加 backend 分支 + `createSafeActExecutors` 新增 `browserBackend` 入参。
- `server.js` mcpClientManager 注入 freedomDeps + `NOE_BROWSER_BACKEND` env 读取。
- 单测 `tests/unit/noe-playwright-browser-adapter.test.js`:注入 fake `mcpClientManager.callTool` 返回固定 snapshot,断言 adapter 输出契约字段齐全 + host 匹配/不匹配两路 + 不泄 secret(`extractedText` 过 `redactText`)。
- backend 灰度回退单测:`NOE_BROWSER_BACKEND` 未设时 `runBrowserDomAdapter` 仍调 JXA(`runNoeFreedomAdapter`)路径,零行为变化。

**④ 依赖前置项**
- P0(executor 路径通)。
- `@playwright/mcp` + `playwright` 已装(已确认在 deps);首次需 `npx playwright install chromium`(本机若未装浏览器二进制)。
- `playwright-local-safe` MCP server 在 McpStore 已注册(跑 `node scripts/noe-ecosystem-mcp-register.mjs` 一次)。

**⑤ 完成判定条件**
- 起一个 localhost dev server(如 `python3 -m http.server` 托一个含已知 `<title>`/正文/按钮的 HTML),`NOE_BROWSER_BACKEND=playwright` 下跑 `browser.observe_page` 真调,返回 `ok:true` + `hostMatched:true` + `extractedText` 含已知正文,且**故意把别的标签页置前台**仍成功(证明不再依赖前台标签页)——这是 vs JXA 的关键反向 probe。
- 同一用例 JXA 路径(不设 env)前台标签页不对时返 `browser_dom_host_mismatch`(对照证明根因被切掉)。
- 单测全绿 + 全量 vitest 绿 + ESLint 0。

---

### P4-1b 公网站点受控观察的 allowed-hosts 策略(owner 授权门 + 证据)

**① 目标**
在 owner 显式授权下,让 Playwright MCP 能观察特定公网域名(如做证据回收时需读某个公开页面),但默认仍 localhost-only,放开必须经声明式 allowlist + 审计,不是一刀切开全网。

**② 执行逻辑(具体到 file:line)**
1. `scripts/noe-playwright-mcp-safe-server.mjs:33` 的 `--allowed-hosts 127.0.0.1,localhost` 改为读 env `NOE_PLAYWRIGHT_ALLOWED_HOSTS`(默认 `127.0.0.1,localhost`),owner 可追加可信域名(逗号分隔)。
2. 在 `ExecPolicyStore` 加一个 `browser.dom.public` capability(对应「观察非 localhost 站点」),`TRUST_PRESETS.developer` 默认**不含**该 cap(即默认 defer/ask),owner 走 standing autonomy grant 或 `.noetrust` 才放行——复用现有 `evaluateStandingAutonomyGrant`(`server.js:951` 已有引用)。
3. adapter(P4-1)在 backend=playwright 且目标 host 非 localhost 时,先查该 cap 是否 allow,否则返 `browser_public_host_not_authorized` blocker。

**③ 交付物标准**
- `noe-playwright-mcp-safe-server.mjs` allowed-hosts 改 env 驱动。
- `ExecPolicyStore` 新 cap + 单测(默认 developer 档观察公网被 defer,grant 后 allow)。
- adapter 公网 host 授权检查分支 + 单测。

**④ 依赖前置项**
- P4-1(Playwright backend 已通)。

**⑤ 完成判定条件**
- 默认档下 adapter 观察一个公网 host 返 `browser_public_host_not_authorized`;`npm run noe:autonomy:grant` 授权对应 scope 后同一观察放行。
- 不泄 secret;授权来源记审计(只记 scope/脱敏状态,不记 secret 原值)。

---

### P4-2 浏览器动手失败归因常态化 + observe 成功率基准(before/after 度量)

**① 目标**
给 P4-1 一个可度量的「成功率 >95%」判据:把已有的失败模式归因从「一次性测试」变成常态化基准,产出 `browser.observe_page` 成功率的 before(JXA)/after(Playwright)对比数字,避免「切了 backend 但没人知道到底好没好」。

**② 执行逻辑(具体到 file:line)**
1. 复用已有归因基础设施 `tests/unit/noe-failure-modes-attribution.test.js`(已按 `browser_dom_host_mismatch` 等簇聚合 `noe_acts` 表的 `failureReason`)+ 它依赖的归因函数(grep `failure-modes` 找到生产侧 `src/...` 归因模块;若仅在测试里,提取成 `src/metrics/NoeBrowserObserveStats.js` 纯函数)。
2. 新建 `scripts/noe-browser-observe-bench.mjs`:对一组固定 URL 用例(localhost fixtures),分别用 `NOE_BROWSER_BACKEND=jxa` 和 `=playwright` 各跑 N 次 `browser.observe_page`,统计 `ok:true` 比例 + 各失败簇计数,写 `output/noe-browser-observe-bench/<ts>.json`(落盘走 `NoeEvidencePack.js:26` 的 `safeResolve` 边界判据)。
3. 输出 before/after 表:`{ backend, runs, okRate, clusters:{browser_dom_host_mismatch:N, ...} }`。

**③ 交付物标准**
- `src/metrics/NoeBrowserObserveStats.js`(若需提取)纯函数 + 单测。
- `scripts/noe-browser-observe-bench.mjs` + `package.json` 加 `bench:noe:browser-observe` script。
- 一份真实 before/after bench JSON(localhost fixtures,非编造)。

**④ 依赖前置项**
- P4-1(两个 backend 都能跑才有对比)。

**⑤ 完成判定条件**
- bench JSON 里 playwright backend `okRate >= 0.95` 且 `browser_dom_host_mismatch` 簇 = 0;jxa backend 同用例 `okRate` 明显更低(坐实改善真实)。
- 数字来自真实跑,不是 mock。

---

### P4-3 autopilot 长程自动驾驶激活(schedules 从 0 到真多步)

**① 目标**
把近空转的 autopilot(`server.js:1244` AutopilotScheduler 已接线,但 schedules≈0)激活成「真能按计划跑多步动手任务」,让 Neo 在 owner 不在场时自主推进长程任务(含 P4-1 的浏览器观察步)。

**② 执行逻辑(具体到 file:line)**
1. 读 `src/autopilot/AutopilotScheduler.js:42-50` 的 `tick` + `enqueueDueSchedules`(`AutopilotScheduleStore.js`),确认 schedules=0 是「没人建 schedule」还是「建了不 enqueue」——`cat AutopilotScheduleStore.js` 看 `enqueueDueSchedules` 的判据(due 时间/状态)。
2. 在 `server.js` autopilot handlers(`AutopilotScheduler` 构造的 `handlers={}`)接一个真 handler:把 due schedule → 经 ActPipeline `propose`(`src/loop/ActPipeline.js`)走完整五门控,executor 真跑(含 browser.observe_page)。handler 必须 env 门控(`NOE_AUTOPILOT_ACTIVE`,默认 OFF)。
3. 加「单步预算 + 最大步数 + 失败即停」护栏:复用 ActPipeline 的 budget gate(`ActPipelinePreflight.js:9` budgetPreflight),autopilot 任务设 `maxSteps` + 每步失败计数,连续失败 N 步自动暂停 schedule(写回 store 状态),防空转烧 tick。
4. 长跑登记复用 `hangAlert`(`ActPipeline.js:280` `this.hangAlert?.start`),超阈值告警非杀(`NoeHangAlert.js` 已有)。

**③ 交付物标准**
- `server.js` autopilot 真 handler(env 门控 OFF 默认)+ maxSteps/失败即停护栏。
- 单测:fake schedule store 注入,验证 due schedule → propose 调用 + 连续失败 N 步后 schedule 暂停 + OFF 时不 enqueue。
- 一个 e2e/集成:建一个 2-3 步 localhost 观察 schedule,`NOE_AUTOPILOT_ACTIVE=1` 下 tick 真推进到完成。

**④ 依赖前置项**
- P4-1(浏览器观察可靠,否则自动驾驶第一步就挂)。
- ActPipeline propose 路径(已通,P0)。

**⑤ 完成判定条件**
- `NOE_AUTOPILOT_ACTIVE=1` 下,一个多步 localhost schedule 被 autopilot tick 自动跑到 `completed`,每步留 act 证据(`noe_act_executed` event)。
- 注入连续失败步,schedule 自动暂停,不无限重试烧 tick。
- 默认(env 未设)autopilot 不 enqueue,零回归;全量测试绿。

---

### P4-4 owner 临场口头意图直触发动手(放宽 goal_step 强绑)

**① 目标**
现在真执行入口强绑 `goal_step + goalRef`(自进化/目标链路),owner 一句「帮我看下 X 页面」要先成目标才能动手,太重。让 owner 的临场口头/单句意图能直接驱动一次受门控的动手(仍过 ActPipeline 五门 + 安全门),不必先建 goal。

**② 执行逻辑(具体到 file:line)**
1. `src/server/routes/noeCoreRoutes.js:206` 的 `POST /api/noe/acts/propose` 已能直接收 act(不强绑 goal)——确认 `actPipeline.propose` 对「无 goalRef 的 owner 直发 act」是否会被 `contextSufficiencyPreflight`(`ActPipelinePreflight.js:140`)或 selfEvolution gate 误拦。`cat ActPipelinePreflight.js` 看 contextSufficiency 对非 self_evolution、非 goal-bound act 的判据。
2. 若 contextSufficiency 对 owner 直发动作要求 goal 上下文 → 加豁免:`source === 'owner_intent'`(类比 P0-5 里 `source === 'self_evolution'` 的豁免模式)时,contextSufficiency 用「owner 显式意图即足够上下文」放行(owner 是最高授权源,`AGENTS.md` Owner 顶层授权)。
3. 在聊天/语音入站链路(`src/channels/InboundChannels.js` / `src/server/routes/noe.js`)加一个意图→act 的轻量解析:owner 单句含明确动作(「打开/观察/点/读 X」)→ 组装 `{ action:'browser.observe_page', source:'owner_intent', ownerApproved:true, ... }` 经 propose 真跑。`ownerApproved:true` 满足 `assertBrowserSideEffectAck`(`SafeActExecutors.js:338`)的 ack 短路。
4. 危险动作(删除/发布/坐标点击)即便 owner 口头也不短路 ack:`ownerApproved` 只豁免「读/观察/普通点击」,删除走 `file.delete`→回收站、社媒走幂等门(P0-4),坐标点击仍需 `ackCoordinateClick`(line 631)。

**③ 交付物标准**
- contextSufficiency 对 `source:'owner_intent'` 的豁免分支 + 单测(owner 直发观察 act 不被 goal 缺失拦)。
- 入站意图→act 轻量解析(env 门控 `NOE_OWNER_INTENT_ACTS`,默认 OFF)+ 单测(明确动作句立 act / 含糊句不立)。
- 危险动作不被 owner_intent 短路的单测(口头「删 X」仍走安全删除/仍需对应 ack)。

**④ 依赖前置项**
- P0(propose 路径通)。
- 与 P4-1 协同(owner 直发的多半是浏览器观察)。

**⑤ 完成判定条件**
- owner 通过 `POST /api/noe/acts/propose` 直发一个无 goalRef 的 `browser.observe_page`(`source:'owner_intent'`),真跑成功不被 contextSufficiency 拦。
- 含糊句不立 act;危险句不被 ownerApproved 绕过安全门。
- 默认 env OFF 时入站解析不触发,零回归;全量测试绿。

---

### P4-5 jsDiff + ast-grep 自改补丁容错(治 codex patch 行号/上下文漂移)

**① 目标**
P0-1 的自改 patch 现在靠 `op:replace` 的 `from` 在文件内**精确唯一**匹配(`NoePatchApplyExecutor.js` checkPreconditions),codex 出的 `from` 一旦带轻微空白/行号漂移就匹配失败。引入模糊贴补(jsdiff 上下文匹配 / ast-grep 结构匹配)作为精确匹配失败后的**受约束兜底**,提升自改一次成功率——但必须带硬约束防误贴。

**② 执行逻辑(具体到 file:line)**
1. `npm i diff`(jsdiff)。ast-grep 走 `@ast-grep/napi`(npm 包)或 CLI;先确认本机/CI 可装(`ast-grep` 当前**未安装**,需评估 CI 跨平台可移植性,失败则只上 jsdiff)。
2. 在 `src/runtime/mission/NoePatchApplyExecutor.js` 的 `checkPreconditions`(精确唯一性校验处)加 fallback:精确 `from` 在文件里 0 命中时,用 jsdiff 的上下文匹配找最相似块,**只有相似度 ≥ 高阈值(如 ≥0.95)且唯一**才接受为贴补点;多命中或相似度低 → 仍拒(`unsupported`/`no_unique_match`),不冒险贴。
3. 硬约束(M3 增强项 MEDIUM,必做):贴补 apply 后**强制 `npm test`**,失败立即 rollback(复用已接好的 `PolicyFileGuard` rollback,`SafeActExecutors.js` 删除走回收站同理);模糊命中块与 codex 目标 `to` 的 diff 相似度 < 阈值则拒 apply(防贴到错位置)。
4. 保留虚拟串行应用(`checkPreconditions` 已有,防同文件多 op 唯一性基于原盘漂移)——模糊匹配也必须在虚拟应用后的中间态上算,不在原盘上算。

**③ 交付物标准**
- `package.json` 加 `diff` 依赖(ast-grep 视 CI 可移植性决定)。
- `NoePatchApplyExecutor.js` checkPreconditions 模糊 fallback 分支 + 阈值常量 + apply 后 `npm test` 绿门 + 失败 rollback。
- 单测 `tests/unit/noe-patch-apply-fuzzy.test.js`:① 精确匹配仍优先(零行为变化) ② 轻微空白漂移的 `from` 被模糊贴补成功 ③ 多命中/低相似度被拒 ④ 贴补后测试失败自动 rollback。

**④ 依赖前置项**
- P0-1(replace op 全链路已支持,本任务在其上加容错)。

**⑤ 完成判定条件**
- 喂一个 `from` 含轻微空白漂移(精确匹配 0 命中)的真 patch plan,模糊 fallback 贴补成功且改对位置;喂多命中/低相似度的被拒不乱贴。
- 贴补后 `npm test` 失败时自动 rollback,工作树复原。
- 全量测试绿 + ESLint 0;ast-grep 若 CI 不可移植则只交付 jsdiff 路径并在交付物注明。

---

### P4-6 浏览器/GUI 动手副作用兜底审计(owner 资产保护维度)

**① 目标**
P4 放开了更可靠的浏览器动手 + autopilot 自动驾驶 + owner 口头直触发,副作用面变大。补一道「动手前危险面识别 + 动手后副作用证据」的审计,确保 Neo 在真实站点/真实 GUI 上的动作可追溯、危险动作被挡、误操作可回滚——这是 owner 资产保护的最后一道。

**② 执行逻辑(具体到 file:line)**
1. 复查 `assertBrowserSideEffectAck`(`SafeActExecutors.js:338`)的 `DANGEROUS_BROWSER_CLICK_RE` 危险词覆盖面(grep 定义),补「发布/删除/支付/购买/确认转账/退订/注销」等高危点击词(中英),确保 autopilot/owner_intent 路径的危险点击默认需 ack。
2. autopilot 自动驾驶(P4-3)路径**强制** `ackSideEffect` 不自动为 true:autopilot 跑到危险点击时,不许自动 ack,必须留 `awaiting_approval`(ActPipeline 已有 `awaiting_approval` 状态)等 owner——自动驾驶可以读、可以普通操作,但危险副作用永远过人。
3. 动手后副作用证据:每个 `browser.dom.execute`/`browser.click` 的真执行结果已进 `noe_act_executed` event(`ActPipeline.js:298-310`),补一个「动作 → 副作用摘要」入证据包(`NoeActionEvidence.js`),记录改了哪个站点/点了什么/是否可逆,证据落盘走 `NoeEvidencePack.js:26` 边界判据。
4. 社媒发布严守 P0-4 幂等(`NoeSocialPublishQueue.js`),autopilot/owner_intent 都不得绕过。

**③ 交付物标准**
- `DANGEROUS_BROWSER_CLICK_RE` 危险词扩充 + 单测(高危词触发 ack required)。
- autopilot 危险点击强制 `awaiting_approval`(不自动 ack)+ 单测。
- 动作副作用摘要入证据包 + 单测(证据含站点/动作/可逆性,不含 secret)。

**④ 依赖前置项**
- P4-1(浏览器 backend)、P4-3(autopilot)、P4-4(owner_intent)——本任务给这三条加副作用兜底。

**⑤ 完成判定条件**
- autopilot 跑到一个危险点击(如含「发布」词)时停在 `awaiting_approval`,不自动执行。
- 普通观察/读取动作正常自动跑;危险词点击在所有路径(autopilot/owner_intent/直 propose)都需对应 ack。
- 副作用证据可读、不泄 secret;全量测试绿。
