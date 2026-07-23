import { describe, it, expect } from 'vitest';
import { FactExtractor } from '../../src/memory/FactExtractor.js';

const mk = (reply) => new FactExtractor({ complete: async () => reply });

describe('FactExtractor 事实抽取', () => {
  it('默认事实抽取模型跟随主脑 Qwen', () => {
    const fe = new FactExtractor({ complete: async () => 'NONE' });
    expect(fe.model).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('自动事实抽取接受 Qwen 模型配置', () => {
    const fe = new FactExtractor({ complete: async () => 'NONE', model: 'qwen/qwen3.6-35b-a3b' });
    expect(fe.model).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('多行事实解析成数组', async () => {
    const facts = await mk('用户对花生过敏\n用户老婆生日是10月1号').extract('对话内容');
    expect(facts).toEqual(['用户对花生过敏', '用户老婆生日是10月1号']);
  });

  it('NONE → 空数组（闲聊/一次性不记）', async () => {
    expect(await mk('NONE').extract('今天好累啊')).toEqual([]);
  });

  it('空回复 → 空', async () => {
    expect(await mk('').extract('x 对话')).toEqual([]);
  });

  it('剥列表符号/序号', async () => {
    const facts = await mk('- 用户喜欢喝美式咖啡\n2. 用户常驻上海').extract('对话内容');
    expect(facts).toEqual(['用户喜欢喝美式咖啡', '用户常驻上海']);
  });

  it('空对话直接返回空（不调 LLM）', async () => {
    let called = false;
    const fe = new FactExtractor({ complete: async () => { called = true; return 'x'; } });
    expect(await fe.extract('')).toEqual([]);
    expect(called).toBe(false);
  });

  it('complete 抛错不阻断（返回空）', async () => {
    const fe = new FactExtractor({ complete: async () => { throw new Error('ollama down'); } });
    expect(await fe.extract('对话内容')).toEqual([]);
  });

  it('过滤过短噪音行', async () => {
    const facts = await mk('用户对花生过敏\nok\n用户在北京工作').extract('对话内容');
    expect(facts).toEqual(['用户对花生过敏', '用户在北京工作']);
  });

  it('extractRecords 保持事实文本并补 temporal/source 元数据', async () => {
    const records = await mk('用户现在改喝拿铁').extractRecords('对话内容', { now: 1234, sourceEpisodeId: 'ep-1', confidence: 0.82 });
    expect(records).toEqual([
      {
        text: '用户现在改喝拿铁',
        body: '用户现在改喝拿铁',
        validFrom: 1234,
        validTo: null,
        sourceEpisodeId: 'ep-1',
        confidence: 0.82,
      },
    ]);
  });
});
