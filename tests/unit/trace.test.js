// Unit tests for src/server/observability/trace.js — the withLLMSpan helper that
// wraps LLM calls in OpenTelemetry spans. We mock the otel module's getTracer so we
// can assert on the exact span API calls (attributes, status, end, recordException)
// without depending on a real OTel SDK being registered.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';

vi.mock('../../src/server/observability/otel.js', () => ({
  getTracer: vi.fn(),
}));

import { getTracer } from '../../src/server/observability/otel.js';
import { withLLMSpan } from '../../src/server/observability/trace.js';

function makeMockSpan() {
  return {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
}

const baseOpts = {
  feature: 'chat',
  provider: 'claude',
  model: 'sonnet-4-6',
  adapter_kind: 'spawn',
};

describe('withLLMSpan', () => {
  let mockSpan;
  let mockTracer;

  beforeEach(() => {
    mockSpan = makeMockSpan();
    mockTracer = { startSpan: vi.fn(() => mockSpan) };
    getTracer.mockReset();
    getTracer.mockReturnValue(mockTracer);
  });

  it('looks up the "panel-llm" tracer', async () => {
    await withLLMSpan(baseOpts, async () => 'ok');
    expect(getTracer).toHaveBeenCalledWith('panel-llm');
  });

  it('starts a span named "<provider>/<model>" with the required panel.* attributes', async () => {
    await withLLMSpan(baseOpts, async () => 'ok');
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'claude/sonnet-4-6',
      {
        attributes: {
          'panel.feature': 'chat',
          'panel.provider': 'claude',
          'panel.model': 'sonnet-4-6',
          'panel.adapter_kind': 'spawn',
        },
      },
      undefined,
    );
  });

  it('includes panel.room_id when roomId is provided', async () => {
    await withLLMSpan({ ...baseOpts, roomId: 'r1' }, async () => 'ok');
    expect(mockTracer.startSpan.mock.calls[0][1].attributes['panel.room_id']).toBe('r1');
  });

  it('omits panel.room_id when roomId is falsy', async () => {
    await withLLMSpan({ ...baseOpts, roomId: '' }, async () => 'ok');
    expect(mockTracer.startSpan.mock.calls[0][1].attributes).not.toHaveProperty('panel.room_id');
  });

  it('forwards parentSpan as the third startSpan argument', async () => {
    const parent = { id: 'parent' };
    await withLLMSpan({ ...baseOpts, parentSpan: parent }, async () => 'ok');
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'claude/sonnet-4-6',
      expect.any(Object),
      parent,
    );
  });

  it('returns whatever the work function resolves to', async () => {
    const payload = { foo: 'bar' };
    await expect(withLLMSpan(baseOpts, async () => payload)).resolves.toBe(payload);
  });

  it('hands the work function a handle exposing setUsage and setTraceMeta', async () => {
    let received;
    await withLLMSpan(baseOpts, async (h) => {
      received = h;
      return 'ok';
    });
    expect(received).toBeDefined();
    expect(typeof received.setUsage).toBe('function');
    expect(typeof received.setTraceMeta).toBe('function');
  });

  it('marks the span OK and ends it on success', async () => {
    await withLLMSpan(baseOpts, async () => 'ok');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('records the exception, marks ERROR, ends the span, and re-throws on failure', async () => {
    const err = new Error('boom');
    await expect(withLLMSpan(baseOpts, async () => { throw err; })).rejects.toBe(err);
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'boom',
    });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('uses String(e) as the status message when the thrown value has no .message', async () => {
    await expect(
      withLLMSpan(baseOpts, async () => { throw 'plain-string'; }),
    ).rejects.toBe('plain-string');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: 'plain-string',
    });
  });

  it('setUsage writes tokens_in / tokens_out / cost_usd / ttft_ms when provided', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setUsage({ tokens_in: 800, tokens_out: 1200, cost_usd: 0.0024, ttft_ms: 250 });
      return 'ok';
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.tokens_in', 800);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.tokens_out', 1200);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.cost_usd', 0.0024);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.ttft_ms', 250);
  });

  it('setUsage only writes the fields that are defined (falsy-but-defined values still pass through)', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setUsage({ tokens_in: 100, tokens_out: undefined, cost_usd: 0, ttft_ms: undefined });
      return 'ok';
    });
    const keys = mockSpan.setAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain('panel.tokens_in');
    expect(keys).toContain('panel.cost_usd');
    expect(keys).not.toContain('panel.tokens_out');
    expect(keys).not.toContain('panel.ttft_ms');
  });

  it('setUsage is a no-op when called without arguments', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setUsage();
      return 'ok';
    });
    const keys = mockSpan.setAttribute.mock.calls.map((c) => c[0]);
    expect(keys).not.toContain('panel.tokens_in');
    expect(keys).not.toContain('panel.tokens_out');
    expect(keys).not.toContain('panel.cost_usd');
    expect(keys).not.toContain('panel.ttft_ms');
  });

  it('setTraceMeta writes each entry as panel.<key> with the supplied value', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setTraceMeta({ cache_hit: true, retry_count: 2 });
      return 'ok';
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.cache_hit', true);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.retry_count', 2);
  });

  it('setTraceMeta skips undefined and null values', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setTraceMeta({ a: 1, b: undefined, c: null, d: 'x' });
      return 'ok';
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.a', 1);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.d', 'x');
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('panel.b', undefined);
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('panel.c', null);
  });

  it('setTraceMeta is a no-op when called without arguments', async () => {
    await withLLMSpan(baseOpts, async (span) => {
      span.setTraceMeta();
      return 'ok';
    });
    const metaKeys = mockSpan.setAttribute.mock.calls
      .map((c) => c[0])
      .filter((k) =>
        k === 'panel.cache_hit' ||
        k === 'panel.retry_count' ||
        k === 'panel.a' ||
        k === 'panel.b' ||
        k === 'panel.c' ||
        k === 'panel.d',
      );
    expect(metaKeys).toHaveLength(0);
  });
});
