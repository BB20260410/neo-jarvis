// Bulkhead 舱壁隔离单元测试
//
// 覆盖行为：
//   1. 并发上限内立即放行
//   2. 超限时进入排队，释放后队列推进
//   3. 排队超时拒绝（fake timers 保证确定性）
//   4. 队列满时直接抛 BULKHEAD_FULL
//   5. snapshot 准确反映运行/排队状态
//   6. BulkheadRegistry.get 懒创建 + 复用实例
//   7. _release 不让 running < 0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Bulkhead, bulkheads } from '../../../src/safety/Bulkhead.js';

// ─── 测试套件 ───────────────────────────────────────────────────────────────

describe('Bulkhead', () => {
  describe('并发上限内立即放行', () => {
    it('running < maxConcurrent 时 acquire 返回 release 函数', async () => {
      const bh = new Bulkhead('test-immediate', { maxConcurrent: 3 });
      const release = await bh.acquire();
      expect(typeof release).toBe('function');
      expect(bh.running).toBe(1);
    });

    it('连续 acquire maxConcurrent 次全部立即放行，running 等于 maxConcurrent', async () => {
      const bh = new Bulkhead('test-full', { maxConcurrent: 3 });
      const r1 = await bh.acquire();
      const r2 = await bh.acquire();
      const r3 = await bh.acquire();
      expect(bh.running).toBe(3);
      expect(bh.queue.length).toBe(0);
      r1(); r2(); r3();
    });

    it('acquire 返回的 release 调用后 running 递减', async () => {
      const bh = new Bulkhead('test-dec', { maxConcurrent: 2 });
      const r1 = await bh.acquire();
      const r2 = await bh.acquire();
      expect(bh.running).toBe(2);
      r1();
      expect(bh.running).toBe(1);
      r2();
      expect(bh.running).toBe(0);
    });
  });

  describe('超限排队，释放后队列推进', () => {
    it('超过 maxConcurrent 的请求进入排队而非立即 resolve', async () => {
      const bh = new Bulkhead('test-queue', { maxConcurrent: 2, queueTimeoutMs: 10_000 });
      // 占满槽位
      const r1 = await bh.acquire();
      const r2 = await bh.acquire();
      expect(bh.running).toBe(2);

      // 第三个 acquire 应该进入排队（不能 await，否则永远卡在这里）
      let queued3Resolved = false;
      const p3 = bh.acquire().then((rel) => {
        queued3Resolved = true;
        return rel;
      });

      // 给微任务机会跑
      await Promise.resolve();
      expect(queued3Resolved).toBe(false);
      expect(bh.queue.length).toBe(1);

      // 释放一个槽位，队列里的第三个应该被推进
      r1();
      const r3 = await p3;
      expect(queued3Resolved).toBe(true);
      expect(bh.running).toBe(2); // r2 + r3
      expect(bh.queue.length).toBe(0);

      r2(); r3();
    });

    it('多个排队请求按 FIFO 顺序推进', async () => {
      const bh = new Bulkhead('test-fifo', { maxConcurrent: 1, queueTimeoutMs: 10_000 });
      const r1 = await bh.acquire();

      const order = [];
      const p2 = bh.acquire().then((rel) => { order.push(2); return rel; });
      const p3 = bh.acquire().then((rel) => { order.push(3); return rel; });
      const p4 = bh.acquire().then((rel) => { order.push(4); return rel; });

      await Promise.resolve();
      expect(bh.queue.length).toBe(3);

      r1();
      const r2 = await p2;
      r2();
      const r3 = await p3;
      r3();
      const r4 = await p4;
      r4();

      expect(order).toEqual([2, 3, 4]);
    });

    it('释放后若仍有空槽则连续推进队列', async () => {
      const bh = new Bulkhead('test-batch', { maxConcurrent: 2, queueTimeoutMs: 10_000 });
      const r1 = await bh.acquire();
      const r2 = await bh.acquire();

      let q3done = false;
      let q4done = false;
      const p3 = bh.acquire().then((rel) => { q3done = true; return rel; });
      const p4 = bh.acquire().then((rel) => { q4done = true; return rel; });

      await Promise.resolve();
      expect(bh.queue.length).toBe(2);

      // 同时释放两个，队列两个都应被推进
      r1();
      r2();

      const r3 = await p3;
      const r4 = await p4;
      expect(q3done).toBe(true);
      expect(q4done).toBe(true);
      expect(bh.running).toBe(2);
      r3(); r4();
    });
  });

  describe('排队超时拒绝（fake timers）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('排队等待超过 queueTimeoutMs 后抛 BULKHEAD_QUEUE_TIMEOUT', async () => {
      const bh = new Bulkhead('test-timeout', {
        maxConcurrent: 1,
        queueTimeoutMs: 5_000,
      });
      // 占满槽位
      const r1 = await bh.acquire();

      // 第二个进入队列
      const p2 = bh.acquire();

      // 推进微任务：确保 queue 已入队
      await Promise.resolve();
      expect(bh.queue.length).toBe(1);

      // 推进假时钟到超时
      vi.advanceTimersByTime(5_000);

      // 等待 promise 拒绝
      await expect(p2).rejects.toMatchObject({
        code: 'BULKHEAD_QUEUE_TIMEOUT',
      });
      // 超时后应从队列移除
      expect(bh.queue.length).toBe(0);

      r1();
    });

    it('超时后 running 未递增（超时前未获得槽位）', async () => {
      const bh = new Bulkhead('test-timeout-running', {
        maxConcurrent: 1,
        queueTimeoutMs: 3_000,
      });
      const r1 = await bh.acquire();
      expect(bh.running).toBe(1);

      const p2 = bh.acquire().catch(() => {});
      await Promise.resolve();

      vi.advanceTimersByTime(3_000);
      await p2;
      // r1 还没释放，running 仍为 1
      expect(bh.running).toBe(1);
      r1();
    });

    it('超时前释放则不抛错，queue entry 中的 timer 被清除', async () => {
      const bh = new Bulkhead('test-no-timeout', {
        maxConcurrent: 1,
        queueTimeoutMs: 5_000,
      });
      const r1 = await bh.acquire();
      const p2 = bh.acquire();

      await Promise.resolve();
      // 3 秒时释放，还没到 5 秒超时
      vi.advanceTimersByTime(3_000);
      r1();

      // p2 应正常 resolve
      const r2 = await p2;
      expect(typeof r2).toBe('function');
      expect(bh.queue.length).toBe(0);

      // 再推到 5 秒，p2 不应再抛错
      vi.advanceTimersByTime(2_000);
      r2();
    });
  });

  describe('队列满时直接拒绝', () => {
    it('超过 maxQueue 时抛 BULKHEAD_FULL', async () => {
      const bh = new Bulkhead('test-full-queue', {
        maxConcurrent: 1,
        maxQueue: 2,
        queueTimeoutMs: 60_000,
      });
      vi.useFakeTimers();

      const r1 = await bh.acquire();
      // 填满队列
      void bh.acquire().catch(() => {});
      void bh.acquire().catch(() => {});
      await Promise.resolve();
      expect(bh.queue.length).toBe(2);

      // 第三个入队应直接抛 BULKHEAD_FULL
      await expect(bh.acquire()).rejects.toMatchObject({
        code: 'BULKHEAD_FULL',
      });

      vi.useRealTimers();
      r1();
    });

    it('BULKHEAD_FULL 错误 message 包含 key 名', async () => {
      const bh = new Bulkhead('my-adapter', {
        maxConcurrent: 1,
        maxQueue: 0,
        queueTimeoutMs: 60_000,
      });
      const r1 = await bh.acquire();

      await expect(bh.acquire()).rejects.toSatisfy((err) =>
        err.message.includes('my-adapter')
      );
      r1();
    });
  });

  describe('snapshot', () => {
    it('空闲状态 snapshot 字段正确', () => {
      const bh = new Bulkhead('snap-idle', { maxConcurrent: 4, maxQueue: 10 });
      const s = bh.snapshot();
      expect(s).toMatchObject({
        key: 'snap-idle',
        running: 0,
        queued: 0,
        maxConcurrent: 4,
        maxQueue: 10,
      });
    });

    it('运行中 snapshot 反映实时 running/queued', async () => {
      vi.useFakeTimers();
      const bh = new Bulkhead('snap-running', {
        maxConcurrent: 2,
        maxQueue: 5,
        queueTimeoutMs: 30_000,
      });
      const r1 = await bh.acquire();
      const r2 = await bh.acquire();
      const p3 = bh.acquire().catch(() => {});
      await Promise.resolve();

      const s = bh.snapshot();
      expect(s.running).toBe(2);
      expect(s.queued).toBe(1);

      vi.useRealTimers();
      r1(); r2();
      await p3;
    });
  });

  describe('_release 边界', () => {
    it('多次 release 不让 running 低于 0', async () => {
      const bh = new Bulkhead('test-underflow', { maxConcurrent: 2 });
      const r1 = await bh.acquire();
      r1();
      // 再次调用 _release（模拟误用）
      bh._release();
      expect(bh.running).toBe(0);
    });
  });

  describe('构造函数 key 处理', () => {
    it('key 被强制转为字符串', () => {
      const bh = new Bulkhead(42);
      expect(bh.key).toBe('42');
    });

    it('falsy key 回退为 "unknown"', () => {
      const bh = new Bulkhead(null);
      expect(bh.key).toBe('unknown');
      const bh2 = new Bulkhead('');
      expect(bh2.key).toBe('unknown');
    });
  });
});

