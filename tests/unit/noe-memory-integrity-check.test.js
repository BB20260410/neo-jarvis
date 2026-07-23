import { describe, it, expect } from 'vitest';
import { checkDanglingMergeRefs, runDanglingMergeRefCheck } from '../../src/memory/NoeMemoryIntegrityCheck.js';

describe('checkDanglingMergeRefs（P3-5 悬挂引用自检）', () => {
  it('merged_into 指向不存在 id → 悬挂', () => {
    const rows = [
      { id: 'a', merged_into: 'GONE' },
      { id: 'b' },
    ];
    const r = checkDanglingMergeRefs(rows);
    expect(r.ok).toBe(false);
    expect(r.danglingCount).toBe(1);
    expect(r.dangling[0]).toEqual({ id: 'a', missingTarget: 'GONE' });
  });

  it('merged_into 指向存在 id → 不悬挂', () => {
    const rows = [{ id: 'a', merged_into: 'b' }, { id: 'b' }];
    expect(checkDanglingMergeRefs(rows).ok).toBe(true);
  });

  it('从 hidden_reason 解析 merged_into:X', () => {
    const rows = [{ id: 'a', hidden_reason: 'merged_into: b9' }, { id: 'c' }];
    const r = checkDanglingMergeRefs(rows);
    expect(r.danglingCount).toBe(1);
    expect(r.dangling[0].missingTarget).toBe('b9');
  });

  it('无 merge 引用 → ok', () => {
    expect(checkDanglingMergeRefs([{ id: 'a' }, { id: 'b', hidden_reason: 'expired' }]).ok).toBe(true);
  });

  it('空输入 → ok scanned 0', () => {
    expect(checkDanglingMergeRefs([])).toMatchObject({ ok: true, scanned: 0, danglingCount: 0 });
  });
});

describe('runDanglingMergeRefCheck（只读 DB runner）', () => {
  it('无 db → no_db', () => {
    expect(runDanglingMergeRefCheck({}).reason).toBe('no_db');
  });
  it('查库跑检测', () => {
    const fakeDb = {
      prepare: () => ({ all: () => [{ id: 'a', merged_into: 'X', hidden_reason: null }, { id: 'b', merged_into: null, hidden_reason: null }] }),
    };
    const r = runDanglingMergeRefCheck({ db: fakeDb });
    expect(r.danglingCount).toBe(1);
    expect(r.dangling[0].missingTarget).toBe('X');
  });
  it('merged_into 列缺失 → 退回只查 hidden_reason', () => {
    let calls = 0;
    const fakeDb = {
      prepare: (sql) => ({
        all: () => {
          calls += 1;
          if (calls === 1 && sql.includes('merged_into')) throw new Error('no such column: merged_into');
          return [{ id: 'a', hidden_reason: 'merged_into:Z' }];
        },
      }),
    };
    const r = runDanglingMergeRefCheck({ db: fakeDb });
    expect(r.danglingCount).toBe(1);
    expect(r.dangling[0].missingTarget).toBe('Z');
  });
});
