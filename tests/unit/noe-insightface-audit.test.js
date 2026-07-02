// InsightFaceClient 审计修复测试（审计 §3.4 P0-2/3）
// P0-2 stdout/stderr 输出上限防 OOM、P0-3 SIGTERM 后 2s 补 SIGKILL 防 fd 泄漏
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock }));

const { InsightFaceClient } = await import('../../src/identity/InsightFaceClient.js');

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

const EXISTING = process.execPath; // node 二进制必存在 → status().ok 为 true（只看 existsSync(python) && existsSync(script)）

beforeEach(() => { spawnMock.mockReset(); });

describe('InsightFaceClient 审计 §3.4 P0-2/3', () => {
  it('正常 close 返回 embedding', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const client = new InsightFaceClient({ python: EXISTING, script: EXISTING });
    const p = client.embedImage('aGVsbG8=');
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, embedding: [1, 2, 3] })));
    child.emit('close', 0);
    await expect(p).resolves.toMatchObject({ ok: true, embedding: [1, 2, 3] });
  });

  it('P0-2 stdout 超 2MB 触发 kill + reject', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const client = new InsightFaceClient({ python: EXISTING, script: EXISTING });
    const p = client.embedImage('aGVsbG8=');
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 10, 120)); // >2MB
    await expect(p).rejects.toThrow(/too large/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('P0-3 timeout 后 SIGTERM，进程不退则 2s 补 SIGKILL', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const client = new InsightFaceClient({ python: EXISTING, script: EXISTING, timeoutMs: 100 });
    const p = client.embedImage('aGVsbG8=');
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(100); // 触发 timeout → SIGTERM
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2000); // 进程仍卡住 → 补 SIGKILL
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(p).rejects.toThrow(/timeout/);
    vi.useRealTimers();
  });

  it('P0-3 timeout 后进程及时退出则不补 SIGKILL（撤销兜底）', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const client = new InsightFaceClient({ python: EXISTING, script: EXISTING, timeoutMs: 100 });
    const p = client.embedImage('aGVsbG8=');
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(100); // SIGTERM
    child.emit('close', null);              // 进程退出
    await vi.advanceTimersByTimeAsync(2000);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL'); // close 已撤销 SIGKILL 定时器
    await expect(p).rejects.toThrow(/timeout/);
    vi.useRealTimers();
  });
});
