import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import {
  applyConsolidationPlan,
  loadConsolidationCandidates,
  createMemoryDreamLoop,
} from '../../src/memory/NoeDreamConsolidation.js';
import { parseMerges, createM3ConsolidateHook, createConsolidateHook, parseModelSpec } from '../../src/memory/NoeDreamM3Hook.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-dream-'));
  initSqlite(path.join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('梦境整合 端到端(真 MemoryCore)', () => {
  it('确定性整合:重复合并(软删可恢复) + 身份级=5 不动', async () => {
    const mem = new MemoryCore();
    mem.write({ id: 'd1', projectId: 'neo', body: '主人喜欢美式咖啡', salience: 3 });
    mem.write({ id: 'd2', projectId: 'neo', body: '主人喜欢美式咖啡', salience: 4 }); // 与 d1 精确重复
    mem.write({ id: 'idz', projectId: 'neo', body: '我是主人专属伴侣', salience: 5 }); // 身份级受保护

    const loop = createMemoryDreamLoop(mem, { projectId: 'neo' }); // 默认 OFF
    expect(loop.isEnabled()).toBe(false);
    const r = await loop.tick(); // 手动触发,无需开后台
    expect(r.ok).toBe(true);

    expect(mem.get('d1')).toBeNull();          // d1 被并入 → 软删
    expect(mem.get('d2')?.id).toBe('d2');       // d2 保留(salience 高者胜)
    expect(mem.get('idz')?.salience).toBe(5);   // 身份级未被动

    expect(mem.unhide('d1')).toBe(true);        // 一键复活
    expect(mem.get('d1')?.id).toBe('d1');
  });

  it('applyConsolidationPlan 计数 + loadConsolidationCandidates 形状', () => {
    const mem = new MemoryCore();
    mem.write({ id: 'a', projectId: 'neo', body: 'x', salience: 3 });
    const cands = loadConsolidationCandidates(mem, { projectId: 'neo' });
    expect(cands.find((c) => c.id === 'a')).toMatchObject({ id: 'a', salience: 3 });
    const out = applyConsolidationPlan(mem, { downgrades: [{ id: 'a', toSalience: 1 }] }, { projectId: 'neo' });
    expect(out.downgraded).toBe(1);
    expect(mem.get('a')?.salience).toBe(1);
  });

  it('确定性整合不会把不同 scope 的同文记忆合并', async () => {
    const mem = new MemoryCore();
    mem.write({ id: 'fact-same', projectId: 'neo', scope: 'fact', body: '同一段文字', salience: 3 });
    mem.write({ id: 'voice-same', projectId: 'neo', scope: 'voice', body: '同一段文字', salience: 3 });

    const loop = createMemoryDreamLoop(mem, { projectId: 'neo' });
    const r = await loop.tick();

    expect(r.ok).toBe(true);
    expect(mem.get('fact-same')?.id).toBe('fact-same');
    expect(mem.get('voice-same')?.id).toBe('voice-same');
  });

  it('防御纵深:即便 plan 被污染,落地层也绝不动身份级(salience=5)', () => {
    const mem = new MemoryCore();
    mem.write({ id: 'idz', projectId: 'neo', body: '身份级', salience: 5 });
    mem.write({ id: 'normal', projectId: 'neo', body: '普通', salience: 3 });
    // 故意污染:试图降级 + 合并掉身份级
    const out = applyConsolidationPlan(mem, {
      downgrades: [{ id: 'idz', toSalience: 1 }],
      merges: [{ keepId: 'normal', dropIds: ['idz'] }],
    }, { projectId: 'neo' });
    expect(mem.get('idz')?.salience).toBe(5);  // 未被降级
    expect(mem.get('idz')?.id).toBe('idz');     // 未被合并软删
    expect(out.skippedProtected).toBe(2);       // 降级+合并各拦一次
  });
});

describe('NoeDreamM3Hook(语义去重大脑)', () => {
  it('parseMerges 稳健解析 + 过滤越界 id', () => {
    const valid = new Set(['a', 'b', 'c']);
    expect(parseMerges('前言 [{"keepId":"a","dropIds":["b"],"reason":"dup"}] 后语', valid))
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'dup' }]);
    expect(parseMerges('<think>推理不进入 parser</think>[bad array]\n```json\n[{"keepId":"a","dropIds":["b"],"reason":"dup"}]\n```', valid))
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'dup' }]);
    expect(parseMerges('[{"keepId":"a","dropIds":["zzz"]}]', valid)).toEqual([]); // 越界 drop 过滤后空
    expect(parseMerges('not json', valid)).toEqual([]);
    expect(parseMerges('[]', valid)).toEqual([]);
  });

  it('注入 chat(不烧 M3):<2 条返回 [],带 quote 自证的合并正常解析', async () => {
    const hook = createM3ConsolidateHook({ chat: async () => '[{"keepId":"a","keepQuote":"我喜欢爬山","dropIds":["b"],"dropQuotes":["我爱好登山"],"reason":"语义重复"}]' });
    expect(await hook([{ id: 'a', content: 'x' }])).toEqual([]); // 单条不合并
    expect(await hook([{ id: 'a', content: '我喜欢爬山远足' }, { id: 'b', content: '我爱好登山徒步' }]))
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: '语义重复' }]);
  });

  it('quote 自证拦 id 错位(2026-06-11 实损回归):摘抄对不上 id 原文 → 整组拒/单条剔', async () => {
    // 模型 reason/quote 在说"爬山组",keepId 却抄错成无关记忆 c 的 id —— 实损场景还原
    const wrongKeep = createM3ConsolidateHook({ chat: async () => '[{"keepId":"c","keepQuote":"我喜欢爬山","dropIds":["b"],"dropQuotes":["我爱好登山"],"reason":"都在说爬山"}]' });
    expect(await wrongKeep([
      { id: 'a', content: '我喜欢爬山远足' }, { id: 'b', content: '我爱好登山徒步' }, { id: 'c', content: '正在调试AI应用Noe' },
    ])).toEqual([]);
    // drop 错位:两个 drop 一对一错 → 只剔错的那条
    const wrongDrop = createM3ConsolidateHook({ chat: async () => '[{"keepId":"a","keepQuote":"我喜欢爬山","dropIds":["b","c"],"dropQuotes":["我爱好登山","我爱好登山"],"reason":"dup"}]' });
    expect(await wrongDrop([
      { id: 'a', content: '我喜欢爬山远足' }, { id: 'b', content: '我爱好登山徒步' }, { id: 'c', content: '正在调试AI应用Noe' },
    ])).toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'dup' }]);
    // 不带 quote 的回复(旧格式/模型偷懒) → 自证失败一律拒
    const noQuote = createM3ConsolidateHook({ chat: async () => '[{"keepId":"a","dropIds":["b"],"reason":"dup"}]' });
    expect(await noQuote([{ id: 'a', content: '我喜欢爬山远足' }, { id: 'b', content: '我爱好登山徒步' }])).toEqual([]);
  });

  it('parseMerges 不传 contentById 保持旧行为;quote 归一化容忍空白标点差异', () => {
    const valid = new Set(['a', 'b']);
    expect(parseMerges('[{"keepId":"a","dropIds":["b"]}]', valid)) // 第三参缺省 → 不要求 quote
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'llm_semantic_duplicate' }]);
    const contentById = new Map([['a', '面对思维的「原地打转」，引入外部熵增'], ['b', '别把 自己绕进死循环！']]);
    expect(parseMerges('[{"keepId":"a","keepQuote":"面对思维的原地打转","dropIds":["b"],"dropQuotes":["别把自己绕进死循环"],"reason":"dup"}]', valid, contentById))
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'dup' }]);
  });

  it('chat 抛错 → 安全返回 []', async () => {
    const hook = createM3ConsolidateHook({ chat: async () => { throw new Error('M3 down'); } });
    expect(await hook([{ id: 'a', content: 'x' }, { id: 'b', content: 'y' }])).toEqual([]);
  });

  it('parseModelSpec:支持 provider:model(model 可含冒号),none/空 → null', () => {
    expect(parseModelSpec('ollama:qwen3.5:2b')).toEqual({ provider: 'ollama', model: 'qwen3.5:2b' });
    expect(parseModelSpec('minimax:MiniMax-M3')).toEqual({ provider: 'minimax', model: 'MiniMax-M3' });
    expect(parseModelSpec('ollama')).toEqual({ provider: 'ollama', model: '' });
    expect(parseModelSpec('none')).toBeNull();
    expect(parseModelSpec('')).toBeNull();
    expect(parseModelSpec(undefined)).toBeNull();
  });

  it('createConsolidateHook:可选模型,注入 chat 时按统一逻辑解析(本地/M3/MiMo 同接口)', async () => {
    const hook = createConsolidateHook({ provider: 'ollama', chat: async () => '[{"keepId":"a","keepQuote":"周末去爬山","dropIds":["b"],"dropQuotes":["假日去登山"]}]' });
    expect(await hook([{ id: 'a', content: '周末去爬山看日出' }, { id: 'b', content: '假日去登山锻炼' }]))
      .toEqual([{ keepId: 'a', dropIds: ['b'], reason: 'llm_semantic_duplicate' }]);
  });
});
