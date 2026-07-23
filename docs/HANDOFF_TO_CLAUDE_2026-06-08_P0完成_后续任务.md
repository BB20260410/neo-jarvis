# HANDOFF TO CLAUDE - 2026-06-08 - P0 完成后续任务

## 真实仓库

- 只使用: `/Users/hxx/Desktop/Neo 贾维斯`
- 不要使用: `/Users/hxx/Documents/Neo 贾维斯`
- 不要被其它 shell cwd 误导。

## 当前边界

- 不要读取或输出 `.env`、API key、token、cookie、owner token 明文。
- 不要触碰 `51735`。
- 不要触碰 `games/cartoon-apocalypse/**`。
- 不要 commit / push，除非用户明确要求。
- 不要给模型/agent/多模型协作设置人为硬超时。
- 不要把本地角色模拟冒充真实多模型。
- 真实上传、真实发布、删除/隐藏/回滚等平台副作用必须另有用户明确授权。

## 必读顺序

1. `/Users/hxx/Desktop/Neo 贾维斯/AGENTS.md`
2. `/Users/hxx/Desktop/Neo 贾维斯/CLAUDE.md`
3. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-08_自由执行发布链收尾.md`
4. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_2026-06-08_P0完成_后续任务.md`
5. `/Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_多模型协作与密钥位置_2026-06-09.md`

## 接手后先执行核验

```bash
pwd
git -C "/Users/hxx/Desktop/Neo 贾维斯" rev-parse --show-toplevel
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short
git -C "/Users/hxx/Desktop/Neo 贾维斯" log -5 --oneline
lsof -nP -iTCP:51835 -sTCP:LISTEN
lsof -nP -iTCP:51735 -sTCP:LISTEN || true
```

期望:

- repo root 是 `/Users/hxx/Desktop/Neo 贾维斯`
- HEAD 当前曾核验为 `12a1564 Noe自由执行: 补充发布链收尾交接`
- `51835` 有 `node server.js` 监听；最近核验 PID 是 `39326`，cwd 是真实仓库
- `51735` 可能也有监听，但不要碰
- 工作区 dirty 是预期，不要擅自清理或回滚

## P0 完成状态

P0.1 已完成并验证。live `51835` 已加载当前 freedom API，不再是旧路由 404。

