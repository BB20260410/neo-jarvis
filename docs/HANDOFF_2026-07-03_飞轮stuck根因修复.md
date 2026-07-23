# 交接:飞轮 stuck 根因修复(2026-07-03,承接同日「漏点诊断」交接)

> 上轮交接的假设 H1(「在途 goal 没被驱动器重新驱动」)**已被 DB 证据证伪**;真根因是另一条链。
> 本轮:证据裁决 → TDD 修复 4 项(A1/A2/B/C/D) → 全量 8229 绿 + 隔离端口端到端验证。

## 真根因链(全部有 DB/日志证据)

上轮数据:467 cycle 里 30%(139 个)终态停在 self_repair_ready(70)/implementation_ready(69)。

1. **H1 证伪**:139 个 stuck cycle 的 goal 全部/几乎全部是 `dropped`(70/70 + 65/68)——它们**被反复驱动过**
   (sticky 心跳每拍都推),是「反复失败后被放弃的尸体」,不是「没人推」。
2. **信息断供(最深根因)**:type_error seed 造的错误详情(行号:错误码)只存 `steps[0].step` 截 120 字;
   goal.title 只有「修 X 的类型 error」;cycle.goal 用 title;implementer prompt **零错误信息** → M3 盲猜
   → 价值锚正确拒绝 → verify_failed。
3. **self_repair 盲重试**:repair 的 implementer 输入与上次完全相同(无失败证据)→ 同命运。
   实测 acts 表:self_repair 失败 359 次全是 `self_repair_failed_needs_consensus`;`needsConsensus`
   抛出后**无人消费**(trigger 只认 needsSelfRepair,grep 全仓确认),每拍盲提直到 stuck-drop。
4. **同因连败烧拍**:生产 `NOE_SELF_EVOLUTION_MAX_STUCK_TICKS=5`,每个注定失败的 goal 烧 5-7 个 act
   (每个=M3 生成 patch+全量测试+apply/回滚)才放弃。359÷70≈5.1 完全吻合。
5. **锚旁路**:self_repair 用裸 runtimeVerify(无 type 价值锚)——npm test 绿就算修好,没修 error 也能盖章。
6. **间歇 1 挂测拖死全局**:runtime-verify 报告 119/200 失败且**恰好 1 个测试挂**(numFailedTests=1),
   把 baseline 打红 → 逻辑门 `baseline_not_green` 全拒(账本 13 次)。挂测**名字**读完即弃无法归因(已修,见 D)。
   当下全量绿,是间歇/窗口性的,下次出现看报告 failedTests 字段。
7. **(附带发现)双 writer 污染**:51999 挂着一个 6/29 遗留的 server.js 实例,与生产 51835 共用
   panel.db 双驱飞轮 4 天(预算门/卡死计数都是进程内的,互相不可见)。已 kill(lsof 验过归属)。

## 本轮修复(全 TDD,RED→GREEN 留痕;+26 测试,基线 8203→8229 全绿)

| 项 | 改动 | flag(默认 OFF) |
|---|---|---|
| A1 错误详情全链路 | seed meta.errors 存行号/错误码/消息(≤5条截断);trigger 拼进 objective | `NOE_SELFEVO_TYPEERR_DETAIL` |
| A2 失败证据回灌 | executor throw 带 verifyReason;ActPipeline 白名单+1;trigger 存 cycle.repairHints(脱敏)并拼进 self_repair objective | `NOE_SELFEVO_REPAIR_HINTS` |
| B fail-fast+终态戳 | 同因连败 N 拍(默认2,`NOE_SELFEVO_FAILFAST_REPEATS`)→先落 stuckDrop 终态 artifact(落库成功才释放)+lesson+drop;常规 stuck-drop 也补终态戳 | `NOE_SELFEVO_FAILFAST` |
| C 锚旁路封堵 | self_repair 对 type_error goal 同样包装 typeErrorVerify(依附既有 `NOE_SELF_EVOLUTION_TYPECHECK`,无新 flag) | — |
| D 挂测名单可观测 | runtime-verify 报告持久化 failedTests(≤10条 fullName 截断);无行为变化 | — |

改动文件:`src/room/NoeTypeErrorSeed.js` `src/room/NoeSelfEvolutionTrigger.js` `src/loop/NoeSelfEvolutionExecutors.js`
`src/loop/ActPipeline.js` `server.js`(组合根接线,棘轮 3825→3830 十四校准) + 5 个测试文件。

