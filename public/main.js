// Noe — ES module 主入口 (S18-1 已激活)
// 已通过 index.html `<script type="module" src="/main.js">` 加载（defer，在 app.js 之后跑）
// 桥接策略：挂 window.PanelUtils 让 app.js（IIFE）有渐进迁移路径
// 下个 sprint：把 app.js 顶层符号（state/$/$$/etc）逐步迁入 src/web/ module，app.js 改用 window.PanelUtils.*

import { escapeHtml, escapeHtmlMl, safeSlice, shortenPath, formatSize, formatElapsed } from './src/web/utils.js';
// S18-5 激活：统一 store
import * as Store from './src/web/state.js';
// S29 starter：dialog 模块
import { confirmModal as _confirmModal, promptModal as _promptModal } from './src/web/dialog.js';
// v0.80 真做：cmdk commands 静态声明拆分
import { matchCommands as _matchCmdk, resolveAction as _resolveCmdkAction, BUILTIN_COMMANDS as _CMDK_BUILTIN } from './src/web/cmdk-commands.js';
// v0.80 真做：inspector 控件拆分；S24 收尾批22：app.js 内联 IIFE 双实现已删，此处正式接线（唯一调用点）
import { initInspector as _initInspector, initInspectorResize as _initInspResize, initInspectorToggle as _initInspToggle, initInspectorAutoCollapse as _initInspAutoCollapse, initDebateStateClear as _initDebateClear } from './src/web/inspector.js';
// v0.80 真做：WS helpers
import { buildWsUrl as _buildWsUrl, backoffDelay as _backoffDelay, createWsDispatcher as _createWsDisp, createReconnectingWs as _createReconnWs } from './src/web/ws-helpers.js';
// v1.0 Task 1.4: i18n
import { initI18n as _initI18n, t as _t, loadLocale as _loadLocale, getLocale as _getLocale, subscribe as _subI18n } from './src/web/i18n.js';
// v1.0 Task 1.5 + v1.1 Task 2.2: onboarding + telemetry consent
import { startOnboarding as _startOnb, resetOnboarding as _resetOnb, askTelemetry as _askTlm } from './src/web/onboarding.js';
// v1.5/v2.0: License + Workspace UI badge（IIFE 自挂载，无导出）
import './src/web/license-ui.js?v=owner-token-gate-20260601';
import './src/web/brain-ui.js?v=noe-brain-lite-20260602';
import './src/web/noe-proposals-ui.js?v=noe-proposal-inbox-20260613';
import './src/web/budget-utils.js?v=appjs-migration-batch2-20260603';
// 第10批（rooms-core/members）：import 必须先于 autopilot/room-adapter/summary-report/agent-graph——
// 这些模块 boot 时快照 core.roomState / core.MODEL_OPTIONS，rooms-core-ui 若后 boot 它们会快照到 undefined
import './src/web/rooms-core-ui.js?v=appjs-migration-batch10-20260610';
import './src/web/rooms-members-ui.js?v=appjs-migration-batch10-20260610';
import './src/web/autopilot-ui.js?v=appjs-migration-20260603-3';
import './src/web/webhook-ui.js?v=appjs-migration-batch2-20260603';
import './src/web/archive-ui.js?v=appjs-migration-batch2-20260603';
import './src/web/mcp-ui.js?v=appjs-migration-batch2-20260603';
import './src/web/room-adapter-ui.js?v=appjs-migration-batch3-20260603';
import './src/web/summary-report-ui.js?v=appjs-migration-batch3-20260603';
// 第三波批25（2026-06-11 分文件达标 <500）：activity 提取器层+详情面板渲染外迁 detail 文件，
// 主文件经 window.PanelActivityDetail 懒解析（调用期实时取，import 先后无 boot 依赖）；bump 缓存串防新旧混跑
import './src/web/activity-ui.js?v=appjs-migration-batch25-20260611';
import './src/web/activity-detail-ui.js?v=appjs-migration-batch25-20260611';
// 第15批：cleanOldMetrics 本体迁入语义属主 overview-ui（bump 缓存串防 5 分钟 stale 旧版解构桥 getter 取到 undefined）
import './src/web/overview-ui.js?v=appjs-migration-batch15-20260611';
// 第三波批26（2026-06-11 分文件达标 <500）：governance Preflight/Resume Review 子域外迁 review 文件，
// 主文件经 window.PanelGovernanceReview 懒解析（调用期实时取，import 先后无 boot 依赖）；bump 缓存串防新旧混跑
import './src/web/governance-ui.js?v=appjs-migration-batch26-20260611';
import './src/web/governance-review-ui.js?v=appjs-migration-batch26-20260611';
// 第三波批27（2026-06-11 分文件达标 <500）：智能体图谱 2324 行拆 6 文件——壳保名（agentRegistryState 单一属主
// + modal 壳/tab 路由 + window.PanelAgentGraph API 面 9 成员一字不改），五子模块挂各自 window.PanelAgentGraph* 命名空间，
// 跨模块互调全走 window 懒解析（调用期实时取，import 先后无 boot 依赖；但都须在 rooms-core/members 之后——
// boot 时从 PanelCore 解构 MODEL_OPTIONS/refreshRoomProviders 等 getter 快照，时序契约同批10）；bump 缓存串防新旧混跑
import './src/web/agent-graph-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/agent-graph-models-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/agent-graph-runs-view-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/agent-graph-run-actions-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/agent-graph-dispatch-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/agent-graph-evidence-ui.js?v=appjs-migration-batch27-20260611';
import './src/web/knowledge-ui.js?v=appjs-migration-batch6-20260610';
import './src/web/approvals-ui.js?v=appjs-migration-batch6-20260610';
import './src/web/delegation-ui.js?v=appjs-migration-batch6-20260610';
import './src/web/timeline-ui.js?v=appjs-migration-batch6-20260610';
import './src/web/rooms-chat-media-ui.js?v=appjs-migration-batch7-20260610';
import './src/web/rooms-cluster-tools-ui.js?v=appjs-migration-batch8-20260610';
import './src/web/rooms-cluster-live-ui.js?v=appjs-migration-batch9-20260610';
// 第17+18批（sessions 域四模块，会话强互联体同 commit 落地，跨文件互调全走 window 懒解析，import 顺序无 boot 依赖）：
// 会话 CRUD/右键菜单 → PanelSessionsCore；列表/归档/appendMessage → PanelSessionsList；
// selectSession/WS 总分发/流式/chip/banner → PanelSessionsStream；Watcher UI → PanelWatcher。
// ⚠️ 顺序契约：sessions-core-ui boot 绑 document 级 click/keydown（Esc 关右键菜单/中断 turn），外迁前在 app.js
// 同步注册（先于一切模块 boot）——必须 import 在 composer/overlays/search 之前，保持既有 Esc 触发序。
import './src/web/sessions-core-ui.js?v=appjs-migration-batch17-20260611';
import './src/web/sessions-list-ui.js?v=appjs-migration-batch17-20260611';
import './src/web/sessions-stream-ui.js?v=appjs-migration-batch18-20260611';
import './src/web/watcher-ui.js?v=appjs-migration-batch18-20260611';
// 第19批（busy/中断/send + snapshot/ctx/handoff + 新建弹窗 → PanelSessionsTools；安全历史 tab → PanelSafety；
// 项目监控+接力链 history+文件浏览器+全局 ⌘N/⌘1-9 → PanelProjectsFiles）
// ⚠️ 顺序契约：projects-files boot 绑 document 级 keydown（Esc 关 project/history/new modal、⌘N/⌘1-9），
// 外迁前在 app.js 同步注册（先于一切模块 boot）——必须 import 在 composer/overlays/search 之前，保持既有 Esc 触发序。
// 第22批（S24 收尾）：star/fork+ctx 警告条归位 sessions-tools（bump 缓存串防 stale 旧版缺 toggleStar/ctx 条）
import './src/web/sessions-tools-ui.js?v=appjs-migration-batch22-20260611';
import './src/web/safety-ui.js?v=appjs-migration-batch19-20260611';
import './src/web/projects-files-ui.js?v=appjs-migration-batch19-20260611';
// 第16批（composer 输入增强 → PanelComposer；全局 overlay 管理 Esc 逐层关/focus-trap/bg 点关/[data-cta] → PanelOverlays）
// ⚠️ 顺序契约：必须 import 在 rooms-debate-ui / search-ui 之前——这两个模块 boot 时也绑 document 级 Esc，
// 外迁前 closeTopOverlay/划词浮层的 Esc 在 app.js 同步注册（先于一切模块 boot）；module boot 均为
// setTimeout(boot,0) FIFO=import 顺序，先 import 才能保持「overlay Esc 先于 debate/search Esc」的既有触发序。
import './src/web/composer-ui.js?v=appjs-migration-batch16-20260611';
import './src/web/overlays-ui.js?v=appjs-migration-batch16-20260611';
import './src/web/rooms-debate-ui.js?v=appjs-migration-batch11-20260610';
import './src/web/rooms-squad-ui.js?v=appjs-migration-batch11-20260610';
// 第12批（chat 渲染/WS 事件总分发/房间操作+全部绑定块）：跨模块互调全走 window 懒解析，import 顺序无 boot 依赖
import './src/web/rooms-chat-ui.js?v=appjs-migration-batch12-20260610';
import './src/web/rooms-events-ui.js?v=appjs-migration-batch12-20260610';
// 第12批b（2026-06-11 分文件达标 <500）：squad/cross_verify/cluster 三子函数搬入 collab，dispatch 经 window 懒解析
import './src/web/rooms-events-collab-ui.js?v=appjs-migration-batch12b-20260611';
import './src/web/rooms-actions-ui.js?v=appjs-migration-batch12-20260610';
// 第13批（Plugin 中心 + 房间模板 modal + 散落属主绑定迁回 mcp/webhook/rooms-actions）
import './src/web/plugin-ui.js?v=appjs-migration-batch13-20260611';
import './src/web/room-templates-ui.js?v=appjs-migration-batch13-20260611';
// 第14批（跨 session 搜索+跨房搜索+cheatsheet+统一快捷键 → PanelSearch；Prompts 模板+浏览器通知+turn_end 轮询 → PanelPromptsNotify）
// 两模块互调（⌘P/Esc → openPrompts/closePrompts）走 window 懒解析，import 顺序无 boot 依赖
import './src/web/search-ui.js?v=appjs-migration-batch14-20260611';
import './src/web/prompts-notify-ui.js?v=appjs-migration-batch14-20260611';
// 第15批（Codebase Center 本地代码索引中心 → PanelCodebase；依赖 PanelAgentGraph/agentRegistryState 全 window 懒解析）
import './src/web/codebase-center-ui.js?v=appjs-migration-batch15-20260611';
// 第20批（主题/StatusBar/启动版本号 → PanelTheme；⌘K 命令面板 → PanelCmdk 合并挂载；内嵌真终端 → PanelTerm）
// cmdk boot 绑 document 级 ⌘K/⌘D keydown（与既有 Esc/⌘N/⌘1-9/⌘⇧F/⌘P 键位无冲突，import 顺序无 boot 依赖）；
// 跨模块互调（toggleTheme/openModal/selectSession/setSessionArchived/handleApprovalRequired）全走 window 懒解析
import './src/web/theme-statusbar-ui.js?v=appjs-migration-batch20-20260611';
import './src/web/cmdk-ui.js?v=appjs-migration-batch20-20260611';
import './src/web/term-ui.js?v=appjs-migration-batch20-20260611';
// 第21批（基建收尾：审批后重试基础设施 → PanelApprovalFlow；markdown 渲染+代码块复制/折叠委托 → PanelMarkdown）
// 消费方全部经 PanelCore 桥懒转发取用（调用时实时解析，与 boot/import 顺序无关）；
// 降级面：main.js 整链加载失败时 PanelCore.apiCall/requestWithApproval/handleApprovalFlow/renderMarkdown
// 经懒转发返回 undefined——但其全部消费方本身也都在本 import 链上，module 全挂时无人调用，裸跑面不变
import './src/web/approval-flow-ui.js?v=appjs-migration-batch21-20260611';
import './src/web/markdown-ui.js?v=appjs-migration-batch21-20260611';
import './src/web/noe-freedom-tools.js?v=developer-freedom-ui-20260608';

