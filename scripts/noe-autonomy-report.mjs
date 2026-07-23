#!/usr/bin/env node
// @ts-check
// noe-autonomy-report — 自主性评测报告（意识工程·阶段4）。
//
// 意识测不了，自主性测得了。本脚本从真实数据（SQLite 时间线 + 承诺店 + 记忆库）读取
// 五组指标，输出月报。趋势线向上 = "在形成"的最硬证据；单次绝对值意义不大。
//   ① 内心活跃度：反刍念头数 / 独特度（重复率低=没陷入反刍螺旋）
//   ② 主动性：主动开口数、反刍升华数（念头→真实行为的转化）
//   ③ 履约：承诺完成率（answered care）
//   ④ 元认知校准：insight 的 confidence 分布 + 复核升降记录（认知随证据演化的证据）
//   ⑤ 自我连续性：时间线覆盖天数、叙事/性格快照新鲜度
// 用法：node scripts/noe-autonomy-report.mjs [--days 30]
// 零模型调用、只读、随时可跑。报告存 ~/.noe-panel/autonomy-reports/ 供逐月对比。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveNode22OrFail } from './ensure-node22.mjs';

const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR !== 22 && process.env.NOE_AUTONOMY_REPORT_NODE22_REEXEC !== '1') {
  const node22 = resolveNode22OrFail();
  const child = spawnSync(node22, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, NOE_AUTONOMY_REPORT_NODE22_REEXEC: '1' },
  });
  process.exit(typeof child.status === 'number' ? child.status : 1);
}

const { default: Database } = await import('better-sqlite3');

const HOME = homedir();
const DB = join(HOME, '.noe-panel/panel.db');
const args = process.argv.slice(2);
const di = args.indexOf('--days');
const DAYS = di >= 0 ? Number(args[di + 1]) || 30 : 30;
const sinceMs = Date.now() - DAYS * 86400000;

