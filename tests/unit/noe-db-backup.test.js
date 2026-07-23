import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { backupPanelDb, listBackups } from '../../src/storage/NoeDbBackup.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';

// 强健② 测试：panel.db 在线快照备份 + 轮转 + 备份可恢复（真 SQLite 端到端）。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-bak-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('backupPanelDb', () => {
  it('在线快照：备份文件可独立打开且数据完整（含 WAL 未 checkpoint 内容）', async () => {
    const core = new MemoryCore({ logger: null });
    core.write({ id: 'precious', body: '这是必须备份住的珍贵记忆' });
    const dir = join(tmp, 'backups');
    const r = await backupPanelDb({ dir, now: () => new Date('2026-06-10T12:00:00') });
    expect(r.ok).toBe(true);
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.path).toContain('panel-2026-06-10.db');
    // 用独立连接打开备份验证数据真在
    const bak = new Database(r.path, { readonly: true });
    const row = bak.prepare("SELECT body FROM noe_memory WHERE id='precious'").get();
    bak.close();
    expect(row.body).toContain('珍贵记忆');
  });

  it('同日重复跑覆盖为最新（不堆文件）', async () => {
    const dir = join(tmp, 'backups');
    const now = () => new Date('2026-06-10T08:00:00');
    await backupPanelDb({ dir, now });
    const core = new MemoryCore({ logger: null });
    core.write({ id: 'later', body: '上午之后新增的记忆' });
    await backupPanelDb({ dir, now });
    const list = listBackups({ dir });
    expect(list).toHaveLength(1);
    const bak = new Database(list[0].path, { readonly: true });
    expect(bak.prepare("SELECT COUNT(*) n FROM noe_memory WHERE id='later'").get().n).toBe(1);
    bak.close();
  });

  it('轮转：超过 keep 份删最旧', async () => {
    const dir = join(tmp, 'backups');
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']) {
      await backupPanelDb({ dir, keep: 2, now: () => new Date(`${day}T12:00:00`) });
    }
    const list = listBackups({ dir });
    expect(list.map((b) => b.day)).toEqual(['2026-06-04', '2026-06-03']);   // 只留最近 2 份
    expect(existsSync(join(dir, 'panel-2026-06-01.db'))).toBe(false);
  });

  it('关键状态文件全家桶随库快照（rooms.json 对话历史等），且随轮转清理', async () => {
    const stateDir = join(tmp, 'state');
    const dir = join(tmp, 'backups');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'rooms.json'), JSON.stringify({ rooms: [{ id: 'r1', conversation: [{ content: '珍贵对话' }] }] }));
    writeFileSync(join(stateDir, 'people-knowledge.json'), '{"people":[]}');
    writeFileSync(join(stateDir, 'license.txt'), 'payload.sig'); // 2026-06-11 收编：license 误删事故后进白名单
    const r = await backupPanelDb({ dir, stateDir, keep: 2, now: () => new Date('2026-06-10T12:00:00') });
    expect(r.copiedFiles).toContain('rooms.json');
    expect(r.copiedFiles).toContain('people-knowledge.json');
    expect(r.copiedFiles).toContain('license.txt');
    expect(readFileSync(join(dir, 'files-2026-06-10', 'license.txt'), 'utf8')).toBe('payload.sig');
    const restored = JSON.parse(readFileSync(join(dir, 'files-2026-06-10', 'rooms.json'), 'utf8'));
    expect(restored.rooms[0].conversation[0].content).toBe('珍贵对话');
    // 轮转也清 files- 目录
    await backupPanelDb({ dir, stateDir, keep: 2, now: () => new Date('2026-06-11T12:00:00') });
    await backupPanelDb({ dir, stateDir, keep: 2, now: () => new Date('2026-06-12T12:00:00') });
    expect(existsSync(join(dir, 'files-2026-06-10'))).toBe(false);
    expect(existsSync(join(dir, 'files-2026-06-12'))).toBe(true);
  });

  it('listBackups 忽略非备份文件，按日期降序', async () => {
    const dir = join(tmp, 'backups');
    await backupPanelDb({ dir, now: () => new Date('2026-06-09T12:00:00') });
    await backupPanelDb({ dir, now: () => new Date('2026-06-10T12:00:00') });
    writeFileSync(join(dir, '无关文件.txt'), 'x');
    const list = listBackups({ dir });
    expect(list.map((b) => b.day)).toEqual(['2026-06-10', '2026-06-09']);
  });
});
