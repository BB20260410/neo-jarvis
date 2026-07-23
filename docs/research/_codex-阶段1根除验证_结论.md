   477	  // ── 自由执行器：developer 信任档下，ActPipeline 经 ExecPolicyStore 放行后才会调到这里 ──
   478	  const freeExec = async ({ act, input }) => {
   479	    const payload = payloadFrom({ act, input });
   480	    if (typeof payload.command === 'string' && payload.command.includes(' ')) {
   481	      throw new Error('command must be argv-style: {command,args}; shell strings are not allowed');
   482	    }
   483	    const cwd = payload.cwd ? resolve(String(payload.cwd)) : process.cwd();
   484	    const { command, args } = validateFreeCommand(payload.command, payload.args, detector, { cwd });
   485	    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
   486	    const result = await runCommand({ command, args, cwd, timeoutMs, runner: commandRunner });
   487	    return {
   488	      command,
   489	      args,
   490	      cwd,

codex
`shell.safe_exec` / `shell.exec` 都把 exitCode 原样返回，不抛错；而 `ActPipeline` 不检查 exitCode，所以“命令真跑了但退出码非零”会被当 completed。这正好击中阶段1想捕捉的 act 真失败。
exec
/bin/zsh -lc "nl -ba src/loop/SafeActExecutors.js | sed -n '348,364p'" in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
   348	    ].filter(Boolean).join(' ');
   349	    if (DANGEROUS_BROWSER_CLICK_RE.test(text)) {
   350	      throw new Error('browser_dom_external_side_effect_ack_required');
   351	    }
   352	  }
   353	}
   354
   355	function assertBrowserDomResult(out = {}, expected = '') {
   356	  if (out?.ok !== true) {
   357	    const blockers = Array.isArray(out?.blockers) ? out.blockers.join('; ') : '';
   358	    throw new Error(out?.error || blockers || 'browser dom action failed');
   359	  }
   360	  const actions = Array.isArray(out.actions) ? out.actions : [];
   361	  if (!expected || !actions.length) return;
   362	  const ok = expected === 'click'
   363	    ? actions.some((action) => action.clicked === true)
   364	    : expected === 'type'

codex
我准备收口前做一个不写文件的语法检查；全量/单元测试这次不能真实跑，因为当前执行沙箱是只读，前面 `git status` 已经显示连 `/tmp` 缓存写入都会被拒。
exec
/bin/zsh -lc 'node --check src/cognition/NoeLearningHook.js' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
exec
/bin/zsh -lc 'node --check src/cognition/NoeStepExpectationBridge.js' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
exec
/bin/zsh -lc 'node --check src/cognition/NoeWorldModelContradictionBridge.js' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
exec
/bin/zsh -lc 'node --check src/cognition/NoeOwnerCorrectionBridge.js' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
exec
/bin/zsh -lc 'node --check scripts/noe-curiosity-yield-report.mjs' in /Users/hxx/Desktop/Neo 贾维斯
 succeeded in 0ms:
codex
结论：**阶段1现在只能判“部分根除”，不能判彻底根除。** 第二轮整改修掉了不少表层死链，但我这轮看到 3 个会影响真实闭环的残留，其中 F2 还有一个更底层的致命漏判。

**发现**
- **致命：F2 仍没真根除，executor 返回失败值会被 ActPipeline 记成 completed。**
  [ActPipeline.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/ActPipeline.js:280) 只把 executor 抛异常 catch 成 `status:'failed'`；只要 executor 正常 resolve，后面无条件写 `status:'completed'`（[ActPipeline.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/ActPipeline.js:323)）。而 `shell.safe_exec/shell.exec` 返回 `exitCode`，不因非 0 抛错（[SafeActExecutors.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/SafeActExecutors.js:463)、[SafeActExecutors.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/SafeActExecutors.js:486)）。所以“真跑了但 exit 1”的 act 会被 Workspace 当成功，根本到不了 `ar.act.status === 'failed'` 分流（[NoeWorkspace.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorkspace.js:552)）。
  改法：`#executeReal` 对 `executorResult.ok === false`、`exitCode !== 0`、明确 `error` 做统一失败归一化，写 `status:'failed'` 和 `failureReason`；补测试：executor resolve `{exitCode:1}` / `{ok:false}` 时 Workspace 必须传 `terminal:'failed'`。

- **严重：WM-FATAL-1 只修了带空格/ASCII topic，纯中文长句仍会退化成旧死链。**
  `extractKeywords()` 用 `/[一-龥]{2,}/`，会把连续中文整段当一个 token（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:18)）。`MemoryCore.recall` 对长度 >=3 默认走 FTS（[MemoryCore.js](/Users/hxx/Desktop/Neo%20贾维斯/src/memory/MemoryCore.js:568)），所以“搞明白为什么没料到浏览器页面没有读到正文”这种生产 topic 仍可能整句召回 0。现有真 sqlite 测试用的是 `Rust 内存管理 GC 机制对比研究`，刚好有空格/ASCII，没覆盖这个形态（[noe-worldmodel-contradiction-bridge.test.js](/Users/hxx/Desktop/Neo%20贾维斯/tests/unit/noe-worldmodel-contradiction-bridge.test.js:89)）。
  改法：中文块做 2-4 字滑窗/停用词过滤，或接已有语义召回；补纯中文长 topic sqlite 回归测试。

