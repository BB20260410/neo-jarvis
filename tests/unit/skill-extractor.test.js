// Odysseus 移植模块自测：SkillExtractor（触发条件 / 提炼 / 置信度门控 / 去重 / dryRun / safe name）。
import { describe, it, expect } from 'vitest';
import { createSkillExtractor } from '../../src/skills/SkillExtractor.js';

function mockStore(existing = {}) {
  const saved = {};
  return { get: (n) => existing[n] || saved[n] || null, upsert: (s) => { saved[s.name] = s; return s; }, _saved: saved };
}
const convo = [
  { role: 'user', content: '怎么部署到 cloudflare' },
  { role: 'assistant', content: '用 wrangler' },
  { role: 'user', content: '然后呢' },
  { role: 'assistant', content: 'wrangler deploy' },
];

describe('SkillExtractor.shouldExtract', () => {
  it('轮次≥2 触发', () => {
    const ex = createSkillExtractor({ chat: async () => ({}), store: mockStore() });
    expect(ex.shouldExtract(convo)).toBe(true);
  });
  it('一次性问答(1轮)不触发', () => {
    const ex = createSkillExtractor({ chat: async () => ({}), store: mockStore() });
    expect(ex.shouldExtract([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBe(false);
  });
  it('单个任务的多段 assistant 协作输出也触发', () => {
    const ex = createSkillExtractor({ chat: async () => ({}), store: mockStore() });
    expect(ex.shouldExtract([
      { role: 'user', content: '整理一次可复用流程' },
      { role: 'assistant', content: '步骤一' },
      { role: 'assistant', content: '步骤二' },
      { role: 'assistant', content: '步骤三' },
      { role: 'assistant', content: '步骤四' },
    ])).toBe(true);
  });
});

describe('SkillExtractor.extract', () => {
  it('高置信度 → 保存为 disabled draft + safe name 转换', async () => {
    const store = mockStore();
    const chat = async () => ({ reply: '{"name":"Deploy CF","displayName":"部署到CF","description":"部署到 cloudflare 时用","body":"步骤","confidence":0.9}' });
    const out = await createSkillExtractor({ chat, store }).extract(convo);
    expect(out.extracted).toBe(true);
    expect(out.skill.name).toBe('deploy-cf');
    expect(out.skill.enabled).toBe(false);
    expect(store._saved['deploy-cf']).toBeTruthy();
  });
  it('能解析 think/fence/prose 包裹的技能 JSON', async () => {
    const store = mockStore();
    const chat = async () => ({
      reply: [
        '<think>不要把推理链当作技能正文。</think>',
        '可以固化：',
        '```json',
        '{"name":"review-json","displayName":"复核 JSON 输出","description":"模型输出 JSON 被说明文字包裹时使用","body":"先剥离 think，再解析 fenced JSON。","confidence":0.91}',
        '```',
      ].join('\n'),
    });
    const out = await createSkillExtractor({ chat, store }).extract(convo);
    expect(out.extracted).toBe(true);
    expect(out.skill.name).toBe('review-json');
    expect(store._saved['review-json'].body).toContain('fenced JSON');
  });
  it('低置信度 → 丢弃', async () => {
    const chat = async () => ({ reply: '{"name":"x","displayName":"x","description":"d","confidence":0.3}' });
    const out = await createSkillExtractor({ chat, store: mockStore() }).extract(convo);
    expect(out.extracted).toBe(false);
    expect(out.reason).toMatch(/置信度/);
  });
  it('LLM 输出 null → 不提炼', async () => {
    const out = await createSkillExtractor({ chat: async () => ({ reply: 'null' }), store: mockStore() }).extract(convo);
    expect(out.extracted).toBe(false);
  });
  it('已存在同名 → 跳过(不覆盖)', async () => {
    const store = mockStore({ 'deploy-cf': { name: 'deploy-cf' } });
    const chat = async () => ({ reply: '{"name":"deploy-cf","displayName":"x","description":"d","confidence":0.9}' });
    const out = await createSkillExtractor({ chat, store }).extract(convo);
    expect(out.skipped).toBe(true);
  });
  it('dryRun → 只返回候选不保存', async () => {
    const store = mockStore();
    const chat = async () => ({ reply: '{"name":"new-skill","displayName":"x","description":"d","confidence":0.9}' });
    const out = await createSkillExtractor({ chat, store }).extract(convo, { dryRun: true });
    expect(out.dryRun).toBe(true);
    expect(out.candidate.name).toBe('new-skill');
    expect(store._saved['new-skill']).toBeFalsy();
  });
  it('未达触发条件直接返回', async () => {
    const out = await createSkillExtractor({ chat: async () => ({ reply: '{}' }), store: mockStore() }).extract([{ role: 'user', content: 'hi' }]);
    expect(out.extracted).toBe(false);
    expect(out.reason).toMatch(/触发条件/);
  });
});
