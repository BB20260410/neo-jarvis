import { describe, expect, it } from 'vitest';
import { createCommitmentStore } from '../../src/runtime/NoeCommitmentStore.js';

// 固定注入时钟，让 createdAt / dueWindow 兜底可预测。
function fixedStore(nowMs) {
  let id = 0;
  return createCommitmentStore({
    now: () => nowMs,
    idGen: () => `cm_${(id += 1)}`,
  });
}

const DAY = 24 * 60 * 60 * 1000;

describe('NoeCommitmentStore.add', () => {
  it('把承诺存为结构化记录并填上默认 status/分类', () => {
    const store = fixedStore(1000);
    const rec = store.add({ text: '  明天提醒我买菜  ' });
    expect(rec.text).toBe('明天提醒我买菜'); // 首尾空白被 clean 掉
    expect(rec.status).toBe('open');
    expect(rec.category).toBe('reminder'); // 默认分类
    expect(rec.sensitivity).toBe('routine'); // 默认敏感度
    expect(rec.createdAt).toBe(1000);
    expect(rec.updatedAt).toBe(1000);
    expect(typeof rec.id).toBe('string');
  });

  it('text 缺失/空白时抛错（空承诺无意义）', () => {
    const store = fixedStore(1000);
    expect(() => store.add({})).toThrow();
    expect(() => store.add({ text: '   ' })).toThrow();
  });

  it('非法 category/sensitivity 走兜底，合法值保留', () => {
    const store = fixedStore(1000);
    const bad = store.add({ text: 'x', category: 'nope', sensitivity: 'weird' });
    expect(bad.category).toBe('reminder');
    expect(bad.sensitivity).toBe('routine');
    const good = store.add({ text: 'y', category: 'open_loop', sensitivity: 'care' });
    expect(good.category).toBe('open_loop');
    expect(good.sensitivity).toBe('care');
  });

  it('缺 dueWindow 时用 createdAt 兜底 earliest，并加默认窗作为 latest', () => {
    const store = fixedStore(5000);
    const rec = store.add({ text: 'z' });
    expect(rec.dueWindow.earliestMs).toBe(5000);
    expect(rec.dueWindow.latestMs).toBe(5000 + DAY);
  });

  it('latest 早于 earliest（倒挂）时用兜底窗修正，永不倒挂', () => {
    const store = fixedStore(0);
    const rec = store.add({ text: 'z', dueWindow: { earliestMs: 10000, latestMs: 1 } });
    expect(rec.dueWindow.earliestMs).toBe(10000);
    expect(rec.dueWindow.latestMs).toBe(10000 + DAY); // latest 被修正回兜底
    expect(rec.dueWindow.latestMs).toBeGreaterThanOrEqual(rec.dueWindow.earliestMs);
  });
});

describe('NoeCommitmentStore.due 时间窗判定', () => {
  it('早于 earliestMs 不触发', () => {
    const store = fixedStore(0);
    store.add({ text: '买菜', dueWindow: { earliestMs: 1000, latestMs: 2000 } });
    expect(store.due(999)).toHaveLength(0); // 还没到最早触发时刻
  });

  it('窗内（earliest..latest 含端点）触发', () => {
    const store = fixedStore(0);
    store.add({ text: '买菜', dueWindow: { earliestMs: 1000, latestMs: 2000 } });
    expect(store.due(1000)).toHaveLength(1); // 等于 earliest
    expect(store.due(1500)).toHaveLength(1); // 窗中间
    expect(store.due(2000)).toHaveLength(1); // 等于 latest
  });

  it('晚于 latestMs 仍触发（兜底，避免错过心跳就永久漏提）', () => {
    const store = fixedStore(0);
    store.add({ text: '买菜', dueWindow: { earliestMs: 1000, latestMs: 2000 } });
    const due = store.due(999999);
    expect(due).toHaveLength(1);
    expect(due[0].text).toBe('买菜');
  });

  it('只返回 open 项：已 resolve/cancel 的不再 due', () => {
    const store = fixedStore(0);
    const a = store.add({ text: 'A', dueWindow: { earliestMs: 0, latestMs: 100 } });
    const b = store.add({ text: 'B', dueWindow: { earliestMs: 0, latestMs: 100 } });
    store.resolve(a.id);
    store.cancel(b.id);
    expect(store.due(50)).toHaveLength(0);
  });

  it('多条按 earliestMs 升序、同窗按 createdAt 升序稳定排序', () => {
    let t = 0;
    const store = createCommitmentStore({ now: () => (t += 10), idGen: () => `cm_${t}` });
    // 三条 earliest 故意乱序加入；createdAt 由注入时钟递增决定
    const late = store.add({ text: 'late', dueWindow: { earliestMs: 300, latestMs: 999999 } });
    const early1 = store.add({ text: 'early1', dueWindow: { earliestMs: 100, latestMs: 999999 } });
    const early2 = store.add({ text: 'early2', dueWindow: { earliestMs: 100, latestMs: 999999 } });
    const order = store.due(100000).map((r) => r.text);
    expect(order).toEqual(['early1', 'early2', 'late']);
    expect(early1.createdAt).toBeLessThan(early2.createdAt);
    expect(late.createdAt).toBeLessThan(early1.createdAt); // late 先加入但 earliest 更晚仍排后
  });

  it('nowMs 缺省时退回注入时钟', () => {
    const store = fixedStore(5000);
    store.add({ text: '到点', dueWindow: { earliestMs: 1000, latestMs: 2000 } });
    expect(store.due()).toHaveLength(1); // now()=5000 晚于 latest → 兜底触发
  });
});

