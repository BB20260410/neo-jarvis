// @ts-check
// 第三波手术 第32批 结构级防回归：server.js 余矿三连之一
// 房间 adapter 工厂（detectCCR/buildRoomAdapters/applyRoomAdaptersConfig/rebuildRoomAdapters，~146 行）
// 迁出 src/server/services/room-adapters.js。
// 注入约定：claudeBin 传值；watcherConfig 是 server.js 的 let → getter 注入按调用时求值；
// roomAdaptersConfig 属主随迁进工厂闭包，路由层读写走工厂 getter/setter 转发。
// 风格对齐 appjs-migration-batch30/31：源码文本断言 + 真跑行为冒烟（池构建/原地重建/watcher 回退）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRoomAdapterFactory, detectCCR } from '../../src/server/services/room-adapters.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/room-adapters.js';

function withProcessEnv(patch, run) {
  const previous = {};
  for (const key of Object.keys(patch)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('server.js 拆分第32批（room adapter 工厂外迁）— 结构', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头 + 注入式工厂', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
    expect(moduleSrc).toContain('export function createRoomAdapterFactory({ claudeBin, getWatcherConfig })');
    expect(moduleSrc).toContain('export function detectCCR()');
  });

  it('server.js：工厂 import + getter 注入 + 同名解构，不再内联实现', () => {
    expect(serverSrc).toContain("import { createRoomAdapterFactory } from './src/server/services/room-adapters.js';");
    expect(serverSrc).toContain('getWatcherConfig: () => watcherConfig,');
    expect(serverSrc).toContain('claudeBin: CLAUDE_BIN,');
    expect(serverSrc).toContain('const { roomAdapterPool, rebuildRoomAdapters } = roomAdapterFactory;');
    expect(serverSrc).not.toContain('function buildRoomAdapters()');
    expect(serverSrc).not.toContain('function applyRoomAdaptersConfig(');
    expect(serverSrc).not.toContain('function rebuildRoomAdapters()');
    expect(serverSrc).not.toContain('let roomAdaptersConfig');
    expect(serverSrc).not.toContain('function detectCCR()');
    expect(serverSrc).not.toContain('_spawnSyncCheck');
  });

  it('server.js：watcher rebuildAdapter 的 TDZ 防御改走工厂 rebuildRoomAdapters（语义同 applyRoomAdaptersConfig(roomAdapterPool)）', () => {
    expect(serverSrc).toContain("typeof roomAdapterFactory !== 'undefined' && roomAdapterFactory");
    expect(serverSrc).toContain('roomAdapterFactory.rebuildRoomAdapters();');
  });

  it('server.js：room-adapters 路由注入改走工厂 getter/setter + hasGeminiCli；adapter 类 import 已精简', () => {
    expect(serverSrc).toContain('getRoomAdaptersConfig: roomAdapterFactory.getRoomAdaptersConfig,');
    expect(serverSrc).toContain('setRoomAdaptersConfig: roomAdapterFactory.setRoomAdaptersConfig,');
    expect(serverSrc).toContain('hasGeminiCli: roomAdapterFactory.hasGeminiCli,');
    for (const gone of [
      "from './src/room/ClaudeSpawnAdapter.js'",
      "from './src/room/CodexSpawnAdapter.js'",
      "from './src/room/OllamaChatAdapter.js'",
      "from './src/room/GeminiSpawnAdapter.js'",
      "from './src/room/GeminiChatAdapter.js'",
      "from './src/room/OpenAICompatChatAdapter.js'",
      "from './src/room/LmStudioChatAdapter.js'",
      "from './src/room/MiniMaxChatAdapter.js'",
      "from './src/room/MiniMaxSpawnAdapter.js'",
      "from './src/room/CCRSpawnAdapter.js'",
    ]) expect(serverSrc, `adapter 类 import 残留 ${gone}`).not.toContain(gone);
    // RoomAdaptersConfig 的 save/clean/mask 仍留 server.js（路由注入用），仅 load 随迁
    expect(serverSrc).toContain("import { saveRoomAdaptersConfig, validateAndCleanConfig as cleanRoomAdaptersConfig, maskedConfig as maskRoomAdaptersConfig } from './src/room/RoomAdaptersConfig.js';");
  });

  it('结构关键字留在模块：内置保留清单/超时覆盖语义/LiteLLM 可选', () => {
    expect(moduleSrc).toContain("if (id === 'claude' || id === 'codex' || id === 'ollama' || id === 'ollama-9b' || id === 'lmstudio' || id === 'lmstudio-code' || id === 'ccr' || id === 'minimax-spawn') continue;");
    expect(moduleSrc).toContain('const tm = (v) => (Number.isFinite(v) && v > 0) ? v : undefined;');
    expect(moduleSrc).toContain('const mt = (v) => (Number.isFinite(v) && v >= 0) ? v : undefined;');
    expect(moduleSrc).toContain('process.env.NOE_LITELLM_URL');
  });
});

