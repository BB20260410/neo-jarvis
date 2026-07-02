import { describe, it, expect } from 'vitest';
import { resolveReflectBrain, resolveHeavyReflectBrain, LOCAL_REFLECT_ADAPTERS, HEAVY_REFLECT_ADAPTERS, DEFAULT_REFLECT_MODEL } from '../../src/cognition/NoeReflectBrain.js';

describe('NoeReflectBrain 深思脑选型', () => {
  it('默认 OFF：未开 NOE_REFLECT_TIER 时 enabled=false（消费方保持现状）', () => {
    const r = resolveReflectBrain({ env: {} });
    expect(r.enabled).toBe(false);
    expect(r.adapterId).toBe(null);
    expect(r.model).toBe(null);
  });

  it('开启后默认 lmstudio + 主脑 Qwen 35B', () => {
    const r = resolveReflectBrain({ env: { NOE_REFLECT_TIER: '1' } });
    expect(r.enabled).toBe(true);
    expect(r.adapterId).toBe('lmstudio');
    expect(r.model).toBe(DEFAULT_REFLECT_MODEL);
    expect(DEFAULT_REFLECT_MODEL).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('env 可覆盖 adapter（白名单内）与模型', () => {
    const r = resolveReflectBrain({ env: { NOE_REFLECT_TIER: '1', NOE_REFLECT_BRAIN: 'ollama', NOE_REFLECT_MODEL: 'my-local-model' } });
    expect(r.adapterId).toBe('ollama');
    expect(r.model).toBe('my-local-model');
  });

  it('铁律：配置指向付费 adapter 一律警告并回退 lmstudio（自主认知不烧配额）', () => {
    const warns = [];
    for (const paid of ['claude', 'codex', 'minimax', 'gemini', 'ccr']) {
      const r = resolveReflectBrain({ env: { NOE_REFLECT_TIER: '1', NOE_REFLECT_BRAIN: paid }, log: { warn: (m) => warns.push(m) } });
      expect(r.adapterId).toBe('lmstudio');
    }
    expect(warns.length).toBe(5);
    expect(warns[0]).toContain('白名单');
  });

  it('空串模型回到主脑 Qwen，避免 adapter 默认漂移', () => {
    const r = resolveReflectBrain({ env: { NOE_REFLECT_TIER: '1', NOE_REFLECT_MODEL: '' } });
    expect(r.model).toBe(DEFAULT_REFLECT_MODEL);
  });

  it('Qwen 可作为自动 reflect tier 模型', () => {
    const warns = [];
    const r = resolveReflectBrain({
      env: { NOE_REFLECT_TIER: '1', NOE_REFLECT_MODEL: 'qwen/qwen3.6-35b-a3b' },
      log: { warn: (m) => warns.push(m) },
    });
    expect(r.model).toBe('qwen/qwen3.6-35b-a3b');
    expect(warns).toEqual([]);
  });

  it('白名单只含本地 adapter', () => {
    expect(LOCAL_REFLECT_ADAPTERS).toEqual(['lmstudio', 'ollama']);
  });
});

describe('NoeReflectBrain 重决策 tier（C 分层：主脑可接 cloud）', () => {
  it('默认 OFF：未开 NOE_REFLECT_HEAVY_TIER → enabled=false + 回退本地 main（零回归）', () => {
    const r = resolveHeavyReflectBrain({ env: {} });
    expect(r.enabled).toBe(false);
    expect(r.adapterId).toBe('lmstudio');
    expect(r.model).toBe(DEFAULT_REFLECT_MODEL);
  });

  it('开启后放开 cloud：HEAVY_BRAIN=claude/codex 走 cloud（与高频 tier 铁律相反——重决策质量优先）', () => {
    const c = resolveHeavyReflectBrain({ env: { NOE_REFLECT_HEAVY_TIER: '1', NOE_REFLECT_HEAVY_BRAIN: 'claude' } });
    expect(c.enabled).toBe(true);
    expect(c.adapterId).toBe('claude'); // 反向对照：同 'claude' 在高频 tier 会被回退 lmstudio，重 tier 放行
    const x = resolveHeavyReflectBrain({ env: { NOE_REFLECT_HEAVY_TIER: '1', NOE_REFLECT_HEAVY_BRAIN: 'codex', NOE_REFLECT_HEAVY_MODEL: 'gpt-5.5' } });
    expect(x.adapterId).toBe('codex');
    expect(x.model).toBe('gpt-5.5');
  });

  it('开启后默认仍本地 lmstudio（不显式指定 cloud 时不擅自烧配额）', () => {
    expect(resolveHeavyReflectBrain({ env: { NOE_REFLECT_HEAVY_TIER: '1' } }).adapterId).toBe('lmstudio');
  });

  it('非重 tier 白名单 adapter（gemini）回退 lmstudio + 警告', () => {
    const warns = [];
    const r = resolveHeavyReflectBrain({ env: { NOE_REFLECT_HEAVY_TIER: '1', NOE_REFLECT_HEAVY_BRAIN: 'gemini' }, log: { warn: (m) => warns.push(m) } });
    expect(r.adapterId).toBe('lmstudio');
    expect(warns.length).toBe(1);
  });

  it('重 tier 白名单含 cloud（与高频本地白名单的关键区别）', () => {
    expect(HEAVY_REFLECT_ADAPTERS).toContain('claude');
    expect(HEAVY_REFLECT_ADAPTERS).toContain('codex');
    expect(LOCAL_REFLECT_ADAPTERS).not.toContain('claude'); // 高频 tier 绝不含 cloud
  });
});
