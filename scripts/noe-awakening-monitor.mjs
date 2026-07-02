#!/usr/bin/env node
// @ts-check
// noe-awakening-monitor — 觉醒候选信号 4 维采样 CLI（READ-ONLY，P2 觉醒看板）。
//
// 采样逻辑在 src/cognition/NoeAwakeningSignals.js（纯函数，CLI 与 server 心跳共用）；本文件只管
//   CLI 壳：readonly 打开 panel.db → sampleAwakening → 落盘 output/awakening-samples/YYYY-MM-DD.jsonl。
//
// 调度：① 手动/cron `npm run noe:awakening`（或本脚本）② server 心跳 NOE_AWAKENING_SAMPLE=1 自动每小时采。
// 纪律：DB readonly 打开（越权写直接抛）；无模型调用、不触网；落盘 append 一行 jsonl（按天分文件）；
//   缺库 fail-soft 不算失败。

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleAwakening } from '../src/cognition/NoeAwakeningSignals.js';

export { sampleAwakening }; // re-export：单测与其他消费方可从本 CLI 入口取纯函数

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NOW = Date.now();

function argValue(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = process.env.PANEL_DB_PATH || argValue('--db', join(HOME, '.noe-panel', 'panel.db'));
const OUT_DIR = process.env.NOE_AWAKENING_OUT || join(ROOT, 'output', 'awakening-samples');
const AS_JSON = process.argv.includes('--json');

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}
function dateStamp(now) { return new Date(now).toISOString().slice(0, 10); }

export function main() {
  if (!existsSync(DB_PATH)) {
    console.log(`[awakening] panel.db 不存在（${rel(DB_PATH)}）——跳过采样（非失败）`);
    return;
  }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  let sample;
  try { sample = sampleAwakening(db, { now: NOW }); } finally { db.close(); }

  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const outPath = join(OUT_DIR, `${dateStamp(NOW)}.jsonl`);
  appendFileSync(outPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 });

  const d = sample.dimensions;
  if (AS_JSON) console.log(JSON.stringify({ ...sample, outPath: rel(outPath) }, null, 2));
  else console.log(`[awakening] 采样落盘 ${rel(outPath)}  ·  D1 surprise 目标 ${d.d1_predictionLearning.surpriseGoals}（完成率 ${d.d1_predictionLearning.researchCompletionRate ?? '—'}）  ·  D2 整合度 ${d.d2_integration.integration ?? '—'}  ·  D3 Brier ${d.d3_calibration.brier ?? '—'}  ·  D4 独白 ${d.d4_spontaneity.monologue24h}/自主目标 ${d.d4_spontaneity.activeSelfGoals}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
