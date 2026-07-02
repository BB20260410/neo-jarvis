import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateAndCleanConfig } from '../../src/room/RoomAdaptersConfig.js';

describe('RoomAdaptersConfig spawn overrides', () => {
  it('allows MiniMax patch-only spawn timeout override', () => {
    const result = validateAndCleanConfig({
      spawn_overrides: { minimaxSpawnTimeoutMs: 120000 },
    }, DEFAULT_CONFIG);

    expect(result.ok).toBe(true);
    expect(result.config.spawn_overrides.minimaxSpawnTimeoutMs).toBe(120000);
  });

  it('rejects invalid MiniMax patch-only spawn timeout override', () => {
    const result = validateAndCleanConfig({
      spawn_overrides: { minimaxSpawnTimeoutMs: 7200001 },
    }, DEFAULT_CONFIG);

    expect(result).toMatchObject({
      ok: false,
      error: 'spawn_overrides.minimaxSpawnTimeoutMs 必须 0~7200000ms',
    });
  });
});
