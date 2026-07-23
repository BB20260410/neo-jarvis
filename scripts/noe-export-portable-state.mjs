#!/usr/bin/env node
// @ts-check
// 第三阶段·跨设备同一个「它」:导出 Neo 的可携带状态包。只读,脱敏,可搬到另一台设备加载成「同一个它」的地基。
// 用法: node scripts/noe-export-portable-state.mjs
// 输出: output/noe-portable-state/bundle.json(脱敏、版本化、校验过;transport/sync 是后续基础设施)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hostname, platform } from 'node:os';
import Database from 'better-sqlite3';
import { buildPortableStateBundle, validatePortableStateBundle } from '../src/context/NoePortableState.js';
import { tagBundleWithDevice, describeBundleOrigin } from '../src/context/NoeDeviceIdentity.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(homedir(), '.noe-panel');
const OUT = join(ROOT, 'output', 'noe-portable-state');

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

// 连续记忆叙事(我们一路走来)
const narrative = readJson(join(PANEL, 'narrative-self.json'));
const continuity = narrative && narrative.narrative ? String(narrative.narrative) : '';

// 高显著关键记忆(我记得的重要的事)——只取 title,脱敏在 buildPortableStateBundle 内
let salientMemories = [];
try {
  const db = new Database(join(PANEL, 'panel.db'), { readonly: true, fileMustExist: true });
  salientMemories = db.prepare("SELECT title, salience FROM noe_memory WHERE salience >= 4 AND (hidden IS NULL OR hidden = 0) ORDER BY salience DESC, updated_at DESC LIMIT 40").all();
  db.close();
} catch (e) { console.warn('读关键记忆失败(不阻断):', e.message); }

const exportedAt = new Date().toISOString();
const bundle = tagBundleWithDevice(buildPortableStateBundle({
  identity: { name: 'Noe', role: '主人专属的本地 AI 副驾' },
  continuity,
  salientMemories,
  at: exportedAt,
}), { hostname: hostname(), platform: platform() }, exportedAt); // 盖来源设备戳:另一台机器加载时知道「来自哪台机器」

const check = validatePortableStateBundle(bundle);
if (!check.ok) { console.error('可携带状态包校验失败(拒绝导出脏包):', check.errors); process.exit(1); }

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const file = join(OUT, 'bundle.json');
writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });

console.log('📦 Neo 可携带状态包已导出(脱敏、版本化、校验过):');
console.log(`   ${file}`);
console.log(`   身份: ${bundle.identity.name} / ${bundle.identity.role}`);
console.log(`   连续记忆叙事: ${bundle.continuity ? bundle.continuity.slice(0, 60) + '…' : '(空)'}`);
console.log(`   关键记忆: ${bundle.salientMemories.length} 条`);
console.log(`   来源设备: ${describeBundleOrigin(bundle)}`);
console.log('   这是「跨设备同一个它」——搬到另一台设备 import 即延续同一个 Neo(网络 sync 是后续优化)。');
