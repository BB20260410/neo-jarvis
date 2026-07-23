#!/usr/bin/env node
// noe-backup-restore-drill — 备份恢复演练（强健补遗 C，2026-06-10）。
// 「没演练过的备份 = 薛定谔的备份」。本脚本在隔离 tmp 环境走完整灾难恢复：
//   造数据 → 每日备份 → 毁掉"生产" → 从备份恢复 → 逐项验数据。全程不碰真 ~/.noe-panel。
// 用法: node scripts/noe-backup-restore-drill.mjs   （exit 0 = 演练通过）

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { close, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { backupPanelDb, listBackups } from '../src/storage/NoeDbBackup.js';

const tmp = mkdtempSync(join(tmpdir(), 'noe-drill-'));
const stateDir = join(tmp, 'noe-panel');           // 模拟 ~/.noe-panel
const backupsDir = join(stateDir, 'backups');
mkdirSync(stateDir, { recursive: true });
const fail = (msg) => { console.error(`❌ 演练失败: ${msg}`); rmSync(tmp, { recursive: true, force: true }); process.exit(1); };

try {
  // 1) 造"生产"数据：库里写记忆 + rooms.json 写对话历史
  close();
  initSqlite(join(stateDir, 'panel.db'));
  const core = new MemoryCore({ logger: null });
  core.write({ id: 'drill-mem', body: '演练用珍贵记忆：主人喜欢喝美式', salience: 4 });
  writeFileSync(join(stateDir, 'rooms.json'), JSON.stringify({ rooms: [{ id: 'r1', conversation: [{ from: 'user', content: '演练对话内容' }] }] }));
  console.log('① 造数据 ✅（1 条记忆 + rooms.json 对话）');

  // 2) 每日备份（库在线快照 + 状态文件全家桶）
  const r = await backupPanelDb({ dir: backupsDir, stateDir, now: () => new Date('2026-06-10T12:00:00') });
  if (!r.copiedFiles.includes('rooms.json')) fail('全家桶没拷到 rooms.json');
  console.log(`② 备份 ✅（${r.path}，状态文件 ${r.copiedFiles.length} 个）`);

  // 3) 灾难：库和 rooms.json 全毁
  close();
  rmSync(join(stateDir, 'panel.db'));
  rmSync(join(stateDir, 'panel.db-wal'), { force: true });
  rmSync(join(stateDir, 'panel.db-shm'), { force: true });
  rmSync(join(stateDir, 'rooms.json'));
  if (existsSync(join(stateDir, 'panel.db'))) fail('灾难模拟没毁干净');
  console.log('③ 灾难模拟 ✅（库 + rooms.json 已毁）');

  // 4) 恢复：按 RUNBOOK 步骤——停服(演练中即 close) → cp 备份回原位 → 重启(重开库)
  const latest = listBackups({ dir: backupsDir })[0];
  cpSync(latest.path, join(stateDir, 'panel.db'));
  cpSync(join(backupsDir, `files-${latest.day}`, 'rooms.json'), join(stateDir, 'rooms.json'));
  console.log('④ 恢复 ✅（备份已拷回原位）');

  // 5) 验数据：记忆在、对话在
  initSqlite(join(stateDir, 'panel.db'));
  const mem = new MemoryCore({ logger: null }).get('drill-mem');
  if (!mem || !mem.body.includes('美式')) fail('恢复后记忆丢失');
  const rooms = JSON.parse(readFileSync(join(stateDir, 'rooms.json'), 'utf8'));
  if (rooms.rooms[0].conversation[0].content !== '演练对话内容') fail('恢复后对话历史丢失');
  // 库完整性体检
  const integ = new Database(join(stateDir, 'panel.db'), { readonly: true }).pragma('integrity_check');
  if (String(integ[0]?.integrity_check) !== 'ok') fail(`integrity_check 异常: ${JSON.stringify(integ)}`);
  console.log('⑤ 数据验证 ✅（记忆在 + 对话在 + integrity_check ok）');
  console.log('\n🎉 备份恢复演练通过——备份是真的能救命的备份。');
} finally {
  close();
  rmSync(tmp, { recursive: true, force: true });
}
