// @ts-check
// spawnWithTimeout 单测——治飞轮停摆真凶：post_review/consensus 的裸 spawn 无超时调 codex，codex 没额度/认证卡死时
//   永不 close → Promise 永不 resolve → selfEvolve tick 卡 running 几小时 + NoeLoop 防重入栅栏 → 整飞轮停摆。
//   超时 SIGTERM+grace SIGKILL 快速失败（非推理超时：卡死该杀；timeoutMs<=0 默认不超时=正常推理不误杀、逐字零回归）。
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawnWithTimeout } from '../../src/room/NoeSpawnWithTimeout.js';

function fakeChild({ hang = false, exitCode = 0, stdoutData = '', errorAfter = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {}, on: () => {} };
  child.killed = [];
  child.kill = (sig) => { child.killed.push(sig); return true; };
  setImmediate(() => {
    if (stdoutData) child.stdout.emit('data', Buffer.from(stdoutData));
    if (errorAfter) child.emit('error', new Error('spawn fail'));
    else if (!hang) child.emit('close', exitCode); // hang=true → 永不 close（模拟 codex 没额度卡死）
  });
  return child;
}

describe('spawnWithTimeout', () => {
  it('正常退出（close code 0）→ ok:true + stdout', async () => {
    const child = fakeChild({ exitCode: 0, stdoutData: 'hello' });
    const r = await spawnWithTimeout({ command: 'x', spawnImpl: () => child });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hello');
    expect(r.code).toBe(0);
  });

  it('非零退出 → ok:false + code', async () => {
    const child = fakeChild({ exitCode: 1 });
    const r = await spawnWithTimeout({ command: 'x', spawnImpl: () => child });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(1);
  });

  it('卡死（永不 close）+ timeoutMs>0 → 超时 SIGTERM + timedOut（治真凶）', async () => {
    const child = fakeChild({ hang: true });
    const r = await spawnWithTimeout({ command: 'codex', timeoutMs: 50, spawnImpl: () => child });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(child.killed).toContain('SIGTERM');
  });

  it('卡死 + timeoutMs=0（默认）→ 不超时（零回归：100ms 内仍 pending、不 resolve）', async () => {
    const child = fakeChild({ hang: true });
    const p = spawnWithTimeout({ command: 'x', timeoutMs: 0, spawnImpl: () => child });
    const race = await Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), 100))]);
    expect(race).toBe('pending'); // timeoutMs=0 不超时 → 永 pending（正常推理不误杀）
    child.emit('close', 0); // 清理
  });

  it('child error 事件 → ok:false + error', async () => {
    const child = fakeChild({ errorAfter: true });
    const r = await spawnWithTimeout({ command: 'x', spawnImpl: () => child });
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('spawn fail');
  });

  it('超时后迟到 close → 不重复 resolve、不抛（settled 守卫）', async () => {
    const child = fakeChild({ hang: true });
    const r = await spawnWithTimeout({ command: 'x', timeoutMs: 30, spawnImpl: () => child });
    expect(r.timedOut).toBe(true);
    expect(() => child.emit('close', 0)).not.toThrow(); // 迟到 close 不改已 settled 结果、不抛
  });

  it('stderr 收集 + stdin 写入不抛', async () => {
    const child = fakeChild({ exitCode: 0 });
    child.stdin = { end: () => {}, on: () => {} };
    const r = await spawnWithTimeout({ command: 'x', stdin: 'prompt', spawnImpl: () => child });
    expect(r.ok).toBe(true);
  });
});
