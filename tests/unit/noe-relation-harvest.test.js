import { describe, it, expect, vi } from 'vitest';
import { createRelationHarvest } from '../../src/cognition/NoeRelationHarvest.js';

// LLM 三元组关系抽取：research report + 已抽实体 → 本地 LLM 抽 (主体,关系,客体) → 只在【已知实体】间 upsertRelation。
//   核心契约：只连已知实体(防 LLM 幻觉造点)、relType 规范化、去重、鲁棒解析、全程 fail-open、flag 默认 OFF。

const mkKg = () => {
  const calls = [];
  return { calls, upsertRelation: vi.fn((r) => { calls.push(r); return `rel-${calls.length}`; }) };
};
const mkAdapter = (reply, extra = {}) => ({ chat: vi.fn(async () => ({ reply, ...extra })) });
const ENTITIES = [{ name: 'Next.js', id: 'e1' }, { name: 'React', id: 'e2' }, { name: 'Vercel', id: 'e3' }];
const REPORT = 'A'.repeat(260); // >200 阈值

// flag 运行时检查（同 EntityHarvest 风格）：测试内开 flag。
const withFlag = async (fn) => {
  const old = process.env.NOE_KG_RELATIONS;
  process.env.NOE_KG_RELATIONS = '1';
  try { return await fn(); } finally {
    if (old === undefined) delete process.env.NOE_KG_RELATIONS; else process.env.NOE_KG_RELATIONS = old;
  }
};

describe('NoeRelationHarvest', () => {
  it('flag OFF → skipped:flag_off（默认零回归）', async () => {
    const old = process.env.NOE_KG_RELATIONS; delete process.env.NOE_KG_RELATIONS;
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => mkAdapter('[]') })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.skipped).toBe('flag_off');
    if (old !== undefined) process.env.NOE_KG_RELATIONS = old;
  });

  it('正常：LLM 三元组 → 只在已知实体间 upsertRelation（name→id 映射）', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = JSON.stringify([
      { src: 'Next.js', rel: 'built_with', dst: 'React' },
      { src: 'Next.js', rel: 'deployed_on', dst: 'Vercel' },
    ]);
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, topic: 'next', entities: ENTITIES });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(2);
    expect(kg.calls[0]).toMatchObject({ srcId: 'e1', dstId: 'e2', relType: 'built_with' });
    expect(kg.calls[1]).toMatchObject({ srcId: 'e1', dstId: 'e3', relType: 'deployed_on' });
  }));

  it('未知实体(不在列表)的三元组 → 跳过，防 LLM 幻觉造点', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = JSON.stringify([
      { src: 'Next.js', rel: 'uses', dst: 'Svelte' },   // Svelte 不在已知实体
      { src: 'Next.js', rel: 'built_with', dst: 'React' },
    ]);
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.written).toBe(1);
    expect(kg.calls[0].dstId).toBe('e2');
  }));

  it('relType 规范化(小写+空白转下划线)+大小写漂移实体名仍匹配', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = JSON.stringify([{ src: 'NEXT.JS', rel: 'Built With', dst: 'react' }]);
    await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(kg.calls[0]).toMatchObject({ srcId: 'e1', dstId: 'e2', relType: 'built_with' });
  }));

  it('自指(src==dst) → 跳过', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = JSON.stringify([{ src: 'React', rel: 'same_as', dst: 'React' }]);
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.written).toBe(0);
  }));

  it('重复三元组 → 去重只写一次', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = JSON.stringify([
      { src: 'Next.js', rel: 'built_with', dst: 'React' },
      { src: 'Next.js', rel: 'built_with', dst: 'React' },
    ]);
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.written).toBe(1);
  }));

  it('LLM 带解释文字 → 鲁棒提取首个 JSON 数组块', async () => withFlag(async () => {
    const kg = mkKg();
    const reply = '好的，关系如下：\n[{"src":"Next.js","rel":"built_with","dst":"React"}]\n以上。';
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(reply) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.written).toBe(1);
  }));

  it('LLM 返回无结构乱码 → ok:true written:0 不崩', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => mkAdapter('抱歉我无法确定关系') })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.ok).toBe(true);
    expect(r.written).toBe(0);
  }));

  it('实体<2 → skipped:too_few_entities（无法连边）', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => mkAdapter('[]') })
      .harvest({ report: REPORT, entities: [{ name: 'X', id: 'e1' }] });
    expect(r.skipped).toBe('too_few_entities');
  }));

  it('report 太短 → skipped:too_short', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => mkAdapter('[]') })
      .harvest({ report: 'short', entities: ENTITIES });
    expect(r.skipped).toBe('too_short');
  }));

  it('无 adapter/chat → skipped:no_brain', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => null })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.skipped).toBe('no_brain');
  }));

  it('adapter.chat 抛错 → fail-open ok:false 不崩', async () => withFlag(async () => {
    const adapter = { chat: async () => { throw new Error('model down'); } };
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => adapter })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('model down');
  }));

  it('incomplete(输出被截断) → skipped:brain_incomplete', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: mkKg(), getAdapter: () => mkAdapter('[', { incomplete: true }) })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.skipped).toBe('brain_incomplete');
  }));

  it('maxRelations 上限截断', async () => withFlag(async () => {
    const kg = mkKg();
    const triples = Array.from({ length: 30 }, (_, i) => ({ src: 'Next.js', rel: `rel_${i}`, dst: 'React' }));
    const r = await createRelationHarvest({ knowledgeGraph: kg, getAdapter: () => mkAdapter(JSON.stringify(triples)), config: { maxRelations: 5 } })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.written).toBe(5);
  }));

  it('无 kg/upsertRelation → skipped:no_kg', async () => withFlag(async () => {
    const r = await createRelationHarvest({ knowledgeGraph: {}, getAdapter: () => mkAdapter('[]') })
      .harvest({ report: REPORT, entities: ENTITIES });
    expect(r.skipped).toBe('no_kg');
  }));
});
