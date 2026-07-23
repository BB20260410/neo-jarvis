import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import {
  buildActiveMemoryContext,
  createActiveMemoryRecallCircuitBreaker,
  parseNoeChineseTimeWindow,
  recallFocusConclusions,
  sanitizeActiveMemoryRecallError,
  writeFocusConclusionMemory,
} from '../../src/memory/NoeActiveMemory.js';

describe('NoeActiveMemory', () => {
  const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('skips when direct session memory is disabled or goal is too small', () => {
    const out = buildActiveMemoryContext({ goal: 'hi', memory: { recall: () => [{ text: 'x' }] } });

    expect(out.skipped).toBe(true);
    expect(out.systemPromptAddition).toBe('');
  });

  it('builds a hidden memory-context block from local recall', () => {
    const out = buildActiveMemoryContext({
      goal: '继续本地多模型协作',
      projectId: 'noe',
      memory: {
        recall: ({ q, projectId }) => [
          { id: 'm1', text: `for ${projectId}: ${q}` },
          { id: 'm2', text: 'XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000' },
        ],
      },
    });

    expect(out.skipped).toBe(false);
    expect(out.memories).toHaveLength(2);
    expect(out.systemPromptAddition).toContain('<memory-context');
    expect(out.systemPromptAddition).toContain('继续本地多模型协作');
    expect(out.systemPromptAddition).not.toContain('tp-unit-test-redaction-key');
  });

  it('fail-opens active recall through an OpenClaw-style circuit breaker', () => {
    let now = 1000;
    let calls = 0;
    const circuitBreaker = createActiveMemoryRecallCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => now,
    });
    const memory = {
      recall: () => {
        calls += 1;
        throw new Error('XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000');
      },
    };

    const first = buildActiveMemoryContext({
      goal: '继续本地记忆召回',
      projectId: 'noe',
      memory,
      circuitBreaker,
      circuitKey: 'unit-active',
    });
    const second = buildActiveMemoryContext({
      goal: '继续本地记忆召回',
      projectId: 'noe',
      memory,
      circuitBreaker,
      circuitKey: 'unit-active',
    });
    now += 60_001;
    const third = buildActiveMemoryContext({
      goal: '继续本地记忆召回',
      projectId: 'noe',
      memory: { recall: () => [{ id: 'm-ok', text: '熔断冷却后恢复召回' }] },
      circuitBreaker,
      circuitKey: 'unit-active',
    });

    expect(first).toMatchObject({ ok: false, skipped: true, reason: 'active_memory_recall_failed' });
    expect(first.debug.error).not.toContain('tp-unit-test-redaction-key');
    expect(second).toMatchObject({ ok: true, skipped: true, reason: 'active_memory_circuit_open' });
    expect(calls).toBe(1);
    expect(third.skipped).toBe(false);
    expect(third.systemPromptAddition).toContain('熔断冷却后恢复召回');
  });

  it('sanitizes active recall errors before telemetry or logs can use them', () => {
    const safe = sanitizeActiveMemoryRecallError('Bearer tp-unit-test-redaction-key-00000000000000000000 failed');
    expect(safe).not.toContain('tp-unit-test-redaction-key');
    expect(safe).toContain('[redacted]');
  });

  it('parses Chinese time words into deterministic recall windows', () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    const yesterday = parseNoeChineseTimeWindow('昨天我们做到哪了', { now });
    const lastWeek = parseNoeChineseTimeWindow('上周做过什么', { now });

    expect(yesterday).toMatchObject({ matched: true, label: 'yesterday' });
    expect(localDay(yesterday.startMs)).toBe('2026-06-07');
    expect(lastWeek).toMatchObject({ matched: true, label: 'last_week' });
  });

  it('blocks focus conclusion writes without user ack or validated consensus ack', () => {
    const writes = [];
    const memory = { write: (input) => { writes.push(input); return { id: 'm1', ...input }; } };
    const blocked = writeFocusConclusionMemory({
      memory,
      projectId: 'noe',
      focus: { id: 'focus-1', title: 'BaiLongma 吸收' },
      summary: '已完成 ACUI-lite',
      consensusAck: { ok: true },
    });
    const allowed = writeFocusConclusionMemory({
      memory,
      projectId: 'noe',
      focus: { id: 'focus-1', title: 'BaiLongma 吸收' },
      summary: '已完成 ACUI-lite',
      consensusAck: { source: 'validated_consensus_ledger', ledgerVerified: true, passed: true },
      evidenceRefs: ['output/report.json'],
    });

    expect(blocked).toMatchObject({ ok: false, error: 'focus_conclusion_ack_required' });
    expect(allowed.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ scope: 'focus_conclusion', sourceType: 'focus_conclusion' });
    expect(writes[0].body).toContain('output/report.json');
  });

  it('recalls focus conclusions by Chinese time words and redacts secrets', () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    const memory = {
      recall: ({ scope }) => scope === 'focus_conclusion' ? [
        { id: 'old', scope, text: '前天的总结', updatedAt: Date.parse('2026-06-06T12:00:00.000Z') },
        { id: 'yesterday', scope, text: '昨天完成 XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000', updatedAt: Date.parse('2026-06-07T08:00:00.000Z') },
      ] : [],
    };
    const out = recallFocusConclusions({ query: '昨天我们做了什么', projectId: 'noe', memory, now });

    expect(out.skipped).toBe(false);
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].id).toBe('yesterday');
    expect(out.memories[0].text).not.toContain('tp-unit-test-redaction-key');
  });

  it('adds matching focus conclusions into active memory context', () => {
    const now = new Date('2026-06-08T12:00:00.000Z');
    const memory = {
      recall: ({ q, scope }) => {
        if (scope === 'focus_conclusion') return [{ id: 'fc1', scope, text: '昨天完成 ACUI-lite 状态卡片', updatedAt: Date.parse('2026-06-07T10:00:00.000Z') }];
        return [{ id: 'base', scope: 'project', text: `base:${q}` }];
      },
    };
    const out = buildActiveMemoryContext({ goal: '昨天我们做到哪了', projectId: 'noe', memory, now });

    expect(out.systemPromptAddition).toContain('base:昨天我们做到哪了');
    expect(out.systemPromptAddition).toContain('昨天完成 ACUI-lite 状态卡片');
    expect(out.debug.focusConclusionTimeWindow).toBe('yesterday');
  });

  it('writes and recalls focus conclusions through the real MemoryCore store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-active-memory-'));
    try {
      initSqlite(path.join(dir, 'panel.db'));
      const memory = new MemoryCore();
      const written = writeFocusConclusionMemory({
        memory,
        projectId: 'noe',
        focus: { id: 'focus-real', title: '真实记忆恢复' },
        summary: '刚刚完成 focus conclusion 集成测试',
        userAck: true,
      });
      const recalled = recallFocusConclusions({
        query: '刚刚我们做到哪了',
        projectId: 'noe',
        memory,
        now: new Date(),
      });

      expect(written.ok).toBe(true);
      expect(recalled.memories.some((item) => item.text.includes('focus conclusion 集成测试'))).toBe(true);
    } finally {
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
