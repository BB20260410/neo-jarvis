import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { noeStructuredCall, buildNoeResponseFormat } from '../../src/runtime/NoeStructuredCall.js';

// 序列 adapter：每次 chat 返回序列中下一个回复（最后一个重复），记录每次 opts。
function seqAdapter(...replies) {
  let i = 0;
  const calls = [];
  return {
    calls,
    chat: async (messages, opts) => {
      calls.push(opts || {});
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return typeof r === 'string' ? { reply: r } : r;
    },
  };
}

describe('buildNoeResponseFormat', () => {
  it('json_schema 档带 schema + strict', () => {
    expect(buildNoeResponseFormat('json_schema', { jsonSchema: { type: 'object' }, name: 'x' }))
      .toEqual({ type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' }, strict: true } });
  });
  it('json_object 档', () => {
    expect(buildNoeResponseFormat('json_object')).toEqual({ type: 'json_object' });
  });
  it('text 档 → null（纯文本兜底，不传 response_format）', () => {
    expect(buildNoeResponseFormat('text')).toBeNull();
  });
  it('json_schema 但无 schema → null（无法约束就别传）', () => {
    expect(buildNoeResponseFormat('json_schema', {})).toBeNull();
  });
});

describe('noeStructuredCall — 三档降级 + zod 校验', () => {
  const schema = z.object({ verdict: z.enum(['APPLIED', 'FAILED', 'UNKNOWN']) });

  it('首档成功：json_schema + zod 过 → ok，tier=json_schema，attempts=1，真传了 response_format', async () => {
    const adapter = seqAdapter('{"verdict":"FAILED"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r).toMatchObject({ ok: true, value: { verdict: 'FAILED' }, tier: 'json_schema', attempts: 1 });
    expect(adapter.calls[0].response_format.type).toBe('json_schema');
  });

  it('maxReask>0：校验失败回喂错误、同档 re-ask 成功（Instructor re-ask 闭环）', async () => {
    // 第一次 verdict 非法（schema 失败）→ 同档 re-ask → 第二次合法
    const adapter = seqAdapter('{"verdict":"WRONG"}', '{"verdict":"APPLIED"}');
    const r = await noeStructuredCall({ adapter, messages: [{ role: 'user', content: 'q' }], zodSchema: schema, startTier: 'json_object', maxReask: 2 });
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('APPLIED');
    expect(r.tier).toBe('json_object'); // 同档 re-ask 成功，没降级
    expect(r.attempts).toBe(2);
    expect(adapter.calls.length).toBe(2); // re-ask 第二轮把错误回填后再问
  });

  it('maxReask=0（默认 OFF）：校验失败不 re-ask、直接降级（行为同原）', async () => {
    const adapter = seqAdapter('{"verdict":"WRONG"}', '{"verdict":"APPLIED"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, startTier: 'json_object', maxReask: 0 });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('text'); // 没 re-ask，json_object 失败直接降级到 text
  });

  it('NOE_STRUCTURED_REASK env 映射：设 env、不传 maxReask → re-ask 默认生效', async () => {
    const prev = process.env.NOE_STRUCTURED_REASK;
    process.env.NOE_STRUCTURED_REASK = '2';
    try {
      const adapter = seqAdapter('{"verdict":"WRONG"}', '{"verdict":"APPLIED"}');
      const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, startTier: 'json_object' }); // 不传 maxReask
      expect(r.ok).toBe(true);
      expect(r.value.verdict).toBe('APPLIED'); // env→默认 maxReask=2，同档 re-ask 成功
      expect(r.tier).toBe('json_object');
    } finally {
      if (prev === undefined) delete process.env.NOE_STRUCTURED_REASK;
      else process.env.NOE_STRUCTURED_REASK = prev;
    }
  });

  it('首档坏 JSON → 降级 json_object 成功（attempts=2）', async () => {
    const adapter = seqAdapter('不是 JSON 的废话', '{"verdict":"APPLIED"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r).toMatchObject({ ok: true, value: { verdict: 'APPLIED' }, tier: 'json_object', attempts: 2 });
  });

  it('zod 校验失败 → 降级（首档 JSON 但枚举不符，次档符）', async () => {
    const adapter = seqAdapter('{"verdict":"GARBAGE"}', '{"verdict":"UNKNOWN"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('UNKNOWN');
    expect(r.tier).toBe('json_object');
  });

  it('全档失败 → ok:false，attempts=3', async () => {
    const adapter = seqAdapter('废话', '更多废话', '还是废话');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
  });

  it('无 zodSchema → 只解析不校验', async () => {
    const adapter = seqAdapter('{"anything":42}');
    const r = await noeStructuredCall({ adapter, messages: [], jsonSchema: { type: 'object' } });
    expect(r).toMatchObject({ ok: true, value: { anything: 42 } });
  });

  it('adapter 忽略 response_format（不支持的本地模型）→ parseNoeLlmJson 兜底仍解析', async () => {
    const adapter = { chat: async () => ({ reply: 'verdict 如下：\n```json\n{"verdict":"APPLIED"}\n```' }) };
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r.ok).toBe(true);
    expect(r.value.verdict).toBe('APPLIED');
  });

  it('无 jsonSchema → 从 json_object 档起', async () => {
    const adapter = seqAdapter('{"verdict":"APPLIED"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema });
    expect(r).toMatchObject({ ok: true, tier: 'json_object', attempts: 1 });
  });

  it('incomplete reply（截断）→ 降级', async () => {
    const adapter = seqAdapter({ incomplete: true, finishReason: 'length' }, '{"verdict":"FAILED"}');
    const r = await noeStructuredCall({ adapter, messages: [], zodSchema: schema, jsonSchema: { type: 'object' } });
    expect(r).toMatchObject({ ok: true, value: { verdict: 'FAILED' }, tier: 'json_object' });
  });

  it('adapter 缺失 → ok:false adapter_unavailable', async () => {
    const r = await noeStructuredCall({ adapter: null, messages: [] });
    expect(r).toMatchObject({ ok: false, error: 'adapter_unavailable', attempts: 0 });
  });
});