// 下个 sprint 继续加：
// import { initWebSocket } from './src/web/ws.js';
// import { initRoomsView } from './src/web/rooms.js';
// import { initPluginView } from './src/web/plugin.js';
// import { initCmdK } from './src/web/cmdk.js';

// === 桥接：让 app.js（IIFE）能用 module 内导出的 helper / store ===
// 注：app.js 顶层 escapeHtml/state 仍然定义，桥接是逐步迁移期的临时方案
if (typeof window !== 'undefined') {
  window.PanelUtils = { escapeHtml, escapeHtmlMl, safeSlice, shortenPath, formatSize, formatElapsed };
  // S29 starter：PanelDialog 桥接（让 app.js 内 wrapper delegate 过来）
  window.PanelDialog = { confirmModal: _confirmModal, promptModal: _promptModal };
  // S18-5：PanelStore.get/set/subscribe/persist/restore；app.js 顶层 const state 暂未迁移
  window.PanelStore = Store;
  // v0.80 真做：window.PanelCmdk 暴露；第20批 cmdk-ui.js 外迁后改合并赋值——cmdk-ui boot（setTimeout(0)，
  // 在本模块体之后跑）挂 openCmdk 等运行时键，双向 Object.assign 合并防互相覆盖
  window.PanelCmdk = Object.assign(window.PanelCmdk || {}, { matchCommands: _matchCmdk, resolveAction: _resolveCmdkAction, BUILTIN_COMMANDS: _CMDK_BUILTIN });
  // v0.80 真做：inspector 控件；S24 收尾批22：app.js 内联 IIFE 双实现已删，这里正式调用模块版（唯一 init 点；
  // main.js module 在 app.js 之后、DOMContentLoaded 前同序执行，元素已就位、首帧前应用 inspector-hidden 不闪烁）
  window.PanelInspector = { initInspectorResize: _initInspResize, initInspectorToggle: _initInspToggle, initInspectorAutoCollapse: _initInspAutoCollapse, initDebateStateClear: _initDebateClear };
  _initInspector();
  // v0.80 真做：WS helpers
  window.PanelWs = { buildWsUrl: _buildWsUrl, backoffDelay: _backoffDelay, createWsDispatcher: _createWsDisp, createReconnectingWs: _createReconnWs };
  // v1.0 Task 1.4: i18n
  window.PanelI18n = { init: _initI18n, t: _t, loadLocale: _loadLocale, getLocale: _getLocale, subscribe: _subI18n };
  // 启动自动加载 locale
  _initI18n().catch(() => {});
  // v1.0 Task 1.5: 自动启 onboarding（首次访问 → 引导；已完成则跳过）
  window.PanelOnboarding = { start: _startOnb, reset: _resetOnb, askTelemetry: _askTlm };
  // 顺序：先 telemetry 同意（弹窗），再 walkthrough（不阻塞）
  _askTlm().catch(() => {});
  _startOnb();
  // 启动时先从 localStorage 恢复，再 flush app.js 在 PanelStore 挂载前积压的 mirror 写入。
  try {
    Store.restore();
    Store.flushPendingMirrors();
  } catch (e) { console.warn('[main.js] Store.restore/flushPendingMirrors', e); }
}

console.log('[main.js] S18-1/S18-5/v0.80 loaded; window.PanelUtils + PanelStore + PanelCmdk ready');
