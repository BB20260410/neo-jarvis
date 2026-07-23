#!/usr/bin/env node
// @ts-check
// 阶段一C 自我复盘入口:把仪表盘+题库的时间序列读出来,算趋势(随时间升/降),摆出三个复盘问题。
// 让循环真转起来:任何 session(我或 owner)跑一条命令,拿到证据化的重排依据。
// 用法: node scripts/noe-evolution-review.mjs   (先跑 dashboard.mjs / capability-battery.mjs 攒历史)
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSeriesTrend } from '../src/loop/NoeEvolutionDashboard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJsonl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

const dash = readJsonl(join(ROOT, 'output', 'noe-evolution-dashboard', 'history.jsonl'));
const battery = readJsonl(join(ROOT, 'output', 'noe-capability-battery', 'history.jsonl'));

const arrow = (d) => d === 'up' ? '📈 升' : d === 'down' ? '📉 降(该查/砍)' : '➖ 平';
const fmt = (t, isPct = true) => t.latest == null ? 'N/A' : `${isPct ? (t.latest * 100).toFixed(1) + '%' : t.latest} ${arrow(t.direction)}${t.delta != null ? ` (Δ ${(t.delta * (isPct ? 100 : 1)).toFixed(1)}${isPct ? 'pt' : ''})` : ''}`;

console.log(`\n🔁 Neo 进化自我复盘  ${new Date().toLocaleString()}`);
console.log('═'.repeat(60));

console.log('\n【北极星 · 随时间趋势】');
console.log(`  真进步率(真保留改逻辑/总): ${fmt(computeSeriesTrend(dash, (s) => s.outcomes?.realProgressRate))}`);
console.log(`  回滚率:                     ${fmt(computeSeriesTrend(dash, (s) => s.outcomes?.rollbackRate))}`);
console.log(`  能力题库总通过率:           ${fmt(computeSeriesTrend(battery, (s) => s.passRate))}`);
console.log(`  失败/reject 教训累计:       ${fmt(computeSeriesTrend(dash, (s) => s.outcomes ? (s.lessonCount ?? 0) : 0), false)}`);

const latestDash = dash[dash.length - 1];
const latestBat = battery[battery.length - 1];
if (latestDash?.goals?.bySignal) {
  console.log('\n【当前信号源 drop 率(找黑洞)】');
  for (const [sig, b] of Object.entries(latestDash.goals.bySignal).sort((a, c) => c[1].dropRate - a[1].dropRate).slice(0, 4)) {
    console.log(`  ${sig.padEnd(26)} drop ${(b.dropRate * 100).toFixed(0)}%`);
  }
}
if (latestBat?.byTier) {
  console.log('\n【能力题库按难度(能做简单不能做难?)】');
  for (const [tier, b] of Object.entries(latestBat.byTier)) console.log(`  ${tier.padEnd(8)} ${(b.passRate * 100).toFixed(0)}%`);
}

console.log('\n【三个复盘问题(据上面数据回答,重排 ROADMAP 优先级)】');
console.log('  ① 当前最大瓶颈是什么?(看最高 drop 信号 + 真进步率是否停滞)');
console.log('  ② 这轮学到了什么?(教训累计涨了吗 / 归因分布变了吗)');
console.log('  ③ 下一个最高杠杆是哪件?(能力曲线哪档最低就补哪档;无效项砍掉)');
console.log(`\n  样本: dashboard ${dash.length} 快照, battery ${battery.length} 快照`);
console.log('  💡 建议每周或每积累 ~50 个进化样本跑一次;曲线降=退步该 revert,平=停滞该换策略。');
