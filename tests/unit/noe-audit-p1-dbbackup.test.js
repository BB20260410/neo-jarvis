// 审计 §3.3 P1① 测试：库备份与 files- 目录按统一 day 集合轮转（某天只有一侧时两侧保留同步）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupPanelDb, listBackups } from '../../src/storage/NoeDbBackup.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-bak-p1-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('§3.3 P1① 库与 files- 统一 day 轮转', () => {
  it('某天只有 files- 目录（库缺）时，轮转后两侧保留相同的最近 keep 天', async () => {
    const dir = join(tmp, 'backups');
    const fakeHome = join(tmp, 'home'); // 隔离 stateDir，避免碰真实 ~/.noe-panel
    mkdirSync(fakeHome, { recursive: true });

    // 建 3 天完整备份（库 + files-）
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
      await backupPanelDb({ dir, keep: 2, stateDir: fakeHome, now: () => new Date(`${day}T12:00:00`) });
    }
    // 模拟某更早天库备份失败：只留一个孤立 files- 目录
    mkdirSync(join(dir, 'files-2026-05-31'), { recursive: true });

    // 再跑一次（同 06-03 覆盖），触发统一轮转
    await backupPanelDb({ dir, keep: 2, stateDir: fakeHome, now: () => new Date('2026-06-03T13:00:00') });

    const libDays = listBackups({ dir }).map((b) => b.day).sort();
    const fileDays = readdirSync(dir)
      .filter((f) => /^files-\d{4}-\d{2}-\d{2}$/.test(f))
      .map((f) => f.replace('files-', ''))
      .sort();

    expect(libDays).toEqual(['2026-06-02', '2026-06-03']); // 最近 keep=2 天
    expect(fileDays).toEqual(libDays);                      // files- 与库保留完全相同的天（孤立 05-31 已删）
  });
});
