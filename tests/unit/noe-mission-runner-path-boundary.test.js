import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { NoeMissionRunner } from '../../src/runtime/mission/NoeMissionRunner.js';

// P0：NoeMissionRunner.js verify_file_exists 前缀越界修复（带尾分隔符比对，防 /root 放行 /root-evil）。

describe('P0 NoeMissionRunner verify_file_exists 前缀越界', () => {
  it('root 内合法文件 → ok；兄弟前缀逃逸(<root>-evil)即便文件真存在也被拒', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-mr-'));
    const evil = `${root}-evil`;
    try {
      const runner = new NoeMissionRunner({ root });
      writeFileSync(join(root, 'real.txt'), 'x');
      const okR = await runner.defaultExecutor({ mission: {}, state: {}, action: { type: 'verify_file_exists', path: 'real.txt' }, runner });
      expect(okR.ok).toBe(true);

      // 兄弟前缀逃逸：resolve(root, '../<base>-evil/x.txt') = <root>-evil/x.txt，文件真实存在。
      // 旧 `file.startsWith(this.root)` 会误放行；修复后带尾分隔符 → 拒绝。
      mkdirSync(evil, { recursive: true });
      writeFileSync(join(evil, 'x.txt'), 'x');
      const ref = `../${basename(evil)}/x.txt`;
      await expect(
        runner.defaultExecutor({ mission: {}, state: {}, action: { type: 'verify_file_exists', path: ref }, runner }),
      ).rejects.toThrow(/verify_file_missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(evil, { recursive: true, force: true });
    }
  });

  it('root 内软链指向外部文件 → realpath 边界拒（多模型 review：防外部文件冒充合法证据）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-mr-sym-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-out-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'x');
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt')); // root 内软链 → 外部
      const runner = new NoeMissionRunner({ root });
      await expect(
        runner.defaultExecutor({ mission: {}, state: {}, action: { type: 'verify_file_exists', path: 'link.txt' }, runner }),
      ).rejects.toThrow(/verify_file_missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
