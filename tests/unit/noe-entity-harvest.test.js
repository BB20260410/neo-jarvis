// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createEntityHarvest, resolveEntityHarvestConfig } from '../../src/cognition/NoeEntityHarvest.js';

function makeKg() {
  const calls = [];
  return { calls, upsertEntity(input) { calls.push(input); return `kg-${calls.length}`; } };
}

// 含多个反复出现技术实体的长报告：MetaGPT(主题,多次) + AutoGPT(提到,多次) + 泛词噪声
const longReport = `MetaGPT is a multi-agent framework. MetaGPT assigns roles. MetaGPT uses SOPs.
Compared to AutoGPT, MetaGPT is more structured. AutoGPT relies on loops. AutoGPT can drift.
This framework and that approach use the best practices for how to build agents. `.repeat(4);

describe('NoeEntityHarvest', () => {
  it('resolveConfig 默认 OFF', () => {
    const c = resolveEntityHarvestConfig({});
    expect(c.enabled).toBe(false);
    expect(c.minMentionInText).toBe(2);
    expect(c.maxEntities).toBe(12);
  });

  it('flag OFF → 不写（零回归）', () => {
    const kg = makeKg();
    const h = createEntityHarvest({ knowledgeGraph: kg });
    const r = h.harvest({ report: longReport, topic: 'MetaGPT' });
    expect(r.skipped).toBe('flag_off');
    expect(kg.calls.length).toBe(0);
  });

  it('flag ON：抽反复出现的技术实体写 kg + 主题实体带 description、其他留空', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg });
      const r = h.harvest({ report: longReport, topic: 'MetaGPT', sources: [{ title: 'MetaGPT repo' }] });
      expect(r.ok).toBe(true);
      expect(r.written).toBeGreaterThan(0);
      const names = kg.calls.map((c) => c.name);
      expect(names).toContain('MetaGPT');
      expect(names).toContain('AutoGPT');
      // 泛词不写
      expect(names).not.toContain('best');
      expect(names).not.toContain('the');
      // 主题实体 MetaGPT description 非空（已深究）；提到的 AutoGPT description 空（没深究=源①缺口信号）
      const meta = kg.calls.find((c) => c.name === 'MetaGPT');
      const auto = kg.calls.find((c) => c.name === 'AutoGPT');
      expect(meta.description.length).toBeGreaterThan(0);
      expect(auto.description).toBe('');
      expect(auto.type).toBe('concept');
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('topic 是真实 query 文本(非纯实体名)时主题实体仍正确识别 description 填(P1#4 真实投产场景，钉死 includes 修复)', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg });
      // 生产 topic 传的是 research step query 文本(winner.queryText)如下，而非纯 'MetaGPT'——旧 === 在此永假致 description 全空
      const r = h.harvest({ report: longReport, topic: 'MetaGPT multi-agent software company collaboration', sources: [{ title: 'MetaGPT repo' }] });
      expect(r.ok).toBe(true);
      const meta = kg.calls.find((c) => c.name === 'MetaGPT');
      expect(meta.description.length).toBeGreaterThan(0); // query 文本含 MetaGPT → includes 识别为主题实体、description 填(治 === 永假)
      const auto = kg.calls.find((c) => c.name === 'AutoGPT');
      expect(auto.description).toBe(''); // AutoGPT 不在 query 中 → 非主题实体 → 空(留给源①当未深究缺口)
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('只出现 1 次的实体不写（防一次性提及噪声）', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg });
      h.harvest({ report: `${longReport} OneShotXyzLib appears once only.`, topic: 'MetaGPT' });
      const names = kg.calls.map((c) => c.name);
      expect(names).not.toContain('OneShotXyzLib'); // 仅 1 次 < minMention 2
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('报告太短 → skip too_short', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg });
      const r = h.harvest({ report: 'MetaGPT MetaGPT', topic: 'MetaGPT' });
      expect(r.skipped).toBe('too_short');
      expect(kg.calls.length).toBe(0);
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('无 kg 安全 skip', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const h = createEntityHarvest({ knowledgeGraph: null });
      expect(h.harvest({ report: longReport, topic: 't' }).skipped).toBe('no_kg');
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('fail-open：upsertEntity 抛错不崩、返回 error', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = { upsertEntity() { throw new Error('db locked'); } };
      const h = createEntityHarvest({ knowledgeGraph: kg });
      const r = h.harvest({ report: longReport, topic: 'MetaGPT' });
      expect(r.ok).toBe(false);
      expect(r.error).toContain('db locked');
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('maxEntities 上限截断（防长报告灌爆）', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg, config: { minMentionInText: 1, maxEntities: 3 } });
      h.harvest({ report: longReport, topic: 'MetaGPT' });
      expect(kg.calls.length).toBeLessThanOrEqual(3);
    } finally { delete process.env.NOE_KG_INGEST; }
  });

  it('返回 entities:[{name,id}]（供 LLM 关系抽取用，name→id 映射）', () => {
    process.env.NOE_KG_INGEST = '1';
    try {
      const kg = makeKg();
      const h = createEntityHarvest({ knowledgeGraph: kg });
      const r = h.harvest({ report: longReport, topic: 'MetaGPT', sources: [{ title: 'MetaGPT repo' }] });
      expect(Array.isArray(r.entities)).toBe(true);
      expect(r.entities.length).toBe(r.written);
      const meta = r.entities.find((e) => e.name === 'MetaGPT');
      expect(meta && meta.id).toBeTruthy();
    } finally { delete process.env.NOE_KG_INGEST; }
  });
});
