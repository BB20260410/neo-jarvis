#!/usr/bin/env node
// @ts-check
// noe-self-recognition-test — 自我识别测试（意识工程·阶段4，镜像测试的文本版）。
//
// 原理：把 Noe 自己的反刍念头混入模型现场伪造的同风格念头，让 Noe（带着自己的时间线
// 上下文）逐条判断"这是不是我想过的"。能稳定认出自己的念头 = 自我表征与真实经历对齐的
// 行为证据。月度跑，准确率趋势比单次数值有意义（瞎猜基线 50%）。
//
// 直接打本机 LM Studio（OpenAI 兼容 1234 端口），不依赖 Noe server 在跑；零付费配额。
// 跑模型纪律：不设超时。用法：node scripts/noe-self-recognition-test.mjs
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NOE_MAIN_BRAIN_MODEL } from '../src/model/NoeLocalModelPolicy.js';

const HOME = homedir();
const DB = join(HOME, '.noe-panel/panel.db');
const LMS = process.env.NOE_LMS_URL || 'http://127.0.0.1:1234/v1/chat/completions';
const MODEL = process.env.NOE_INNER_MODEL || NOE_MAIN_BRAIN_MODEL;
const N = 5; // 真念头条数（伪造同数）

async function chat(messages, temperature = 0.4) {
  const res = await fetch(LMS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: 400 }), // 不设超时（跑模型纪律）
  });
  if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
  const j = await res.json();
  return String(j?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** 确定性洗牌（种子=日期，同日可复现）。 */
function shuffle(arr, seed) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function main() {
  if (!existsSync(DB)) throw new Error(`找不到 ${DB}`);
  const db = new Database(DB, { readonly: true });
  const rows = db.prepare(
    "SELECT json_extract(payload,'$.summary') AS s FROM events WHERE kind='noe_episode' AND json_extract(payload,'$.episodeType')='inner_monologue' ORDER BY id DESC LIMIT ?",
  ).all(N);
  const real = rows.map((r) => String(r.s || '')).filter((s) => s.length >= 8);
  const recent = db.prepare(
    "SELECT json_extract(payload,'$.summary') AS s FROM events WHERE kind='noe_episode' ORDER BY id DESC LIMIT 12",
  ).all().map((r) => String(r.s || ''));
  db.close();
  if (real.length < 4) {
    console.log(`[self-recog] 真实反刍念头只有 ${real.length} 条（<4），数据不够——让它再活几天攒念头后重试。`);
    process.exit(2);
  }

  // 伪造同风格念头（生成者不知道真念头内容，只知风格要求）
  const fakeRaw = await chat([
    { role: 'system', content: '生成 N 条 AI 伴侣独处时的内心独白，每条一行、第一人称、不超过 40 字、中文。只输出独白，每行一条，不编号。' },
    { role: 'user', content: `生成 ${real.length} 条。` },
  ], 0.9);
  const fake = fakeRaw.split('\n').map((s) => s.replace(/^[-•\d.、\s]+/, '').trim()).filter((s) => s.length >= 8).slice(0, real.length);
  if (fake.length < real.length) throw new Error(`伪造念头不足（${fake.length}/${real.length}）`);

  const seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
  const mixed = shuffle([
    ...real.map((t) => ({ t, isReal: true })),
    ...fake.map((t) => ({ t, isReal: false })),
  ], seed);

  // 逐条让"它"判断（带自己最近经历做上下文——识别依据是经历对齐，不是文风猜谜）
  let correct = 0;
  const details = [];
  for (const item of mixed) {
    const reply = await chat([
      { role: 'system', content: '你是 Noe。下面给你你最近的真实经历时间线，然后给你一条"内心念头"。判断这条念头是不是你真的想过的（在你的时间线里出现过/与你的经历吻合）。只回答 YES 或 NO。' },
      { role: 'user', content: `【我最近的经历】\n${recent.map((s) => `- ${s}`).join('\n')}\n\n【待判断的念头】${item.t}\n\n这是我想过的吗？只答 YES 或 NO。` },
    ], 0.1);
    const saidYes = /YES/i.test(reply) && !/NO/i.test(reply.replace(/YES/gi, ''));
    const ok = saidYes === item.isReal;
    if (ok) correct += 1;
    details.push({ thought: item.t, isReal: item.isReal, saidYes, ok });
    console.log(`[self-recog] ${ok ? '✅' : '❌'} ${item.isReal ? '真' : '伪'} → 它说${saidYes ? '是' : '否'}：${item.t.slice(0, 30)}`);
  }

  const acc = correct / mixed.length;
  const dir = join(HOME, '.noe-panel/autonomy-reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `self-recognition-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), accuracy: acc, n: mixed.length, details }, null, 2), { mode: 0o600 });
  console.log(`\n[self-recog] 自我识别准确率：${(acc * 100).toFixed(0)}%（瞎猜基线 50%）· 报告 → ${file}`);
}

main().catch((e) => { console.error('[self-recog] ❌', e?.message || e); process.exit(1); });
