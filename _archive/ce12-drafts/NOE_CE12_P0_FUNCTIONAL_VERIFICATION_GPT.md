# CE12 P0 功能验证 - GPT 独立稿

生成时间：2026-06-02 15:20 CST  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
阶段：8. 功能验证  
事实源：承接 `NOE_CE12_P0_REQUIREMENTS_CANONICAL.md` 与 `NOE_CE12_P0_EVIDENCE_INDEX.md`，不替代需求事实源。当前结论只能表述为「CE12 P0 产品化基础可继续验收」，不是完整 Jarvis 产品完成。

## 1. 用户主路径

主路径定义：用户打开 Noe → 进入 Brain → 写入并搜索 Memory → 触发 Act Tick → Brain UI 显示 act queue、审批状态、工具权限、失败原因、成本/预算、可复现日志 → 后端同时验证 Memory、Focus、NoeLoop、ActPipeline、Approval、SQLite、危险操作阻断 → Electron app 可启动、加载窗口、注册菜单并退出。

本阶段不做 Voice、Social I/O、完整 Jarvis 全体验、真实外发、真实删除或批量移动。

## 2. 验证环境与 Browser 路径

- Shell runner：Node `v26.0.0`，ABI `147`。
- 关键子任务：经 `scripts/ensure-node22.mjs --require-22 --exec` 重入 Node `v22.22.2`，ABI `127`。
- Browser 插件：已按 Browser 技能尝试连接 in-app browser，返回 `Browser is not available: iab`。
- 降级路径：使用项目内 Playwright e2e 和受管 server；这是当前运行时可复现的 UI 证据路径。
- 工作区边界：本轮所有文件读写均在 `/Users/hxx/Desktop/Neo 贾维斯`；原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 不作为读写目标。

## 3. 实测命令与结果

### 3.1 全量 P0 功能门

```bash
npm run verify:p0
```

结果：

```text
PASS [FR-P0-1..7] Result: 60/60 checks passed
PASS [FR-P0-1] mode=candidate_exact selected=v22.22.2 ABI127
PASS [FR-P0-1/4/7] 40/40 tests passed
PASS [FR-P0-4] allPass=true noRealExecution=true approvals=1
PASS [FR-P0-2/3/4/6] Result: 18/18 checks passed
PASS [FR-P0-5] electron-smoke PASS
PASS [FR-P0-2/3] Result: 17/17 checks passed
汇总: 7/7 门通过
结果: ALL PASS
EXIT=0
```

证据：

- 汇总 JSON：`output/ce12-p0/p0-verify-all-1780384749402.json`
- 集成报告：`output/ce12-p0/integration/integration-report-1780384750799.json`
- Electron 日志：`output/electron-smoke/electron-smoke-1780384752336.jsonl`

### 3.2 UI 用户流

```bash
npm run test:e2e:p0
```

输入：

- 受管 server：`http://127.0.0.1:51845`
- 隔离 HOME：`/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/noe-e2e-HHKEuX`
- Memory marker：`E2E_NOE_P0_1780384811664`
- 用户动作：打开 Brain，写入 Memory，搜索 marker，点击 Act Tick。

输出：

```text
[PASS] page title is Noe - Noe
[PASS] Brain panel opens - #noeBrainArea
[PASS] P0 execution DOM visible #noeActQueue
[PASS] P0 execution DOM visible #noeCurrentAct
[PASS] P0 execution DOM visible #noeApprovalStatus
[PASS] P0 execution DOM visible #noeToolPermissionStatus
[PASS] P0 execution DOM visible #noeFailureReason
[PASS] P0 execution DOM visible #noeBudgetStatus
[PASS] P0 execution DOM visible #noeEvidenceLogLink
[PASS] health chip shows ok - #noeHealthStatus
[PASS] memory write and recall is visible - E2E_NOE_P0_1780384811664
[PASS] act queue updates after Act Tick - completed · Noe focus review
[PASS] budget state rendered - ok · $0.0000
[PASS] tool permission state rendered - allow
[PASS] reproducible log link rendered - sqlite:events/2
[PASS] P0 screenshot captured - /Users/hxx/Desktop/Neo 贾维斯/output/playwright/noe-brain-ui-p0-1780384811993.png
[PASS] no relevant console errors
Result: 17/17 checks passed
EXIT=0
```

截图：`output/playwright/noe-brain-ui-p0-1780384811993.png`。截图可见 Brain 面板已展示 `completed · Noe focus review`、`allow`、`ok · $0.0000`、`sqlite:events/2`。

### 3.3 后端集成用户流

证据文件：`output/ce12-p0/integration/integration-report-1780384750799.json`

关键结果：

- Server 用隔离 HOME 和随机端口启动：`http://127.0.0.1:51737`。
- 缺 owner token 的 Noe API 请求返回 `401`。
- Memory 写入返回 `201`，随后搜索返回 `200` 且命中 1 条。
- Focus push 返回 `201`，随后列表返回 `200` 且命中 1 条。
- NoeLoop 以 `actMode=true` 启动，tick 返回 `acted=true`。
- ActStore 暴露 dry-run completed act，日志链为 `sqlite:events/2`。
- 高风险 act 返回 `202` 并进入 pending approval。
- pending approval act 可取消，终态 `cancelled`。
- destructive act 返回 `403`，终态 `blocked_safety`，原因是 `shell.exec is blocked in CE12 P0 dry-run pipeline`。
- SQLite 里同时有 memory、focus、acts、approvals、dry_run_events、loop_tick_events。
- server port 清理通过。

### 3.4 Act Pipeline 安全路径

证据文件：`output/ce12-p0/act-pipeline-evidence.json`

结果：

- 低风险 `noe.focus.review`：终态 `completed`，生成 `sqlite:events/23`。
- 高风险 `noe.custom.sensitive`：终态 `awaiting_approval`，权限状态 `approval_required`。
- 破坏性 `file.delete`：终态 `blocked_safety`，没有真实执行。
- 汇总：`allPass=true`，`noRealExecution=true`，`approvalsCreated=1`。

### 3.5 Electron smoke

证据文件：`output/electron-smoke/electron-smoke-1780384752336.jsonl`

输出事件：

```text
app_ready
menu_registered
server_node_selected
server_ready
window_loaded
smoke_quit_requested
```

结论：Electron app 能启动、选择 Node22 server、注册菜单、加载窗口并自动退出。P0 范围不包含签名、公证或真实发布。

## 4. 功能验证裁定

CE08 功能验证通过。用户主路径不是只靠单测假设，已通过真实 UI、HTTP API、SQLite 存储、ActPipeline 安全状态机、Electron smoke 和一键聚合命令复现。

可推进 CE09 文档编写。CE09 应引用本文件、`NOE_CE12_P0_EVIDENCE_INDEX.md`、`output/ce12-p0/p0-verify-all-1780384749402.json`、`output/playwright/noe-brain-ui-p0-1780384811993.png`，并继续明确「P0 产品化基础通过，不等于完整 Jarvis 产品完成」。

## 5. 剩余风险

- Browser in-app browser 当前不可用，UI 证据由项目 Playwright 降级提供。
- MiniMax M3 中文侧审计还需要后续补一次能产出明确 proposal 的 patch-only 会话；当前 patch-only 代码和单测已 fail-closed。
- Voice、Social I/O、完整 Jarvis 全体验仍是后续阶段，不进入 CE12 P0 验收。
