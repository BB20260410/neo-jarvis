import { describe, it, expect } from 'vitest';
import { matchToolsForNeed } from '../../src/capabilities/NoeToolMatch.js';

// 阶段二·扩展可自主调用的工具生态:让 Neo 能推理「自己已有哪些工具」。
// 轴3 察觉能力缺口时先查现有工具能否满足(再决定是否装新的)——更好用现有生态 + 零新增安装风险。
// 纯函数:按 need 与 tool 的 name/description/category 关键词重叠打分。

const TOOLS = [
  { id: 't1', name: '网页抓取器', description: '抓取网页内容并提取正文', category: 'web', enabled: true },
  { id: 't2', name: 'PDF 解析', description: '解析 PDF 文档提取文本', category: 'doc', enabled: true },
  { id: 't3', name: '旧工具', description: '抓取网页', category: 'web', enabled: false },
];

describe('matchToolsForNeed', () => {
  it('need 与工具描述关键词重叠 → 命中并按分排序', () => {
    const m = matchToolsForNeed('需要一个抓取网页的工具', TOOLS);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].id).toBe('t1'); // 网页抓取器最相关
  });

  it('只返回 enabled 工具(disabled 的不算可调用)', () => {
    const m = matchToolsForNeed('抓取网页', TOOLS);
    expect(m.find((t) => t.id === 't3')).toBeUndefined(); // t3 disabled 不返回
  });

  it('无重叠 → 空(该去装新的)', () => {
    expect(matchToolsForNeed('需要语音合成能力', TOOLS)).toEqual([]);
  });

  it('空 need / 空工具 / 非法 → [](fail-open)', () => {
    expect(matchToolsForNeed('', TOOLS)).toEqual([]);
    expect(matchToolsForNeed('抓取', [])).toEqual([]);
    expect(matchToolsForNeed('抓取', null)).toEqual([]);
    expect(matchToolsForNeed(null, TOOLS)).toEqual([]);
  });
});
