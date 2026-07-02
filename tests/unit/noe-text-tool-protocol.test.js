// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, buildTextToolProtocolPrompt, normalizeArgKey } from '../../src/voice/NoeTextToolProtocol.js';

const wrap = (tool, args) => `<<<NOE_TOOL>>>\ntool: ${tool}\nargs: ${args}\n<<<END_NOE_TOOL>>>`;
const ALL = { allowedToolIds: ['*'] }; // 测试解析逻辑时显式放行所有

describe('NoeTextToolProtocol (VCP 吸收 H3)', () => {
  describe('parseTextToolCalls', () => {
    it('正常单块解析 + stripped 剥掉标记', () => {
      const r = parseTextToolCalls('好的' + wrap('noe.memory.recall', '{"query":"会议","limit":5}'), { allowedToolIds: ['noe.memory.recall'] });
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].toolId).toBe('noe.memory.recall');
      expect(r.calls[0].args).toEqual({ query: '会议', limit: 5 });
      expect(r.stripped).toBe('好的');
    });
    it('多块解析(各自独立)', () => {
      const txt = wrap('a.x', '{"k":1}') + '\n中间\n' + wrap('b.y', '{}');
      const r = parseTextToolCalls(txt, { allowedToolIds: ['a.x', 'b.y'] });
      expect(r.calls).toHaveLength(2);
      expect(r.stripped).toBe('中间');
    });
    it('多行 JSON args 解析(本地模型常见形态，H3审#1)', () => {
      const block = '<<<NOE_TOOL>>>\ntool: a.x\nargs: {\n  "query": "会议",\n  "limit": 5\n}\n<<<END_NOE_TOOL>>>';
      const r = parseTextToolCalls(block, ALL);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].args).toEqual({ query: '会议', limit: 5 });
    });
    it('fail-closed：空白名单 → 全拒(H3审#3，防接入忘传白名单)', () => {
      const r = parseTextToolCalls(wrap('any.tool', '{}'), {});
      expect(r.calls).toHaveLength(0);
      expect(r.rejected[0].reason).toBe('not_in_allowlist');
    });
    it("'*' 哨兵 → 显式放行所有", () => {
      expect(parseTextToolCalls(wrap('any.tool', '{}'), ALL).calls).toHaveLength(1);
    });
    it('allowlist 拒绝未授权 toolId(防大脑幻觉)', () => {
      const r = parseTextToolCalls(wrap('evil.delete', '{}'), { allowedToolIds: ['safe.read'] });
      expect(r.calls).toHaveLength(0);
      expect(r.rejected[0]).toEqual({ name: 'evil.delete', reason: 'not_in_allowlist' });
    });
    it('toolId 非法字符(路径穿越) → invalid_tool_id(H3审#2)', () => {
      const r = parseTextToolCalls(wrap('../../etc/passwd', '{}'), ALL);
      expect(r.calls).toHaveLength(0);
      expect(r.rejected[0].reason).toBe('invalid_tool_id');
    });
    it('args 含 __proto__ 不污染全局原型', () => {
      parseTextToolCalls(wrap('a.x', '{"__proto__":{"polluted":1}}'), ALL);
      expect({}.polluted).toBeUndefined();
    });
    it('无 tool 名 → 拒绝 no_tool_name', () => {
      const r = parseTextToolCalls('<<<NOE_TOOL>>>\nargs: {}\n<<<END_NOE_TOOL>>>', ALL);
      expect(r.calls).toHaveLength(0);
      expect(r.rejected[0].reason).toBe('no_tool_name');
    });
    it('args 非法 JSON → 拒绝', () => {
      expect(parseTextToolCalls(wrap('a.x', '{not json}'), ALL).rejected[0].reason).toBe('args_invalid_json');
    });
    it('args 是数组(非 object) → 拒绝', () => {
      expect(parseTextToolCalls(wrap('a.x', '[1,2]'), ALL).rejected[0].reason).toBe('args_invalid_json');
    });
    it('无 args 行 → args 默认空对象', () => {
      const r = parseTextToolCalls('<<<NOE_TOOL>>>\ntool: a.x\n<<<END_NOE_TOOL>>>', ALL);
      expect(r.calls[0].args).toEqual({});
    });
    it('超 maxCalls → 多出的拒绝', () => {
      const txt = wrap('a', '{}') + wrap('b', '{}') + wrap('c', '{}') + wrap('d', '{}');
      const r = parseTextToolCalls(txt, { allowedToolIds: ['*'], maxCalls: 2 });
      expect(r.calls).toHaveLength(2);
      expect(r.rejected.filter((x) => x.reason === 'over_max_calls')).toHaveLength(2);
    });
    it('去重(同 tool+body)', () => {
      const txt = wrap('a.x', '{"k":1}') + wrap('a.x', '{"k":1}');
      const r = parseTextToolCalls(txt, ALL);
      expect(r.calls).toHaveLength(1);
      expect(r.rejected[0].reason).toBe('duplicate');
    });
    it('反向 probe：空/null/undefined 文本不崩', () => {
      expect(parseTextToolCalls('', ALL).calls).toHaveLength(0);
      expect(parseTextToolCalls(null, ALL).calls).toHaveLength(0);
      expect(parseTextToolCalls(undefined, ALL).calls).toHaveLength(0);
    });
    it('反向 probe：无标记块 → stripped=原文', () => {
      const r = parseTextToolCalls('就是普通回复没有工具', ALL);
      expect(r.calls).toHaveLength(0);
      expect(r.stripped).toBe('就是普通回复没有工具');
    });
  });

  describe('normalizeArgKey', () => {
    it('小写 + 去下划线连字符', () => {
      expect(normalizeArgKey('Image_Size')).toBe('imagesize');
      expect(normalizeArgKey('image-size')).toBe('imagesize');
      expect(normalizeArgKey('IMAGESIZE')).toBe('imagesize');
      expect(normalizeArgKey(null)).toBe('');
    });
  });

  describe('buildTextToolProtocolPrompt', () => {
    it('空工具 → 空串', () => {
      expect(buildTextToolProtocolPrompt([])).toBe('');
      expect(buildTextToolProtocolPrompt(null)).toBe('');
    });
    it('有工具 → 含标记说明 + 工具行 + example', () => {
      const p = buildTextToolProtocolPrompt([{ id: 'noe.memory.recall', description: '回忆', example: '{"query":"x"}' }]);
      expect(p).toContain('<<<NOE_TOOL>>>');
      expect(p).toContain('noe.memory.recall：回忆');
      expect(p).toContain('范例 args: {"query":"x"}');
    });
    it('maxTools 限制', () => {
      const tools = Array.from({ length: 20 }, (_, i) => ({ id: 't' + i, description: 'd' }));
      const p = buildTextToolProtocolPrompt(tools, { maxTools: 3 });
      expect(p).toContain('t0');
      expect(p).toContain('t2');
      expect(p).not.toContain('t3：');
    });
    it('过滤无 id 的工具', () => {
      const p = buildTextToolProtocolPrompt([{ description: '无id' }, { id: 'ok.tool', description: 'd' }]);
      expect(p).toContain('ok.tool');
      expect(p).not.toContain('无id');
    });
  });
});
