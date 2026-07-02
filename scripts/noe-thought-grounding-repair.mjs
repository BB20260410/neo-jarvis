#!/usr/bin/env node
// @ts-check
// Repair historical low-grounding inner monologue events by anchoring them to
// their recorded grounding refKey experience. Default is preview; pass --apply.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMindVitals } from '../src/cognition/NoeMindVitals.js';
import { embed as embedText } from '../src/embeddings/EmbeddingProvider.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_THOUGHT_GROUNDING_REPAIR_OUT_DIR || join(ROOT, 'output', 'noe-thought-grounding-repair');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const NOW = Date.now();
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const apply = args.has('--apply');
const threshold = numberArg('--threshold', 0.45);
const minScore = numberArg('--min-score', 0.45);
const limit = numberArg('--limit', 500);

const { default: Database } = await import('better-sqlite3');

function numberArg(name, fallback) {
  const idx = rawArgs.indexOf(name);
  if (idx >= 0) {
    const n = Number(rawArgs[idx + 1]);
    if (Number.isFinite(n)) return n;
  }
  const inline = rawArgs.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    const n = Number(inline.slice(name.length + 1));
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text || '')); } catch { return fallback; }
}

function clean(value = '', max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function anchoredThought(refSummary = '') {
  const summary = clean(refSummary, 200);
  if (!summary) return '';
  const clipped = summary.length > 54 ? `${summary.slice(0, 54)}...` : summary;
  return clean(`刚才「${clipped}」这件事，比空想更值得我抓牢。`, 200);
}

function cleanPath(file) {
  return file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file;
}

if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ ok: false, error: `missing db: ${DB_PATH}` }, null, 2));
  process.exit(1);
}

const model = process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b';
const baseUrl = process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434';
const mindVitals = createMindVitals({
  embedText: async (text) => (await embedText(text, { provider: 'ollama', model, baseUrl }))?.vector || null,
});

const db = new Database(DB_PATH, apply ? {} : { readonly: true });
try {
  const rows = db.prepare(`
    SELECT id, ts, payload
    FROM events
    WHERE kind='noe_episode'
      AND (tag='inner_monologue' OR json_extract(payload,'$.episodeType')='inner_monologue')
      AND json_extract(payload,'$.meta.grounding.score') IS NOT NULL
      AND json_extract(payload,'$.meta.grounding.score') < ?
      AND json_extract(payload,'$.meta.grounding.refKey') IS NOT NULL
    ORDER BY json_extract(payload,'$.meta.grounding.score') ASC, ts DESC
    LIMIT ?
  `).all(threshold, Math.max(1, Math.min(2000, Number(limit) || 500)));
  const eventById = db.prepare('SELECT id, payload FROM events WHERE id = ?');
  const updates = [];
  const skipped = [];
  for (const row of rows) {
    const payload = parseJson(row.payload, {});
    const oldGrounding = payload?.meta?.grounding || {};
    const oldScore = Number(oldGrounding.score);
    const refId = String(oldGrounding.refKey || '').match(/^ep:(\d+)$/)?.[1];
    if (!refId) {
      skipped.push({ id: row.id, reason: 'refkey_not_event_id' });
      continue;
    }
    const ref = eventById.get(Number(refId));
    const refPayload = parseJson(ref?.payload, {});
    const refSummary = clean(refPayload.summary, 500);
    const nextSummary = anchoredThought(refSummary);
    if (!nextSummary) {
      skipped.push({ id: row.id, reason: 'missing_ref_summary', refId: Number(refId) });
      continue;
    }
    const grounding = await mindVitals.groundedness(`repair:${row.id}`, nextSummary, [{ key: `ep:${refId}`, text: refSummary }]);
    if (!grounding || !(Number(grounding.score) >= minScore) || !(Number(grounding.score) > oldScore)) {
      skipped.push({ id: row.id, reason: 'repair_score_not_better', refId: Number(refId), oldScore, newScore: grounding?.score ?? null });
      continue;
    }
    const repairedPayload = {
      ...payload,
      summary: nextSummary,
      meta: {
        ...(payload.meta && typeof payload.meta === 'object' ? payload.meta : {}),
        grounding,
        groundingRepair: {
          mode: 'deterministic_experience_anchor',
          repairedAt: NOW,
          previousSummary: clean(payload.summary, 500),
          previousGrounding: oldGrounding,
          refEventId: Number(refId),
          refSummary: clean(refSummary, 500),
          repairScore: grounding.score,
        },
      },
    };
    updates.push({
      id: row.id,
      refId: Number(refId),
      oldScore,
      newScore: grounding.score,
      oldSummary: clean(payload.summary, 120),
      newSummary: nextSummary,
      payload: JSON.stringify(repairedPayload),
    });
  }

  if (apply && updates.length) {
    const stmt = db.prepare('UPDATE events SET payload = ? WHERE id = ?');
    const tx = db.transaction((items) => {
      for (const item of items) stmt.run(item.payload, item.id);
    });
    tx(updates);
  }

  const avgOld = updates.length ? updates.reduce((sum, item) => sum + item.oldScore, 0) / updates.length : null;
  const avgNew = updates.length ? updates.reduce((sum, item) => sum + item.newScore, 0) / updates.length : null;
  mkdirSync(OUT_DIR, { recursive: true });
  const reportPath = join(OUT_DIR, `thought-grounding-repair-${NOW}.json`);
  const latestPath = join(OUT_DIR, 'latest.json');
  const report = {
    ok: true,
    applied: apply,
    dbPath: DB_PATH,
    provider: { type: 'ollama', model, baseUrl },
    threshold,
    minScore,
    scanned: rows.length,
    repaired: updates.length,
    skipped: skipped.length,
    avgOld: avgOld == null ? null : Math.round(avgOld * 1000) / 1000,
    avgNew: avgNew == null ? null : Math.round(avgNew * 1000) / 1000,
    sample: updates.slice(0, 10).map(({ payload: _payload, ...item }) => item),
    skippedSample: skipped.slice(0, 10),
    generatedAt: new Date(NOW).toISOString(),
    reportPath: cleanPath(reportPath),
    latestPath: cleanPath(latestPath),
  };
  const body = JSON.stringify(report, null, 2);
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  console.log(body);
} finally {
  db.close();
}
