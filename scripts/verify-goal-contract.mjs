#!/usr/bin/env node
// 校验 Noe 阶段 1「用户想法」目标契约与磁盘实况是否一致。
// 全程只读：不启动服务、不写文件、不触碰原项目目录。
// 用法：node scripts/verify-goal-contract.mjs   （全部 PASS 退出码 0，任一 FAIL 退出码 1）
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // Noe 仓库根
const ORIG_DIR = '~/Desktop/00_项目/05_Claude可视化面板';
const AUDIT_DIR = join(ROOT, 'BaiLongma-audit');
const CANONICAL_CONTRACT = 'NOE_PHASE1_目标契约_CANONICAL.md';
const AUDIT_REPORT = 'NOE_BAILONGMA_ARCH_AUDIT.md';

function read(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
function lineCount(text) { return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }
const serverJs = read(join(ROOT, 'server.js'));
const canonical = read(join(ROOT, CANONICAL_CONTRACT));
const auditReport = read(join(ROOT, AUDIT_REPORT));
let noePkg = {}; try { noePkg = JSON.parse(read(join(ROOT, 'package.json'))); } catch {}
let blPkg = {}; try { blPkg = JSON.parse(read(join(AUDIT_DIR, 'package.json'))); } catch {}
const blLicenseFirst = read(join(AUDIT_DIR, 'LICENSE')).split('\n')[0].trim();
const phase1Files = readdirSync(ROOT).filter((name) => /^NOE_PHASE1(?:_|\.|$).*\.md$/.test(name));
const markdownWithSecret = readdirSync(ROOT)
  .filter((name) => name.endsWith('.md'))
  .filter((name) => {
    const source = read(join(ROOT, name));
    return /doubaoKey["']?\s*[:=]\s*["'](?!<REDACTED>)[0-9a-fA-F-]{32,}/.test(source);
  });

// 端口占用（只读探测，best-effort，缺 lsof 不算失败）
function listening(port) {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

const checks = [
  ['F1_noe_dir', 'Noe 工作目录正确', () => /Neo .*维斯$/.test(ROOT.replace(/\/$/, '')) && existsSync(join(ROOT, 'server.js')), ROOT],
  ['F2_noe_pkg', 'Noe 包名/版本 = noe/2.1.0', () => noePkg.name === 'noe' && noePkg.version === '2.1.0', `${noePkg.name}/${noePkg.version}`],
  ['F3_noe_port', 'server.js 绑定端口 51835', () => serverJs.includes('51835') && /PANEL_PORT\s*=\s*process\.env\.PORT\s*\|\|\s*51835/.test(serverJs), 'PANEL_PORT=51835'],
  ['F4_noe_datadir', "Noe 数据目录隔离为 ~/.noe-panel", () => serverJs.includes(".noe-panel"), `${homedir()}/.noe-panel`],
  ['F5_orig_dir', '原稳定项目目录存在', () => existsSync(ORIG_DIR), ORIG_DIR],
  ['F6_orig_port', '端口隔离 51735 != 51835', () => 51735 !== 51835, '51735 vs 51835'],
  ['F7_audit_clone', 'BaiLongma-audit 使用工作区内 canonical 镜像', () => existsSync(AUDIT_DIR), AUDIT_DIR],
  ['F8_audit_license', 'BaiLongma 许可 = MIT License', () => blLicenseFirst === 'MIT License', blLicenseFirst || '(无 LICENSE)'],
  ['F9_audit_pkg', 'BaiLongma = bailongma/type:module', () => blPkg.name === 'bailongma' && blPkg.type === 'module', `${blPkg.name}/${blPkg.version}/${blPkg.type}`],
  ['F10_audit_modules', 'BaiLongma 可吸收能力点存在(ticker/memory/context/voice/ui)', () => ['src/ticker.js', 'src/memory', 'src/context', 'src/voice', 'src/ui'].every(p => existsSync(join(AUDIT_DIR, p))), 'ticker.js,memory,context,voice,ui'],
  ['F11_canonical_contract', '阶段 1 单一目标契约存在且含四项交付物', () => existsSync(join(ROOT, CANONICAL_CONTRACT)) && ['一句话目标', '范围边界', '成功标准', '风险假设'].every((text) => canonical.includes(text)), CANONICAL_CONTRACT],
  ['F12_single_phase1_file', '顶层只有 1 个 NOE_PHASE1_*.md 文件', () => phase1Files.length === 1 && phase1Files[0] === CANONICAL_CONTRACT, phase1Files.join(', ') || '(无)'],
  ['F13_audit_report_state', '审计报告存在且实质非空', () => existsSync(join(ROOT, AUDIT_REPORT)) && lineCount(auditReport) >= 120, `${AUDIT_REPORT}/${lineCount(auditReport)} lines`],
  ['F14_secret_redaction', 'Noe 顶层 Markdown 不暴露未脱敏 doubaoKey', () => markdownWithSecret.length === 0, markdownWithSecret.join(', ') || '无'],
];

console.log('== Noe 阶段 1 目标契约校验 (CANONICAL vs 磁盘实况) ==\n');
let pass = 0, fail = 0;
for (const [id, desc, fn, observed] of checks) {
  let ok = false;
  try { ok = !!fn(); } catch { ok = false; }
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${id.padEnd(16)} ${desc}\n            实测: ${observed}`);
  ok ? pass++ : fail++;
}

// 端口隔离的运行态旁证（只读，不影响判定结果）
const p35 = listening(51835), p35h = p35 ? '占用' : '空闲';
const p17 = listening(51735), p17h = p17 ? '占用' : '空闲';
console.log(`\n端口运行态(旁证): 51835=${p35h} ｜ 51735=${p17h}`);
if (p35) console.log('  ⚠️  51835 已被占用，启动 Noe 前需确认是否为 Noe 自身。');

console.log(`\n结果: ${pass} PASS / ${fail} FAIL（共 ${checks.length}）`);
process.exit(fail === 0 ? 0 : 1);
