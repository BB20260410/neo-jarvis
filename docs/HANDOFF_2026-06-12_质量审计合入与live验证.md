# HANDOFF 2026-06-12 - 质量审计合入与 live 验证

## 本窗口结论

本窗口任务已完成：已把隔离 worktree `/Users/hxx/Documents/Neo-Quality-Audit` 中的 P0/P1/P2 质量审计成果安全合入真实主仓库 `/Users/hxx/Desktop/Neo 贾维斯`，并完成单测、质量审计、总验收、`51835` live 重启验证和浏览器页面验证。

没有 commit、push、reset、clean。暂存区已清空。

## 真实仓库

- 真实 repo root：`/Users/hxx/Desktop/Neo 贾维斯`
- 当前分支：`noe-main`
- 当前 HEAD：`145e642 本地模型: 收敛单主脑 Gemma`
- 不要使用：`/Users/hxx/Documents/Neo 贾维斯` 或 `/Users/hxx/Documents/Neo 2`

## 本窗口改动

新增：

- `scripts/noe-quality-audit.mjs`
- `docs/QUALITY_AUDIT_2026-06-12_P0_P2.md`

合入/修改：

- `public/cognitive.html`
- `public/mind.js`
- `public/src/web/autopilot-ui.js`
- `public/src/web/cmdk-ui.js`
- `public/src/web/cognitive-attachments.js`
- `public/src/web/cognitive-command-surface.js`
- `public/src/web/cognitive-local-council.js`
- `public/src/web/cognitive-research.js`
- `public/src/web/cognitive-taskflow.js`
- `public/src/web/overview-ui.js`
- `public/src/web/projects-files-ui.js`
- `public/src/web/rooms-core-ui.js`
- `public/src/web/rooms-squad-ui.js`
- `public/src/web/search-ui.js`
- `public/src/web/sessions-list-ui.js`
- `src/server/routes/roomsMedia.js`
- `tests/unit/routes/rooms-advanced-routes.test.js`

注意：`src/server/routes/lemonsqueezy.js`、`src/server/routes/payment-webhooks.js`、`tests/unit/routes/payment-webhooks.test.js` 在主仓库里已经与隔离成果一致；本窗口没有额外覆盖它们，但它们仍显示为主仓库既有 dirty。

## 关键合并判断

原整包 patch 不能直接套入主仓库，因为以下文件在主仓库已有其它窗口改动：

- `public/mind.js`
- `public/src/web/cognitive-attachments.js`
- `src/server/routes/lemonsqueezy.js`
- `src/server/routes/payment-webhooks.js`
- `tests/unit/routes/payment-webhooks.test.js`
- `tests/unit/routes/rooms-advanced-routes.test.js`

实际处理：

- `public/mind.js`：保留主仓库 Noe100 Proof 逻辑，叠加 SVG DOM 安全渲染与目标状态/来源/id/priority 规范化。
- `public/src/web/cognitive-attachments.js`：保留主仓库图片/视频大小限制，叠加附件名称与状态的 DOM API 渲染。
- `tests/unit/routes/rooms-advanced-routes.test.js`：保留 `seedScope=all` 回归测试，新增 `roomsMedia` fallback 合法路径与越界路径测试。
- 支付相关 3 文件内容已与隔离成果一致，不重复写入。

## 已验证结果

代码/单测：

- `node scripts/noe-quality-audit.mjs`
  - `files: 657`
  - `findings: 0`
  - `p0: 0`
  - `p1: 0`
  - `p2: 0`
- `npx vitest run tests/unit/routes/payment-webhooks.test.js tests/unit/routes/rooms-advanced-routes.test.js`
  - 2 files
  - 24 tests passed
- `npm run test:p0:unit`
  - 107 files
  - 756 tests passed
- `npm run verify:noe:self-evolution`
  - 198 passed
  - 0 failed
- `npm run verify:handoff`
  - 83 passed
  - 0 failed
- `git diff --check -- ':!games/cartoon-apocalypse/**'`
  - passed
- `npm run verify:noe:full-current -- --include-managed`
  - all PASS
  - report: `output/noe-full-current/full-current-1781256982301.json`