验证命令:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run verify:noe:freedom-live
```

最近结果:

- `ok: true`
- `checked: 4`
- `failed: 0`
- 缺 `priorStageEvidence` 时 status `409`
- blockers 包含:
  - `final_publish_prior_stage_evidence_required`
  - `final_publish_prior_stage_missing:form_fill_execute`
  - `final_publish_prior_stage_missing:media_upload_execute`
- 带合格 `priorStageEvidence` 时 status `200`, `ok:true`
- DOM recipe tags probe 无 secret leak

因此不要再把 P0 当作未完成，也不要再从“修复 404”开始，除非重新核验发现 live 状态漂移。

## 已完成但未提交的后续进展

P1 进展:

- `scripts/noe-social-dom-live-probe.mjs` 拆成 CLI + runner + utils。
- live probe 支持:
  - 打开 creator page
  - 只读 DOM probe
  - 只点击 `creator_publish_entry`
  - editor fallback URL
  - `media_upload_ready` gate
  - guarded controlled upload path
- 抖音和小红书 live gate 均已找到 `media_upload`。
- 未执行真实上传、未执行最终发布。

P2 进展:

- Freedom Tools UI 已能展示社交发布链阶段摘要。
- 展示内容包括:
  - stages
  - blockers
  - DOM readiness
  - rollback evidence
  - child ledger refs
- 相关 UI 会脱敏 secret-like token/query。

## 近期验证记录

```bash
npm test -- tests/unit/noe-freedom-tools-ui.test.js tests/unit/noe-freedom-stage-summary-ui.test.js tests/unit/noe-freedom-executor.test.js tests/unit/routes/noe-freedom-routes.test.js tests/unit/noe-social-publish-orchestrator.test.js tests/unit/noe-social-publish-workflow.test.js tests/unit/noe-social-dom-live-probe.test.js
```

- 7 files
- 76 tests passed

```bash
npm run test:p0:unit
```

- 77 files
- 522 tests passed

```bash
npm run verify:handoff
```

- 24/24 passed

```bash
git diff --check -- ':!games/cartoon-apocalypse/**'
```

- passed

Live social DOM gate 最近通过:

```bash
npm run verify:noe:social-dom-live-probe -- --platform xiaohongshu --open-creator --execute --ack-owner-present --enter-editor --require-media-upload-ready --enter-wait-ms 4000 --open-wait-ms 2500
npm run verify:noe:social-dom-live-probe -- --platform douyin --open-creator --execute --ack-owner-present --enter-editor --require-media-upload-ready --enter-wait-ms 4000 --open-wait-ms 2500
```

- 小红书: ok true，找到 `media_upload`，未上传，未发布
- 抖音: ok true，只点击 `creator_publish_entry`，找到 `media_upload`，未上传，未发布

## 当前 dirty 工作区概览

预期 dirty，不要清理用户未提交改动。主要包含:

- `docs/HANDOFF_2026-06-08_自由执行发布链收尾.md`
- `package.json`
- `public/src/web/noe-freedom-tools.js`
- `public/src/web/noe-freedom-ui-utils.js`
- `public/src/web/noe-freedom-request.js`
- `public/src/web/noe-freedom-followups.js`
- `public/src/web/noe-freedom-stage-summary.js`
- `tests/unit/noe-freedom-tools-ui.test.js`
- `tests/unit/noe-freedom-stage-summary-ui.test.js`
- `src/runtime/NoeFreedomAdapters.js`
- `src/runtime/NoeFreedomExecutor.js`
- `src/runtime/NoeSocialDomRecipe.js`
- `src/runtime/NoeSocialPublishOrchestrator.js`
- `src/runtime/NoeSocialPublishWorkflow.js`
- `scripts/noe-freedom-live-smoke.mjs`
- `scripts/noe-social-dom-live-probe.mjs`
- `scripts/lib/noe-social-dom-live-probe-utils.mjs`
- `scripts/lib/noe-social-dom-live-probe-runner.mjs`
- `tests/unit/noe-social-dom-live-probe.test.js`
- `tests/unit/helpers/noe-social-dom-live-probe-fake.js`

另有认知/语音相关 dirty 文件，属于当前工作区已有改动，不要误删:

- `public/cognitive.html`
- `public/index.html`
- `public/src/web/cognitive-profiles.js`
- `public/src/web/cognitive-research.js`
- `public/src/web/cognitive-action-drawer.js`
- `public/src/web/noe-voice.js`
- `src/voice/ChatProfileStore.js`
- `src/voice/ChatProfiles.js`
- `tests/unit/noe-voice-session.test.js`
- `tests/unit/routes/noe-routes.test.js`

## 文件行数约束

最近核验:

- `public/src/web/noe-freedom-tools.js`: 405 lines
- `public/src/web/noe-freedom-ui-utils.js`: 36 lines
- `public/src/web/noe-freedom-request.js`: 88 lines
- `public/src/web/noe-freedom-followups.js`: 119 lines
- `public/src/web/noe-freedom-stage-summary.js`: 107 lines
- `tests/unit/noe-freedom-tools-ui.test.js`: 488 lines
- `tests/unit/noe-freedom-stage-summary-ui.test.js`: 70 lines
- `scripts/lib/noe-social-dom-live-probe-runner.mjs`: 496 lines

继续改动时保持新文件或被触碰文件低于 500 行，必要时继续拆分。

## Claude 后续优先级

### 第一优先级: 不要继续 P0

除非新核验失败，否则 P0 已完成。Claude 应直接从 P1 或用户指定任务继续。

### P1 - 真实平台 DOM E2E

下一步建议:

1. 先重跑只读 gate，确认登录态和页面状态没漂移。
2. 如果用户提供媒体文件并明确允许上传副作用，才执行 guarded upload path。
3. 上传后只做 post-upload field readiness probe，确认 title/content/tags 是否出现。
4. 不要点击最终发布，除非用户再次明确允许真实发布。

安全命令模板:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run verify:noe:social-dom-live-probe -- --platform douyin --open-creator --execute --ack-owner-present --enter-editor --require-media-upload-ready --enter-wait-ms 4000 --open-wait-ms 2500
npm run verify:noe:social-dom-live-probe -- --platform xiaohongshu --open-creator --execute --ack-owner-present --enter-editor --require-media-upload-ready --enter-wait-ms 4000 --open-wait-ms 2500
```

