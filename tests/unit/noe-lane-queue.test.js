import { describe, expect, it } from 'vitest';
import { NoeLaneQueue } from '../../src/runtime/NoeLaneQueue.js';

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('NoeLaneQueue', () => {
  it('serializes jobs that share a lane without artificial timeouts', async () => {
    const queue = new NoeLaneQueue();
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue({
      id: 'first',
      lanes: ['workspace:noe'],
      run: async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
        return { ok: true };
      },
    });
    const second = queue.enqueue({
      id: 'second',
      lanes: ['workspace:noe'],
      run: async () => {
        order.push('second:start');
        return { ok: true };
      },
    });

    await tick();
    expect(queue.snapshot().jobs.map((job) => [job.id, job.status])).toEqual([
      ['first', 'running'],
      ['second', 'queued'],
    ]);
    releaseFirst();
    await Promise.all([first.promise, second.promise]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs jobs on disjoint lanes concurrently', async () => {
    const queue = new NoeLaneQueue();
    const seen = [];
    const a = queue.enqueue({ id: 'a', lanes: ['model:a'], run: async () => { seen.push('a'); return { ok: true }; } });
    const b = queue.enqueue({ id: 'b', lanes: ['model:b'], run: async () => { seen.push('b'); return { ok: true }; } });

    await Promise.all([a.promise, b.promise]);
    expect(new Set(seen)).toEqual(new Set(['a', 'b']));
  });

  it('lets user-priority jobs cooperatively preempt running background work on the same lane', async () => {
    const queue = new NoeLaneQueue();
    const order = [];
    let releaseBackground;
    const gate = new Promise((resolve) => { releaseBackground = resolve; });
    const background = queue.enqueue({
      id: 'background',
      lanes: ['workspace:noe'],
      priority: 'background',
      run: async ({ isCancelRequested }) => {
        order.push('background:start');
        await gate;
        order.push(isCancelRequested() ? 'background:cancelled' : 'background:end');
        return { ok: !isCancelRequested() };
      },
    });
    await tick();
    const user = queue.enqueue({
      id: 'user',
      lanes: ['workspace:noe'],
      priority: 'user',
      run: async () => {
        order.push('user:start');
        return { ok: true };
      },
    });

    expect(queue.snapshot().jobs.find((job) => job.id === 'background')).toMatchObject({ status: 'running', cancelRequested: true });
    releaseBackground();
    const results = await Promise.all([background.promise, user.promise]);

    expect(results.map((item) => [item.id, item.status])).toEqual([
      ['background', 'cancelled'],
      ['user', 'succeeded'],
    ]);
    expect(order).toEqual(['background:start', 'background:cancelled', 'user:start']);
  });

  it('cancels queued lower-priority jobs when a user job preempts the lane', async () => {
    const queue = new NoeLaneQueue();
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const running = queue.enqueue({ id: 'running', lanes: ['model'], priority: 'normal', run: async () => { await gate; return { ok: true }; } });
    const queued = queue.enqueue({ id: 'queued-bg', lanes: ['model'], priority: 'background', run: async () => ({ ok: true }) });
    await tick();
    const user = queue.enqueue({ id: 'user', lanes: ['model'], priority: 'user', run: async () => ({ ok: true }) });
    const queuedResult = await queued.promise;

    expect(queuedResult).toMatchObject({ id: 'queued-bg', status: 'cancelled', cancelled: true });
    releaseFirst();
    await Promise.all([running.promise, user.promise]);
  });

  it('does not preempt equal-priority user jobs', async () => {
    const queue = new NoeLaneQueue();
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = queue.enqueue({ id: 'user-a', lanes: ['session'], priority: 'user', run: async () => { await gate; return { ok: true }; } });
    await tick();
    const second = queue.enqueue({ id: 'user-b', lanes: ['session'], priority: 'user', run: async () => ({ ok: true }) });

    expect(queue.snapshot().jobs.find((job) => job.id === 'user-a').cancelRequested).toBe(false);
    releaseFirst();
    await Promise.all([first.promise, second.promise]);
  });
});
