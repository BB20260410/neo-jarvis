#!/usr/bin/env node
// @ts-check

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { appendEvent, close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { buildNoeMemoryStatus } from '../src/memory/NoeMemoryStatus.js';
import { memoryPolicyForProfile } from '../src/voice/MemoryPolicy.js';

function check(id, passed, details = {}) {
  return { id, passed: passed === true, details };
}

function makeStack(dbPath) {
  initSqlite(dbPath);
  const memory = new MemoryCore({
    conflictPolicy: { enabled: true, scanLimit: 50 },
    dedupe: { enabled: false },
    logger: { warn: () => {}, info: () => {} },
  });
  const auditLog = new NoeMemoryAuditLog({ db: () => memory.db() });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now: () => Date.now(), logger: { warn: () => {} } });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });
  return { memory, auditLog, writeGate, retriever };
}

export async function runMemoryRetentionVerification({ dbPath } = {}) {
  const dir = dbPath ? null : mkdtempSync(join(tmpdir(), 'noe-memory-retention-'));
  const path = dbPath || join(dir, 'panel.db');
  const checks = [];
  try {
    let { memory, auditLog, writeGate, retriever } = makeStack(path);
    const retained = writeGate.commit({
      kind: 'preference',
      projectId: 'noe',
      body: '主人长期偏好黑咖啡，不加糖。',
      sourceType: 'fact_extract',
      sourceEpisodeId: 'ep-retention-1',
      evidenceRefs: ['episode:ep-retention-1'],
      confidence: 0.86,
      tags: ['preference', 'coffee'],
    });
    close();
    ({ memory, auditLog, writeGate, retriever } = makeStack(path));
    const afterRestart = memory.recall({ q: '黑咖啡', projectId: 'noe', scope: 'fact', bumpHits: false });
    checks.push(check('restart_retention', Boolean(retained.ok && afterRestart.some((m) => /黑咖啡/.test(m.body))), { memoryId: retained.memory?.id || null }));

    for (let i = 0; i < 80; i += 1) {
      writeGate.commit({
        kind: 'fact',
        projectId: 'noe',
        body: `噪声事实 ${i}：这条用于上下文轮转压力，主题是文件索引和任务队列。`,
        sourceType: 'verify_noise',
        sourceEpisodeId: `ep-noise-${i}`,
        evidenceRefs: [`episode:ep-noise-${i}`],
        confidence: 0.55,
      });
    }
    const retrieved = await retriever.retrieve({
      transcript: '黑咖啡',
      projectId: 'noe',
      routeType: 'chat',
      memoryPolicy: { injectLimit: 4, recallLimit: 6 },
    });
    checks.push(check('context_rotation_noise_recall', retrieved.selected.some((m) => /黑咖啡/.test(m.body)), { selected: retrieved.selected.map((m) => m.id).slice(0, 6) }));

    const linkedRows = getDb().prepare('SELECT link_type, link_ref FROM noe_memory_link WHERE memory_id=?').all(retained.memory?.id);
    checks.push(check('source_linkage', linkedRows.some((r) => r.link_type === 'source_episode' && r.link_ref === 'ep-retention-1'), { links: linkedRows.length }));

    const oldPref = writeGate.commit({
      kind: 'preference',
      projectId: 'noe',
      body: '主人现在喝美式咖啡。',
      sourceType: 'fact_extract',
      sourceEpisodeId: 'ep-pref-old',
      evidenceRefs: ['episode:ep-pref-old'],
      confidence: 0.75,
    });
    const newPref = writeGate.commit({
      kind: 'preference',
      projectId: 'noe',
      body: '主人现在喝拿铁咖啡。',
      sourceType: 'fact_extract',
      sourceEpisodeId: 'ep-pref-new',
      evidenceRefs: ['episode:ep-pref-new'],
      confidence: 0.78,
    });
    const currentCoffee = memory.recall({ q: '拿铁咖啡', projectId: 'noe', scope: 'fact', includeHidden: true, bumpHits: false });
    checks.push(check('update_preference', Boolean(oldPref.ok && newPref.ok && currentCoffee.some((m) => /拿铁/.test(m.body))), { oldId: oldPref.memory?.id, newId: newPref.memory?.id }));

    const secret = writeGate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: 'OPENAI_API_KEY=unit-test-redacted-value',
      sourceEpisodeId: 'ep-secret',
      evidenceRefs: ['episode:ep-secret'],
      confidence: 0.9,
    });
    checks.push(check('secret_quarantine', secret.decision === 'quarantined' && !secret.memory, { decision: secret.decision, reason: secret.reason }));

    const incomplete = writeGate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: '这是一条被截断模型输出里的半截记忆',
      sourceEpisodeId: 'ep-incomplete',
      evidenceRefs: ['episode:ep-incomplete'],
      confidence: 0.9,
      incomplete: true,
      finishReason: 'length',
    });
    checks.push(check('incomplete_rejected', incomplete.decision === 'rejected' && incomplete.reason === 'incomplete_model_output', { decision: incomplete.decision, reason: incomplete.reason }));

    const noWrite = writeGate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: 'no_write:ephemeral_instruction',
      sourceEpisodeId: 'ep-nowrite',
      evidenceRefs: ['episode:ep-nowrite'],
      confidence: 1,
      noWriteReason: 'ephemeral_instruction',
    });
    checks.push(check('no_write_rejected', noWrite.decision === 'rejected' && /^no_write:/.test(noWrite.reason), { decision: noWrite.decision, reason: noWrite.reason }));

    const runtimeState = writeGate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: '刚刚用户点击了当前页面的刷新按钮。',
      sourceEpisodeId: 'ep-runtime-state',
      evidenceRefs: ['episode:ep-runtime-state'],
      confidence: 0.9,
    });
    checks.push(check('ephemeral_runtime_rejected', runtimeState.decision === 'rejected' && runtimeState.reason === 'ephemeral_or_runtime_state', { decision: runtimeState.decision, reason: runtimeState.reason }));

    const replay = auditLog.replayCandidate(secret.candidate?.id);
    checks.push(check('quarantine_replay', replay.ok === true && replay.decision === 'quarantined', { candidateId: secret.candidate?.id, decision: replay.decision }));

    const assistantPolicy = memoryPolicyForProfile({ id: 'assistant-test', mode: 'assistant' });
    checks.push(check('assistant_mode_memory_policy', assistantPolicy.writeDialogue === false && assistantPolicy.extractFacts === false, assistantPolicy));

    const status = buildNoeMemoryStatus({ db: getDb(), env: { NOE_MEMORY_EMBED: 'ollama', NOE_MEMORY_EMBED_MODEL: 'qwen3-embedding:0.6b' } });
    checks.push(check('semantic_provider_report', status.semanticProvider.enabled === true && status.semanticProvider.provider === 'ollama', status.semanticProvider));
    checks.push(check('orphan_fact_budget', status.sourceLinked.orphanFacts <= 1, status.sourceLinked));

    const hideOk = memory.hide(retained.memory?.id, { projectId: 'noe', reason: 'verify_ui_hide' });
    const unhideOk = memory.unhide(retained.memory?.id, { projectId: 'noe' });
    appendEvent({ kind: 'noe_memory_ui', tag: 'hide', entityType: 'noe_memory', entityId: retained.memory?.id, projectId: 'noe' });
    const auditCount = getDb().prepare("SELECT COUNT(*) AS c FROM events WHERE kind='noe_memory_ui' AND entity_id=?").get(retained.memory?.id)?.c || 0;
    checks.push(check('ui_forget_audit', Boolean(hideOk && unhideOk && auditCount >= 1), { hideOk, unhideOk, auditCount }));

    const passed = checks.every((item) => item.passed);
    return { ok: passed, passed, checks, dbPath: path };
  } finally {
    close();
    if (dir && process.env.NOE_KEEP_MEMORY_VERIFY_DB !== '1') {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const report = await runMemoryRetentionVerification({});
  const outDir = join(process.cwd(), 'output', 'noe-memory-retention');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `noe-memory-retention-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: report.ok, passed: report.passed, reportPath: file, checks: report.checks.map((c) => ({ id: c.id, passed: c.passed })) }, null, 2));
  if (process.argv.includes('--require-pass') && !report.passed) process.exit(1);
}
