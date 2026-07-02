// @ts-check
// 第三波手术 第30批 结构级防回归：server.js 二轮拆分热身矿③
// sessions 持久化群（debouncedSave/saveData/loadData，~115 行）迁出
// src/server/services/session-persistence.js，工厂注入 { sessions, dataFile }。
// sessions Map 本体留守 server.js（单一属主）；saveTimer 去抖态收进工厂闭包；
// 既有注入点（registerSessionsCoreRoutes/Continuum/Extras、persistSession、gracefulShutdown）走解构 const，零改。
// 风格对齐 appjs-migration-batch28/29：源码文本断言 + 真跑行为冒烟（落盘往返/截断映射/损坏备份）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSessionPersistence } from '../../src/server/services/session-persistence.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/session-persistence.js';

describe('server.js 拆分第30批（sessions 持久化外迁）— 结构', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头 + 注入式工厂', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
    expect(moduleSrc).toContain('export function createSessionPersistence({ sessions, dataFile })');
  });

  it('server.js：sessions Map 留守 + 工厂解构 + 启动即 loadData()，不再内联实现', () => {
    expect(serverSrc).toContain('const sessions = new Map();');
    expect(serverSrc).toContain("import { createSessionPersistence } from './src/server/services/session-persistence.js';");
    expect(serverSrc).toContain('const { debouncedSave, saveData, loadData } = createSessionPersistence({ sessions, dataFile: DATA_FILE });');
    expect(serverSrc).toContain('loadData();');
    expect(serverSrc).not.toContain('function saveData()');
    expect(serverSrc).not.toContain('function loadData()');
    expect(serverSrc).not.toContain('function debouncedSave()');
    expect(serverSrc).not.toContain('let saveTimer');
  });

  it('server.js：既有使用点全保留（路由注入/persistSession/优雅关停双保存）', () => {
    expect(serverSrc).toContain('persistSession: () => saveData(),');
    expect(serverSrc.match(/debouncedSave[,)]/g)?.length, 'debouncedSave 注入点丢失').toBeGreaterThanOrEqual(2);
    expect(serverSrc.match(/\bsaveData\(\)/g)?.length, 'gracefulShutdown 双保存丢失').toBeGreaterThanOrEqual(2);
  });

  it('server.js：随迁 fs 函数（write/read/copy/chmod/rename FileSync）已从 import 精简，留守的不动', () => {
    const fsImport = serverSrc.split('\n').find((l) => l.includes("} from 'fs';"));
    expect(fsImport).toBeTruthy();
    // 第34批补遗：rmSync 随 Noe 维护循环群（旧日志清理）迁出 noe-maintenance.js，从留守清单转入随迁清单
    for (const gone of ['readFileSync', 'writeFileSync', 'copyFileSync', 'chmodSync', 'renameSync', 'rmSync']) {
      expect(fsImport, `fs import 残留 ${gone}`).not.toContain(gone);
    }
    for (const kept of ['readdirSync', 'statSync', 'mkdirSync', 'existsSync', 'unlinkSync']) {
      expect(fsImport, `fs import 丢失 ${kept}`).toContain(kept);
    }
  });

  it('行为契约关键字留在模块：原子写/0o600/截断 200/加载 cap 500/损坏备份', () => {
    expect(moduleSrc).toContain("const tmp = dataFile + '.tmp';");
    expect(moduleSrc).toContain('{ mode: 0o600 }');
    expect(moduleSrc).toContain('const KEEP = 200;');
    expect(moduleSrc).toContain('data.length > 500');
    expect(moduleSrc).toContain(".corrupted-' + Date.now() + '.bak'");
    expect(moduleSrc).toContain('setTimeout(saveData, 500)');
  });
});

describe('server.js 拆分第30批 — 真跑行为冒烟', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noe-batch30-'));
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ } });

  it('save → load 往返：字段全保真 + runtime 态重置（child/pid/busy/clients）', () => {
    const dataFile = join(dir, 'data.json');
    const sessions = new Map();
    const { saveData } = createSessionPersistence({ sessions, dataFile });
    sessions.set('s1', {
      id: 's1', name: '会话一', cwd: '/tmp', claudeSessionId: 'c1', createdAt: '2026-06-11T00:00:00Z',
      child: { fake: true }, pid: 123, busy: true, clients: new Set(['x']),
      messages: [{ role: 'user', text: 'hi' }], starredIndices: [0],
      mainGoal: 'g', runState: 'running', guardLevel: 'strict', model: 'opus',
      costTracker: { totalUSD: () => 1.5 },
      watcherEnabled: true, watcherProviderId: 'w', hookEvents: [{ k: 1 }],
    });
    saveData();
    expect(existsSync(dataFile)).toBe(true);
    expect(existsSync(dataFile + '.tmp'), '原子写残留 tmp').toBe(false);
    const restored = new Map();
    createSessionPersistence({ sessions: restored, dataFile }).loadData();
    const s = restored.get('s1');
    expect(s.name).toBe('会话一');
    expect(s.messages).toEqual([{ role: 'user', text: 'hi' }]);
    expect(s.starredIndices).toEqual([0]);
    expect(s.runState).toBe('running');
    expect(s.watcherEnabled).toBe(true);
    // runtime 态不持久化、加载即重置
    expect(s.child).toBe(null);
    expect(s.pid).toBe(null);
    expect(s.busy).toBe(false);
    expect(s.clients instanceof Set && s.clients.size === 0).toBe(true);
  });

  it('messages>200 截断 + starredIndices offset 映射 + runtime 同步 cap（Q-07 契约）', () => {
    const dataFile = join(dir, 'trunc.json');
    const sessions = new Map();
    const { saveData } = createSessionPersistence({ sessions, dataFile });
    const messages = Array.from({ length: 250 }, (_, i) => ({ i }));
    const s = { id: 't', name: 't', cwd: '/', messages, starredIndices: [10, 60, 249] };
    sessions.set('t', s);
    saveData();
    const onDisk = JSON.parse(readFileSync(dataFile, 'utf-8'))[0];
    expect(onDisk.messages.length).toBe(200);
    expect(onDisk.messages[0]).toEqual({ i: 50 });
    expect(onDisk.starredIndices).toEqual([10, 199]); // 10 越界丢弃，60→10，249→199
    expect(s.messages.length, 'runtime 未同步 cap').toBe(200);
  });

  it('data.json 损坏：备份 .corrupted-*.bak 且以空表运行（B-01 契约）', () => {
    const dataFile = join(dir, 'bad.json');
    writeFileSync(dataFile, '{ 不是 JSON');
    const sessions = new Map();
    createSessionPersistence({ sessions, dataFile }).loadData();
    expect(sessions.size).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith('bad.json.corrupted-') && f.endsWith('.bak'))).toBe(true);
  });

  it('debouncedSave 500ms 去抖：连发只落盘一次', async () => {
    const dataFile = join(dir, 'debounce.json');
    const sessions = new Map([['d', { id: 'd', name: 'd', cwd: '/', messages: [] }]]);
    const { debouncedSave } = createSessionPersistence({ sessions, dataFile });
    debouncedSave(); debouncedSave(); debouncedSave();
    expect(existsSync(dataFile)).toBe(false); // 还在去抖窗口内
    await new Promise((r) => setTimeout(r, 700));
    expect(existsSync(dataFile)).toBe(true);
  });
});
