// @ts-check
// S24 模块化第12批（chat 渲染/发送 → rooms-chat-ui.js + WS 事件总分发 → rooms-events-ui.js + 房间操作/全部绑定块 → rooms-actions-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch11.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const CHAT_FILE = 'public/src/web/rooms-chat-ui.js';
const EVENTS_FILE = 'public/src/web/rooms-events-ui.js';
const EVENTS_COLLAB_FILE = 'public/src/web/rooms-events-collab-ui.js';
const ACTIONS_FILE = 'public/src/web/rooms-actions-ui.js';

const CHAT_FNS = ['renderChatRoom', 'buildChatMessageEl', 'sendChatMessage', 'abortChat'];
// 第12批b（2026-06-11 分文件达标 <500）：事件子函数按文件分组
const EVENT_FNS_MAIN = ['handleRoomEvent', 'handleDebateEvent', 'handleArenaEvent', 'handleChatEvent'];
const EVENT_FNS_COLLAB = ['handleSquadEvent', 'handleCrossVerifyEvent', 'handleClusterEvent'];
const ACTION_FNS = [
  'startDebate', 'abortDebate', 'deleteRoom', 'pullRoomAndRender',
  'delegateActiveRoom', 'addRoomRequirement',
];

describe('app.js 模块化第12批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const chatSrc = read(CHAT_FILE);
  const eventsSrc = read(EVENTS_FILE);
  const eventsCollabSrc = read(EVENTS_COLLAB_FILE);
  const actionsSrc = read(ACTIONS_FILE);

  it('rooms-chat-ui 存在、走 PanelCore 桥、暴露 window.PanelRoomsChat 全部公开符号', () => {
    expect(chatSrc).toContain('window.PanelCore');
    expect(chatSrc).toContain('window.PanelRoomsChat = {');
    for (const sym of CHAT_FNS) expect(chatSrc, `${CHAT_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(chatSrc.replace(/core\.roomState\./g, '')), `${CHAT_FILE} 裸引 roomState`).toBe(false);
  });

  it('rooms-events-ui 存在、handleRoomEvent dispatch 入口不变、暴露 window.PanelRoomsEvents（squad/cv/cluster 已分文件）', () => {
    expect(eventsSrc).toContain('window.PanelCore');
    expect(eventsSrc).toContain('window.PanelRoomsEvents = {');
    for (const sym of EVENT_FNS_MAIN) expect(eventsSrc, `${EVENTS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // dispatch 调全部 6 个 mode 子函数：本文件 3 个直调，collab 3 个经 window 懒解析（第12批b 分文件）
    for (const sub of EVENT_FNS_MAIN.slice(1)) expect(eventsSrc).toContain(`${sub}(msg);`);
    for (const sub of EVENT_FNS_COLLAB) expect(eventsSrc).toContain(`window.PanelRoomsEventsCollab?.${sub}?.(msg);`);
    // 导出面对搬走的 3 子函数保留懒转发兼容
    for (const sub of EVENT_FNS_COLLAB) expect(eventsSrc).toContain(`${sub}: (...a) => window.PanelRoomsEventsCollab?.${sub}?.(...a),`);
    expect(eventsSrc).toContain("if (msg.type === 'connected') {");
    expect(eventsSrc).toContain("if (msg.type === 'debate_state_meta') {");
    expect(eventsSrc).toContain("if (msg.type === 'room_auto_paused') {");
    // 跨模块依赖全走 window 懒解析：chat 渲染 / pullRoomAndRender（本体在 rooms-chat/actions-ui）
    expect(eventsSrc.match(/window\.PanelRoomsChat\?\.buildChatMessageEl\?\.\(/g)?.length).toBe(4);
    expect(eventsSrc.match(/window\.PanelRoomsActions\?\.pullRoomAndRender\?\.\(\);/g)?.length).toBe(1);
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(eventsSrc.replace(/core\.roomState\./g, '')), `${EVENTS_FILE} 裸引 roomState`).toBe(false);
  });

  it('rooms-events-collab-ui 存在、含 squad/cv/cluster 三子函数本体、暴露 window.PanelRoomsEventsCollab（第12批b）', () => {
    expect(eventsCollabSrc).toContain('window.PanelCore');
    expect(eventsCollabSrc).toContain('window.PanelRoomsEventsCollab = {');
    for (const sym of EVENT_FNS_COLLAB) expect(eventsCollabSrc, `${EVENTS_COLLAB_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 跨模块依赖全走 window 懒解析：pullRoomAndRender 24 处随三子函数搬入（25 拆两文件分计 1+24）
    expect(eventsCollabSrc.match(/window\.PanelRoomsActions\?\.pullRoomAndRender\?\.\(\);/g)?.length).toBe(24);
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(eventsCollabSrc.replace(/core\.roomState\./g, '')), `${EVENTS_COLLAB_FILE} 裸引 roomState`).toBe(false);
  });

  it('rooms-actions-ui 存在、暴露 window.PanelRoomsActions、含全部房间域 DOM 绑定块（boot 只绑一次）', () => {
    expect(actionsSrc).toContain('window.PanelCore');
    expect(actionsSrc).toContain('window.PanelRoomsActions = {');
    for (const sym of ACTION_FNS) expect(actionsSrc, `${ACTIONS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 绑定块全部随迁（含 #btnRooms/#btnRoom*/#btnChat*/结论转发/拖放粘贴/#qaStrictSelect/重启/续跑/大轮数）
    for (const bind of [
      "$('#btnRooms')?.addEventListener('click'",
      "$('#btnRoomBack')?.addEventListener('click'",
      "$('#btnRoomNewDebate')?.addEventListener('click'",
      "$('#btnRoomNewChat')?.addEventListener('click'",
      "document.querySelectorAll('#roomConsensusActions [data-forward]')",
      "$('#btnChatRotate')?.addEventListener('click'",
      "$('#btnChatAttach')?.addEventListener('click'",
      "$('#chatMediaInput')?.addEventListener('change'",
      "$('#chatRoomInput')?.addEventListener('keydown'",
      "$('#qaStrictSelect')?.addEventListener('change'",
      "$('#btnRoomStart')?.addEventListener('click', startDebate);",
      "$('#btnRoomAbort')?.addEventListener('click', abortDebate);",
      "$('#btnRoomDelete')?.addEventListener('click', deleteRoom);",
      "$('#btnDelegateRoom')?.addEventListener('click', delegateActiveRoom);",
      "$('#btnRoomAddRequirement')?.addEventListener('click', addRoomRequirement);",
      "$('#btnRoomRestart')?.addEventListener('click'",
      "$('#btnRoomResume')?.addEventListener('click'",
      "$('#roomDebateRoundsInput')?.addEventListener('change'",
    ]) {
      expect(actionsSrc, `${ACTIONS_FILE} 缺绑定 ${bind}`).toContain(bind);
    }
    // chat 发送/中止经 window.PanelRoomsChat 懒解析（本体在 rooms-chat-ui）
    expect(actionsSrc).toContain("$('#btnChatSend')?.addEventListener('click', () => window.PanelRoomsChat?.sendChatMessage?.());");
    expect(actionsSrc).toContain("$('#btnChatAbort')?.addEventListener('click', () => window.PanelRoomsChat?.abortChat?.());");
    // 轮换交接走统一 apiCall（第12批新增桥条目）
    expect(actionsSrc).toContain('const { $, toast, confirmModal, promptModal, api, apiCall } = core;');
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(actionsSrc.replace(/core\.roomState\./g, '')), `${ACTIONS_FILE} 裸引 roomState`).toBe(false);
  });

  it('main.js import 第12批三模块 + 第12批b collab 模块（带 cache-bust）', () => {
    expect(mainJs).toContain('./src/web/rooms-chat-ui.js?v=appjs-migration-batch12-20260610');
    expect(mainJs).toContain('./src/web/rooms-events-ui.js?v=appjs-migration-batch12-20260610');
    expect(mainJs).toContain('./src/web/rooms-events-collab-ui.js?v=appjs-migration-batch12b-20260611');
    expect(mainJs).toContain('./src/web/rooms-actions-ui.js?v=appjs-migration-batch12-20260610');
  });

  it('app.js 不再保留三节实现，只留外迁标记（房间域函数定义零残留）', () => {
    for (const gone of [
      ...CHAT_FNS.map((f) => `function ${f}(`),
      'function handleRoomEvent(',
      ...ACTION_FNS.map((f) => `function ${f}(`),
      'let _pullRoomThrottle',
      "$('#btnRoomStart')?.addEventListener",
      "$('#btnChatSend')?.addEventListener",
      "$('#btnRooms')?.addEventListener",
      "$('#roomDebateRoundsInput')?.addEventListener",
      "document.querySelectorAll('#roomConsensusActions [data-forward]')",
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第12批）==========/g)?.length).toBe(4);
  });

  it('PanelCore 桥：房间域条目全部 window 懒转发（不再残留指向已迁函数的闭包转发）+ apiCall 桥可达', () => {
    expect(appJs).toContain('renderChatRoom: (...a) => window.PanelRoomsChat?.renderChatRoom?.(...a),');
    expect(appJs).toContain('abortDebate: (...a) => window.PanelRoomsActions?.abortDebate?.(...a),');
    expect(appJs).toContain('pullRoomAndRender: (...a) => window.PanelRoomsActions?.pullRoomAndRender?.(...a),');
    expect(appJs).toContain('handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),');
    // 第12批引入直引；第21批 apiCall 本体外迁 approval-flow-ui → 改 window 懒转发（消费方 rooms-actions 零改动）
    expect(appJs).toContain('apiCall: (...a) => window.PanelApprovalFlow?.apiCall?.(...a),');
    // 桥上不允许再有「(...a) => 裸函数(...a)」形式的闭包转发（全部应解析到 window.* 模块全局）
    expect(/\(\.\.\.a\) => [a-zA-Z_$][\w$]*\(\.\.\.a\)/.test(appJs), 'PanelCore 桥残留闭包转发').toBe(false);
  });

  it('__noeClusterTest 测试钩子：handleRoomEvent 改懒解析仍可调（e2e 消费）', () => {
    const hook = appJs.slice(appJs.indexOf("Object.defineProperty(window, '__noeClusterTest'"));
    expect(hook).toContain('handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),');
  });

  it('消费方接线不变：attachRoomWS 经 core 桥、debate 经 core.renderChatRoom/abortDebate、squad 经 core.pullRoomAndRender', () => {
    expect(read('public/src/web/rooms-core-ui.js')).toContain('core.handleRoomEvent(JSON.parse(ev.data))');
    const debateSrc = read('public/src/web/rooms-debate-ui.js');
    expect(debateSrc).toContain('core.renderChatRoom(room)');
    expect(debateSrc).toContain('core.abortDebate()');
    expect(read('public/src/web/rooms-squad-ui.js')).toContain('core.pullRoomAndRender()');
  });
});
