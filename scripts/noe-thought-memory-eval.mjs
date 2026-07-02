#!/usr/bin/env node
// @ts-check
// Read-only eval for thought groundedness and memory quality signals.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideMemoryConflict } from '../src/memory/NoeMemoryConflictPolicy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_THOUGHT_MEMORY_EVAL_OUT_DIR
  ? resolve(process.env.NOE_THOUGHT_MEMORY_EVAL_OUT_DIR)
  : join(ROOT, 'output', 'noe-thought-memory-eval');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const NOW = Date.now();
const args = new Set(process.argv.slice(2));
const { default: Database } = await import('better-sqlite3');

function row(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function pct(n, d) {
  return d ? Math.round((Number(n || 0) / Number(d || 1)) * 1000) / 1000 : null;
}

function cleanPath(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

function runConflictFixtures() {
  const now = 1_780_000_000_000;
  const cases = [
    {
      id: 'preference_supersede',
      expected: 'supersede',
      input: {
        oldFact: { text: '用户喜欢喝美式咖啡', sourceType: 'owner', confidence: 0.9, salience: 4 },
        newFact: { text: '用户现在改喝拿铁', sourceType: 'owner', confidence: 0.95, salience: 4 },
        now,
      },
    },
    {
      id: 'protected_low_confidence_ignore',
      expected: 'ignore',
      input: {
        oldFact: { text: '用户住在成都', sourceType: 'owner', confidence: 0.95, salience: 5 },
        newFact: { text: '也许用户住在上海', sourceType: 'reflection', confidence: 0.45, salience: 2 },
        now,
      },
    },
    {
      id: 'different_slots_keep_both',
      expected: 'keep_both',
      input: {
        oldFact: { text: '用户喜欢喝美式咖啡', sourceType: 'owner' },
        newFact: { text: '用户住在成都', sourceType: 'owner' },
        now,
      },
    },
  ];
  return cases.map((item) => {
    const result = decideMemoryConflict(item.input);
    return { id: item.id, ok: result.action === item.expected, expected: item.expected, actual: result.action, slot: result.slot || null, reason: result.reason || null };
  });
}

export function writeThoughtMemoryEvalReport(summary, { outDir = OUT_DIR, now = NOW } = {}) {
  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, `thought-memory-eval-${now}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return {
    reportPath: cleanPath(reportPath),
    latestPath: cleanPath(latestPath),
  };
}

export async function main() {
if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ ok: false, passed: false, error: `missing db: ${DB_PATH}` }, null, 2));
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  const grounding = row(db, `
    SELECT
      COUNT(*) AS n,
      AVG(json_extract(payload,'$.meta.grounding.score')) AS avgScore,
      SUM(CASE WHEN json_extract(payload,'$.meta.grounding.score') >= 0.45 THEN 1 ELSE 0 END) AS passCount,
      SUM(CASE WHEN json_extract(payload,'$.meta.groundingRewrite') IS NOT NULL THEN 1 ELSE 0 END) AS rewriteCount,
      SUM(CASE WHEN json_extract(payload,'$.meta.grounding.refKey') IS NOT NULL THEN 1 ELSE 0 END) AS refKeyCount
    FROM events
    WHERE kind='noe_episode'
      AND (tag='inner_monologue' OR json_extract(payload,'$.episodeType')='inner_monologue')
      AND json_extract(payload,'$.meta.grounding.score') IS NOT NULL
  `) || {};
  const lowRecent = all(db, `
    SELECT
      json_extract(payload,'$.summary') AS summary,
      json_extract(payload,'$.meta.grounding.score') AS score,
      json_extract(payload,'$.meta.grounding.refKey') AS refKey,
      json_extract(payload,'$.meta.groundingRewrite.fromScore') AS rewriteFromScore,
      ts
    FROM events
    WHERE kind='noe_episode'
      AND (tag='inner_monologue' OR json_extract(payload,'$.episodeType')='inner_monologue')
      AND json_extract(payload,'$.meta.grounding.score') IS NOT NULL
    ORDER BY json_extract(payload,'$.meta.grounding.score') ASC, ts DESC
    LIMIT 8
  `);
  const memories = row(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN source_type='skill_distill' THEN 1 ELSE 0 END) AS skillDistill,
      SUM(CASE WHEN source_type='fact_extract' THEN 1 ELSE 0 END) AS factExtract,
      SUM(CASE WHEN scope='insight' AND hidden=0 THEN 1 ELSE 0 END) AS insights,
      SUM(CASE WHEN hidden=1 THEN 1 ELSE 0 END) AS hidden,
      AVG(confidence) AS avgConfidence
    FROM noe_memory
  `) || {};
  const liveQueries = [
    { id: 'skill_card_recall', needle: '技能卡', requiredSourceType: 'skill_distill' },
    { id: 'fact_extract_recall', needle: '用户偏好', requiredSourceType: 'fact_extract' },
    { id: 'insight_recall', needle: '', requiredScope: 'insight' },
  ].map((q) => {
    const hit = row(db, `
      SELECT id, scope, source_type, substr(body, 1, 180) AS bodyPrefix
      FROM noe_memory
      WHERE hidden=0
        AND (? = '' OR body LIKE ?)
        AND (? = '' OR source_type = ?)
        AND (? = '' OR scope = ?)
      ORDER BY updated_at DESC
      LIMIT 1
    `, [q.needle, `%${q.needle}%`, q.requiredSourceType || '', q.requiredSourceType || '', q.requiredScope || '', q.requiredScope || '']);
    const ok = Boolean(hit);
    return { id: q.id, ok, needle: q.needle, hit: hit || null };
  });
  const conflictFixtures = runConflictFixtures();

  const groundingPassRate = pct(grounding.passCount, grounding.n);
  const groundingBlockers = [];
  if (Number(grounding.n || 0) < 50) groundingBlockers.push('grounding_sample_below_50');
  if (Number(grounding.avgScore || 0) < 0.45) groundingBlockers.push('grounding_avg_below_0_45');
  if (Number(groundingPassRate || 0) < 0.60) groundingBlockers.push('grounding_pass_rate_below_0_60');
  if (Number(grounding.refKeyCount || 0) < Number(grounding.n || 0)) groundingBlockers.push('grounding_refkey_missing');

  const memoryBlockers = [];
  if (Number(memories.skillDistill || 0) < 1) memoryBlockers.push('skill_distill_memory_missing');
  if (Number(memories.factExtract || 0) < 1) memoryBlockers.push('fact_extract_memory_missing');
  if (Number(memories.insights || 0) < 1) memoryBlockers.push('insight_memory_missing');
  for (const item of liveQueries) if (!item.ok) memoryBlockers.push(`live_memory_query_failed:${item.id}`);
  for (const item of conflictFixtures) if (!item.ok) memoryBlockers.push(`conflict_fixture_failed:${item.id}`);

  const summary = {
    ok: true,
    passed: groundingBlockers.length === 0 && memoryBlockers.length === 0,
    generatedAt: new Date(NOW).toISOString(),
    score: Math.round(((groundingBlockers.length === 0 ? 50 : 25) + (memoryBlockers.length === 0 ? 50 : 25))),
    thoughtGrounding: {
      sampleCount: grounding.n || 0,
      avgScore: Number.isFinite(Number(grounding.avgScore)) ? Math.round(Number(grounding.avgScore) * 1000) / 1000 : null,
      passCount: grounding.passCount || 0,
      passRate: groundingPassRate,
      rewriteCount: grounding.rewriteCount || 0,
      refKeyCount: grounding.refKeyCount || 0,
      blockers: groundingBlockers,
      lowRecent,
    },
    memoryEval: {
      counts: memories,
      liveQueries,
      conflictFixtures,
      blockers: memoryBlockers,
    },
    blockers: [...groundingBlockers, ...memoryBlockers],
    source: {
      dbPath: DB_PATH,
      policy: 'read-only; no .env; no owner token; no model calls',
    },
  };

  const paths = writeThoughtMemoryEvalReport(summary);
  console.log(JSON.stringify({ ...summary, ...paths }, null, 2));
  if (args.has('--require-pass') && !summary.passed) process.exitCode = 1;
} finally {
  db.close();
}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
