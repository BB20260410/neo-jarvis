// 记忆语义去重（方向三）：向量+字符双指标抓"换关键词矛盾"（美式→拿铁），字符近重复仍走原字符路。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { decideSemanticConflict } from '../../src/memory/NoeMemoryDedup.js';

describe('decideSemanticConflict 纯函数（零 LLM 双指标判定）', () => {
  const latte = { body: '我现在改喝拿铁了', scope: 'fact' };
  const americano = { id: 'a', body: '我喜欢喝美式咖啡', scope: 'fact', salience: 3 };

  it('验收样例：美式→拿铁（向量高分+字符低分）判为冲突', () => {
    const r = decideSemanticConflict(latte, americano, { vecScore: 0.88 });
    expect(r.conflict).toBe(true);
    expect(r.charSim).toBeLessThan(0.62);
  });

  it('字符近重复不归语义路（charSim≥0.62 → 字符路合并管）', () => {
    const r = decideSemanticConflict({ body: '我喜欢喝美式咖啡。', scope: 'fact' }, americano, { vecScore: 0.99 });
    expect(r).toMatchObject({ conflict: false, reason: 'near_dup_char_path' });
  });

  it('向量分不够阈值（默认 0.82）不判冲突——宁可漏合并', () => {
    expect(decideSemanticConflict(latte, americano, { vecScore: 0.7 })).toMatchObject({ conflict: false, reason: 'low_vec' });
  });

  it('保守铁律：跨 scope / salience≥5 / 短句 一律不判冲突', () => {
    expect(decideSemanticConflict(latte, { ...americano, scope: 'voice' }, { vecScore: 0.9 })).toMatchObject({ conflict: false, reason: 'scope' });
    expect(decideSemanticConflict(latte, { ...americano, salience: 5 }, { vecScore: 0.9 })).toMatchObject({ conflict: false, reason: 'protected' });
    expect(decideSemanticConflict({ body: '好的', scope: 'fact' }, { id: 'b', body: '好', scope: 'fact', salience: 3 }, { vecScore: 0.99 })).toMatchObject({ conflict: false, reason: 'too_short' });
  });

  it('阈值可调：semanticThreshold 降到 0.6 后中分也判冲突', () => {
    expect(decideSemanticConflict(latte, americano, { vecScore: 0.7, semanticThreshold: 0.6 }).conflict).toBe(true);
  });
});

