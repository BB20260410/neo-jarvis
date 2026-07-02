// 强健加固测试:NoeAffectEngine.history({sinceTs}) 入口校验。
// 覆盖:①非数字 sinceTs 不再静默清空透视页曲线(回退0=从头取全量);
//      ②合法数字 sinceTs 行为与加固前逐字等价(零回归)。
// 确定性:注入 now,临时 SQLite 库,不触网。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createAffectEngine } from '../../src/cognition/NoeAffectEngine.js';

let dir;
const T0 = 1_780_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-affect-hist-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  let t = T0;
  const engine = createAffectEngine({ now: () => t });
  engine.appraise({ goalCongruence: 1 }, { ts: t });
  t += 1000;
  engine.appraise({ novelty: 1 }, { ts: t });
  t += 1000;
  engine.appraise({ socialWarmth: 1 }, { ts: t });
  return engine;
}

describe('history sinceTs 入口校验(强健)', () => {
  it('非数字 sinceTs 不再静默返回空,回退0取全量(等价 sinceTs:0)', () => {
    const engine = seed();
    // 加固前:字符串 sinceTs 绑进 SQL → SQLite 字符串vs整数比较 → 静默 0 行(透视页清空)
    const bad = engine.history({ sinceTs: 'oops' });
    const fromZero = engine.history({ sinceTs: 0 });
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.length).toBe(fromZero.length);   // 非法输入回退到"从头取"
  });

  it('undefined/null sinceTs 走默认0(取全量)', () => {
    const engine = seed();
    expect(engine.history({}).length).toBe(engine.history({ sinceTs: 0 }).length);
    expect(engine.history({ sinceTs: null }).length).toBe(engine.history({ sinceTs: 0 }).length);
  });

  it('合法数字 sinceTs 行为逐字等价(零回归):按时间窗正确过滤', () => {
    const engine = seed();
    const all = engine.history({ sinceTs: 0 });
    expect(all.length).toBe(3);                                 // 三条快照全在
    const recent = engine.history({ sinceTs: T0 + 1500 });      // 只剩第3条(ts=T0+2000)
    expect(recent.length).toBe(1);
    expect(recent[0].ts).toBe(T0 + 2000);
    const future = engine.history({ sinceTs: T0 + 999999 });    // 窗口在所有数据之后
    expect(future.length).toBe(0);
  });

  it('limit clamp 与 sinceTs 校验并存,均生效', () => {
    const engine = seed();
    expect(engine.history({ sinceTs: 'bad', limit: 2 }).length).toBeLessThanOrEqual(2);
  });
});
