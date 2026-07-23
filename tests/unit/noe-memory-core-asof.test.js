// @ts-check
// P1.1 P5 双时态 recall asOf：召回支持时间点查询——只返回 asOf 时刻有效的记忆（valid_from<=asOf<valid_to）。
//   反向 probe：asOf 落在老事实有效窗→只老；落在新事实窗→只新；不传 asOf→全召回（零回归）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp; let core;
beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-asof-'));
  initSqlite(join(tmp, 'panel.db'));
  core = new MemoryCore();
  // 老事实有效窗 [1000, 2000)；新事实有效窗 [2000, ∞)（valid_to=null）。
  core.write({ id: 'old', body: '首都记忆旧版本内容', validFrom: 1000, validTo: 2000 });
  core.write({ id: 'new', body: '首都记忆新版本内容', validFrom: 2000, validTo: null });
});
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('P1.1 P5 双时态 recall asOf', () => {
  it('asOf=1500（落在老事实窗内）→ 只召回 old；new 那时未生效（反向：机制失效则 new 也进）', () => {
    const ids = core.recall({ q: '首都记忆', asOf: 1500, includeExpired: true }).map((m) => m.id);
    expect(ids).toContain('old');
    expect(ids).not.toContain('new'); // new.valid_from=2000 > 1500，asOf 时未生效
  });

  it('asOf=2500（老事实已失效 valid_to=2000）→ 只召回 new；old 已过期（反向：机制失效则 old 也进）', () => {
    const ids = core.recall({ q: '首都记忆', asOf: 2500, includeExpired: true }).map((m) => m.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old'); // old.valid_to=2000 <= 2500，asOf 时已失效
  });

  it('边界：asOf=2000 恰为切换点 → old 失效(valid_to 闭区间外)、new 生效(valid_from 闭区间内)', () => {
    const ids = core.recall({ q: '首都记忆', asOf: 2000, includeExpired: true }).map((m) => m.id);
    expect(ids).not.toContain('old'); // valid_to>asOf 为 false（2000>2000=false）
    expect(ids).toContain('new');     // valid_from<=asOf 为 true（2000<=2000）
  });

  it('零回归：不传 asOf → 两条都召回（默认行为不变）', () => {
    const ids = core.recall({ q: '首都记忆', includeExpired: true }).map((m) => m.id);
    expect(ids).toContain('old');
    expect(ids).toContain('new');
  });
});
