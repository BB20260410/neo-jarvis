import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CCRSpawnAdapter } from '../../src/room/CCRSpawnAdapter.js';
import { ClaudeSpawnAdapter } from '../../src/room/ClaudeSpawnAdapter.js';
import { CodexSpawnAdapter } from '../../src/room/CodexSpawnAdapter.js';
import { clusterMemberCallTimeoutMs } from '../../src/room/CrossVerifyDispatcher.js';
import { GeminiChatAdapter } from '../../src/room/GeminiChatAdapter.js';
import { GeminiSpawnAdapter } from '../../src/room/GeminiSpawnAdapter.js';
import { MiniMaxChatAdapter } from '../../src/room/MiniMaxChatAdapter.js';
import { MiniMaxSpawnAdapter } from '../../src/room/MiniMaxSpawnAdapter.js';
import { OllamaChatAdapter } from '../../src/room/OllamaChatAdapter.js';
import { OpenAICompatChatAdapter } from '../../src/room/OpenAICompatChatAdapter.js';
import { RoomAdapter } from '../../src/room/RoomAdapter.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('Room model timeout policy', () => {
  it('does not set hard model timeouts by default', () => {
    const adapters = [
      new RoomAdapter({ id: 'base', displayName: 'base' }),
      new MiniMaxChatAdapter({ apiKey: 'k' }),
      new OllamaChatAdapter(),
      new GeminiChatAdapter({ apiKey: 'k' }),
      new OpenAICompatChatAdapter({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', model: 'm' }),
      new ClaudeSpawnAdapter({ bin: 'claude' }),
      new CodexSpawnAdapter({ bin: 'codex' }),
      new GeminiSpawnAdapter({ bin: 'gemini' }),
      new CCRSpawnAdapter({ bin: 'ccr' }),
      new MiniMaxSpawnAdapter({ bin: 'minimax' }),
    ];
    for (const adapter of adapters) expect(adapter.timeout).toBe(0);
  });

  it('still honors explicit user timeout overrides', () => {
    expect(new MiniMaxChatAdapter({ apiKey: 'k', timeout: 1234 }).timeout).toBe(1234);
    expect(new ClaudeSpawnAdapter({ bin: 'claude', timeout: 2345 }).timeout).toBe(2345);
    expect(new GeminiSpawnAdapter({ bin: 'gemini', timeout: 3456 }).timeout).toBe(3456);
  });

  it('does not set a hard cluster member call timeout unless explicitly configured', () => {
    const old = process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
    try {
      delete process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
      expect(clusterMemberCallTimeoutMs()).toBe(0);
      expect(clusterMemberCallTimeoutMs(1234)).toBe(1234);
      process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = '5678';
      expect(clusterMemberCallTimeoutMs()).toBe(5678);
    } finally {
      if (old === undefined) delete process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS;
      else process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS = old;
    }
  });

  it('requires explicit manual acknowledgement before running LM Studio benchmark scripts', () => {
    const scripts = [
      'scripts/noe-main-brain-candidate-benchmark.mjs',
      'scripts/noe-main-brain-absolute-benchmark-v2.mjs',
      'scripts/noe-gemma-family-benchmark.mjs',
      'scripts/noe-new-model-benchmark.mjs',
    ];
    for (const script of scripts) {
      const out = spawnSync(process.execPath, [script], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NOE_ACK_MANUAL_BENCHMARK: '' },
        timeout: 5000,
      });
      const output = `${out.stdout}\n${out.stderr}`;
      expect(out.status, script).toBe(2);
      expect(output, script).toContain('manual benchmark / explicit experiment only');
      expect(output, script).toContain('Resident default remains qwen/qwen3.6-35b-a3b');
    }
  });
});
