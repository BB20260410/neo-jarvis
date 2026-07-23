// @ts-check
// P0.5 emergency stop 测试：① readEmergencyStop 信号判定(env/file/无信号-零回归) ② emergencyStopShouldSkip
//   自主 vs 基础设施区分 ③ heartbeat 集成【反向 probe】：停机时自主 kind(selfEvolve 自改)被跳过、基础设施
//   kind(maintenance)仍跑、游标仍前进；正向对照证明"不跑"是急停所致非永远不跑。
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEmergencyStop, emergencyStopShouldSkip, EMERGENCY_STOP_INFRA_KINDS } from '../../src/security/NoeEmergencyStop.js';
import { createHeartbeat } from '../../src/loop/NoeHeartbeat.js';
import { registerNoeEmergencyStopRoutes } from '../../src/server/routes/noeEmergencyStop.js';

const tmpDirs = [];
function tmpStopFile() { const d = mkdtempSync(join(tmpdir(), 'noe-estop-')); tmpDirs.push(d); return join(d, 'EMERGENCY_STOP'); }
afterEach(() => { while (tmpDirs.length) { try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* best-effort */ } } });

describe('NoeEmergencyStop 信号判定', () => {
  it('env NOE_EMERGENCY_STOP=1 → stopped(source=env，不依赖 IO 的可靠强停)', () => {
    const s = readEmergencyStop({ env: { NOE_EMERGENCY_STOP: '1' }, stopFile: tmpStopFile() });
    expect(s.stopped).toBe(true);
    expect(s.source).toBe('env');
  });
  it('停机文件存在 → stopped(source=file，reason 含文件内容)', () => {
    const f = tmpStopFile();
    writeFileSync(f, 'owner 手动急停 2026-06-22');
    const s = readEmergencyStop({ env: {}, stopFile: f });
    expect(s.stopped).toBe(true);
    expect(s.source).toBe('file');
    expect(s.reason).toContain('急停');
  });
  it('两信号都无 → not stopped(默认零回归，正常自主照跑)', () => {
    expect(readEmergencyStop({ env: {}, stopFile: tmpStopFile() }).stopped).toBe(false);
  });
  it('反向:env 非"1"(如 "0"/"") → 不误停', () => {
    expect(readEmergencyStop({ env: { NOE_EMERGENCY_STOP: '0' }, stopFile: tmpStopFile() }).stopped).toBe(false);
    expect(readEmergencyStop({ env: { NOE_EMERGENCY_STOP: '' }, stopFile: tmpStopFile() }).stopped).toBe(false);
  });
});

describe('emergencyStopShouldSkip 自主 vs 基础设施', () => {
  const STOP = { stopped: true, source: 'file', reason: 'x' };
  it('停机 + 自主 kind(selfEvolve/proactive/innerReflect/expectation) → 跳过', () => {
    for (const k of ['selfEvolve', 'proactive', 'innerReflect', 'expectation']) {
      expect(emergencyStopShouldSkip(k, STOP)).toBe(true);
    }
  });
  it('停机 + 基础设施 kind(maintenance/wallGuard/…) → 不跳过(保留健康监控)', () => {
    for (const k of EMERGENCY_STOP_INFRA_KINDS) {
      expect(emergencyStopShouldSkip(k, STOP)).toBe(false);
    }
  });
  it('反向:未停机 → 任何 kind 都不跳过(零回归)', () => {
    expect(emergencyStopShouldSkip('selfEvolve', { stopped: false })).toBe(false);
    expect(emergencyStopShouldSkip('selfEvolve', null)).toBe(false);
  });
});