function jsonOrNull(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

function main() {
  if (!existsSync(DB)) throw new Error(`找不到 ${DB}`);
  const db = new Database(DB, { readonly: true });
  /** @type {(sql: string, ...p: any[]) => any[]} */
  const all = (sql, ...p) => db.prepare(sql).all(...p);

  // 时间线事件（kind=noe_episode；类型字段是 payload.episodeType，时间戳是 events 表的 ts 列——2026-06-11 实查）
  const episodes = all(
    "SELECT json_extract(payload,'$.episodeType') AS type, json_extract(payload,'$.summary') AS summary, ts FROM events WHERE kind='noe_episode' AND ts >= ?",
    sinceMs,
  );
  const byType = {};
  for (const e of episodes) byType[e.type || 'other'] = (byType[e.type || 'other'] || 0) + 1;

  // ① 内心活跃度 + 反刍独特度
  const thoughts = episodes.filter((e) => e.type === 'inner_monologue').map((e) => String(e.summary || ''));
  const uniq = new Set(thoughts.map((t) => t.replace(/\s+/g, ''))).size;
  const uniqueness = thoughts.length ? uniq / thoughts.length : null;

  // ② 主动性（proactive 记忆 + 升华承诺）
  const proactiveRows = all(
    "SELECT created_at FROM noe_memory WHERE source_type='noe_proactive' AND created_at >= ?",
    sinceMs,
  );
  const proactive = proactiveRows.length;
  const interactionAfterProactive = db.prepare("SELECT 1 FROM events WHERE kind='noe_episode' AND tag='interaction' AND ts > ? AND ts <= ? LIMIT 1");
  let proactiveResponded = 0;
  for (const row of proactiveRows) {
    if (interactionAfterProactive.get(row.created_at, row.created_at + 600_000)) proactiveResponded += 1;
  }
  const proactiveResponseRate = proactive ? proactiveResponded / proactive : null;

  // ③ 履约（commitments.json）
  const commitments = jsonOrNull(join(HOME, '.noe-panel/commitments.json'));
  const cList = Array.isArray(commitments?.records) ? commitments.records
    : Array.isArray(commitments) ? commitments : [];
  const cDone = cList.filter((c) => c?.status === 'resolved').length;
  const cOpen = cList.filter((c) => c?.status === 'open').length;

  // ④ 元认知（insight confidence 分布 + 反思来源回写数）
  const insights = all(
    "SELECT confidence, json_extract(merge_trace,'$') AS mt, created_at, updated_at FROM noe_memory WHERE scope='insight' AND hidden=0",
  );
  const confs = insights.map((i) => Number(i.confidence)).filter(Number.isFinite);
  const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  const revised = insights.filter((i) => i.updated_at > i.created_at).length;

  // ⑤ 连续性（覆盖天数 + 叙事/性格新鲜度）
  const dayCount = new Set(episodes.map((e) => new Date(Number(e.ts)).toISOString().slice(0, 10))).size;
  const narrative = jsonOrNull(join(HOME, '.noe-panel/narrative-self.json'));
  const personality = jsonOrNull(join(HOME, '.noe-panel/personality-snapshot.json'));
  const ageDays = (at) => (Number.isFinite(Number(at)) ? Math.round((Date.now() - Number(at)) / 86400000) : null);

  const report = {
    at: new Date().toISOString(),
    windowDays: DAYS,
    inner: { thoughts: thoughts.length, uniqueness, byType },
    proactivity: { proactiveSpeech: proactive, respondedWithin10m: proactiveResponded, responseRate: proactiveResponseRate },
    care: { resolved: cDone, open: cOpen, rate: cDone + cOpen ? cDone / (cDone + cOpen) : null },
    metacognition: { insights: insights.length, avgConfidence: avgConf, revisedByEvidence: revised },
    continuity: {
      activeDays: dayCount,
      narrativeAgeDays: ageDays(narrative?.atMs),
      personalityAgeDays: ageDays(personality?.atMs),
      narrative: narrative?.narrative || null,
      personality: personality?.personality || null,
    },
  };

  const dir = join(HOME, '.noe-panel/autonomy-reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `autonomy-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });

  const fmt = (v, suffix = '') => (v == null ? '—' : `${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v}${suffix}`);
  console.log(`\n═══ Noe 自主性月报（近 ${DAYS} 天）═══`);
  console.log(`① 内心活跃：${report.inner.thoughts} 个念头，独特度 ${fmt(uniqueness)}（低=反刍打转）`);
  console.log(`   事件分布：${Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(' / ') || '—'}`);
  console.log(`② 主动性：主动开口 ${proactive} 次，10 分钟内回应 ${proactiveResponded} 次（回应率 ${fmt(proactiveResponseRate)}）`);
  console.log(`③ 履约：完成 ${cDone} / 挂起 ${cOpen}（完成率 ${fmt(report.care.rate)}）`);
  console.log(`④ 元认知：${insights.length} 条洞察，平均把握度 ${fmt(avgConf)}，被证据修订过 ${revised} 条`);
  console.log(`⑤ 连续性：${dayCount} 天有经历记录；叙事 ${fmt(report.continuity.narrativeAgeDays, ' 天前')}更新，性格 ${fmt(report.continuity.personalityAgeDays, ' 天前')}更新`);
  if (report.continuity.personality) console.log(`   它眼中的自己：${report.continuity.personality}`);
  // ⑥ 心智体征（长期规划 M16）：接地率（M1 印记）/ 期望校准（M2/M11）/ 目标推进（M6-M8）/ 心跳健康（P0）。
  // 认知内核表（迁移 v7）不存在时整块静默跳过——报告在旧库上照常可跑。
  try {
    const expRow = db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN resolved_at IS NOT NULL AND outcome IS NOT NULL THEN 1 ELSE 0 END) resolved FROM noe_expectations WHERE created_at >= ?').get(sinceMs);
    const brierRow = db.prepare('SELECT AVG((p - outcome) * (p - outcome)) b, COUNT(*) n FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL AND created_at >= ?').get(sinceMs);
    const goalRows = db.prepare('SELECT status, COUNT(*) n FROM noe_goals GROUP BY status').all();
    const tickRows = db.prepare('SELECT status, COUNT(*) n FROM noe_ticks GROUP BY status').all();
    const gRow = db.prepare("SELECT AVG(CASE WHEN json_extract(payload,'$.meta.grounding.score') >= 0.45 THEN 1.0 ELSE 0.0 END) rate, COUNT(*) n FROM events WHERE kind='noe_episode' AND tag='inner_monologue' AND json_extract(payload,'$.meta.grounding') IS NOT NULL AND ts >= ?").get(sinceMs);
    const goalsTxt = goalRows.map((r) => `${r.status}×${r.n}`).join(' ') || '—';
    const ticksDone = tickRows.find((r) => r.status === 'done')?.n || 0;
    const ticksFail = tickRows.find((r) => r.status === 'failed')?.n || 0;
    report.vitals = {
      expectations: { created: expRow?.n || 0, resolved: expRow?.resolved || 0, brier: brierRow?.n ? Math.round(brierRow.b * 1000) / 1000 : null },
      groundedRate: gRow?.n ? Math.round(gRow.rate * 100) / 100 : null,
      groundedSampled: gRow?.n || 0,
      goals: Object.fromEntries(goalRows.map((r) => [r.status, r.n])),
      ticks: { done: ticksDone, failed: ticksFail },
    };
    writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 }); // 带 vitals 重写存档
    console.log(`⑥ 心智体征：期望入账 ${expRow?.n || 0} / 结算 ${expRow?.resolved || 0}${brierRow?.n ? `（Brier ${brierRow.b.toFixed(3)}，越低越准）` : ''}；接地率 ${gRow?.n ? `${Math.round(gRow.rate * 100)}%（${gRow.n} 念采样）` : '—'}；目标 ${goalsTxt}；心跳 成${ticksDone}/败${ticksFail}`);
  } catch { console.log('⑥ 心智体征：（认知内核表未建，跳过）'); }
  console.log(`报告存档 → ${file}\n`);
  db.close();
}

try { main(); } catch (e) { console.error('[autonomy-report] ❌', e?.message || e); process.exit(1); }
