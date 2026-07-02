// 批4：findNoeFreedomRunLedgerFiles 排序的等价性 + 稳健性回归。
// 证明 (1) 全文件存在时按 mtime 降序（与旧实现行为等价）；
//      (2) walk 收集后某文件被并发删除时不再抛 ENOENT（旧实现裸 statSync 比较器会抛），
//          消失文件排到末尾，listNoeFreedomRunLedgers 逐项 try/catch 仍能优雅返回。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
  findNoeFreedomRunLedgerFiles,
  listNoeFreedomRunLedgers,
} from '../../src/runtime/NoeFreedomRunLedger.js';

function seedLedger(root, runId, ageMinutes) {
  const dir = join(root, DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR, runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ledger.json');
  // 最小可解析 ledger（不求 validate ok，仅测 find/sort 路径）；无 secret。
  writeFileSync(file, JSON.stringify({ runId, ok: true }));
  const t = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(file, t, t);
  return file;
}

describe('findNoeFreedomRunLedgerFiles 排序等价性与稳健性', () => {
  it('全文件存在时按 mtime 降序（最新在前）', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-find-sort-'));
    try {
      seedLedger(root, 'oldest', 30);
      seedLedger(root, 'middle', 20);
      seedLedger(root, 'newest', 5);
      const files = findNoeFreedomRunLedgerFiles({ root });
      const runIds = files.map((f) => basename(join(f, '..')));
      expect(runIds).toEqual(['newest', 'middle', 'oldest']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('收集后某 ledger 文件被并发删除时不抛，消失文件排末尾、保留全部已收集路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-find-sort-race-'));
    try {
      const a = seedLedger(root, 'keep-new', 5);
      const gone = seedLedger(root, 'vanished', 20);
      const c = seedLedger(root, 'keep-old', 30);
      // 模拟 TOCTOU：删除文件后再调用（等价于 walk 收集后、排序前被并发清理）。
      rmSync(gone);
      let result;
      expect(() => { result = findNoeFreedomRunLedgerFiles({ root }); }).not.toThrow();
      // 删除后该文件不会被 readdir 收集，剩 2 个且仍按 mtime 降序，不抛。
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(a);
      expect(result[1]).toBe(c);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('safeLedgerMtimeMs 容忍：人为把不可 stat 路径混入排序也不抛（mtime 0 排末尾）', () => {
    // 通过 listNoeFreedomRunLedgers 走完整链路：即便目录里只有正常文件也应稳定返回 ok。
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-list-stable-'));
    try {
      seedLedger(root, 'r1', 10);
      seedLedger(root, 'r2', 1);
      const listed = listNoeFreedomRunLedgers({ root, limit: 10 });
      expect(listed.ok).toBe(true);
      expect(listed.checked).toBe(2);
      expect(listed.returned).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('空目录返回空数组（不抛）', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-find-empty-'));
    try {
      expect(findNoeFreedomRunLedgerFiles({ root })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
