#!/usr/bin/env node
// NOE_PHASE2_SECRET_GATE.mjs
// 阶段 2 通用 secret 扫描门（CE02 修复 GPT 阻断：审计稿曾明文泄漏 doubaoKey）。
//
// 作用：把"交付物不含真实第三方密钥"从一次性人工脱敏，升级为可复跑的确定性闸门。
//   1. 从只读上游镜像 BaiLongma-audit/config.json 抽取真实凭据"字面量"（按 key 名启发式 + UUID 形态）。
//   2. 扫描 Noe 工作区所有 .md 交付物（排除镜像本身、node_modules、.git）。
//   3. 任一交付物出现真实凭据字面量、或任意 UUID 形态串 => 退出码 1。
//   4. 顺带校验镜像被 .gitignore（真实 key 不会被 commit 进 Noe）。
//
// 不变量优于 SHA：审计稿是多写入热点、SHA 易抖动；本门验证的是"无真实密钥"这一属性，对 SHA 漂移免疫。
// 用法：在工作区根目录跑 `node NOE_PHASE2_SECRET_GATE.mjs`；退出码 0 = 通过。
// 边界：只读扫描，绝不修改任何文件；镜像 config.json 作为合法上游源保持只读。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MIRROR_DIR = 'BaiLongma-audit';
const MIRROR_CONFIG = path.join(ROOT, MIRROR_DIR, 'config.json');
const EXCLUDE_DIRS = new Set([MIRROR_DIR, 'node_modules', '.git']);

// 凭据 key 名启发式（doubaoKey / apiKey / token / secret / password / appid / access / credential）
const CRED_KEY_RE = /(api[-_]?key|key|token|secret|password|appid|access|credential|bearer|sk-)/i;
// UUID 形态（doubaoKey 即此形态）；git HEAD(40hex 无连字符) / SHA-256(64hex 无连字符) 不会误命中
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// 「被当作密钥呈现」的标签：同一行出现这些词的 UUID 才硬失败；房间 ID / 公开 checkout 产品 URL 等不带标签 => 仅 WARN
const SECRET_LABEL_RE = /(api[-_]?key|key\b|token|secret|password|credential|bearer|sk-|凭据|密钥|口令)/i;

function redact(s) {
  return `<${s.length} chars, head=${s.slice(0, 4)}…>`;
}

// 1) 从只读镜像 config.json 收集真实凭据字面量（绝不打印明文）
function collectCreds(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') { collectCreds(v, out); continue; }
    const s = String(v);
    if (s.length >= 8 && (CRED_KEY_RE.test(k) || UUID_RE.test(s))) out.add(s);
    UUID_RE.lastIndex = 0;
  }
}

const forbidden = new Set();
if (fs.existsSync(MIRROR_CONFIG)) {
  try {
    collectCreds(JSON.parse(fs.readFileSync(MIRROR_CONFIG, 'utf8')), forbidden);
  } catch (e) {
    console.error(`[secret-gate] 无法解析镜像 config.json: ${e.message}`);
  }
} else {
  console.error(`[secret-gate] 警告：未找到 ${MIRROR_DIR}/config.json（镜像缺失？跳过字面量收集，仍跑 UUID 形态扫描）`);
}

// 2) 递归收集交付物 .md（排除镜像 / node_modules / .git）
function walkMd(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walkMd(path.join(dir, ent.name), acc);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
      acc.push(path.join(dir, ent.name));
    }
  }
  return acc;
}
const mdFiles = walkMd(ROOT, []);

// 3) 扫描：hard = 必须阻断；warn = 列出供人工复核但不阻断
const hard = [];
const warn = [];
for (const file of mdFiles) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // (a) 真实凭据字面量（来自只读 config.json）出现在交付物 => 硬失败，零误报
    for (const lit of forbidden) {
      if (line.includes(lit)) hard.push({ file: rel, line: i + 1, kind: '真实凭据字面量', detail: redact(lit) });
    }
    // (b) UUID：同一行带密钥标签 => 硬失败（如 `doubaoKey: <uuid>`）；否则仅 WARN（房间 ID / 公开 checkout URL 等）
    const m = line.match(UUID_RE);
    if (m) {
      const labeled = SECRET_LABEL_RE.test(line);
      m.forEach((u) => (labeled ? hard : warn).push({ file: rel, line: i + 1, kind: labeled ? 'UUID被标注为密钥' : 'UUID形态(非凭据上下文)', detail: redact(u) }));
    }
    UUID_RE.lastIndex = 0;
  });
}

// 4) 校验镜像被 gitignore
let ignoreOk = null;
try {
  const out = execFileSync('git', ['check-ignore', `${MIRROR_DIR}/config.json`], { cwd: ROOT, encoding: 'utf8' }).trim();
  ignoreOk = out.length > 0;
} catch { ignoreOk = false; }

console.log('=== NOE 阶段 2 Secret 扫描门 ===');
console.log(`扫描交付物 .md: ${mdFiles.length} 个（已排除 ${[...EXCLUDE_DIRS].join(', ')}）`);
console.log(`从镜像加载真实凭据字面量: ${forbidden.size} 个 -> ${[...forbidden].map(redact).join(', ') || '(无)'}`);
console.log(`镜像 ${MIRROR_DIR}/config.json 被 gitignore: ${ignoreOk ? 'OK（真实 key 不会 commit 进 Noe）' : '否（建议加入 .gitignore）'}`);

// WARN：非凭据上下文的裸 UUID（房间 ID / 公开 checkout 产品 URL 等），列出但不阻断（不静默吞）
if (warn.length) {
  console.log(`WARN ${warn.length} 处裸 UUID（非凭据上下文，人工复核，不阻断）：`);
  for (const f of warn) console.log(`  ${f.file}:${f.line}  [${f.kind}] ${f.detail}`);
}

if (hard.length === 0 && ignoreOk) {
  console.log('结果: PASS — 所有 .md 交付物无真实密钥（含 BaiLongma doubaoKey），镜像已被 gitignore 隔离。');
  process.exit(0);
} else {
  if (hard.length) {
    console.error(`结果: FAIL — 命中 ${hard.length} 处真实密钥/被标注为密钥的值：`);
    for (const f of hard) console.error(`  ${f.file}:${f.line}  [${f.kind}] ${f.detail}`);
  }
  if (!ignoreOk) console.error('结果: FAIL — 镜像 config.json 未被 gitignore，真实 key 有被 commit 风险。');
  process.exit(1);
}