Live：

- 重启前 `51835` PID：`51610`
- 重启命令：`npm run restart:panel`
- 重启方式：`direct`
- 重启后 `51835` PID：`46832`
- 重启后 cwd：`/Users/hxx/Desktop/Neo 贾维斯`
- `/health`：`ok:true`
- `/api/noe/readiness`：`status:"passed"`
- `npm run verify:noe:freedom-live`
  - checked 5
  - failed 0

Browser live QA：

- `http://127.0.0.1:51835/mind.html`
  - 页面标题：`Noe · 内心透视`
  - Noe100 Proof、目标、情感图均渲染
  - 点击刷新后无 console error/warn
- `http://127.0.0.1:51835/cognitive.html`
  - 页面标题：`Noe · 认知界面`
  - stream、chat、input、attach button 均存在
  - 输入本地草稿后清空，未发送外部数据
  - 无 console error/warn

## 当前状态

- 本窗口验证时 `51835` 重启后 PID 为 `46832`；后续 live 进程已经被其它窗口/进程再次重启过。最新只读观察：`51835` 当前由 PID `2783` 监听，cwd 为真实仓库，`/health` ok，`/api/noe/readiness` passed。
- `51735` 未触碰。
- 暂存区为空：`git diff --cached --name-only` 为 0。
- 排除 `games/cartoon-apocalypse/**` 后，主仓库仍有大量既有 dirty，最新观察约 234 项。这是其它窗口/历史任务叠加状态，不是本窗口未完成。
- 本窗口未 commit。若后续要 commit，必须只 stage 本窗口相关文件，避免把其它窗口未完成改动一起提交。

## 硬边界

- 不读、不打印、不复制 `.env`、API key、token、cookie、OAuth、owner token、`~/.noe-panel/room-adapters.json`。
- 不触碰 `51735`。
- 不触碰 `games/cartoon-apocalypse/**`。
- 不 reset、clean、checkout 回滚其它人的改动。
- 不 commit/push，除非 owner 明确要求。
- 如果再次重启 `51835`，必须记录 PID、cwd、启动方式、health/readiness 和验证结果。

## 深入判断：下一步往哪个方向发展

### 总判断

下一步不应该继续无边界地堆功能、装工具或重新评测模型。当前最重要的是把“已经证明能跑的质量改动和 live 状态”变成可追溯的稳定基线，然后围绕 Noe100 真实 blocker 和 P6 自我对话交付证据继续推进。

原因：

- 代码质量审计成果已经合入并通过 full-current/live/browser 验证，继续在同一窗口扩大改动会增加交叉污染风险。
- 主仓库 dirty 已超过 200 项，说明多个窗口/任务的成果混在同一工作区；再直接开发新功能会让后续 commit、回滚和归因变难。
- Noe100 最新矩阵显示真正缺口不是再写一个脚本，而是时间和自然数据：`not_enough_soak_evidence`、`expectation_settlements_below_20`。
- live readiness 里 P6 仍显示 `confirmedDelivery=0`、`llmContextAllowed=false`，说明自我对话/反刍方向还没有形成可证明的“落地给用户/落地到行动”的交付闭环。
- 模型策略已经收敛到 Q35-6 Main、Q27-4 Review、G26-4 Fallback；短期继续反复换主脑收益低，风险高。

### P0：先做稳定基线和提交边界

优先级最高的是把当前已经通过验证的一组质量改动从全仓 dirty 里分离出来。

建议路径：

1. 先重新核对 live 与状态：
   - `git status --short -- ':!games/cartoon-apocalypse/**'`
   - `git diff --cached --name-only -- ':!games/cartoon-apocalypse/**'`
   - `lsof -nP -iTCP:51835 -sTCP:LISTEN`
   - `/health`
   - `/api/noe/readiness`
