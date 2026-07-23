import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';

let dir = null;

function stack() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-gate-test-'));
  initSqlite(join(dir, 'panel.db'));
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => 1000 });
  const gate = new NoeMemoryWriteGate({ memory, auditLog, now: () => 1000, logger: { warn: () => {} } });
  return { memory, gate };
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('NoeMemoryWriteGate', () => {
  it('accepts evidenced candidates, writes memory, and links the source episode', () => {
    const { gate } = stack();
    const r = gate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: '主人长期偏好黑咖啡。',
      sourceEpisodeId: 'ep-1',
      evidenceRefs: ['episode:ep-1'],
      confidence: 0.8,
    });
    expect(r.ok).toBe(true);
    expect(r.memory).toMatchObject({ body: '主人长期偏好黑咖啡。', sourceEpisodeId: 'ep-1' });
    const link = getDb().prepare('SELECT link_type, link_ref FROM noe_memory_link WHERE memory_id=?').all(r.memory.id);
    expect(link).toEqual(expect.arrayContaining([expect.objectContaining({ link_type: 'source_episode', link_ref: 'ep-1' })]));
  });

  it('rejects auto facts without evidence and audits the candidate', () => {
    const { gate } = stack();
    const r = gate.commit({ kind: 'fact', projectId: 'noe', body: '主人喜欢蓝色。', confidence: 0.8 });
    expect(r).toMatchObject({ ok: false, decision: 'rejected', reason: 'source_evidence_required' });
    const row = getDb().prepare('SELECT decision, decision_reason FROM noe_memory_candidate WHERE id=?').get(r.candidate.id);
    expect(row).toMatchObject({ decision: 'rejected', decision_reason: 'source_evidence_required' });
  });

  it('quarantines secret-like text and rejects incomplete model output', () => {
    const { gate } = stack();
    const secret = gate.commit({
      kind: 'fact',
      body: 'OPENAI_API_KEY=unit-test-redacted-value',
      sourceEpisodeId: 'ep-secret',
      evidenceRefs: ['episode:ep-secret'],
      confidence: 0.9,
    });
    expect(secret).toMatchObject({ ok: false, decision: 'quarantined', reason: 'sensitive_text_detected' });
    const incomplete = gate.commit({
      kind: 'fact',
      body: '半截记忆',
      sourceEpisodeId: 'ep-cut',
      evidenceRefs: ['episode:ep-cut'],
      confidence: 0.9,
      incomplete: true,
      finishReason: 'length',
    });
    expect(incomplete).toMatchObject({ ok: false, decision: 'rejected', reason: 'incomplete_model_output' });
  });

  it('rejects no-write and ephemeral runtime candidates before persistence', () => {
    const { gate } = stack();
    const noWrite = gate.commit({
      kind: 'fact',
      body: 'no_write:闲聊不沉淀',
      noWriteReason: 'casual_chat',
      sourceEpisodeId: 'ep-nowrite',
      evidenceRefs: ['episode:ep-nowrite'],
      confidence: 1,
    });
    expect(noWrite).toMatchObject({ ok: false, decision: 'rejected', reason: 'no_write:casual_chat' });

    const ephemeral = gate.commit({
      kind: 'fact',
      body: '刚刚用户点击了当前页面的刷新按钮。',
      sourceEpisodeId: 'ep-runtime',
      evidenceRefs: ['episode:ep-runtime'],
      confidence: 0.9,
    });
    expect(ephemeral).toMatchObject({ ok: false, decision: 'rejected', reason: 'ephemeral_or_runtime_state' });
  });

  it('passes ttlMs/expiresAt through to memory.write for one-shot expiring cards', () => {
    const { gate } = stack();
    // 显式 expiresAt：原样透传（确定性，不依赖时钟）。
    const explicit = gate.commit({
      kind: 'skill',
      projectId: 'noe',
      scope: 'project',
      body: '一次性技能卡：本次部署专用，过期窗后应自然退场。',
      tags: ['skill'],
      sourceEpisodeId: 'ep-exp',
      evidenceRefs: ['episode:ep-exp'],
      confidence: 0.8,
      expiresAt: 9_999_999,
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.memory.expiresAt).toBe(9_999_999);

    // 仅给 ttlMs：MemoryCore 用自身写入时钟派生 expiresAt（= 写入 now + ttlMs），ttlMs 本身原样落库。
    const before = Date.now();
    const ttl = gate.commit({
      kind: 'skill',
      projectId: 'noe',
      scope: 'project',
      body: '一次性技能卡：给 ttlMs 让其在窗口后过期。',
      tags: ['skill'],
      sourceEpisodeId: 'ep-ttl',
      evidenceRefs: ['episode:ep-ttl'],
      confidence: 0.8,
      ttlMs: 60_000,
    });
    const after = Date.now();
    expect(ttl.ok).toBe(true);
    expect(ttl.memory.ttlMs).toBe(60_000);
    expect(ttl.memory.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(ttl.memory.expiresAt).toBeLessThanOrEqual(after + 60_000);

    // 未给过期信息时不该凭空造过期窗（默认 null，逐字零回归）。
    const noTtl = gate.commit({
      kind: 'skill',
      projectId: 'noe',
      scope: 'project',
      body: '普通技能卡：不带过期窗，应永不过期。',
      tags: ['skill'],
      sourceEpisodeId: 'ep-none',
      evidenceRefs: ['episode:ep-none'],
      confidence: 0.8,
    });
    expect(noTtl.ok).toBe(true);
    expect(noTtl.memory.ttlMs ?? null).toBe(null);
    expect(noTtl.memory.expiresAt ?? null).toBe(null);
  });

  it('requires review for high-risk memory unless owner confirmed', () => {
    const { gate } = stack();
    const highRisk = gate.commit({
      kind: 'identity',
      body: '主人身份级事实需要人工确认。',
      sourceEpisodeId: 'ep-risk',
      evidenceRefs: ['episode:ep-risk'],
      confidence: 0.9,
      risk: 'high',
    });
    expect(highRisk).toMatchObject({ ok: false, decision: 'needs_review', reason: 'review_required_for_high_risk_memory' });

    const confirmed = gate.commit({
      kind: 'identity',
      body: '主人确认的身份级事实。',
      sourceEpisodeId: 'ep-risk-ok',
      evidenceRefs: ['episode:ep-risk-ok'],
      confidence: 0.9,
      risk: 'high',
      writeMode: 'owner_confirmed',
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.memory.body).toBe('主人确认的身份级事实。');
  });
});
