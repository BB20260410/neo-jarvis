import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so the mock tracer/span exist before vi.mock factories run.
const { mockSpan, mockTracer, mockGetTracer } = vi.hoisted(() => {
  const mockSpan = {
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    end: vi.fn(),
  };
  const mockTracer = {
    startSpan: vi.fn(() => mockSpan),
  };
  const mockGetTracer = vi.fn(() => mockTracer);
  return { mockSpan, mockTracer, mockGetTracer };
});

vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: { OK: 1, ERROR: 2, UNSET: 0 },
}));

vi.mock('../../src/server/observability/otel.js', () => ({
  getTracer: mockGetTracer,
}));

const { withLLMSpan } = await import('../../src/server/observability/trace.js');

const baseConfig = {
  feature: 'chat',
  provider: 'claude',
  model: 'sonnet-4-6',
  roomId: 'room-1',
  adapter_kind: 'spawn',
};

describe('withLLMSpan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the panel-llm tracer from getTracer', async () => {
    await withLLMSpan(baseConfig, async () => 'ok');
    expect(mockGetTracer).toHaveBeenCalledWith('panel-llm');
  });

  it('starts a span named "<provider>/<model>" with panel.* attributes', async () => {
    await withLLMSpan(baseConfig, async () => 'ok');
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      'claude/sonnet-4-6',
      {
        attributes: {
          'panel.feature': 'chat',
          'panel.provider': 'claude',
          'panel.model': 'sonnet-4-6',
          'panel.adapter_kind': 'spawn',
          'panel.room_id': 'room-1',
        },
      },
      undefined,
    );
  });

  it('omits panel.room_id attribute when roomId is missing', async () => {
    const { roomId, ...cfg } = baseConfig;
    await withLLMSpan(cfg, async () => 'ok');
    const attrs = mockTracer.startSpan.mock.calls[0][1].attributes;
    expect(attrs).not.toHaveProperty('panel.room_id');
  });

  it('passes parentSpan as the third argument to startSpan', async () => {
    const parent = { id: 'parent-span' };
    await withLLMSpan({ ...baseConfig, parentSpan: parent }, async () => 'ok');
    expect(mockTracer.startSpan.mock.calls[0][2]).toBe(parent);
  });

  it('returns the value produced by the work function', async () => {
    const result = await withLLMSpan(baseConfig, async () => ({ content: 'hello' }));
    expect(result).toEqual({ content: 'hello' });
  });

  it('sets OK status and ends the span on success', async () => {
    await withLLMSpan(baseConfig, async () => 'ok');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 1 });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('setUsage writes each provided token/cost/ttft attribute', async () => {
    await withLLMSpan(baseConfig, async (span) => {
      span.setUsage({ tokens_in: 800, tokens_out: 1200, cost_usd: 0.0024, ttft_ms: 320 });
      return 'ok';
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.tokens_in', 800);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.tokens_out', 1200);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.cost_usd', 0.0024);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.ttft_ms', 320);
  });

  it('setUsage with no arguments is a noop', async () => {
    await withLLMSpan(baseConfig, async (span) => {
      span.setUsage();
      return 'ok';
    });
    expect(mockSpan.setAttribute).not.toHaveBeenCalled();
  });

  it('setUsage skips undefined keys but keeps 0 values', async () => {
    await withLLMSpan(baseConfig, async (span) => {
      span.setUsage({ tokens_in: 0, tokens_out: undefined, cost_usd: 0 });
      return 'ok';
    });
    const keys = mockSpan.setAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain('panel.tokens_in');
    expect(keys).toContain('panel.cost_usd');
    expect(keys).not.toContain('panel.tokens_out');
  });

  it('setTraceMeta writes panel.* attributes for defined, non-null values', async () => {
    await withLLMSpan(baseConfig, async (span) => {
      span.setTraceMeta({ retry: 2, cache_hit: true, dropped: undefined, missing: null });
      return 'ok';
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.retry', 2);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('panel.cache_hit', true);
    const keys = mockSpan.setAttribute.mock.calls.map((c) => c[0]);
    expect(keys).not.toContain('panel.dropped');
    expect(keys).not.toContain('panel.missing');
  });

  it('setTraceMeta with no arguments is a noop', async () => {
    await withLLMSpan(baseConfig, async (span) => {
      span.setTraceMeta();
      return 'ok';
    });
    expect(mockSpan.setAttribute).not.toHaveBeenCalled();
  });

  it('records exception, sets ERROR status with message, and re-throws on failure', async () => {
    const err = new Error('boom');
    await expect(
      withLLMSpan(baseConfig, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'boom' });
  });

  it('still ends the span when work throws', async () => {
    await expect(
      withLLMSpan(baseConfig, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it('uses String(e) as the status message when the thrown value has no message', async () => {
    await expect(
      withLLMSpan(baseConfig, async () => {
        throw 'plain-string';
      }),
    ).rejects.toBe('plain-string');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: 'plain-string' });
  });
});