2. 如果 owner 明确要求 commit，只做“质量审计合入与 live 验证”这一小包 commit，不要全仓提交。
3. commit 前精确 stage 本窗口文件，并逐个 `git diff -- <file>` 核对。
4. commit 前复跑：
   - `node scripts/noe-quality-audit.mjs`
   - `npx vitest run tests/unit/routes/payment-webhooks.test.js tests/unit/routes/rooms-advanced-routes.test.js`
   - `npm run test:p0:unit`
   - `npm run verify:handoff`
   - `git diff --check -- ':!games/cartoon-apocalypse/**'`
5. commit 后再跑一次 `/health` 和 `/api/noe/readiness`，确认 live 没被提交过程扰动。

如果 owner 没要求 commit，则下一窗口至少要保留本 handoff，不要把本窗口文件和其它 dirty 混淆。

### P0：做全仓 dirty 分组，不要继续盲改

下一步应该生成一个“dirty worktree integration map”，把 234 项 dirty 按来源和业务域分组。

建议分组：

- 质量审计合入：本 handoff 记录的前端安全、`roomsMedia`、审计脚本和报告。
- P6 / self-talk / rumination guard：`SelfTalk*`、`RuminationGuard*`、P6 报告和测试。
- Noe100 / readiness / soak / expectation：`noe-100-readiness`、`soak`、`expectation-calibration`、`action-evidence`。
- 模型路由 / Qwen 三角色：`NoeLocalModelPolicy`、LM Studio loader、模型 benchmark 脚本。
- freedom/social/live：发布链、DOM probe、freedom live smoke。
- UI/认知页面：`mind.html/css/js`、`cognitive*`、voice/profile 相关。

这个 map 的价值是决定后续 commit 顺序和回滚边界。没有这个 map，不要做大 commit。

### P1：围绕 Noe100 两个真实 blocker 推进

Noe100 现在不是“缺更多代码”，而是缺自然证据：

- `not_enough_soak_evidence`：activeDays 未达到 7 天。
- `expectation_settlements_below_20`：natural live resolved 未达到 20。

下一步做法：

1. 每天跑只读 soak snapshot，保留日报，不伪造 activeDays。
2. 每天跑 expectation calibration，记录 dueNow/open/future/resolved，不把 controlled drill 算成 natural live。
3. 如果 dueNow 为 0，不要硬结算；让系统继续自然产生到期待判证项。
4. 如果 dueNow 有项目，再通过 owner 可理解的方式裁决，形成自然结算样本。
5. Noe100 达到 100 前，任何文档/UI 都只能说“ready progress / proof score”，不能说已 100%。

### P1：P6 自我对话要从“反刍”转成“交付”

当前 live readiness 暴露了 P6 方向的真实信号：selfTalk outcome 数量在增长，guard records 也在增长，但 confirmed delivery 仍是 0。这说明系统会想、会记录、会被 guard 拦，但还没有足够证据证明“把有价值的想法稳定交付给用户或行动链”。

下一步应该做：

1. 审计 P6 产物：哪些 selfTalk 是重复/空转，哪些有行动价值。
2. 定义 confirmed delivery：UI 展示、用户看到、行动链采纳、目标 checkpoint、memory writeback 中至少一种可验证落点。
3. 给 selfTalk 增加“落地结果”字段，而不是只记录生成内容。
4. rumination guard 不只拦截重复，还要把被拦原因反馈给目标选择/注意力系统。
5. `llmContextAllowed=false` 时，不要把 P6 内容塞进主脑上下文；先证明 P6 输出质量和落地率。

### P1：产品方向从 debug console 转向可用 Jarvis

当前 `mind.html` 和 `cognitive.html` 已能 live 渲染，但本质上仍偏调试面板。下一步产品方向应是：

- `cognitive.html`：用户真正使用的主入口，强调对话、附件、视觉、行动确认。
- `mind.html`：调试/透明度入口，展示 Noe 为什么这么想、为什么没行动、证据链是否足够。
- 普通用户路径不应该依赖读日志、看 JSON、点内部按钮。
- 行动前的确认、行动后的证据、失败后的恢复建议要在 UI 里闭环。

这比继续换模型更重要。模型已经够用，缺的是产品闭环和证据闭环。

### P2：工具/MCP 方向只保留能增强证据链的