- **严重：worldModel 关键词召回没有相关性闸，容易把无关 belief 喂给本地脑刷假矛盾。**
  当前任意 keyword 命中就进入 `related`（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:55)），随后只拼 `body` 给模型（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:64)），prompt 里也没有 topic/匹配词/候选相关性要求（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:66)）。宽词如“配置/API/模型/失败”会召回 unrelated memory。
  改法：候选先过 relevance gate，至少要求 topic/content 与 memory 有多词重叠或语义相似；prompt 要逐条输出 `RELEVANT + CONFLICT`，只有相关且直接矛盾才 `harvestSurprise`。

- **严重：owner correction 有噪声和隐藏接线依赖。**
  正则会把 `不对外发布` 里的“不对”、`其实是想问...` 里的“其实是”当纠正（[NoeOwnerCorrectionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeOwnerCorrectionBridge.js:15)），排除规则只挡少量疑问尾缀（[NoeOwnerCorrectionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeOwnerCorrectionBridge.js:17)）。另外 production watcher 挂在 `NOE_OWNER_PREDICTION` 块里（[server.js](/Users/hxx/Desktop/Neo%20贾维斯/server.js:2095)），不是单开 `NOE_OWNER_CORRECTION=1` 就必然跑。
  改法：纠正正则要求“你/上条回答/事实 X→Y”这类锚点，排除“不对外/其实是想/其实应该怎么”；owner correction watcher 独立注册或启动时明确校验依赖。

- **一般：#6 的 `lessonsRead` 不是严格“决策真读”。**
  报告用 `hit_count > 0`（[noe-curiosity-yield-report.mjs](/Users/hxx/Desktop/Neo%20贾维斯/scripts/noe-curiosity-yield-report.mjs:99)），但 `MemoryCore.recall` 默认任何调用都会 bump hit（[MemoryCore.js](/Users/hxx/Desktop/Neo%20贾维斯/src/memory/MemoryCore.js:578)）。这能证明“被召回过”，不能证明“被某个决策路径消费”。
  改法：给 recall 增加 caller/source 审计，报告只统计 `goal_step/world_model/chat_context` 等生产决策路径命中。

**按 7 问判定**
1. WM-FATAL-1：**部分解决**。带空格/ASCII 能命中；纯中文长 topic 和宽关键词假召回未根除。
2. F2：**未真解决**。Workspace 分流对 `act.status:'failed'` 有效，但 ActPipeline 会把非抛错失败记 completed。
3. F1 端到端实证：**组件级够，production 不够**。测试用 mock adapter、手调 hook/bridge，没有真实 server/heartbeat/room adapter。
4. owner correction：**部分可用，误判风险仍高**。
5. 阶段1：**部分根除**。还不能宣布彻底根除。
6. 前两轮遗漏的深层问题：上面第 1、2、3 是本轮最关键残留。
7. 零回归：我做了 `node --check`，5 个目标文件语法均通过；全量/单测没跑，因为当前沙箱只读，连 `/tmp` 写缓存都被拒。
tokens used
158,905
结论：**阶段1现在只能判“部分根除”，不能判彻底根除。** 第二轮整改修掉了不少表层死链，但我这轮看到 3 个会影响真实闭环的残留，其中 F2 还有一个更底层的致命漏判。

**发现**
- **致命：F2 仍没真根除，executor 返回失败值会被 ActPipeline 记成 completed。**
  [ActPipeline.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/ActPipeline.js:280) 只把 executor 抛异常 catch 成 `status:'failed'`；只要 executor 正常 resolve，后面无条件写 `status:'completed'`（[ActPipeline.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/ActPipeline.js:323)）。而 `shell.safe_exec/shell.exec` 返回 `exitCode`，不因非 0 抛错（[SafeActExecutors.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/SafeActExecutors.js:463)、[SafeActExecutors.js](/Users/hxx/Desktop/Neo%20贾维斯/src/loop/SafeActExecutors.js:486)）。所以“真跑了但 exit 1”的 act 会被 Workspace 当成功，根本到不了 `ar.act.status === 'failed'` 分流（[NoeWorkspace.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorkspace.js:552)）。
  改法：`#executeReal` 对 `executorResult.ok === false`、`exitCode !== 0`、明确 `error` 做统一失败归一化，写 `status:'failed'` 和 `failureReason`；补测试：executor resolve `{exitCode:1}` / `{ok:false}` 时 Workspace 必须传 `terminal:'failed'`。

