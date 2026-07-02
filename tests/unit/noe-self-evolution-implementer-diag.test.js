import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeNoeSelfEvolutionImplementer } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// P1：implementer 失败诊断黑洞修复（attemptedCandidates 记全候选真实尝试）+ 硬网络错跳重试。
// 用注入的 structuredCall + adapter.id 标识区分 codex/lmstudio，精确验证候选循环行为。

const PLAN = { kind: 'noe_patch_plan', operations: [{ op: 'write_file', path: 'z.js', content: '// ok' }] };
const route = () => ({ adapterId: 'codex' });
const codexAdapter = { id: 'codex', chat: () => {} };
const lmAdapter = { id: 'lmstudio', chat: () => {} };
const getAdapter = (aid) => (aid === 'lmstudio' ? lmAdapter : codexAdapter);
const readRef = (root, ref) => JSON.parse(readFileSync(resolve(root, ref), 'utf8'));
const callsFor = (sc, id) => sc.mock.calls.filter((c) => c[0]?.adapter?.id === id).length;

describe('P1 implementer 诊断黑洞 + 硬网络跳重试', () => {
  it('codex 硬网络错(error 61) → 只试 1 次(不重试) → 降级 lmstudio 出 patch；attemptedCandidates 两候选可见', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-impl-'));
    try {
      const sc = vi.fn(async ({ adapter }) => (adapter.id === 'codex'
        ? { ok: false, error: 'fetch failed: connect error 61' }
        : { ok: true, value: PLAN }));
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, now: () => new Date('2026-06-21T00:00:00Z'), structuredCall: sc });
      const out = await impl({ objective: '给 src/x.js 加输入校验' });

      expect(out.adapterId).toBe('lmstudio');
      expect(callsFor(sc, 'codex')).toBe(1); // 硬网络错 → 只试 1 次（不浪费第 2 次重试）
      expect(callsFor(sc, 'lmstudio')).toBe(1);
      const payload = readRef(root, out.patchPlanRef);
      expect(payload.attemptedCandidates).toHaveLength(2);
      expect(payload.attemptedCandidates[0]).toMatchObject({ id: 'codex', ok: false, attempts: 1 });
      expect(payload.attemptedCandidates[0].error).toMatch(/61/);
      expect(payload.attemptedCandidates[1]).toMatchObject({ id: 'lmstudio', ok: true, operationsLen: 1 });
      expect(payload.routedAdapterId).toBe('codex');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('codex 软错(非网络) → 重试满 2 次再降级；lmstudio 成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-impl-'));
    try {
      const sc = vi.fn(async ({ adapter }) => (adapter.id === 'codex'
        ? { ok: false, error: '解析失败：模型没给 operations' }
        : { ok: true, value: PLAN }));
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, structuredCall: sc });
      const out = await impl({ objective: 'x' });
      expect(out.adapterId).toBe('lmstudio');
      expect(callsFor(sc, 'codex')).toBe(2); // 软错 → 用满 2 次重试（与硬网络对照）
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('两候选都失败 → 抛 no_patch_plan，且 diag 报告含 attemptedCandidates(黑洞修复=两候选错都可见)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-impl-'));
    try {
      const sc = vi.fn(async ({ adapter }) => ({ ok: false, error: adapter.id === 'codex' ? 'connect error 61' : 'lmstudio offline ECONNREFUSED' }));
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, now: () => new Date('2026-06-21T00:00:00Z'), structuredCall: sc });
      let caught;
      try { await impl({ objective: 'x' }); } catch (e) { caught = e; }
      expect(caught?.message).toBe('self_evolution_no_patch_plan_in_reply');
      const diagRef = caught?.selfEvolution?.diagRef;
      expect(diagRef).toBeTruthy();
      const diag = readRef(root, diagRef);
      expect(diag.attemptedCandidates).toHaveLength(2);
      expect(diag.attemptedCandidates.map((c) => c.id).sort()).toEqual(['codex', 'lmstudio']);
      expect(diag.attemptedCandidates.every((c) => c.ok === false)).toBe(true);
      // codex 硬网络错只试 1 次；lmstudio 硬网络错(ECONNREFUSED)也只试 1 次
      expect(diag.attemptedCandidates.find((c) => c.id === 'codex').attempts).toBe(1);
      expect(diag.routedAdapterId).toBe('codex');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('静默成功(ok 但 operations 空) → 候选记 error=non_usable_patch_plan(防黑洞复发)，rawReplyExcerpt 非 [object Object]', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-impl-'));
    try {
      const sc = vi.fn(async () => ({ ok: true, value: { kind: 'noe_patch_plan', operations: [] } })); // 合法 JSON 但空操作
      const impl = makeNoeSelfEvolutionImplementer({ getAdapter, route, root, now: () => new Date('2026-06-21T00:00:00Z'), structuredCall: sc });
      let caught;
      try { await impl({ objective: 'x' }); } catch (e) { caught = e; }
      expect(caught?.message).toBe('self_evolution_no_patch_plan_in_reply');
      const diag = readRef(root, caught.selfEvolution.diagRef);
      // 两候选都"ok 但空 operations" → 都记 non_usable_patch_plan（不再是空 error 的"失败但无因"）
      expect(diag.attemptedCandidates.every((c) => c.ok === false && c.error === 'non_usable_patch_plan')).toBe(true);
      // 软错(非硬网络) → 重试满 2 次
      expect(diag.attemptedCandidates.find((c) => c.id === 'codex').attempts).toBe(2);
      // rawReplyExcerpt 不再是 [object Object]，能看到真实空操作回复
      expect(diag.rawReplyExcerpt).not.toContain('[object Object]');
      expect(diag.rawReplyExcerpt).toContain('operations');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
