import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { listLoadedLmStudioModels, ensureLmStudioModel } from '../../src/room/LmStudioLoader.js';

const fakeFetch = (body, ok = true) => async () => ({ ok, json: async () => body });
function fakeSpawn(exitCode, { failBins = [] } = {}) {
  const calls = [];
  const impl = (bin, args) => {
    calls.push({ bin, args });
    const ee = new EventEmitter();
    queueMicrotask(() => { if (failBins.includes(bin)) ee.emit('error', new Error('ENOENT')); else ee.emit('exit', exitCode); });
    return ee;
  };
  impl.calls = calls;
  return impl;
}

describe('LmStudioLoader', () => {
  it('listLoadedLmStudioModels 只挑 state=loaded', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'A', state: 'loaded' }, { id: 'B', state: 'not-loaded' }] });
    expect(await listLoadedLmStudioModels('http://127.0.0.1:1234/v1', { fetchImpl })).toEqual(['A']);
  });

  it('REST 不可用 → 返回 null(交给 lms load 兜底)', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    expect(await listLoadedLmStudioModels('http://127.0.0.1:1234/v1', { fetchImpl })).toBeNull();
  });

  it('已加载 → already，不触发 lms load', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'gemma-x', state: 'loaded' }] });
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('gemma-x', { fetchImpl, spawnImpl });
    expect(r).toMatchObject({ ok: true, already: true });
    expect(spawnImpl.calls.length).toBe(0);
  });

  it('未加载 → lms load <model> -y，成功返回 loaded，并带上显式加载参数', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'other', state: 'loaded' }] });
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('gemma-load-me', { fetchImpl, spawnImpl, ttlSeconds: 600, contextLength: 32768, parallel: 3 });
    expect(r).toMatchObject({ ok: true, loaded: true });
    expect(spawnImpl.calls[0]).toMatchObject({ bin: 'lms', args: ['load', 'gemma-load-me', '-y', '--context-length', '32768', '--parallel', '3', '--ttl', '600'] });
  });

  it('当前 LM Studio 主脑固定加载 Qwen 35B A3B 6bit 并暴露稳定聊天 id', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const spawnImpl = fakeSpawn(0);
    await ensureLmStudioModel('qwen/qwen3.6-35b-a3b', { fetchImpl, spawnImpl });
    expect(spawnImpl.calls[0].args).toEqual([
      'load',
      'qwen/qwen3.6-35b-a3b@6bit',
      '-y',
      '--context-length',
      '262144',
      '--parallel',
      '1',
      '--identifier',
      'qwen/qwen3.6-35b-a3b',
    ]);
  });

  it('旧 Q35 mlx/8bit 请求会归一为当前 Q35-6 主脑加载参数', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const spawnImpl = fakeSpawn(0);
    await ensureLmStudioModel('qwen3.6-35b-a3b-mlx@8bit', { fetchImpl, spawnImpl });
    expect(spawnImpl.calls[0].args).toEqual([
      'load',
      'qwen/qwen3.6-35b-a3b@6bit',
      '-y',
      '--context-length',
      '262144',
      '--parallel',
      '1',
      '--identifier',
      'qwen/qwen3.6-35b-a3b',
    ]);
  });

  it('只加载旧 Q35-8 实验模型时不视为当前主脑 ready', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'qwen3.6-35b-a3b-mlx@8bit', state: 'loaded' }] });
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('qwen/qwen3.6-35b-a3b', { fetchImpl, spawnImpl });
    expect(r).toMatchObject({ ok: true, loaded: true });
    expect(spawnImpl.calls[0].args[1]).toBe('qwen/qwen3.6-35b-a3b@6bit');
  });

  it('Review Brain 按需加载 Q27 4bit 并带 TTL', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const spawnImpl = fakeSpawn(0);
    await ensureLmStudioModel('qwen/qwen3.6-27b', { fetchImpl, spawnImpl });
    expect(spawnImpl.calls[0].args).toEqual([
      'load',
      'qwen/qwen3.6-27b@4bit',
      '-y',
      '--context-length',
      '262144',
      '--parallel',
      '1',
      '--ttl',
      '600',
      '--identifier',
      'qwen/qwen3.6-27b',
    ]);
  });

  it('Gemma 显式模型仍带适配加载参数', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const spawnImpl = fakeSpawn(0);
    await ensureLmStudioModel('gemma-4-26b-a4b-it-qat-mlx', { fetchImpl, spawnImpl });
    expect(spawnImpl.calls[0].args).toEqual([
      'load',
      'gemma-4-26b-a4b-it-qat-mlx',
      '-y',
      '--context-length',
      '262144',
      '--parallel',
      '4',
      '--identifier',
      'gemma-4-26b-a4b-it-qat-mlx',
    ]);
  });

  it('Qwen 主脑基础 id 已加载时不会重复 load 6bit key', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'qwen/qwen3.6-35b-a3b', state: 'loaded' }] });
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('qwen/qwen3.6-35b-a3b@6bit', { fetchImpl, spawnImpl });
    expect(r).toMatchObject({ ok: true, already: true });
    expect(spawnImpl.calls).toEqual([]);
  });

  it('角色 load key 已加载时也视为 already，避免重复加载同一脑', async () => {
    const fetchImpl = fakeFetch({ data: [{ id: 'qwen/qwen3.6-27b@4bit', state: 'loaded' }] });
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('qwen/qwen3.6-27b', { fetchImpl, spawnImpl });
    expect(r).toMatchObject({ ok: true, already: true });
    expect(spawnImpl.calls).toEqual([]);
  });

  it('Fallback Brain 首个 Gemma key 失败时尝试备用 load key', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const calls = [];
    const spawnImpl = (bin, args) => {
      calls.push({ bin, args });
      const ee = new EventEmitter();
      queueMicrotask(() => ee.emit('exit', args[1] === 'google/gemma-4-26b-a4b-qat' ? 0 : 1));
      return ee;
    };
    const r = await ensureLmStudioModel('gemma-4-26b-a4b-it-qat-mlx', { fetchImpl, spawnImpl });
    expect(r.ok).toBe(true);
    expect(calls.map((call) => call.args[1])).toContain('gemma-4-26b-a4b-it-qat-mlx');
    expect(calls.map((call) => call.args[1])).toContain('google/gemma-4-26b-a4b-qat');
  });

  it('REST 查不到状态也照样尝试加载', async () => {
    const fetchImpl = async () => { throw new Error('down'); };
    const spawnImpl = fakeSpawn(0);
    const r = await ensureLmStudioModel('gemma-blind', { fetchImpl, spawnImpl });
    expect(r.ok).toBe(true);
    expect(spawnImpl.calls[0].args).toEqual(['load', 'gemma-blind', '-y']);
  });

  it('lms 两个路径都失败 → ok:false(让上层 fallback)', async () => {
    const fetchImpl = fakeFetch({ data: [] });
    const spawnImpl = fakeSpawn(1, { failBins: ['lms'] }); // PATH lms 报 error，退到 ~/.lmstudio 又 exit 1
    const r = await ensureLmStudioModel('gemma-nope', { fetchImpl, spawnImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lms load gemma-nope/);
  });

  it('空 model → no-op', async () => {
    expect(await ensureLmStudioModel('', {})).toMatchObject({ ok: true, already: true });
  });
});