- **严重：WM-FATAL-1 只修了带空格/ASCII topic，纯中文长句仍会退化成旧死链。**
  `extractKeywords()` 用 `/[一-龥]{2,}/`，会把连续中文整段当一个 token（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:18)）。`MemoryCore.recall` 对长度 >=3 默认走 FTS（[MemoryCore.js](/Users/hxx/Desktop/Neo%20贾维斯/src/memory/MemoryCore.js:568)），所以“搞明白为什么没料到浏览器页面没有读到正文”这种生产 topic 仍可能整句召回 0。现有真 sqlite 测试用的是 `Rust 内存管理 GC 机制对比研究`，刚好有空格/ASCII，没覆盖这个形态（[noe-worldmodel-contradiction-bridge.test.js](/Users/hxx/Desktop/Neo%20贾维斯/tests/unit/noe-worldmodel-contradiction-bridge.test.js:89)）。
  改法：中文块做 2-4 字滑窗/停用词过滤，或接已有语义召回；补纯中文长 topic sqlite 回归测试。

- **严重：worldModel 关键词召回没有相关性闸，容易把无关 belief 喂给本地脑刷假矛盾。**
  当前任意 keyword 命中就进入 `related`（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:55)），随后只拼 `body` 给模型（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:64)），prompt 里也没有 topic/匹配词/候选相关性要求（[NoeWorldModelContradictionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeWorldModelContradictionBridge.js:66)）。宽词如“配置/API/模型/失败”会召回 unrelated memory。
  改法：候选先过 relevance gate，至少要求 topic/content 与 memory 有多词重叠或语义相似；prompt 要逐条输出 `RELEVANT + CONFLICT`，只有相关且直接矛盾才 `harvestSurprise`。

- **严重：owner correction 有噪声和隐藏接线依赖。**
  正则会把 `不对外发布` 里的“不对”、`其实是想问...` 里的“其实是”当纠正（[NoeOwnerCorrectionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeOwnerCorrectionBridge.js:15)），排除规则只挡少量疑问尾缀（[NoeOwnerCorrectionBridge.js](/Users/hxx/Desktop/Neo%20贾维斯/src/cognition/NoeOwnerCorrectionBridge.js:17)）。另外 production watcher 挂在 `NOE_OWNER_PREDICTION` 块里（[server.js](/Users/hxx/Desktop/Neo%20贾维斯/server.js:2095)），不是单开 `NOE_OWNER_CORRECTION=1` 就必然跑。
  改法：纠正正则要求“你/上条回答/事实 X→Y”这类锚点，排除“不对外/其实是想/其实应该怎么”；owner correction watcher 独立注册或启动时明确校验依赖。

- **一般：#6 的 `lessonsRead` 不是严格“决策真读”。**
  报告用 `hit_count > 0`（[noe-curiosity-yield-report.mjs](/Users/hxx/Desktop/Neo%20贾维斯/scripts/noe-curiosity-yield-report.mjs:99)），但 `MemoryCore.recall` 默认任何调用都会 bump hit（[MemoryCore.js](/Users/hxx/Desktop/Neo%20贾维斯/src/memory/MemoryCore.js:578)）。这能证明“被召回过”，不能证明“被某个决策路径消费”。
  改法：给 recall 增加 caller/source 审计，报告只统计 `goal_step/world_model/chat_context` 等生产决策路径命中。

**按 7 问判定**
1. WM-FATAL-1：**部分解决**。带空格/ASCII 能命中；纯中文长 topic 和宽关键词假召回未根除。
2. F2：**未真解决**。Workspace 分流对 `act.status:'failed'` 有效，但 ActPipeline 会把非抛错失败记 completed。
3. F1 端到端实证：**组件级够，production 不够**。测试用 mock adapter、手调 hook/bridge，没有真实 server/heartbeat/room adapter。
4. owner correction：**部分可用，误判风险仍高**。
5. 阶段1：**部分根除**。还不能宣布彻底根除。
6. 前两轮遗漏的深层问题：上面第 1、2、3 是本轮最关键残留。
7. 零回归：我做了 `node --check`，5 个目标文件语法均通过；全量/单测没跑，因为当前沙箱只读，连 `/tmp` 写缓存都被拒。