describe('MemoryCore × 语义冲突 sweep（真 SQLite + 假向量索引）', () => {
  let tmp;
  beforeEach(() => {
    close();
    tmp = mkdtempSync(join(tmpdir(), 'noe-semdedup-'));
    initSqlite(join(tmp, 'panel.db'));
  });
  afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

  // 假语义索引：search 按 scores 表返回 [{refId, score}]，可中途改表模拟"旧记忆已在索引里"
  function makeIndex({ provider = 'fake-test', scores = {} } = {}) {
    return {
      provider,
      scores,
      searchCalls: 0,
      removed: [],
      async upsert() {},
      async search() { this.searchCalls += 1; return Object.entries(this.scores).map(([refId, score]) => ({ refId, score })); },
      remove(refId) { this.removed.push(refId); },
    };
  }
  const makeCore = (idx, semantic = { enabled: true }) => new MemoryCore({
    semanticIndex: idx,
    dedupe: { enabled: true, threshold: 0.62, semantic: { threshold: 0.82, ...semantic } },
    logger: { warn: () => {}, info: () => {} },
  });

  it('验收闭环：美式→拿铁 自动合并——旧条隐藏(merged_into)、新条留 semantic_conflict 痕、旧向量清掉', async () => {
    const idx = makeIndex();
    const core = makeCore(idx);
    const a = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    idx.scores[a.id] = 0.9; // 模拟旧记忆已可被语义召回
    const b = core.write({ body: '我现在改喝拿铁了', scope: 'fact', projectId: 'p1' });
    await vi.waitFor(() => expect(core.get(a.id)).toBeNull()); // 写后异步 sweep 生效
    const hiddenOld = core.get(a.id, { includeHidden: true });
    expect(hiddenOld.hiddenReason).toBe(`merged_into:${b.id}`);
    const target = core.get(b.id, { includeHidden: true });
    expect(target.mergeTrace.some((t) => t.reason === 'semantic_conflict' && t.sourceIds.includes(a.id))).toBe(true);
    expect(idx.removed).toContain(a.id);
  });

  it('字符近重复仍走原字符路：同步合并且不触发语义 sweep', async () => {
    const idx = makeIndex();
    const core = makeCore(idx);
    const a = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    await new Promise((r) => setTimeout(r, 10)); // 第一条的合法 sweep 落定
    idx.scores[a.id] = 0.99;
    idx.searchCalls = 0;
    const b = core.write({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact', projectId: 'p1' });
    expect(b.id).toBe(a.id); // 字符路同步 UPDATE 同一条
    await new Promise((r) => setTimeout(r, 10));
    expect(idx.searchCalls).toBe(0); // mergedFrom 命中 → 这次写入语义 sweep 不跑
  });

  it('hash provider 拒跑（精度近零防误删）', async () => {
    const idx = makeIndex({ provider: 'hash' });
    const core = makeCore(idx);
    const r = await core.semanticConflictSweep({ id: 'x', body: '随便', projectId: 'p1', scope: 'fact' });
    expect(r).toMatchObject({ swept: false, reason: 'hash_provider' });
  });

  it('开关默认 OFF：不配 semantic.enabled 时写入零语义动作', async () => {
    const idx = makeIndex();
    const core = new MemoryCore({ semanticIndex: idx, dedupe: { enabled: true, semantic: { enabled: false } }, logger: { warn: () => {} } });
    const a = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    idx.scores[a.id] = 0.95;
    core.write({ body: '我现在改喝拿铁了', scope: 'fact', projectId: 'p1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(idx.searchCalls).toBe(0);
    expect(core.get(a.id)).not.toBeNull(); // 旧条还在
  });

  it('保护与隔离在 sweep 层兜底：高 salience/跨 project 不合并', async () => {
    const idx = makeIndex();
    const core = makeCore(idx);
    const vip = core.write({ body: '我对花生严重过敏', scope: 'fact', projectId: 'p1', salience: 5 });
    const other = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p2' });
    idx.scores[vip.id] = 0.95;
    idx.scores[other.id] = 0.95;
    const b = core.write({ body: '我现在改喝拿铁了', scope: 'fact', projectId: 'p1' });
    const r = await core.semanticConflictSweep({ id: b.id, body: b.body, projectId: 'p1', scope: 'fact' });
    expect(r.merged).toEqual([]);
    expect(core.get(vip.id)).not.toBeNull();
    expect(core.get(other.id)).not.toBeNull();
  });

  it('sweep 层不把跨 scope 的高分候选合并', async () => {
    const idx = makeIndex();
    const core = makeCore(idx);
    const fact = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    idx.scores[fact.id] = 0.95;
    const voice = core.write({ body: '我现在改喝拿铁了', scope: 'voice', projectId: 'p1' });

    const r = await core.semanticConflictSweep({ id: voice.id, body: voice.body, projectId: 'p1', scope: 'voice' });

    expect(r.merged).toEqual([]);
    expect(core.get(fact.id)?.id).toBe(fact.id);
  });

  it('sweep 抛错 fail-open：写入照常返回、不留半成品', async () => {
    const idx = makeIndex();
    idx.search = async () => { throw new Error('embed 服务挂了'); };
    const core = makeCore(idx);
    const a = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    const b = core.write({ body: '我现在改喝拿铁了', scope: 'fact', projectId: 'p1' });
    expect(b).toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(core.get(a.id)).not.toBeNull(); // 没误伤
  });
});