不要继续“看到工具就装”。下一步工具/MCP 选择标准：

- 能否提升 Noe 的真实动手能力。
- 能否产生可审计 evidence。
- 是否有只读 smoke / dry-run / rollback。
- 是否默认不暴露 secret。
- 是否能纳入 `TOOL_ADOPTION_RECORD`。

优先级高的不是新奇工具，而是：

- browser/Playwright 可重复 UI 验证。
- local file/wiki/search evidence。
- MCP readonly adapters。
- safe automation wrappers。
- benchmark/eval harness，但必须 no-load/no-secret/no-side-effect 默认。

### 不建议立刻做的事

- 不建议继续换主脑或重跑大规模模型竞赛。
- 不建议把所有 dirty 一次性 commit。
- 不建议为了 Noe100 改 SQLite 或合成自然数据。
- 不建议在 P6 confirmed delivery 为 0 时把 P6 内容写入长期上下文。
- 不建议继续安装大批未审计 MCP/工具。
- 不建议在没有 integration map 前继续大范围改 `server.js`、`noe.js` 或全局模型路由。

### 我给下个窗口的具体打法

1. 先做 dirty integration map。
2. 得到 owner 明确要求后，优先把本窗口质量审计成果单独 commit。
3. 然后选择一个主线推进，不要多线混做：
   - 要稳定：做 commit/验证/回滚文档。
   - 要 Noe100：做 soak + expectation natural settlement。
   - 要 Jarvis 产品化：做 cognitive 主入口闭环。
   - 要 P6：做 confirmed delivery 和 anti-rumination 落地。
4. 每完成一条主线，必须跑对应验证并更新 handoff。

## 下个窗口建议

1. 先确认真实仓库和 live 状态：

```bash
pwd
git -C "/Users/hxx/Desktop/Neo 贾维斯" rev-parse --show-toplevel
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short -- ':!games/cartoon-apocalypse/**'
lsof -nP -iTCP:51835 -sTCP:LISTEN
curl -sS -m 3 http://127.0.0.1:51835/health
curl -sS -m 3 http://127.0.0.1:51835/api/noe/readiness
```

2. 如果 owner 要 commit，建议只 stage 本窗口相关文件，先复跑：

```bash
node scripts/noe-quality-audit.mjs
npx vitest run tests/unit/routes/payment-webhooks.test.js tests/unit/routes/rooms-advanced-routes.test.js
npm run test:p0:unit
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```

3. 不要把全仓 dirty 一把提交。先用 `git diff -- <file>` 逐个核对本窗口文件，再按精确文件列表 `git add`。

## 给下个窗口的复制提示

```text
继续 Neo / Noe。真实仓库只用 /Users/hxx/Desktop/Neo 贾维斯，不要用 Documents/Neo 2。

先读：
1. /Users/hxx/Desktop/Neo 贾维斯/AGENTS.md
2. /Users/hxx/Desktop/Neo 贾维斯/CLAUDE.md
3. /Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-12_质量审计合入与live验证.md

本窗口已完成质量审计成果合入和 live 验证。51835 已通过 npm run restart:panel 受控重启，当前 PID 最近为 46832，cwd 是真实仓库，/health ok，/api/noe/readiness passed。51735 未触碰。

已验证：
- node scripts/noe-quality-audit.mjs：657 files，findings 0，P0/P1/P2 全 0
- targeted vitest：2 files，24 tests passed
- npm run test:p0:unit：107 files，756 tests passed
- npm run verify:noe:self-evolution：198/198
- npm run verify:handoff：83/83
- npm run verify:noe:freedom-live：checked 5，failed 0
- npm run verify:noe:full-current -- --include-managed：all PASS
- mind.html 和 cognitive.html 浏览器 live QA 无 console error/warn

暂存区已清空，没有 commit/push/reset/clean。主仓库仍有大量既有 dirty，不能全量提交。若用户要求 commit，只 stage docs/QUALITY_AUDIT_2026-06-12_P0_P2.md、scripts/noe-quality-audit.mjs 以及本次触碰的前端/roomsMedia/test 文件，逐文件核对后再提交。
```