## 验证记录
- 全量 `npm test` 8229/8229 绿;`npm run perf-check` 完成(🟡 RSS 242MB 为既有状态)。
- lint 改动文件 0 错。
- 隔离端口端到端:`PORT=51999 npm start`(注意:**`npm run start:noe` 内联死 PORT=51835,外部 PORT 无效**,
  项目 CLAUDE.md 的 `PORT=51999 npm run start:noe` 示例是过时的)+四 flag ON+REAL_APPLY=0 →
  5s listen HTTP 200,trigger 装配日志正常,清理无残留。

## 点火(owner 已永久授权自主点火)
```
NOE_SELFEVO_TYPEERR_DETAIL=1
NOE_SELFEVO_REPAIR_HINTS=1
NOE_SELFEVO_FAILFAST=1
# NOE_SELFEVO_FAILFAST_REPEATS 默认 2,可不写
```
点火后重启 51835(launchd 管理)。回滚=删这三行重启。

## 修没修好怎么看(隔几天)
- `node scripts/noe-evolution-review.mjs`:self_repair_ready+implementation_ready 占比应降;
  新尸体 cycle 应带 `stuckDrop` 终态戳(可区分存量);真进步率应上抬。
- acts 表 self_repair 同因连败长度应从 ~5 降到 ~2;type_error goal 的 implementation 成功率应升
  (implementer 现在拿得到具体错误了)。
- 若再出现「1 挂测拖死 baseline」:看 runtime-verify 报告新字段 `failedTests` 直接归因;
  若坐实是别窗瞬时改动,考虑点火既有 `NOE_EVOLUTION_RELATIVE_BASELINE=1`(相对基线,fail 数不超 baseline 即放行)。

## 未做/留给后续
- `needsConsensus` 的「回 consensus 重立项」路由仍未实现(B 的 fail-fast 已让它不再烧拍,优先级降低;
  真要做=consensus autodrive 重跑+清 implementation 证据,类似 rework 模式)。
- 间歇 1 挂测的身份未定(当下全绿复现不了),D 的 failedTests 字段让下次可归因。
- 别窗(Codex)未提交改动仍在工作区(13 个 M 文件+1 新测试),未动。

## 追加(2026-07-03 深夜)：点火实证 + repair 升级模型链

**点火后 2h 实证(3 goal/8 act)**:A1/A2/B/C/D 全部按设计工作——objective 带错误详情(`L173 TS18046`)与
失败回灌(`error 未减少 1→1` / `作弊消音标记 : any`),同因连败 2 拍收口带 stuckDrop 终态戳,单 goal 消耗
5-7 act→2-3 act。**但 0 complete,瓶颈干净移到 implement 引擎**:本地 27b 对 TS18046 修不动、TS2741 靠
`: any` 作弊被锚拦(锚全对,产出侧不行)。

**repair 升级模型链已实现+点火(commit 2fc91e0)**:`NOE_SELFEVO_REPAIR_ESCALATE=1`(.env 已加)——
self_repair 拍(本地已败一次+失败证据在 objective)候选序改云端(route 选的 M3)优先、本地兜底;
implementation 拍不升级(本地优先省额度不变)。escalate 标记 self_repair executor→resolvePatchPlanRef→
spawnImplementer 工厂;route 无 adapterId 时 fail-open 回本地。TDD +7 测,全量 8236 绿。

**观察点**:下一个 type_error goal 的 self_repair act 应出现 minimax adapter 的 agent.run + repair 成功率
应显著上抬(TS18046/TS2741 是云模型甜点)。若 M3 经代理 TLS 抖动失败,本地兜底仍在(双向韧性)。

## 追加(2026-07-05 凌晨)：接手核查——生产宕机 26h + escalate 真实效果为零的根因

**发现1(P0，已修复)：51835 点火后仅活了 2.5h 就停了，此后宕机 ~26h 无人发现**
- 证据链：`launchctl print gui/501/com.noe.panel` 返回 "Could not find service"（**任务根本没被 launchd 加载**）；
  `/tmp/noe-panel.launchd.log` 停在 2026-07-03 23:53（"收到 SIGTERM，force save data + 关 child..."，**是正常关闭流程，不是崩溃**）；
  `panel.db` mtime 同步停在同一时刻；系统 `uptime`/`who -b` 显示机器 7/3 21:16 才重启过一次——面板是重启后随 launchd RunAtLoad 起来的，跑了 2.5h 后被人为/外部 SIGTERM 停掉，然后再没人拉起来。
  Neo 自己心跳恢复后的第一句内心独白也印证了这一点："我刚才离线了约 26 小时，现在心跳恢复，继续在了"。
