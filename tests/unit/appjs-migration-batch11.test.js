// @ts-check
// S24 模块化第11批（辩论渲染+轮次卡 → rooms-debate-ui.js + Squad 看板 → rooms-squad-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch10.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const DEBATE_FILE = 'public/src/web/rooms-debate-ui.js';
const SQUAD_FILE = 'public/src/web/rooms-squad-ui.js';

const DEBATE_FNS = [
  'renderRoomDebate', 'getRoundTitle', 'renderRounds', 'getCurrentRoomStatus',
  'renderTurnCard', 'retryTurn', 'ensureRoundCard',
];
const SQUAD_FNS = ['renderSquadKanban', 'retrySquadTask', 'openSquadDetail'];

describe('app.js 模块化第11批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const debateSrc = read(DEBATE_FILE);
  const squadSrc = read(SQUAD_FILE);

  it('rooms-debate-ui 存在、走 PanelCore 桥、暴露 window.PanelRoomsDebate 全部公开符号', () => {
    expect(debateSrc).toContain('window.PanelCore');
    expect(debateSrc).toContain('window.PanelRoomsDebate = {');
    expect(debateSrc).toContain('const ROUND_TITLES = {');
    for (const sym of DEBATE_FNS) expect(debateSrc, `${DEBATE_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 跨区依赖经 core 桥闭包转发调用（renderChatRoom/abortDebate 仍在 app.js，待后续批次）
    expect(debateSrc).toContain('core.renderChatRoom(room)');
    expect(debateSrc).toContain('core.abortDebate()');
    // 全局 Esc 结束辩论绑定随迁（boot 只跑一次保证只绑一次）
    expect(debateSrc).toContain("document.addEventListener('keydown', (e) => {");
    // squad 看板经 window 懒解析（两模块互不依赖 boot 顺序）
    expect(debateSrc).toContain('window.PanelRoomsSquad?.renderSquadKanban?.(room.taskList || [])');
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(debateSrc.replace(/core\.roomState\./g, '')), `${DEBATE_FILE} 裸引 roomState`).toBe(false);
  });

  it('rooms-squad-ui 存在、走 PanelCore 桥、暴露 window.PanelRoomsSquad 全部公开符号', () => {
    expect(squadSrc).toContain('window.PanelCore');
    expect(squadSrc).toContain('window.PanelRoomsSquad = {');
    expect(squadSrc).toContain("const SQUAD_COLS = ['pending', 'in_progress', 'in_review', 'done', 'escalated']");
    expect(squadSrc).toContain('const _squadTaskStartedAt = new Map()');
    for (const sym of SQUAD_FNS) expect(squadSrc, `${SQUAD_FILE} 缺 ${sym}`).toContain(`function ${sym}(`);
    // 缓存经 getter 实时暴露（handleRoomEvent 仍在 app.js，经 window 写 Map）
    expect(squadSrc).toContain('get squadCurrentTasks() { return squadCurrentTasks; }');
    expect(squadSrc).toContain('get _squadTaskStartedAt() { return _squadTaskStartedAt; }');
    // 跨模块/跨区依赖：getCurrentRoomStatus 经 window 懒解析；pullRoomAndRender 经 core 桥闭包转发
    expect(squadSrc).toContain("window.PanelRoomsDebate?.getCurrentRoomStatus?.() === 'running'");
    expect(squadSrc).toContain('core.pullRoomAndRender()');
    // 状态必须经 window.PanelRoomsCore.roomState 实时取，禁止裸引 roomState
    expect(/[^.]roomState\./.test(squadSrc.replace(/core\.roomState\./g, '')), `${SQUAD_FILE} 裸引 roomState`).toBe(false);
  });

  it('main.js import 第11批两模块（带 cache-bust）', () => {
    expect(mainJs).toContain("./src/web/rooms-debate-ui.js?v=appjs-migration-batch11-20260610");
    expect(mainJs).toContain("./src/web/rooms-squad-ui.js?v=appjs-migration-batch11-20260610");
  });

  it('app.js 不再保留两节实现，只留外迁标记', () => {
    for (const gone of [
      'const ROUND_TITLES = {',
      'const SQUAD_COLS = [',
      'const _squadTaskStartedAt = new Map(',
      'let squadCurrentTasks = [',
      ...DEBATE_FNS.map((f) => `function ${f}(`),
      ...SQUAD_FNS.map((f) => `function ${f}(`),
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第11批）==========/g)?.length).toBe(3);
  });

  it('PanelCore 桥：renderRoomDebate 改 window 懒转发 + renderChatRoom/abortDebate/pullRoomAndRender（第12批本体出走改 window 懒转发）+ escapeHtmlMl 直引', () => {
    expect(appJs).toContain('renderRoomDebate: (...a) => window.PanelRoomsDebate?.renderRoomDebate?.(...a),');
    expect(appJs).toContain('renderChatRoom: (...a) => window.PanelRoomsChat?.renderChatRoom?.(...a),');
    expect(appJs).toContain('abortDebate: (...a) => window.PanelRoomsActions?.abortDebate?.(...a),');
    expect(appJs).toContain('pullRoomAndRender: (...a) => window.PanelRoomsActions?.pullRoomAndRender?.(...a),');
    expect(appJs).toContain('escapeHtmlMl,');
  });

  it('外迁调用点全部走 window 懒解析，app.js 无裸调用（第12批起调用点随 rooms-events/actions-ui 出走）', () => {
    const eventsSrc = read('public/src/web/rooms-events-ui.js');
    // 第12批b：squad/cross_verify/cluster 三子函数（含 Squad 调用点）随 rooms-events-collab-ui 出走
    const eventsCollabSrc = read('public/src/web/rooms-events-collab-ui.js');
    const actionsSrc = read('public/src/web/rooms-actions-ui.js');
    // handleRoomEvent / pullRoomAndRender 内的辩论渲染/轮次卡/Squad 调用点
    expect(eventsSrc).toContain('window.PanelRoomsDebate?.renderRoomDebate?.(msg.room);');
    expect(eventsSrc.match(/window\.PanelRoomsDebate\?\.ensureRoundCard\?\.\(/g)?.length).toBe(8);
    expect(eventsSrc.match(/window\.PanelRoomsDebate\?\.renderTurnCard\?\.\(/g)?.length).toBe(3);
    expect(eventsCollabSrc).toContain('for (const c of (window.PanelRoomsSquad?.SQUAD_COLS || []))');
    expect(eventsCollabSrc).toContain('window.PanelRoomsSquad?.renderSquadKanban?.(msg.taskList);');
    expect(actionsSrc).toContain('window.PanelRoomsSquad?.renderSquadKanban?.(r.room.taskList || []);');
    expect(eventsCollabSrc.match(/window\.PanelRoomsSquad\?\._squadTaskStartedAt\?\.(set|delete)\(/g)?.length).toBe(6);
    for (const fn of [...DEBATE_FNS, ...SQUAD_FNS]) {
      expect(new RegExp(`[^.?\\w]${fn}\\(`).test(appJs), `app.js 裸调用 ${fn}(`).toBe(false);
    }
  });

  it('rooms-core-ui selectRoom 调辩论渲染改 window 懒解析（renderRoomDebate 已出 app.js）', () => {
    const coreSrc = read('public/src/web/rooms-core-ui.js');
    expect(coreSrc).toContain('window.PanelRoomsDebate?.renderRoomDebate?.(r.room)');
    expect(coreSrc).not.toContain('core.renderRoomDebate(');
  });
});
