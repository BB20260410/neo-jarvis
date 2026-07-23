// @ts-check
import { describe, expect, it } from 'vitest';
import { buildFrontDoorManifest } from '../../src/runtime/NoeTaskReceiptView.js';
import { runBrowserStandardLoop } from '../../src/runtime/NoeProductCapabilityLoops.js';
import {
  BAILONGMA_STYLE_PROACTIVE_TICK_MS,
  applyRuntimeModeFromEnv,
  buildBaiLongmaGapMatrix,
} from '../../src/runtime/NoeBaiLongmaRuntimeMode.js';

describe('6h longline gap landings', () => {
  it('front door runtimeVisibility invent: mode + tick under bailongma_style', () => {
    const env = { NOE_RUNTIME_MODE: 'bailongma_style' };
    applyRuntimeModeFromEnv(env);
    const m = buildFrontDoorManifest({
      env,
      sourceDigest: 'sha256:abcdef0123456789deadbeef',
    });
    expect(m.runtimeVisibility.modeId).toBe('bailongma_style');
    expect(m.runtimeVisibility.bailongmaStyle).toBe(true);
    expect(m.runtimeVisibility.isFullyCloud).toBe(false);
    expect(m.runtimeVisibility.proactiveTickMs).toBe(BAILONGMA_STYLE_PROACTIVE_TICK_MS);
    expect(m.runtimeVisibility.sourceDigestPrefix).toBe('sha256:abcdef012345');
    expect(m.ordinaryEntries).toHaveLength(5);
  });

  it('browser missing executor is external_blocked not fake green', async () => {
    const r = await runBrowserStandardLoop({ browser: null });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('external_blocked');
    expect(r.fakeGreen).toBe(false);
    expect(r.error).toBe('browser_executor_missing');
  });

  it('browser playwrightAvailable=false is external_blocked', async () => {
    const r = await runBrowserStandardLoop({
      browser: { run: async () => ({ ok: true, title: 'x' }), playwrightAvailable: false },
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('external_blocked');
    expect(r.error).toBe('playwright_unavailable');
  });

  it('browser happy path still ok with executor', async () => {
    const r = await runBrowserStandardLoop({
      browser: {
        run: async (t) => ({ ok: true, title: `t-${t.id}`, summary: 'ok' }),
      },
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.okCount).toBe(3);
  });

  it('gap matrix documents browser borrow + memory invent landings', () => {
    const rows = buildBaiLongmaGapMatrix();
    const browser = rows.find((r) => r.dimension === 'browser');
    const memory = rows.find((r) => r.dimension === 'memory_state_visibility');
    expect(browser?.decision).toBe('borrow');
    expect(String(browser?.rationale || '')).toMatch(/external_blocked|Landed/i);
    expect(memory?.decision).toBe('invent');
    expect(String(memory?.rationale || '')).toMatch(/runtimeVisibility|Landed/i);
  });
});