// 内存版 store（忠实模拟 NoeHeartbeatStore 语义），不 mock 被测的跳过逻辑本身——只注入信号源与 store。
function makeStore() {
  const cursors = new Map(); const ticks = []; let id = 0;
  return {
    cursor(k) { return cursors.get(k) || null; },
    allCursors() { return [...cursors.values()]; },
    ensureCursor(k, c, n) { if (!cursors.has(k)) cursors.set(k, { kind: k, next_due: n + c, cadence_ms: c }); return cursors.get(k); },
    dueCursors(n) { return [...cursors.values()].filter((c) => c.next_due <= n); },
    advanceCursor(k, nd) { const c = cursors.get(k); if (c) c.next_due = nd; },
    beginTick(k) { ticks.push({ id: ++id, kind: k, status: 'running' }); return id; },
    finishTick(tid, o) { const t = ticks.find((x) => x.id === tid); if (t) { t.status = 'done'; t.outcome = o; } },
    failTick(tid, e) { const t = ticks.find((x) => x.id === tid); if (t) { t.status = 'failed'; t.error = e; } },
    markCoalesced() {}, recoverDeadTicks() { return 0; }, bootLagMs() { return 0; },
  };
}
const noopTimer = { setTimer: () => ({ unref() {} }), clearTimer: () => {} };

describe('P0.5 反向 probe：emergency stop 真停自主作业(heartbeat 集成)', () => {
  it('停机时 selfEvolve(自改)被跳过、maintenance(基础设施)仍跑——跳过逻辑被移除则 ran 含 selfEvolve→红', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({
      store, now: () => t, ...noopTimer,
      emergencyStop: () => ({ stopped: true, source: 'file', reason: 'test 急停' }),
    });
    hb.register('selfEvolve', { cadenceMs: 1000, run: () => ran.push('selfEvolve') });
    hb.register('maintenance', { cadenceMs: 1000, run: () => ran.push('maintenance') });
    hb.start();
    t = 1_001_000; // 两 kind 都到期
    await hb.pumpOnce();
    expect(ran).not.toContain('selfEvolve'); // 反向核心：急停绝不能让自改跑
    expect(ran).toContain('maintenance');    // 基础设施保留
    expect(store.cursor('selfEvolve').next_due).toBe(t + 1000); // 跳过仍推游标，防解除后疯狂补账
    hb.stop();
  });

  it('正向对照:未停机时 selfEvolve 正常跑(证明上面的"不跑"是急停所致，非永远不跑)', async () => {
    let t = 1_000_000;
    const store = makeStore();
    const ran = [];
    const hb = createHeartbeat({
      store, now: () => t, ...noopTimer,
      emergencyStop: () => ({ stopped: false, source: '', reason: '' }),
    });
    hb.register('selfEvolve', { cadenceMs: 1000, run: () => ran.push('selfEvolve') });
    hb.start();
    t = 1_001_000;
    await hb.pumpOnce();
    expect(ran).toContain('selfEvolve');
    hb.stop();
  });
});

describe('P0.5 emergency stop HTTP 控制(owner 一键)', () => {
  function captureApp() {
    const routes = {};
    return {
      get(p, ...h) { routes['GET ' + p] = h[h.length - 1]; },   // 末位=真 handler(跳过 requireOwnerToken 中间件)
      post(p, ...h) { routes['POST ' + p] = h[h.length - 1]; },
      routes,
    };
  }
  function fakeRes() { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }

  it('POST on 写信号文件→stopped；GET 查到 stopped；POST off 删文件→not stopped', () => {
    const stopFile = tmpStopFile();
    const app = captureApp();
    registerNoeEmergencyStopRoutes(app, { stopFile, now: () => new Date('2026-06-22T00:00:00Z') });

    let res = fakeRes();
    app.routes['POST /api/noe/emergency-stop']({ body: { on: true, reason: 'test 急停' } }, res);
    expect(res.body.stopped).toBe(true);
    expect(existsSync(stopFile)).toBe(true); // 真写了信号文件

    res = fakeRes();
    app.routes['GET /api/noe/emergency-stop']({}, res);
    expect(res.body.stopped).toBe(true);

    res = fakeRes();
    app.routes['POST /api/noe/emergency-stop']({ body: { on: false } }, res);
    expect(res.body.stopped).toBe(false);
    expect(existsSync(stopFile)).toBe(false); // 真删了信号文件
  });
});
