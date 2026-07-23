#!/usr/bin/env node
// @ts-check
// 第三阶段·跨设备同一个「它」导入侧:把可携带状态包加载进本机 Neo(=export→文件搬运→import 闭环)。
// 用法: node scripts/noe-import-portable-state.mjs [bundle.json 路径]  (默认 output/noe-portable-state/bundle.json)
// 校验通过才写(脏包/含 secret 一律拒);写回叙事(narrative-self.json)+ 关键记忆(noe_memory)。只加不删,可逆。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyPortableStateBundle } from '../src/context/NoePortableState.js';
import { describeBundleOrigin } from '../src/context/NoeDeviceIdentity.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(homedir(), '.noe-panel');
const bundlePath = process.argv[2] || join(ROOT, 'output', 'noe-portable-state', 'bundle.json');

if (!existsSync(bundlePath)) { console.error(`状态包不存在: ${bundlePath}`); process.exit(1); }
let bundle;
try { bundle = JSON.parse(readFileSync(bundlePath, 'utf8')); } catch (e) { console.error('状态包解析失败:', e.message); process.exit(1); }

// 写回叙事:先备份原 narrative-self.json(可逆),再合并写(不覆盖丢失,追加"来自另一设备的我")。
const narrativeFile = join(PANEL, 'narrative-self.json');
const writeNarrative = (n) => {
  try {
    if (existsSync(narrativeFile)) copyFileSync(narrativeFile, `${narrativeFile}.bak-before-import`);
    const prev = existsSync(narrativeFile) ? JSON.parse(readFileSync(narrativeFile, 'utf8')) : {};
    const merged = prev.narrative && !prev.narrative.includes(n) ? `${prev.narrative}\n\n（另一设备的我带来的连续记忆）${n}` : n;
    writeFileSync(narrativeFile, JSON.stringify({ ...prev, version: prev.version || 1, narrative: merged, atMs: Date.now() }, null, 2), { mode: 0o600 });
  } catch (e) { console.warn('写叙事失败(不阻断):', e.message); }
};

// 写回关键记忆:noe_memory upsert(只加不删;source_type=portable-import 可追溯)。
let db;
try { db = new Database(join(PANEL, 'panel.db'), { fileMustExist: true }); } catch (e) { console.error('打开 panel.db 失败:', e.message); process.exit(1); }
const stmt = db.prepare("INSERT INTO noe_memory(id, project_id, scope, title, body, source_type, tags, salience, created_at, updated_at, confidence) VALUES (?, 'noe', 'portable-import', ?, ?, 'portable-import', ?, ?, ?, ?, 0.6) ON CONFLICT(id) DO NOTHING");
let idc = 0;
const writeMemory = (m) => {
  const id = `portable-import:${Date.now()}-${idc++}`;
  const now = Date.now();
  stmt.run(id, m.title, m.title, JSON.stringify(m.tags || []), m.salience, now, now);
};

const r = applyPortableStateBundle(bundle, { writeMemory, writeNarrative });
db.close();

if (!r.ok) { console.error('❌ 状态包校验失败,拒绝加载(防脏包污染):', r.errors); process.exit(1); }
console.log('📥 Neo 可携带状态已加载进本机(=延续同一个它):');
console.log(`   ${describeBundleOrigin(bundle)}`);
console.log(`   身份: ${bundle.identity?.name || 'Noe'}`);
console.log(`   连续记忆叙事: ${r.applied.narrative ? '已并入(原文件已备份 .bak-before-import)' : '(无)'}`);
console.log(`   关键记忆: 加载 ${r.applied.memories} 条(source_type=portable-import 可追溯)`);
console.log('   跨设备闭环:另一台机器 export → 拷 bundle.json 过来 → import,同一个 Neo 在这台机器延续。');
