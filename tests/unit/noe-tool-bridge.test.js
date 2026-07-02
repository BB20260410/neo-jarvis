import { describe, expect, it } from 'vitest';
import { runQueryTools, extractQuery } from '../../src/voice/NoeToolBridge.js';
import { buildPeopleBrief } from '../../src/voice/VoiceSession.js';

describe('NoeToolBridge 对话工具桥（查询类真执行）', () => {
  it('命中查询意图 → 后端真跑工具 + 把结果注入(据实回答)', async () => {
    const calls = [];
    const toolRegistry = { invoke: async (id) => { calls.push(id); return { ok: true, result: id === 'noe.memory.recall' ? [{ text: '主人喜欢美式咖啡' }] : null }; } };
    const s = await runQueryTools('我之前说过喜欢喝什么', { toolRegistry });
    expect(calls).toContain('noe.memory.recall');
    expect(s).toContain('美式咖啡');
    expect(s).toMatch(/不要说.*(我去查|稍等)/);
  });

  it('没命中意图 → 空，不白跑工具', async () => {
    const calls = [];
    const toolRegistry = { invoke: async (id) => { calls.push(id); return { ok: true, result: [] }; } };
    expect(await runQueryTools('今天天气真好啊', { toolRegistry })).toBe('');
    expect(calls.length).toBe(0);
  });

  it('工具返回空结果 → 不注入空壳', async () => {
    const toolRegistry = { invoke: async () => ({ ok: true, result: [] }) };
    expect(await runQueryTools('帮我找一下我的文件', { toolRegistry })).toBe('');
  });

  it('工具报错不阻断(单工具失败) → 返回空', async () => {
    const toolRegistry = { invoke: async () => { throw new Error('tool down'); } };
    expect(await runQueryTools('找一下文件', { toolRegistry })).toBe('');
  });

  it('无 toolRegistry → 降级返回空', async () => {
    expect(await runQueryTools('记得我说过什么', {})).toBe('');
  });

  it('extractQuery 去疑问/虚词噪声', () => {
    expect(extractQuery('邓达是谁？')).toContain('邓达');
    expect(extractQuery('帮我找一下关于项目的文件')).toContain('项目');
  });
});

describe('buildPeopleBrief 人物库注入', () => {
  it('注入人物库简表 + 禁"去找"指令', () => {
    const store = { list: () => [{ displayName: '邓达', relation: '主人老板', notes: '新升集团的总裁，主人的老板', aliases: [] }] };
    const s = buildPeopleBrief(store);
    expect(s).toContain('邓达');
    expect(s).toContain('新升集团的总裁');
    expect(s).toMatch(/不要说.*去找/);
  });

  it('空库 / 无 store → 空', () => {
    expect(buildPeopleBrief({ list: () => [] })).toBe('');
    expect(buildPeopleBrief(null)).toBe('');
  });
});
