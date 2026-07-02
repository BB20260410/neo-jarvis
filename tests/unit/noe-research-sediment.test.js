// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { createResearchSediment, resolveResearchSedimentConfig } from '../../src/sediment/NoeResearchSediment.js';

function makeMemoryCore() {
  const writes = [];
  return { writes, write(input) { writes.push(input); return { id: `mem-${writes.length}` }; } };
}

const longReport = 'Neo 自主进化研究要点与来源分析。'.repeat(150); // > 1600 字（触发摘要截断，验非全文）

describe('NoeResearchSediment', () => {
  it('resolveConfig 默认 OFF', () => {
    const c = resolveResearchSedimentConfig({});
    expect(c.enabled).toBe(false);
    expect(c.minReportChars).toBe(800);
    expect(c.ttlMs).toBe(0);
  });

  it('盐度门槛：report 太短不沉淀（避垃圾入库）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: '太短的报告', sources: [{ title: 'x', url: 'y' }], topic: 't' });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('too_short');
    expect(mc.writes.length).toBe(0);
  });

  it('无来源不沉淀（Codex 审发现6：无 grounding 报告不入库）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [] });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('no_sources');
    expect(mc.writes.length).toBe(0);
  });

  it('低覆盖不沉淀（Codex 复审 Finding 4：coverageScore < 0.3 拦截）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }], critique: { coverageScore: 0.1 } });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('low_coverage');
    expect(mc.writes.length).toBe(0);
  });

  it('无 coverageScore 不拦（向后兼容：无评分不 gate）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }] });
    expect(r.ok).toBe(true);
  });

  it('coverageScore=0 放行（DeepResearcher 自评 JSON 失败 fail-open 归 0，非真低质，不误杀——子代理复审 F4 副作用）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }], critique: { coverageScore: 0 } });
    expect(r.ok).toBe(true); // 0 视同无有效自评，不拦
    expect(mc.writes.length).toBe(1);
  });

  it('正常沉淀：摘要非全文 + sourceType + 幂等 sourceId + salience', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({
      report: longReport,
      sources: [{ title: '源1', url: 'http://a' }, { title: '源2', url: 'http://b' }],
      topic: 'AI agent memory',
      goalRef: { goalId: 'g1', stepIndex: 2 },
      critique: { coverageScore: 0.8 },
    });
    expect(r.ok).toBe(true);
    expect(mc.writes.length).toBe(1);
    const w = mc.writes[0];
    expect(w.sourceType).toBe('research_report');
    expect(w.scope).toBe('project');
    expect(w.salience).toBe(4);
    expect(w.sourceId).toBe('research:goal:g1:2');
    expect(w.id).toBe('research:goal:g1:2'); // 同时作 id → MemoryCore ON CONFLICT(id) 真 upsert 幂等（治堆叠，审查 MEDIUM-1 修复）
    expect(w.confidence).toBe(0.8);
    expect(w.body.length).toBeLessThan(longReport.length); // 摘要非全文（避污染召回）
    expect(w.body).toContain('## 来源(2)'); // 含来源清单
    expect(w.body).toContain('覆盖评分: 0.80');
    expect(w.tags).toContain('research');
    expect(w.title).toContain('研究：AI agent memory');
  });

  it('无 memoryCore 安全 skip', async () => {
    const s = createResearchSediment({ memoryCore: null });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }] });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('no_memory_core');
  });

  it('fail-open：write 抛错不抛、返回 error（不阻断研究闭环）', async () => {
    const mc = { write() { throw new Error('db locked'); } };
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('db locked');
  });

  it('无 goalRef：不带 sourceId 仍沉淀', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const r = await s.sediment({ report: longReport, topic: 't', sources: [{ title: 's', url: 'u' }] });
    expect(r.ok).toBe(true);
    expect(mc.writes[0].sourceId).toBeUndefined();
  });

  it('body 截断到上限（超长 report 不污染）', async () => {
    const mc = makeMemoryCore();
    const s = createResearchSediment({ memoryCore: mc });
    const huge = 'x'.repeat(50000);
    await s.sediment({ report: huge, topic: 't', sources: [{ title: 's', url: 'u' }] });
    expect(mc.writes[0].body.length).toBeLessThanOrEqual(8000);
  });
});