describe('BulkheadRegistry', () => {
  it('get 同 key 返回同一实例', () => {
    const b1 = bulkheads.get('registry-key-a');
    const b2 = bulkheads.get('registry-key-a');
    expect(b1).toBe(b2);
  });

  it('get 不同 key 返回不同实例', () => {
    const b1 = bulkheads.get('registry-key-x');
    const b2 = bulkheads.get('registry-key-y');
    expect(b1).not.toBe(b2);
  });

  it('all() 返回所有 snapshot 数组，包含 get 过的 key', () => {
    bulkheads.get('registry-all-1');
    bulkheads.get('registry-all-2');
    const snapshots = bulkheads.all();
    expect(Array.isArray(snapshots)).toBe(true);
    const keys = snapshots.map((s) => s.key);
    expect(keys).toContain('registry-all-1');
    expect(keys).toContain('registry-all-2');
  });

  it('all() 每项都有 running/queued/maxConcurrent/maxQueue 字段', () => {
    bulkheads.get('registry-shape');
    const snapshots = bulkheads.all();
    const target = snapshots.find((s) => s.key === 'registry-shape');
    expect(target).toBeDefined();
    expect(typeof target.running).toBe('number');
    expect(typeof target.queued).toBe('number');
    expect(typeof target.maxConcurrent).toBe('number');
    expect(typeof target.maxQueue).toBe('number');
  });
});
