// 记忆整合/去重审计修复测试（审计 §3.3 P0-5/6/7）
// P0-5 Consolidator 晋升 hitCount 代理（死代码复活）、P0-6 Dedup 前缀膨胀约束、P0-7 Dream 冷热混合候选
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planConsolidation } from '../../src/memory/NoeMemoryConsolidator.js';
import { decideMemoryWrite } from '../../src/memory/NoeMemoryDedup.js';
import { loadConsolidationCandidates } from '../../src/memory/NoeDreamConsolidation.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

const NOW = 1_000_000_000_000;

describe('P0-5 recall-heat 晋升 hitCount 代理', () => {
  it('无 uniqueQueryCount 时回退 hitCount≥3 触发晋升（修复死代码）', async () => {
    const plan = await planConsolidation([
      { id: 'hot', content: '高频命中记忆', hitCount: 5, salience: 3 },
      { id: 'cold', content: '低频记忆', hitCount: 1, salience: 3 },
    ], { nowMs: NOW });
    expect(plan.promotions.map((p) => p.id)).toContain('hot');
    expect(plan.promotions.map((p) => p.id)).not.toContain('cold');
  });

  it('显式 uniqueQueryCount 仍优先（纯函数调用方行为不变）', async () => {
    const plan = await planConsolidation([
      { id: 'x', content: '显式查询计数', uniqueQueryCount: 4, hitCount: 0, salience: 3 },
    ], { nowMs: NOW });
    expect(plan.promotions.map((p) => p.id)).toContain('x');
  });

  it('hitCount<3 不晋升（保守）', async () => {
    const plan = await planConsolidation([
      { id: 'y', content: '低频', hitCount: 2, salience: 3 },
    ], { nowMs: NOW });
    expect(plan.promotions).toEqual([]);
  });
});

describe('P0-6 前缀包含长度膨胀约束', () => {
  it('短句温和细化（长方≤短方2倍）仍判近重复合并', () => {
    const d = decideMemoryWrite(
      { body: '明天三点开会在会议室A', scope: 'fact' },
      [{ id: 'old', body: '明天三点开会', scope: 'fact', salience: 3 }],
      { threshold: 0.62 },
    );
    expect(d.action).toBe('update');
    expect(d.target.id).toBe('old');
  });

  it('短句+大量无关新事实（长方>短方2倍）不再被强制合并', () => {
    const d = decideMemoryWrite(
      { body: '明天三点开会在A室另外下周还要去北京出差讨论新项目预算分配', scope: 'fact' },
      [{ id: 'old', body: '明天三点开会', scope: 'fact', salience: 3 }],
      { threshold: 0.62 },
    );
    expect(d.action).toBe('add'); // 膨胀超 2 倍→不前缀合并，字符相似度低→保留为独立记忆（不丢新事实）
  });
});

describe('P0-7 Dream 冷热混合候选', () => {
  let tmp;
  beforeEach(() => {
    close();
    tmp = mkdtempSync(join(tmpdir(), 'noe-dream-audit-'));
    initSqlite(join(tmp, 'panel.db'));
  });
  afterEach(() => {
    close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('命中0的陈旧冷记忆进候选（不再被热记忆挤出）', () => {
    const core = new MemoryCore();
    core.write({ id: 'cold', body: '最冷的旧记忆从未被命中' }); // 先写=最旧、hit_count=0
    for (let i = 0; i < 10; i += 1) {
      core.write({ id: `hot${i}`, body: `热记忆${i}` });
      core.bumpHitMany([`hot${i}`]); // hit_count=1 且 updated_at 推后（比 cold 新）
    }
    const cands = loadConsolidationCandidates(core, { limit: 6 });
    expect(cands.map((c) => c.id)).toContain('cold');
  });

  it('候选仍含热记忆（混合不是纯冷）', () => {
    const core = new MemoryCore();
    core.write({ id: 'cold', body: '旧记忆' });
    core.write({ id: 'veryhot', body: '最热记忆' });
    for (let i = 0; i < 5; i += 1) core.bumpHitMany(['veryhot']); // hit_count=5
    const cands = loadConsolidationCandidates(core, { limit: 4 });
    expect(cands.map((c) => c.id)).toContain('veryhot');
  });
});
