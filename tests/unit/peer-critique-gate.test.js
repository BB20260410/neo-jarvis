import { describe, it, expect } from 'vitest';
import {
  PeerCritiqueGate,
  parseCritique,
  findDuplicates,
  selectSurvivors,
  buildCritiquePrompt,
} from '../../src/room/PeerCritiqueGate.js';

const P = (anonId, content) => ({ anonId, content });

describe('parseCritique 解析评审输出', () => {
  it('解析 pipe 格式：分数/keep-kill/理由', () => {
    const reply = 'A | 8 | keep | 具体可落地\nB | 3 | kill | 泛泛而谈';
    const v = parseCritique(reply, ['A', 'B']);
    expect(v.get('A')).toEqual({ score: 8, keep: true, reason: '具体可落地' });
    expect(v.get('B')).toEqual({ score: 3, keep: false, reason: '泛泛而谈' });
  });
  it('支持中文 保留/淘汰 + 全角竖线', () => {
    const v = parseCritique('A ｜ 9 ｜ 保留 ｜ 好\nB ｜ 2 ｜ 淘汰 ｜ 差', ['A', 'B']);
    expect(v.get('A').keep).toBe(true);
    expect(v.get('B').keep).toBe(false);
  });
  it('分数越界裁剪到 0-10，忽略未知编号', () => {
    const v = parseCritique('A | 99 | keep | x\nZ | 5 | keep | 不存在', ['A', 'B']);
    expect(v.get('A').score).toBe(10);
    expect(v.has('Z')).toBe(false);
  });
  it('垃圾输入返回空 Map（交给 fail-open）', () => {
    expect(parseCritique('完全不符合格式的一段话', ['A', 'B']).size).toBe(0);
    expect(parseCritique('', ['A']).size).toBe(0);
  });
});

describe('findDuplicates 近似重复检测', () => {
  it('近乎相同的两份 → 较短的判重复指向较长', () => {
    const long = '使用 Redis 缓存热点数据并设置合理过期时间提升接口性能';
    const short = '使用 Redis 缓存热点数据并设置过期时间';
    const dup = findDuplicates([P('A', long), P('B', short)], 0.5);
    // 较短(B) 指向较长(A)
    expect(dup.get('B')).toBe('A');
    expect(dup.has('A')).toBe(false);
  });
  it('内容差异大不判重复', () => {
    const dup = findDuplicates([P('A', '用 Redis 做缓存'), P('B', '改用 PostgreSQL 分区表归档冷数据')], 0.85);
    expect(dup.size).toBe(0);
  });
});

describe('selectSurvivors 选存活', () => {
  it('保留 keep / 高分，剪除 kill+低分', () => {
    const props = [P('A', 'a'), P('B', 'b'), P('C', 'c')];
    const verdicts = new Map([
      ['A', { score: 8, keep: true, reason: '' }],
      ['B', { score: 2, keep: false, reason: '弱' }],
      ['C', { score: 7, keep: true, reason: '' }],
    ]);
    const { survivors, rejected } = selectSurvivors(props, verdicts, new Map(), { minSurvivors: 2, scoreThreshold: 5 });
    expect(survivors.map((p) => p.anonId).sort()).toEqual(['A', 'C']);
    expect(rejected.map((p) => p.anonId)).toEqual(['B']);
  });
  it('剪太狠时按分数补回，保证 minSurvivors', () => {
    const props = [P('A', 'a'), P('B', 'b'), P('C', 'c')];
    const verdicts = new Map([
      ['A', { score: 1, keep: false, reason: '' }],
      ['B', { score: 4, keep: false, reason: '' }],
      ['C', { score: 3, keep: false, reason: '' }],
    ]); // 全 kill
    const { survivors } = selectSurvivors(props, verdicts, new Map(), { minSurvivors: 2, scoreThreshold: 5 });
    // 补回分数最高的 2 个：B(4) C(3)
    expect(survivors.length).toBe(2);
    expect(survivors.map((p) => p.anonId).sort()).toEqual(['B', 'C']);
  });
  it('被判重复的排除在存活外', () => {
    const props = [P('A', 'a'), P('B', 'b'), P('C', 'c')];
    const verdicts = new Map([
      ['A', { score: 8, keep: true, reason: '' }],
      ['B', { score: 8, keep: true, reason: '' }],
      ['C', { score: 8, keep: true, reason: '' }],
    ]);
    const dup = new Map([['C', 'A']]); // C 重复于 A
    const { survivors, rejected } = selectSurvivors(props, verdicts, dup, { minSurvivors: 2, scoreThreshold: 5 });
    expect(survivors.map((p) => p.anonId).sort()).toEqual(['A', 'B']);
    expect(rejected.map((p) => p.anonId)).toEqual(['C']);
  });
});

describe('PeerCritiqueGate.evaluate 端到端', () => {
  const props = [P('A', '方案A详细内容'), P('B', '方案B详细内容'), P('C', '方案C详细内容')];

  it('提案 < 3 直接跳过，保留全部', async () => {
    const gate = new PeerCritiqueGate({});
    const critic = { chat: async () => ({ reply: 'A | 1 | kill | x' }) };
    const r = await gate.evaluate({ roomId: 'r', topic: 't', critic, proposals: props.slice(0, 2) });
    expect(r.skipped).toBe(true);
    expect(r.survivors.length).toBe(2);
  });

  it('mock 评审员 → 按裁决剪枝', async () => {
    const events = [];
    const gate = new PeerCritiqueGate({ broadcast: (id, e) => events.push(e) });
    const critic = { chat: async () => ({ reply: 'A | 8 | keep | 好\nB | 2 | kill | 弱\nC | 7 | keep | 行' }) };
    const r = await gate.evaluate({ roomId: 'r', topic: 't', critic, proposals: props });
    expect(r.degraded).toBe(false);
    expect(r.survivors.map((p) => p.anonId).sort()).toEqual(['A', 'C']);
    expect(events.find((e) => e.type === 'critique_gate')).toBeTruthy();
  });

  it('评审员抛错 → fail-open 保留全部', async () => {
    const gate = new PeerCritiqueGate({});
    const critic = { chat: async () => { throw new Error('local brain down'); } };
    const r = await gate.evaluate({ roomId: 'r', topic: 't', critic, proposals: props });
    expect(r.degraded).toBe(true);
    expect(r.survivors.length).toBe(3);
  });

  it('解析不出裁决 → 降级保留全部', async () => {
    const gate = new PeerCritiqueGate({});
    const critic = { chat: async () => ({ reply: '一段无法解析的废话' }) };
    const r = await gate.evaluate({ roomId: 'r', topic: 't', critic, proposals: props });
    expect(r.degraded).toBe(true);
    expect(r.survivors.length).toBe(3);
  });

  it('没评审员也不崩，保留全部', async () => {
    const gate = new PeerCritiqueGate({});
    const r = await gate.evaluate({ roomId: 'r', topic: 't', critic: null, proposals: props });
    expect(r.survivors.length).toBe(3);
  });
});

describe('buildCritiquePrompt', () => {
  it('含任务、各方案编号、格式说明', () => {
    const p = buildCritiquePrompt('优化首屏', [P('A', 'aaa'), P('B', 'bbb')]);
    expect(p).toContain('优化首屏');
    expect(p).toContain('方案 A');
    expect(p).toContain('keep 或 kill');
  });
});
