// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { runTextToolCalls, summarizeResult, buildFeedbackText, orchestrateTextToolTurn } from '../../src/voice/NoeTextToolExecutor.js';

describe('NoeTextToolExecutor (VCP 吸收 H3)', () => {
  describe('runTextToolCalls', () => {
    it('正常执行 + feedbackText', async () => {
      const r = await runTextToolCalls([{ toolId: 'a.x', args: { k: 1 } }], { invokeTool: async () => ({ ok: true, text: '结果A' }) });
      expect(r.results[0]).toMatchObject({ toolId: 'a.x', ok: true });
      expect(r.results[0].summary).toContain('结果A');
      expect(r.feedbackText).toContain('a.x');
      expect(r.feedbackText).toContain('请据此继续回复');
    });
    it('invokeTool 抛错 → 错误隔离，标记失败，不影响其余', async () => {
      const invokeTool = async (id) => { if (id === 'bad') throw new Error('boom'); return { ok: true, text: 'ok' }; };
      const r = await runTextToolCalls([{ toolId: 'bad' }, { toolId: 'good' }], { invokeTool });
      expect(r.results[0]).toMatchObject({ toolId: 'bad', ok: false });
      expect(r.results[0].summary).toContain('执行出错');
      expect(r.results[1]).toMatchObject({ toolId: 'good', ok: true });
    });
    it('res.ok===false → ok false', async () => {
      const r = await runTextToolCalls([{ toolId: 'x' }], { invokeTool: async () => ({ ok: false, error: 'denied' }) });
      expect(r.results[0].ok).toBe(false);
    });
    it('redact 透传到结果 summary(H3 multimodel审#6)', async () => {
      const redact = (s) => s.replace(/secret/g, '***');
      const r = await runTextToolCalls([{ toolId: 'x' }], { invokeTool: async () => ({ text: 'my secret here' }), redact });
      expect(r.results[0].summary).toBe('my *** here');
    });
    it('realExecute 透传给 invokeTool', async () => {
      let seen;
      await runTextToolCalls([{ toolId: 'x' }], { invokeTool: async (_i, _a, opts) => { seen = opts.realExecute; return {}; }, realExecute: true });
      expect(seen).toBe(true);
    });
    it('默认 dry-run(realExecute=false)', async () => {
      let seen;
      await runTextToolCalls([{ toolId: 'x' }], { invokeTool: async (_i, _a, opts) => { seen = opts.realExecute; return {}; } });
      expect(seen).toBe(false);
    });
    it('空 calls → 空 results + 空 feedback', async () => {
      const r = await runTextToolCalls([], { invokeTool: async () => ({}) });
      expect(r.results).toHaveLength(0);
      expect(r.feedbackText).toBe('');
    });
    it('缺 invokeTool → throw TypeError', async () => {
      await expect(runTextToolCalls([], {})).rejects.toThrow(TypeError);
    });
    it('跳过无 toolId 的 call', async () => {
      const r = await runTextToolCalls([{ args: {} }, null, { toolId: 'ok' }], { invokeTool: async () => ({ ok: true }) });
      expect(r.results).toHaveLength(1);
      expect(r.results[0].toolId).toBe('ok');
    });
  });

  describe('summarizeResult', () => {
    it('字符串原样', () => { expect(summarizeResult('hi')).toBe('hi'); });
    it('null → (无返回)', () => { expect(summarizeResult(null)).toBe('(无返回)'); });
    it('过 redact 脱敏(H3 multimodel审#6)', () => {
      const redact = (s) => s.replace(/sk-[A-Za-z0-9]+/g, '[REDACTED]');
      expect(summarizeResult({ text: 'token is sk-abc123def' }, 1200, redact)).toBe('token is [REDACTED]');
    });
    it('object 优先取 text/message 字段', () => {
      expect(summarizeResult({ ok: true, text: '正文' })).toBe('正文');
      expect(summarizeResult({ ok: true, result: { a: 1 } })).toBe('{"a":1}');
    });
    it('超长截断', () => {
      const r = summarizeResult('x'.repeat(2000), 100);
      expect(r.length).toBeLessThan(130);
      expect(r).toContain('已截断');
    });
  });

  describe('buildFeedbackText', () => {
    it('空 → 空串', () => { expect(buildFeedbackText([])).toBe(''); });
    it('多结果拼块', () => {
      const t = buildFeedbackText([{ toolId: 'a', ok: true, summary: 's1' }, { toolId: 'b', ok: false, summary: 's2' }]);
      expect(t).toContain('工具 a 结果');
      expect(t).toContain('工具 b 失败');
    });
  });

  describe('orchestrateTextToolTurn (回读循环)', () => {
    it('无工具标记 → used:false，原样返回(零侵入)', async () => {
      const r = await orchestrateTextToolTurn('普通回复', { invokeTool: async () => ({}), regenerate: async () => 'x' });
      expect(r.used).toBe(false);
      expect(r.reply).toBe('普通回复');
    });
    it('有工具标记 → 执行 + 回灌再生成最终回复', async () => {
      const reply = '好的<<<NOE_TOOL>>>\ntool: a.x\nargs: {"k":1}\n<<<END_NOE_TOOL>>>';
      let fed;
      const r = await orchestrateTextToolTurn(reply, {
        allowedToolIds: ['a.x'],
        invokeTool: async () => ({ ok: true, text: '工具结果' }),
        regenerate: async (feedback) => { fed = feedback; return '最终回复(基于工具结果)'; },
      });
      expect(r.used).toBe(true);
      expect(r.reply).toBe('最终回复(基于工具结果)');
      expect(fed).toContain('工具结果');
      expect(r.calls).toHaveLength(1);
    });
    it('白名单外工具 → 不执行，used:false', async () => {
      const reply = '<<<NOE_TOOL>>>\ntool: evil\nargs: {}\n<<<END_NOE_TOOL>>>';
      const r = await orchestrateTextToolTurn(reply, { allowedToolIds: ['safe'], invokeTool: async () => ({}), regenerate: async () => 'x' });
      expect(r.used).toBe(false);
    });
    it('有工具但缺 regenerate → throw TypeError', async () => {
      const reply = '<<<NOE_TOOL>>>\ntool: a\nargs: {}\n<<<END_NOE_TOOL>>>';
      await expect(orchestrateTextToolTurn(reply, { allowedToolIds: ['a'], invokeTool: async () => ({}) })).rejects.toThrow(TypeError);
    });
    it('跨轮 ledger：复读同一标记块 → 不重复执行(H3 multimodel审#7) + 残留 strip(审#4)', async () => {
      let calls = 0;
      const reply = '<<<NOE_TOOL>>>\ntool: a.x\nargs: {}\n<<<END_NOE_TOOL>>>';
      const r = await orchestrateTextToolTurn(reply, {
        allowedToolIds: ['a.x'],
        invokeTool: async () => { calls += 1; return { ok: true }; },
        regenerate: async () => reply, // 复读同一块（相同 toolId+args）
        maxRounds: 3,
      });
      expect(calls).toBe(1); // ledger 跨轮去重：相同 (toolId,args) 只执行一次，绝不重复副作用
      expect(r.reply).not.toContain('NOE_TOOL'); // 残留标记块被 strip
    });
    it('不同工具多轮：ledger 不挡不同调用，maxRounds 封顶后 strip', async () => {
      let n = 0;
      const blk = (t) => `<<<NOE_TOOL>>>\ntool: ${t}\nargs: {}\n<<<END_NOE_TOOL>>>`;
      const r = await orchestrateTextToolTurn(blk('t0'), {
        allowedToolIds: ['*'],
        invokeTool: async () => ({ ok: true }),
        regenerate: async () => { n += 1; return blk('t' + n); }, // 每轮换不同工具
        maxRounds: 2,
      });
      expect(n).toBe(2); // 跑满 maxRounds（每轮不同工具，ledger 不挡）
      expect(r.reply).not.toContain('NOE_TOOL'); // 达上限后 strip
    });
  });
});
