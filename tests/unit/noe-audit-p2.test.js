// 审计 §3.3 P2①② 测试：ContextBudgeter running used、SqliteStore appendEvent statement 缓存按 db 失效
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContextComposer } from '../../src/context/NoeContextBudgeter.js';
import { close, initSqlite, appendEvent, countEvents } from '../../src/storage/SqliteStore.js';

describe('§3.3 P2① ContextBudgeter running usedTokens', () => {
  it('预算内 usedTokens > 0 且无丢弃', () => {
    const c = createContextComposer({ budgetTokens: 10_000 });
    c.add('a', '甲段甲段');
    c.add('b', '乙段');
    const r = c.compose();
    expect(r.dropped).toEqual([]);
    expect(r.usedTokens).toBeGreaterThan(0);
  });

  it('drop 后 usedTokens 精确等于只保留存活段重算的值（running used 正确）', () => {
    const c = createContextComposer({ budgetTokens: 30 });
    c.add('v', 'V'.repeat(60), { keep: 8 });
    c.add('n', 'N'.repeat(60), { keep: 2 });
    const r = c.compose(); // 丢 n，保留 v
    expect(r.dropped).toContain('n');

    const ref = createContextComposer({ budgetTokens: 10_000 });
    ref.add('v', 'V'.repeat(60), { keep: 8 });
    const refR = ref.compose();
    expect(r.usedTokens).toBe(refR.usedTokens); // running used 减去被丢段后 == 只含 v 的全量
  });
});

describe('§3.3 P2② appendEvent statement 缓存按 db 失效', () => {
  afterEach(() => { close(); });

  it('切库后 appendEvent 写入新库不报错（缓存重建）', () => {
    const d1 = mkdtempSync(join(tmpdir(), 'noe-evt1-'));
    const d2 = mkdtempSync(join(tmpdir(), 'noe-evt2-'));
    try {
      initSqlite(join(d1, 'a.db'));
      appendEvent({ kind: 'auditP2', n: 1 });
      appendEvent({ kind: 'auditP2', n: 2 }); // 复用缓存 statement
      expect(countEvents({ kind: 'auditP2' })).toBe(2);

      initSqlite(join(d2, 'b.db')); // 显式切库（旧连接 close，旧 statement 随之失效）
      expect(() => appendEvent({ kind: 'auditP2', n: 3 })).not.toThrow(); // 缓存按新 db 重建
      expect(countEvents({ kind: 'auditP2' })).toBe(1); // 新库只此 1 条，没串到旧库
    } finally {
      rmSync(d1, { recursive: true, force: true });
      rmSync(d2, { recursive: true, force: true });
    }
  });
});