describe('server.js 拆分第32批 — 真跑行为冒烟', () => {
  it('detectCCR 返回布尔且不抛', () => {
    expect(typeof detectCCR()).toBe('boolean');
  });

  it('工厂构建内置池：claude/codex/ollama/ollama-9b/lmstudio/minimax-spawn 全在场，claude bin 走注入值', () => {
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => null });
    for (const id of ['claude', 'codex', 'ollama', 'ollama-9b', 'lmstudio', 'minimax-spawn']) {
      expect(f.roomAdapterPool.has(id), `内置 adapter 丢失 ${id}`).toBe(true);
    }
    expect(typeof f.hasCCR).toBe('boolean');
    expect(typeof f.hasGeminiCli).toBe('boolean');
  });

  it('TAKEOVER_ALL 单独开启不得压掉 MiniMax env 兜底', () => withProcessEnv({
    NOE_USE_XAI_BRAIN: '0',
    NOE_XAI_TAKEOVER_ALL: '1',
    MINIMAX_API_KEY: 'test-minimax-key',
    XAI_API_KEY: undefined,
    NOE_XAI_API_KEY: undefined,
  }, () => {
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => null });
    expect(f.roomAdapterPool.get('minimax')?.constructor?.name).toBe('MiniMaxChatAdapter');
    expect(f.roomAdapterPool.get('minimax')?.apiKey).toBe('test-minimax-key');
    expect(f.roomAdapterPool.get('minimax-highspeed')?.constructor?.name).toBe('MiniMaxChatAdapter');
  }));

  it('xAI 真正生效且 TAKEOVER_ALL 时，MiniMax 两槽保持 xAI 不被 env 覆盖', () => withProcessEnv({
    NOE_USE_XAI_BRAIN: '1',
    NOE_XAI_TAKEOVER_ALL: '1',
    MINIMAX_API_KEY: 'test-minimax-key',
    XAI_API_KEY: undefined,
    NOE_XAI_API_KEY: 'test-xai-key',
  }, () => {
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => null });
    expect(f.roomAdapterPool.get('minimax')?.constructor?.name).toBe('XaiChatAdapter');
    expect(f.roomAdapterPool.get('minimax-highspeed')?.constructor?.name).toBe('XaiChatAdapter');
  }));

  it('setRoomAdaptersConfig + rebuild：custom:* 原地注册进同一 Map 引用（dispatcher 持有引用不变）', () => {
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => null });
    const poolRef = f.roomAdapterPool;
    f.setRoomAdaptersConfig({ customs: [{ id: 'b32', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'm' }] });
    f.rebuildRoomAdapters();
    expect(f.roomAdapterPool).toBe(poolRef);
    expect(poolRef.has('custom:b32')).toBe(true);
    // 再清空配置重建：可变 id 被清理，内置仍在
    f.setRoomAdaptersConfig({});
    f.rebuildRoomAdapters();
    expect(poolRef.has('custom:b32')).toBe(false);
    expect(poolRef.has('claude')).toBe(true);
  });

  it('watcher 回退：room-adapters.json 未配 minimax 但 watcher 配了 minimax key → 仍注册（getter 按调用时求值）', () => {
    let watcherConfig = null;
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => watcherConfig });
    f.setRoomAdaptersConfig({});
    f.rebuildRoomAdapters();
    expect(f.roomAdapterPool.has('minimax')).toBe(false);
    watcherConfig = { provider: 'minimax', apiKey: 'wk', model: 'abab', baseUrl: undefined };
    f.rebuildRoomAdapters();
    expect(f.roomAdapterPool.has('minimax')).toBe(true);
  });

  it('getRoomAdaptersConfig/setRoomAdaptersConfig 往返：属主在工厂闭包内', () => {
    const f = createRoomAdapterFactory({ claudeBin: '/tmp/fake-claude-bin', getWatcherConfig: () => null });
    const next = { gemini: { enabled: false } };
    f.setRoomAdaptersConfig(next);
    expect(f.getRoomAdaptersConfig()).toBe(next);
  });
});
