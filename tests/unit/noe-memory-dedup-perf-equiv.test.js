// 批3 性能：NoeMemoryDedup.decideMemoryWrite 把 incoming 归一化 + bigram 提到候选循环外、
// 每候选只归一化一次。本测证明 ①对随机语料逐字等价于优化前的朴素实现 ②可观测地少做工
// （每个通过粗筛的候选只访问一次 c.body，优化前是三次：guard + textSimilarity + isPrefixContainment）。
import { describe, it, expect } from 'vitest';
import {
  decideMemoryWrite,
  textSimilarity,
  normalizeForDedup,
} from '../../src/memory/NoeMemoryDedup.js';

// ── 优化前语义的忠实参考实现（用公开 textSimilarity + 旧 isPrefixContainment 原文） ──
function refIsPrefixContainment(a, b, minLen = 6, maxExpandRatio = 2) {
  const na = normalizeForDedup(a);
  const nb = normalizeForDedup(b);
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= minLen && long.startsWith(short) && long.length <= short.length * maxExpandRatio;
}
function refDecideMemoryWrite(incoming, candidates = [], { threshold = 0.62, protectSalience = 5 } = {}) {
  const body = String(incoming?.body || '');
  if (!body || !Array.isArray(candidates) || !candidates.length) return { action: 'add' };
  const incScope = incoming?.scope || 'project';
  let best = null;
  for (const c of candidates) {
    if (!c || !c.body || c.id == null) continue;
    if ((c.scope || 'project') !== incScope) continue;
    if (Number(c.salience) >= protectSalience) continue;
    const realSim = textSimilarity(body, c.body);
    const contained = refIsPrefixContainment(body, c.body);
    const sim = contained ? Math.max(realSim, threshold) : realSim;
    if (sim >= threshold && (!best || realSim > best.realSim)) best = { target: c, similarity: sim, realSim };
  }
  return best ? { action: 'update', target: best.target, similarity: best.similarity } : { action: 'add' };
}

// 确定性 PRNG（mulberry32）——不依赖真实随机，CI 可复现
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const FRAGMENTS = ['我喜欢喝美式咖啡', '不加糖', '明天下午三点开会', '在会议室A', '我家住在北京朝阳区',
  '我今天买了一台新电脑', '我家的宽带是电信的', '随便什么', '。', '！', '好', '好的', '我叫张三',
  '现在改喝拿铁', '今天北京下雨', '我家的猫叫小白', 'I Like AmericanO', 'hello world', '讨论方案'];
const SCOPES = ['fact', 'user', 'voice', 'project', undefined];
function pick(r, arr) { return arr[Math.floor(r() * arr.length)]; }
function randText(r) {
  const n = 1 + Math.floor(r() * 3);
  let out = '';
  for (let i = 0; i < n; i++) out += pick(r, FRAGMENTS);
  return out;
}

describe('NoeMemoryDedup.decideMemoryWrite 优化逐字等价', () => {
  it('对 400 组随机 incoming×候选集，新实现与优化前参考实现输出完全一致', () => {
    const r = rng(20260613);
    for (let t = 0; t < 400; t++) {
      const incoming = { body: randText(r), scope: pick(r, SCOPES), salience: 1 + Math.floor(r() * 6) };
      const k = Math.floor(r() * 6);
      const cands = [];
      for (let i = 0; i < k; i++) {
        cands.push({ id: `c${i}`, body: randText(r), scope: pick(r, SCOPES), salience: 1 + Math.floor(r() * 6) });
      }
      const got = decideMemoryWrite(incoming, cands);
      const ref = refDecideMemoryWrite(incoming, cands);
      // 逐字比较 action / target.id / similarity（其余字段两实现一致）
      expect(got.action, `case#${t}`).toBe(ref.action);
      expect(got.target?.id ?? null, `case#${t} target`).toBe(ref.target?.id ?? null);
      expect(got.similarity ?? null, `case#${t} sim`).toBe(ref.similarity ?? null);
    }
  });

  it('既有边界用例结果不变（近重复/追加/跨scope/高salience保护/前缀并列择优）', () => {
    const cands = [
      { id: 'a', body: '我喜欢喝美式咖啡', scope: 'fact', salience: 3 },
      { id: 'b', body: '我家住在北京朝阳区', scope: 'fact', salience: 3 },
    ];
    expect(decideMemoryWrite({ body: '我喜欢喝美式咖啡。', scope: 'fact' }, cands).action).toBe('update');
    expect(decideMemoryWrite({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact' }, cands).action).toBe('update');
    expect(decideMemoryWrite({ body: '我今天买了一台新电脑', scope: 'fact' }, cands).action).toBe('add');
    const vip = [{ id: 'vip', body: '我叫张三', scope: 'fact', salience: 5 }];
    expect(decideMemoryWrite({ body: '我叫张三。', scope: 'fact' }, vip).action).toBe('add');
    const tie = [
      { id: 'a', body: '明天下午三点', scope: 'fact', salience: 3 },
      { id: 'b', body: '明天下午三点开', scope: 'fact', salience: 3 },
    ];
    expect(decideMemoryWrite({ body: '明天下午三点开会讨论方案', scope: 'fact' }, tie).target.id).toBe('b');
  });
});

describe('NoeMemoryDedup.decideMemoryWrite 可观测地少做工', () => {
  // 用「访问计数的 c.body getter」证明优化确实少做工：
  // 优化前每个通过粗筛的候选读 c.body 3 次（guard 1 + textSimilarity 1 + isPrefixContainment 1）；
  // 优化后读 2 次（guard 1 + 单次 normalizeForDedup 1）——即每候选省掉一遍重复归一化路径。
  function countingCandidate(id, bodyValue, scope, salience) {
    let reads = 0;
    return {
      _reads: () => reads,
      get id() { return id; },
      get scope() { return scope; },
      get salience() { return salience; },
      get body() { reads += 1; return bodyValue; },
    };
  }

  it('优化后通过粗筛的候选 c.body 读 2 次，且严格少于优化前参考实现的 3 次', () => {
    // 优化后
    const a1 = countingCandidate('a', '我喜欢喝美式咖啡', 'fact', 3);
    const a2 = countingCandidate('b', '我家住在北京朝阳区', 'fact', 3);
    decideMemoryWrite({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact' }, [a1, a2]);
    expect(a1._reads()).toBe(2);
    expect(a2._reads()).toBe(2);
    // 优化前参考实现（同一计数候选）：每条读 3 次 —— 证明确有缩减
    const b1 = countingCandidate('a', '我喜欢喝美式咖啡', 'fact', 3);
    const b2 = countingCandidate('b', '我家住在北京朝阳区', 'fact', 3);
    refDecideMemoryWrite({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact' }, [b1, b2]);
    expect(b1._reads()).toBe(3);
    expect(b2._reads()).toBe(3);
    expect(a1._reads()).toBeLessThan(b1._reads());
  });
});
