import { describe, expect, it } from 'vitest';
import { parseNoeLlmJson, parseNoeLlmJsonValue, stripNoeLlmThinking } from '../../src/runtime/NoeLlmJsonExtractor.js';

describe('NoeLlmJsonExtractor', () => {
  it('strips think blocks and parses fenced JSON arrays', () => {
    const raw = [
      '<think>这里有推理，不应进入 JSON parser。</think>',
      '```json',
      '[{"title":"A","url":"https://a.example"}]',
      '```',
    ].join('\n');
    const parsed = parseNoeLlmJson(raw);

    expect(stripNoeLlmThinking(raw)).not.toContain('这里有推理');
    expect(parsed).toMatchObject({ ok: true, source: 'fenced' });
    expect(parsed.value).toEqual([{ title: 'A', url: 'https://a.example' }]);
  });

  it('extracts the first balanced JSON span from surrounding prose without greedy last-brace parsing', () => {
    const raw = '说明 {不是 JSON。真正结果： {"ok":true,"nested":{"note":"brace } inside string"}} 后面还有 {bad';
    expect(parseNoeLlmJsonValue(raw)).toEqual({ ok: true, nested: { note: 'brace } inside string' } });
  });

  it('returns fallback instead of leaking raw invalid model text on parse failure', () => {
    const raw = '<think>secret-ish tp-unit-test-redaction-key-00000000000000000000</think>not json';
    expect(parseNoeLlmJson(raw)).toEqual({ ok: false, value: null, source: '', error: 'json_parse_failed' });
    expect(parseNoeLlmJsonValue(raw, { fallback: true })).toEqual({ fallback: true });
  });

  it('NOE_SAP_REPAIR=1：删尾随逗号修补后解析成功（BAML SAP）', () => {
    const prev = process.env.NOE_SAP_REPAIR;
    process.env.NOE_SAP_REPAIR = '1';
    try {
      const parsed = parseNoeLlmJson('{"a":1,"b":[1,2,],}'); // 尾逗号（LLM 高频错误）
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toEqual({ a: 1, b: [1, 2] });
      expect(parsed.source).toContain('_repaired');
    } finally {
      if (prev === undefined) delete process.env.NOE_SAP_REPAIR;
      else process.env.NOE_SAP_REPAIR = prev;
    }
  });

  it('NOE_SAP_REPAIR 默认 OFF：尾逗号 JSON 解析失败（行为同原，不静默兜造）', () => {
    const prev = process.env.NOE_SAP_REPAIR;
    delete process.env.NOE_SAP_REPAIR;
    try {
      expect(parseNoeLlmJson('{"a":1,}').ok).toBe(false);
    } finally {
      if (prev !== undefined) process.env.NOE_SAP_REPAIR = prev;
    }
  });
});
