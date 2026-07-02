// @ts-check
// S24 模块化第10批（房间核心状态/列表/选择/归档群 → rooms-core-ui.js + 成员/技能/providers/计时器群 → rooms-members-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch9.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const CORE_FILE = 'public/src/web/rooms-core-ui.js';
const MEMBERS_FILE = 'public/src/web/rooms-members-ui.js';

const CORE_FNS = [
  'showRoomArea', 'hideRoomArea', 'loadRooms', 'maybeAutoSelectRunningRoom',
  'updateRunningRoomsIndicator', 'renderRoomList', 'loadArchivedRooms', 'renderArchivedRooms',
  'setRoomArchived', 'createRoom', 'selectRoom', 'attachRoomWS',
  'statusLabel', 'isRoomRunningLike', 'shortLineageValue', 'renderRoomLineage',
];
const MEMBERS_FNS = [
  'refreshRoomProviders', 'refreshRoomAgentProfiles', 'refreshRoomSkills',
  'renderRoomSkillBindings', 'updateRoomSkillsFromControls', 'renderRoomMembers',
  'updateMember', 'removeMember', 'addRoomMember',
  'formatElapsed', 'startElapsedTicker', 'maybeStopElapsedTicker', 'updateRoomStatusChip',
];

describe('app.js 模块化第10批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const coreSrc = read(CORE_FILE);
  const membersSrc = read(MEMBERS_FILE);

  it('rooms-core-ui 存在、走 PanelCore 桥、暴露 window.PanelRoomsCore 全部公开符号', () => {
    expect(coreSrc).toContain('window.PanelCore');
    expect(coreSrc).toContain('window.PanelRoomsCore = {');
    expect(coreSrc).toContain('const roomState = {');
    expect(coreSrc).toContain('const MODEL_OPTIONS = {');
    expect(coreSrc).toContain('const ROOM_STATUS_ZH = {');
    for (const sym of CORE_FNS) expect(coreSrc, `${CORE_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 跨区依赖经 core 桥转发调用（第12批起桥条目改 window.PanelRoomsEvents 懒转发，消费侧不变）
    expect(coreSrc).toContain('core.handleRoomEvent(JSON.parse(ev.data))');
    // 第11批：renderRoomDebate 已外迁 rooms-debate-ui → selectRoom 改 window 懒解析
    expect(coreSrc).toContain('window.PanelRoomsDebate?.renderRoomDebate?.(r.room)');
    expect(coreSrc).toContain('core.state.activeId');
  });

  it('rooms-members-ui 存在、走 PanelCore 桥、暴露 window.PanelRoomsMembers 全部公开符号', () => {
    expect(membersSrc).toContain('window.PanelCore');
    expect(membersSrc).toContain('window.PanelRoomsMembers = {');
    for (const sym of MEMBERS_FNS) expect(membersSrc, `${MEMBERS_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 缓存 let 经 getter 实时暴露 + roomSkillsLoaded 保留可写代理（agent-graph-ui 经 PanelCore set 桥写 false）
    expect(membersSrc).toContain('get roomProvidersCache() { return roomProvidersCache; }');
    expect(membersSrc).toContain('get roomSkillsCache() { return roomSkillsCache; }');
    expect(membersSrc).toContain('get roomSkillsLoaded() { return roomSkillsLoaded; }');
    expect(membersSrc).toContain('setRoomSkillsLoaded(v) { roomSkillsLoaded = v; }');
    // 状态必须经 core.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(membersSrc.replace(/core\.roomState\./g, '')), `${MEMBERS_FILE} 裸引 roomState`).toBe(false);
    // MODEL_OPTIONS 经 core 实时取（本体在 rooms-core-ui）
    expect(membersSrc).toContain('core.MODEL_OPTIONS?.[m.adapterId]');
  });

  it('main.js import 第10批两模块（带 cache-bust），且先于快照消费者 autopilot/room-adapter/agent-graph', () => {
    expect(mainJs).toContain("./src/web/rooms-core-ui.js?v=appjs-migration-batch10-20260610");
    expect(mainJs).toContain("./src/web/rooms-members-ui.js?v=appjs-migration-batch10-20260610");
    const coreIdx = mainJs.indexOf('rooms-core-ui.js');
    const membersIdx = mainJs.indexOf('rooms-members-ui.js');
    for (const consumer of ['autopilot-ui.js', 'room-adapter-ui.js', 'summary-report-ui.js', 'agent-graph-ui.js']) {
      expect(coreIdx, `rooms-core-ui 必须先于 ${consumer} import（boot 快照时序）`).toBeLessThan(mainJs.indexOf(consumer));
    }
    expect(coreIdx).toBeLessThan(membersIdx);
  });

  it('app.js 不再保留两节实现，只留外迁标记', () => {
    for (const gone of [
      'const roomState = {',
      'const MODEL_OPTIONS = {',
      'const ROOM_STATUS_ZH = {',
      ...CORE_FNS.map((f) => `function ${f}(`),
      ...MEMBERS_FNS.map((f) => `function ${f}(`),
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第10批）==========/g)?.length).toBe(3);
  });

  it('PanelCore 桥：roomState/核心群/成员群改 window 懒转发，roomSkillsLoaded 保留可写代理', () => {
    expect(appJs).toContain('get roomState() { return window.PanelRoomsCore?.roomState; }');
    expect(appJs).toContain('showRoomArea: (...a) => window.PanelRoomsCore?.showRoomArea?.(...a),');
    expect(appJs).toContain('loadRooms: (...a) => window.PanelRoomsCore?.loadRooms?.(...a),');
    expect(appJs).toContain('selectRoom: (...a) => window.PanelRoomsCore?.selectRoom?.(...a),');
    expect(appJs).toContain('refreshRoomProviders: (...a) => window.PanelRoomsMembers?.refreshRoomProviders?.(...a),');
    expect(appJs).toContain('renderRoomMembers: (...a) => window.PanelRoomsMembers?.renderRoomMembers?.(...a),');
    expect(appJs).toContain('startElapsedTicker: (...a) => window.PanelRoomsMembers?.startElapsedTicker?.(...a),');
    expect(appJs).toContain('refreshRoomSkills: (...a) => window.PanelRoomsMembers?.refreshRoomSkills?.(...a),');
    expect(appJs).toContain('get MODEL_OPTIONS() { return window.PanelRoomsCore?.MODEL_OPTIONS; }');
    expect(appJs).toContain('get roomSkillsCache() { return window.PanelRoomsMembers?.roomSkillsCache; }');
    expect(appJs).toContain('get roomProvidersCache() { return window.PanelRoomsMembers?.roomProvidersCache; }');
    expect(appJs).toContain('get roomSkillsLoaded() { return window.PanelRoomsMembers?.roomSkillsLoaded; }');
    expect(appJs).toContain('set roomSkillsLoaded(v) { window.PanelRoomsMembers?.setRoomSkillsLoaded?.(v); }');
    // 第10批新增直引（函数声明 hoist）+ handleRoomEvent 转发（第12批本体随 rooms-events-ui 出走改 window 懒转发）
    expect(appJs).toContain('hasOwnerToken, renderOwnerTokenMissingBanner, confirmModal, shortenPath, wsUrl,');
    expect(appJs).toContain('handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),');
  });

  it('app.js 残留调用点全部改 window 懒解析，无裸调用/裸引 roomState', () => {
    // roomState 实时取（含 #btnArchiveNow / jumpToRoomSearchHit / createRoomFromTemplate 等区外点）
    expect(/(?<![.\w])roomState[.?]/.test(appJs.replace(/window\.PanelRoomsCore([?.]+)roomState/g, '_RS_')), 'app.js 裸引 roomState').toBe(false);
    // 绑定块第12批随 rooms-actions-ui 出走（仍 window 懒解析）
    const actionsSrc = read('public/src/web/rooms-actions-ui.js');
    expect(actionsSrc).toContain('$(\'#btnRoomBack\')?.addEventListener(\'click\', () => window.PanelRoomsCore?.hideRoomArea?.());');
    expect(actionsSrc).toContain("window.PanelRoomsCore?.createRoom?.('debate')");
    expect(actionsSrc).toContain('window.PanelRoomsCore?.loadRooms?.({ autoSelectRunning: true });');
    for (const fn of CORE_FNS) {
      expect(new RegExp(`[^.?\\w]${fn}\\(`).test(appJs), `app.js 裸调用 ${fn}(`).toBe(false);
    }
    for (const fn of MEMBERS_FNS) {
      expect(new RegExp(`[^.?\\w]${fn}\\(`).test(appJs), `app.js 裸调用 ${fn}(`).toBe(false);
    }
  });
});
