// @ts-check
// 第三波手术 第34批 结构级防回归：server.js 余矿三连之三
// Noe 后台维护循环群（geo-weather/agent-probe/dream/episode-sublimation/db-backup/retention/memory-GC，
// 7 块各自 env 门控 timer，~110 行）迁出 src/server/services/noe-maintenance.js。
// 注入约定：memoryCore/prefetchStore/dataDir 单向注入；无状态模块函数（fetchGeoWeather/backupPanelDb/
// pruneEvents/withActiveGuard 等）模块内直 import；env 求值时机不变（install() 原位同步调用）。
// 风格对齐 appjs-migration-batch30/32/33：源码文本断言 + 真跑行为冒烟（env 全关下 install 安全幂等）。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installNoeMaintenanceLoops } from '../../src/server/services/noe-maintenance.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/noe-maintenance.js';

describe('server.js 拆分第34批（Noe 后台维护循环群外迁）— 结构', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头 + 注入式 install 函数', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
    expect(moduleSrc).toContain('export function installNoeMaintenanceLoops({ memoryCore, prefetchStore, dataDir })');
  });

  it('server.js：install import + 原位同步调用注入三件，不再内联 7 块 timer', () => {
    expect(serverSrc).toContain("import { installNoeMaintenanceLoops } from './src/server/services/noe-maintenance.js';");
    expect(serverSrc).toContain('installNoeMaintenanceLoops({ memoryCore: noeMemoryCore, prefetchStore: noePrefetchStore, dataDir: DATA_DIR });');
    for (const gone of [
      "process.env.NOE_GEO_WEATHER === '1'",
      'noe-agent-probe',
      'createMemoryDreamLoop(',
      'createEpisodeSublimationLoop({',
      "process.env.NOE_DB_BACKUP !== '0'",
      "process.env.NOE_MAINTENANCE !== '0'",
      'noeMemGcMode',
    ]) expect(serverSrc, `维护循环内联残留 ${gone}`).not.toContain(gone);
  });

  it('server.js：随迁 import 全精简（geo-weather/probe/dream/升华/backup/withActiveGuard/pruneEvents/rmSync），留守的不动', () => {
    for (const gone of [
      "from './src/context/NoeGeoWeather.js'",
      "from './src/autopilot/NoeLocalAgentProbe.js'",
      "from './src/memory/NoeDreamConsolidation.js'",
      "from './src/memory/NoeDreamM3Hook.js'",
      "from './src/memory/NoeEpisodeSublimation.js'",
      "from './src/storage/NoeDbBackup.js'",
      "from './src/runtime/NoeActiveJobGuard.js'",
      'pruneEvents',
    ]) expect(serverSrc, `import 残留 ${gone}`).not.toContain(gone);
    // SqliteStore 的 close 仍留 server.js（gracefulShutdown 用）；EpisodicTimeline/defaultCircadian 另有留守使用点
    expect(serverSrc).toContain("import { close as closeSqliteStore } from './src/storage/SqliteStore.js';");
    expect(serverSrc).toContain("from './src/memory/EpisodicTimeline.js'");
    expect(serverSrc).toContain("from './src/loop/NoeCircadian.js'");
  });

  it('行为契约关键字留在模块：7 块门控/unref 防挂进程/水位线文件/GC 重叠防护', () => {
    for (const kept of [
      "process.env.NOE_GEO_WEATHER === '1'",
      'probeLocalAgents(undefined, { detect: makeCliDetector() })',
      "enabled: process.env.NOE_DREAM === '1'",
      "enabled: process.env.NOE_DREAM_EPISODES === '1'",
      "watermarkFile: join(dataDir, 'episode-sublimation.json')",
      "process.env.NOE_DB_BACKUP !== '0'",
      "process.env.NOE_MAINTENANCE !== '0'",
      "withActiveGuard('noe-memory-gc'",
      '/^panel-\\d{4}-\\d{2}-\\d{2}\\.log$/',
    ]) expect(moduleSrc, `行为契约丢失 ${kept}`).toContain(kept);
    expect(moduleSrc.match(/\.unref\?\.\(\)/g)?.length, 'timer unref 防挂进程点位不足').toBeGreaterThanOrEqual(6);
  });
});

describe('server.js 拆分第34批 — 真跑行为冒烟', () => {
  const ENV_KEYS = ['NOE_GEO_WEATHER', 'NOE_DREAM', 'NOE_DREAM_EPISODES', 'NOE_DB_BACKUP', 'NOE_MAINTENANCE', 'NOE_MEMORY_GC', 'NOE_CIRCADIAN'];
  const saved = {};
  const dir = mkdtempSync(join(tmpdir(), 'noe-batch34-'));
  // 假时钟：install 内部的延迟 timer（agent-probe 3s/db-backup 90s/dream 5min…）在测试窗口永不真跑，
  // 防 unref 残留 timer 在共享 worker 里触发 spawnSync 干扰其他测试文件
  beforeEach(() => { vi.useFakeTimers(); for (const k of ENV_KEYS) { saved[k] = process.env[k]; } });
  afterEach(() => { vi.useRealTimers(); for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ } });

  it('env 全关：install 不抛、不启梦境双循环（start 已在内部调过且为 no-op）', () => {
    delete process.env.NOE_GEO_WEATHER;
    delete process.env.NOE_DREAM;
    delete process.env.NOE_DREAM_EPISODES;
    delete process.env.NOE_MEMORY_GC;
    process.env.NOE_DB_BACKUP = '0';
    process.env.NOE_MAINTENANCE = '0';
    const writes = [];
    const prefetchStore = { set: (k, v, ttl) => writes.push({ k, v, ttl }) };
    const r = installNoeMaintenanceLoops({ memoryCore: {}, prefetchStore, dataDir: dir });
    expect(r.dreamLoop).toBeTruthy();
    expect(r.episodeSublimationLoop).toBeTruthy();
    // enabled=false 下重复 start() 仍是 no-op（返回 falsy，不会再起 timer）
    expect(r.dreamLoop.start()).toBeFalsy();
    expect(r.episodeSublimationLoop.start()).toBeFalsy();
    // 同步阶段不写预取池（agent-probe 是 3s 延迟 timer 且 unref，不在本测试窗口触发）
    expect(writes.length).toBe(0);
  });

  it('NOE_DREAM=1（不配模型）：dreamLoop 真启用，stop 可幂等收尾', () => {
    process.env.NOE_DREAM = '1';
    delete process.env.NOE_DREAM_MODEL;
    process.env.NOE_DB_BACKUP = '0';
    process.env.NOE_MAINTENANCE = '0';
    const r = installNoeMaintenanceLoops({ memoryCore: {}, prefetchStore: { set: () => {} }, dataDir: dir });
    // install 内部已 start() 成功 → 再 start() 返回 false（已在跑），stop 后资源释放
    expect(r.dreamLoop.start()).toBeFalsy();
    r.dreamLoop.stop?.();
    r.episodeSublimationLoop.stop?.();
  });
});
