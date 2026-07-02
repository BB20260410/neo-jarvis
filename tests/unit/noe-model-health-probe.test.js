// @ts-check
import { describe, expect, it } from 'vitest';
import { createModelHealthProbe } from '../../src/server/services/NoeModelHealthProbe.js';

// P2 觉醒看板·本地模型存活探针。纯注入式，不触真后端。
const ROLES = {
  main: { role: 'main', label: 'Main', apiModel: 'qwen/qwen3.6-35b-a3b', loadKeys: ['qwen/qwen3.6-35b-a3b@6bit', 'qwen/qwen3.6-35b-a3b'] },
  review: { role: 'review', label: 'Review', apiModel: 'qwen/qwen3.6-27b', loadKeys: ['qwen/qwen3.6-27b@4bit'] },
  fallback: { role: 'fallback', label: 'Fallback', apiModel: 'gemma-4-26b-a4b-it-qat-mlx', loadKeys: ['gemma-4-26b-a4b-it-qat-mlx'] },
};

function discoverWith(modelIds, { lmOk = true, ollamaOk = true } = {}) {
  return async () => ({
    providers: [
      { id: 'lmstudio', available: lmOk, status: lmOk ? '已连接' : 'HTTP 0' },
      { id: 'ollama', available: ollamaOk, status: ollamaOk ? '已连接' : 'HTTP 0' },
    ],
    models: modelIds.map((id) => ({ id, provider: 'lmstudio' })),
  });
}

describe('createModelHealthProbe（P2 模型存活）', () => {
  it('三脑全加载 → brainsReady=3 + 各 loaded=true', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith(['qwen/qwen3.6-35b-a3b', 'qwen/qwen3.6-27b', 'gemma-4-26b-a4b-it-qat-mlx']),
      brainRoles: ROLES, now: () => 123,
    });
    const r = await probe.probe();
    expect(r.brainsReady).toBe(3);
    expect(r.brains.main.loaded).toBe(true);
    expect(r.brains.review.loaded).toBe(true);
    expect(r.brains.fallback.loaded).toBe(true);
    expect(r.lmstudio.available).toBe(true);
    expect(r.ts).toBe(123);
  });

  it('只 main 加载 → brainsReady=1，review/fallback 缺位', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith(['qwen/qwen3.6-35b-a3b']), brainRoles: ROLES,
    });
    const r = await probe.probe();
    expect(r.brainsReady).toBe(1);
    expect(r.brains.main.loaded).toBe(true);
    expect(r.brains.review.loaded).toBe(false);
    expect(r.brains.fallback.loaded).toBe(false);
  });

  it('@quant 后缀仍匹配（loaded id 带 @6bit → 命中 main）', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith(['qwen/qwen3.6-35b-a3b@6bit']), brainRoles: ROLES,
    });
    const r = await probe.probe();
    expect(r.brains.main.loaded).toBe(true);
  });

  it('discover 抛错 → fail-open（双后端未连 + brainsReady=0，不抛）', async () => {
    const probe = createModelHealthProbe({
      discover: async () => { throw new Error('ECONNREFUSED'); }, brainRoles: ROLES,
    });
    const r = await probe.probe();
    expect(r.ok).toBe(true);
    expect(r.brainsReady).toBe(0);
    expect(r.ollama.available).toBe(false);
    expect(r.lmstudio.available).toBe(false);
  });

  it('embedding dimHealth 注入：ollama 1024 维健康', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith([]), brainRoles: ROLES,
      dimHealth: () => ({ provider: 'ollama', dimension: 1024, degraded: false, orphanEventCount: 0 }),
    });
    const r = await probe.probe();
    expect(r.embedding.provider).toBe('ollama');
    expect(r.embedding.dimension).toBe(1024);
    expect(r.embedding.degraded).toBe(false);
  });

  it('embedding 维度孤儿（queryDimOrphaned）→ degraded=true', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith([]), brainRoles: ROLES,
      dimHealth: () => ({ provider: 'hash', dimension: 128, queryDimOrphaned: true, orphanEventCount: 7 }),
    });
    const r = await probe.probe();
    expect(r.embedding.degraded).toBe(true);
    expect(r.embedding.orphanEventCount).toBe(7);
  });

  it('dimHealth getter 抛错 → embedding fail-open 不崩', async () => {
    const probe = createModelHealthProbe({
      discover: discoverWith([]), brainRoles: ROLES,
      dimHealth: () => { throw new Error('boom'); },
    });
    const r = await probe.probe();
    expect(r.ok).toBe(true);
    expect(r.embedding.provider).toBe('unknown');
  });

  it('缺 discover → 构造即抛（DI 契约）', () => {
    expect(() => createModelHealthProbe({})).toThrow(/discover/);
  });
});