真实上传必须同时具备:

- 用户提供 `--media-file` 或 `--media-files`
- 用户明确说允许上传副作用
- CLI 显式带 `--ack-upload-side-effect`
- 仍然不要 final publish

### P2 - UI 阶段展示

当前已实现基础展示。后续可继续:

- 在页面上增加更明显的阶段视觉状态，而不只是在列表里显示。
- 增加 latest run/history 对阶段摘要的回放。
- 增加 e2e browser test，验证真实页面渲染阶段摘要。

### P3 - rollback/delete/hide

尚未开始真实 adapter。开始前必须设计 evidence gate:

- target post URL
- post-publish evidence
- 操作前截图/DOM evidence
- 操作后证据
- 高风险操作 permission/consensus gate

不要直接删除或隐藏平台内容。

### P4 - developer mode / tool manifest

尚未完整产品化。继续时要保留硬红线:

- 不删除系统
- 不删除 Codex/自身运行核心
- 不输出密钥值
- destructive action 必须有证据链和回滚计划

## 交接给 Claude 的推荐首句

让 Claude 先核验，再继续，不要只让它“读上下文”。可直接粘贴以下提示。

```text
你接手的是 Noe / Neo 贾维斯项目。真实仓库只认:
/Users/hxx/Desktop/Neo 贾维斯

不要使用:
/Users/hxx/Documents/Neo 贾维斯

当前目标: P0 已完成，停止继续 P0。请从 P1/P2/P3/P4 后续任务继续，但任何真实上传、真实发布、删除、隐藏、回滚等平台副作用都必须等我再次明确授权。

硬边界:
- 不要读取或输出 .env、API key、token、cookie、owner token 明文。
- 不要触碰 51735。
- 不要触碰 games/cartoon-apocalypse/**。
- 不要 commit / push，除非我明确要求。
- 不要给模型/agent/多模型协作设置人为硬超时。
- 不要把本地角色模拟冒充真实多模型。

先执行核验:
pwd
git -C "/Users/hxx/Desktop/Neo 贾维斯" rev-parse --show-toplevel
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short
git -C "/Users/hxx/Desktop/Neo 贾维斯" log -5 --oneline
lsof -nP -iTCP:51835 -sTCP:LISTEN
lsof -nP -iTCP:51735 -sTCP:LISTEN || true

按顺序读取:
1. /Users/hxx/Desktop/Neo 贾维斯/AGENTS.md
2. /Users/hxx/Desktop/Neo 贾维斯/CLAUDE.md
3. /Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_2026-06-08_自由执行发布链收尾.md
4. /Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_2026-06-08_P0完成_后续任务.md
5. /Users/hxx/Desktop/Neo 贾维斯/docs/HANDOFF_TO_CLAUDE_多模型协作与密钥位置_2026-06-09.md

已完成事实:
- P0.1 live 51835 freedom API 已修复/恢复，不再是旧路由 404。
- npm run verify:noe:freedom-live 最近通过: 4/4。
- 缺 priorStageEvidence 返回 409 阻断。
- 带合格 priorStageEvidence 返回 200。
- 本阶段不要再从修 P0 404 开始，除非重新核验失败。

已验证:
- npm run test:p0:unit: 77 files / 522 tests passed。
- npm run verify:handoff: 24/24 passed。
- git diff --check -- ':!games/cartoon-apocalypse/**': passed。
- 抖音和小红书 live DOM gate 都找到 media_upload，未上传、未发布。

后续优先级:
1. P1: 继续真实平台 DOM E2E。先只读重跑 media_upload readiness gate；如果我提供媒体文件并明确允许上传副作用，再执行 guarded upload path。不要最终发布。
2. P2: Freedom UI 阶段摘要已实现，可继续做页面级更强展示和回放。
3. P3: rollback/delete/hide adapter 只能先设计 evidence gate，不要做真实删除/隐藏。
4. P4: developer mode/tool manifest 产品化，保留硬红线和 destructive action 证据链。

接手后先用当前工作区和命令输出作为权威，不要依赖旧聊天记忆。工作区 dirty 是预期，不要擅自回滚或清理用户改动。
```
