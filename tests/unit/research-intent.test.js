import { describe, expect, it } from 'vitest';
import { assessSearchSummaryQuality, cleanSearchText, detectResearchIntent, summarizeSearchResults } from '../../src/research/ResearchIntent.js';

describe('ResearchIntent STT query cleanup', () => {
  it('清洗繁体帮我和 STT 大写 NO→Noe', () => {
    expect(detectResearchIntent('幫我搜索NO語音自動演示測試')).toMatchObject({
      mode: 'search',
      query: 'Noe語音自動演示測試',
    });
  });

  it('不把普通小写 no 单词误改成 Noe', () => {
    expect(detectResearchIntent('帮我搜索 no code 工具')).toMatchObject({
      query: 'no code 工具',
    });
  });

  it('清理开头唤醒词，避免把 Noe 当搜索词', () => {
    expect(detectResearchIntent('Noe 搜索全世界最强的AI模型是什么')).toMatchObject({
      query: '全世界最强的AI模型是什么',
    });
  });
});

describe('Search result summary cleanup', () => {
  it('清理搜索摘要里的图片标签和 URL 参数垃圾', () => {
    const raw = "引言 <img src='http://qqpublic.qpic.cn/a.png?fmt=png&size=4372&h=1773&w=23'> 正文";
    expect(cleanSearchText(raw)).toBe('引言 正文');
  });

  it('规则兜底摘要不读 HTML/img/http', async () => {
    const text = await summarizeSearchResults(null, '最强 AI 模型', [{
      title: '全球十大最强大模型',
      snippet: "GPT、Claude、Gemini <img src='http://x/y.png'> 排名变化很快",
      source: 'minimax',
    }]);
    expect(text).toContain('搜索结果');
    expect(text).not.toMatch(/<img|http|src=/i);
  });

  it('优先使用模型总结，而不是逐条复读搜索结果', async () => {
    const chat = async () => ({ reply: '结论是：综合能力榜单常见 GPT、Claude、Gemini，但排名会随评测变化，建议把它当作初步判断。' });
    const text = await summarizeSearchResults(chat, '最强 AI 模型', [{ title: 'T', snippet: 'S' }], { personaName: '主人' });
    expect(text).toContain('主人');
    expect(text).toContain('结论是');
  });

  it('质检拒绝 URL/HTML/标题列表风格的模型总结', () => {
    const results = [
      { title: '全球十大最强大模型', snippet: 'GPT、Claude、Gemini 排名变化很快' },
      { title: 'AI 模型榜单更新', snippet: '不同评测口径不同' },
    ];
    expect(assessSearchSummaryQuality('1. 全球十大最强大模型\n2. AI 模型榜单更新', results).reasons)
      .toContain('title_list_style');
    expect(assessSearchSummaryQuality('结论见 https://example.com <img src=x>', results).reasons)
      .toContain('dirty_markup_or_url');
  });

  it('模型总结不达质检时回落到规则口语兜底', async () => {
    const chat = async () => ({ reply: '1. 全球十大最强大模型\n2. AI 模型榜单更新\nhttps://example.com' });
    const text = await summarizeSearchResults(chat, '最强 AI 模型', [
      { title: '全球十大最强大模型', snippet: 'GPT、Claude、Gemini 排名变化很快', source: 'minimax' },
      { title: 'AI 模型榜单更新', snippet: '不同评测口径不同', source: 'minimax' },
    ]);
    expect(text).toContain('主人，我先给你结论');
    expect(text).not.toMatch(/https?:|<img|^\s*1\./i);
  });

  // Task 0.5 Step1：finish_reason=length 截断时丢弃半截总结，回落完整规则兜底（绝不把半截模型输出当总结）
  it('模型总结 finish_reason=length 被截断时不采用半截，回落规则兜底', async () => {
    const chat = async () => ({
      reply: '主人，结论是：综合能力榜单常见 GPT、Claude，但是排名会随着评测口径不同而', // 半截、未收尾
      finish_reason: 'length',
    });
    const text = await summarizeSearchResults(chat, '最强 AI 模型', [
      { title: '全球十大最强大模型', snippet: 'GPT、Claude、Gemini 排名变化很快', source: 'minimax' },
      { title: 'AI 模型榜单更新', snippet: '不同评测口径不同', source: 'minimax' },
    ]);
    // 不能采用半截模型总结；必须是基于搜索结果拼出的完整规则兜底
    expect(text).toContain('主人，我先给你结论');
    expect(text).not.toContain('排名会随着评测口径不同而');
  });

  it('模型总结 truncated/completionStatus=incomplete_length 同样回落规则兜底', async () => {
    const chat = async () => ({ reply: '主人，结论是：最强模型其实', truncated: true });
    const text = await summarizeSearchResults(chat, '最强 AI 模型', [
      { title: '全球十大最强大模型', snippet: 'GPT 排名变化很快', source: 'minimax' },
      { title: 'AI 模型榜单更新', snippet: '不同评测口径不同', source: 'minimax' },
    ]);
    expect(text).toContain('主人，我先给你结论');
    expect(text).not.toContain('最强模型其实');
  });

  it('完整模型总结（finishReason=stop）仍正常采用', async () => {
    const chat = async () => ({
      reply: '主人，结论是：综合榜单常见 GPT、Claude、Gemini，但排名会随评测变化，建议当作初步判断再复核。',
      finishReason: 'stop',
    });
    const text = await summarizeSearchResults(chat, '最强 AI 模型', [{ title: 'T', snippet: 'S' }], { personaName: '主人' });
    expect(text).toContain('结论是');
    expect(text).toContain('GPT、Claude、Gemini');
  });
});