- **真根因(新发现的 bug)：launchd label 对不上**。已安装的 plist(`~/Library/LaunchAgents/com.noe.panel.plist`)
  Label 是 `com.noe.panel`；但 `scripts/restart-panel.mjs` 里 `LAUNCHD_LABEL` 默认写死 `com.hxx.noe.panel51835`——
  两者不一致，导致 `restart-panel.mjs` 的 `launchdLoaded()` 检测永远查不到已装的 job，只能走「直接 spawn」分支
  （而不是 `launchctl kickstart`）。这意味着**当前生产面板不是在 launchd 监管下跑的**：无论是这次的正常 SIGTERM
  还是未来任何一次崩溃，都不会被自动拉起，得靠人/下一个会话手动发现+重启。
  这是"已转 launchd 自愈"(2026-06-11 旧记录)这个说法目前不成立的直接证据——建议下一轮专门修：
  统一两边 label(改 plist 的 Label 或改脚本默认值)+ `launchctl bootstrap` 重装 + 用真实 kill -TERM 演练一次验证
  确实会被拉起，而不是只信配置存在。
- **已处理**：`lsof` 验证端口/进程归属干净后，`npm run restart:panel` 直接重启，`curl 127.0.0.1:51835/` 返回 HTTP 200，
  PID 45448，启动日志确认四个 flag 所在 `.env` 行仍在(`grep -c "^NOE_SELFEVO_" .env` = 4)。**label 不对齐的根治没做**，
  留给下一轮，当前只是又一次「直接 spawn」，重启前的宕机没有自动防护，这次也一样。

**发现2(信息性，非 bug)：repair 升级模型链点火后 2.5h 窗口内，self_repair 拍一次都没触发云端**
- 用 panel.db 逐条核对了点火窗口(21:00-23:55)：4 个 `self_repair` act(21:52/21:56/22:52/22:55)全部只用了
  本地 `lmstudio-code qwen/qwen3.6-27b`，一次都没出现 minimax；同窗口确实出现了 2 次 minimax 调用
  (22:02:19 / 22:03:33)，但对应的是 `noe.self_evolution.implementation` act(非 self_repair)，且是既有模型路由
  逻辑自己选的云端(和本次新加的 escalate flag 无关)，两次都以 `self_evolution_no_patch_plan_in_reply` 收场。
- **原因定位（代码层面，非环境/点火问题）**：`makeNoeSelfEvolutionImplementer` 里 `cloudFirstForRepair` 只是把
  candidate 顺序从 `[decision.adapterId, localId]` 变成 `[decision.adapterId, localId, 'lmstudio']`——**首位候选
  仍然是 `decision.adapterId`，没有强制换成云端**。而 spawnImplementer 的候选级联只在「压根没解析出 patch plan」
  时才试下一个候选；本次观察到的 4 次 self_repair 失败都是「解析出了patch plan，但 verify/价值锚拒收」
  (`self_repair_failed_needs_consensus`)——这种"有产出但产出不对"的失败模式**根本不会触发候选级联**，因为
  spawnImplementer 自己已经"成功返回"了。换句话说：**repair 升级模型链目前只能救"模型完全答不出患者结构"的
  case，救不了"本地模型自信地给了个错答案"的 case**——而后者恰恰是这轮 stuck 分析里最常见的失败模式。
- **结论**：escalate 的机制本身接线没问题(能证明会级联、会回退)，但覆盖不到目标故障模式，**实际效果目前约等于 0**。
  真要堵这个洞，需要另一层：self_repair 拍如果是"第 2 次即以后"的重试(即 cycle.repairHints 已非空)，
  直接跳过本地、强制第一候选就是云端，而不是指望"local 答不出来才降级"这条已有的容错路径。这属于新的一轮
  TDD 改动，本次先如实记录留给下一轮，不在本次交接里顺手改。

**当前生产状态(2026-07-05 凌晨核实)**：51835 已重启存活(HTTP 200)；四个 flag 仍点火中；A1/A2/B/C/D 五项 2026-07-03
的修复本身没有回退证据(观察窗口内 objective 拼接、fail-fast 提前收口的行为在此前 2.5h 里已经验证过，见上文)。
下一轮建议顺序：① 修 launchd label 对齐(防再宕机没人发现) ② 重新设计 escalate 触发条件(覆盖"有产出但产出不对"
的失败模式) ③ 让面板再稳定跑一段时间后重新用本节的同一套 SQL 查询法核对效果。