describe('NoeCommitmentStore status 流转', () => {
  it('resolve 把 open → done 并打 resolvedAt 时间戳', () => {
    let t = 100;
    const store = createCommitmentStore({ now: () => t, idGen: () => 'cm_x' });
    const rec = store.add({ text: '做完' });
    t = 500;
    const done = store.resolve(rec.id);
    expect(done.status).toBe('done');
    expect(done.updatedAt).toBe(500);
    expect(done.resolvedAt).toBe(500);
  });

  it('cancel 把 open → cancelled 并打 cancelledAt 时间戳', () => {
    let t = 100;
    const store = createCommitmentStore({ now: () => t, idGen: () => 'cm_x' });
    const rec = store.add({ text: '不做了' });
    t = 700;
    const cancelled = store.cancel(rec.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBe(700);
  });

  it('对已收口记录再次流转是幂等的，不二次改时间戳/不串改状态', () => {
    let t = 100;
    const store = createCommitmentStore({ now: () => t, idGen: () => 'cm_x' });
    const rec = store.add({ text: '一次性' });
    t = 200;
    store.resolve(rec.id);
    t = 999;
    const again = store.resolve(rec.id);
    expect(again.status).toBe('done');
    expect(again.resolvedAt).toBe(200); // 仍是首次收口时间
    const tryCancel = store.cancel(rec.id);
    expect(tryCancel.status).toBe('done'); // 已 done，cancel 不改成 cancelled
  });

  it('resolve/cancel 不存在的 id 返回 null', () => {
    const store = fixedStore(0);
    expect(store.resolve('没有这个')).toBeNull();
    expect(store.cancel('也没有')).toBeNull();
    expect(store.get('不存在')).toBeNull();
  });
});

describe('NoeCommitmentStore.list 过滤与隔离', () => {
  it('按 status 过滤，非法过滤值返回空列表', () => {
    const store = fixedStore(0);
    const a = store.add({ text: 'A' });
    store.add({ text: 'B' });
    store.resolve(a.id);
    expect(store.list()).toHaveLength(2); // 不过滤=全部
    expect(store.list({ status: 'open' })).toHaveLength(1);
    expect(store.list({ status: 'done' })).toHaveLength(1);
    expect(store.list({ status: '乱写' })).toHaveLength(0);
  });

  it('返回的是快照，外部改动不污染内部状态', () => {
    const store = fixedStore(0);
    const rec = store.add({ text: 'A', dueWindow: { earliestMs: 1, latestMs: 2 } });
    rec.status = 'HACKED';
    rec.dueWindow.earliestMs = 999;
    const fresh = store.get(rec.id);
    expect(fresh.status).toBe('open'); // 内部未被外部改动污染
    expect(fresh.dueWindow.earliestMs).toBe(1);
  });

  it('idGen 撞号时不覆盖已有记录，自动追加序号兜底', () => {
    const store = createCommitmentStore({ now: () => 0, idGen: () => 'dup' });
    const a = store.add({ text: 'A' });
    const b = store.add({ text: 'B' });
    expect(a.id).not.toBe(b.id); // 撞号被消歧
    expect(store.size()).toBe(2); // 两条都在，没被覆盖
  });

  it('reset 清空所有记录', () => {
    const store = fixedStore(0);
    store.add({ text: 'A' });
    store.add({ text: 'B' });
    expect(store.size()).toBe(2);
    store.reset();
    expect(store.size()).toBe(0);
    expect(store.list()).toHaveLength(0);
  });
});
