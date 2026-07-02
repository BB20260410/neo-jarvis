// 强健加固测试:MemoryCore.runGc({maxScan}) 入口校验。
// 覆盖:①非法 maxScan(负/NaN/小数/超大) 安全兜底,不崩溃、不击穿 OOM 防护;
//      ②合法 maxScan(正整数) 行为与加固前逐字等价(零回归)。
// 确定性:临时 SQLite 库,不触网/不依赖真实时钟外部状态。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;
let core;
const past = Date.now() - 100000;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-gc-maxscan-'));
  initSqlite(join(tmp, 'panel.db'));
  core = new MemoryCore();
  // 5 条过期记忆(都应进 GC 候选)
  for (let i = 0; i < 5; i++) core.write({ id: `e${i}`, body: `过期${i}`, expiresAt: past });
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('runGc maxScan 入口校验(强健)', () => {
  it('NaN maxScan 不再抛 datatype mismatch,安全跑完(回退默认上限,扫到全部)', () => {
    // 加固前:LIMIT NaN → SQLite 抛 "datatype mismatch" 崩溃
    expect(() => core.runGc({ maxScan: NaN })).not.toThrow();
    const r = core.runGc({ maxScan: NaN });
    expect(r.plan.gcCandidates).toHaveLength(5);   // 5<默认上限 → 不截断、全部入候选
    expect(r.truncated).toBe(false);
  });

  it('负 maxScan 不再无限扫描/错切,安全钳为正整数(=1,正常截断而非击穿防护)', () => {
    // 加固前:LIMIT -4 = 无限SELECT*(OOM防护失效) + rows.slice(0,-5) 错切
    const r = core.runGc({ maxScan: -5 });
    expect(r.truncated).toBe(true);                // 钳为 1 → 5>1 截断
    expect(r.plan.gcCandidates.length).toBeLessThanOrEqual(1); // 单轮只扫 1 条,未无限放行
  });

  it('小数 maxScan 被 trunc 成整数(2.9→2),行为与整数 2 一致', () => {
    const frac = core.runGc({ maxScan: 2.9 });
    const int2 = core.runGc({ maxScan: 2 });
    expect(frac.truncated).toBe(int2.truncated);
    expect(frac.plan.gcCandidates.length).toBe(int2.plan.gcCandidates.length);
  });

  it('合法正整数 maxScan 行为逐字等价(零回归):截断语义与扫描条数不变', () => {
    const r2 = core.runGc({ maxScan: 2 });
    expect(r2.truncated).toBe(true);              // 5>2 截断,与加固前一致
    const rBig = core.runGc({ maxScan: 10000 });  // 默认量级
    expect(rBig.truncated).toBe(false);
    expect(rBig.plan.gcCandidates).toHaveLength(5);
  });

  it('apply=true 配合合法 maxScan 真 hide 候选(正常路径零回归)', () => {
    const r = core.runGc({ apply: true, maxScan: 10000 });
    expect(r.applied).toBe(true);
    expect(r.hidden.length).toBe(5);
    expect(core.get('e0')).toBeNull();                          // 已软删
    expect(core.get('e0', { includeHidden: true })).not.toBeNull(); // 可 unhide 恢复
  });
});
