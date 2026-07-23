import { describe, expect, it } from 'vitest';
import { createPrefetchStore } from '../../src/prefetch/NoePrefetchStore.js';

describe('NoePrefetchStore', () => {
  it('set/get 在 TTL 窗口内可命中', () => {
    const store = createPrefetchStore();
    store.set('weather:Beijing', '晴 22°C', 60_000, 1000);
    // 距抓取 30s，未过期
    expect(store.get('weather:Beijing', 31_000)).toBe('晴 22°C');
  });

  it('TTL 过期后 get 返回 null', () => {
    const store = createPrefetchStore();
    store.set('news', 'HN 热榜', 30_000, 0);
    // 边界：恰好到 ttl（now == fetchedAt + ttl）即视为过期
    expect(store.get('news', 30_000)).toBeNull();
    // 远超 ttl 也是 null
    expect(store.get('news', 99_999)).toBeNull();
  });

  it('TTL 边界：到期前一刻仍新鲜，到期刻即过期', () => {
    const store = createPrefetchStore();
    store.set('k', 'v', 1000, 5000); // 过期点 = 6000
    expect(store.get('k', 5999)).toBe('v');
    expect(store.get('k', 6000)).toBeNull();
  });

  it('freshItems 只返回未过期项', () => {
    const store = createPrefetchStore();
    store.set('a', 'AA', 10_000, 0);   // 过期点 10000
    store.set('b', 'BB', 100_000, 0);  // 过期点 100000
    const fresh = store.freshItems(20_000); // a 已过期，b 仍新鲜
    const keys = fresh.map((i) => i.key);
    expect(keys).toEqual(['b']);
    expect(fresh[0].value).toBe('BB');
    expect(fresh[0].expiresAt).toBe(100_000);
  });

  it('toContextBlock 含新鲜项、不含过期项，且被 <prefetched-items> 包裹', () => {
    const store = createPrefetchStore();
    store.set('weather:Beijing', '晴 22°C', 60_000, 0);  // 过期点 60000
    store.set('news:hn', 'Rust 1.0 发布', 10_000, 0);     // 过期点 10000
    const block = store.toContextBlock(30_000); // news 已过期，weather 新鲜
    expect(block).toContain('<prefetched-items>');
    expect(block).toContain('</prefetched-items>');
    expect(block).toContain('[weather:Beijing]');
    expect(block).toContain('晴 22°C');
    // 过期的 news 不应出现
    expect(block).not.toContain('news:hn');
    expect(block).not.toContain('Rust 1.0 发布');
  });

  it('toContextBlock 空池返回空串', () => {
    const store = createPrefetchStore();
    expect(store.toContextBlock(123)).toBe('');
  });

  it('toContextBlock 全部过期时返回空串', () => {
    const store = createPrefetchStore();
    store.set('a', 'AA', 1000, 0);
    store.set('b', 'BB', 1000, 0);
    expect(store.toContextBlock(9999)).toBe('');
  });

  it('toContextBlock 对对象值序列化为 JSON', () => {
    const store = createPrefetchStore();
    store.set('cfg', { temp: 22, city: 'BJ' }, 10_000, 0);
    const block = store.toContextBlock(1000);
    expect(block).toContain('"temp":22');
    expect(block).toContain('"city":"BJ"');
  });

  it('prune 物理删除过期项并返回条数', () => {
    const store = createPrefetchStore();
    store.set('a', 'AA', 1000, 0);    // 过期点 1000
    store.set('b', 'BB', 100_000, 0); // 过期点 100000
    expect(store.size()).toBe(2);
    const removed = store.prune(5000); // a 过期
    expect(removed).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.has('b', 5000)).toBe(true);
    expect(store.has('a', 5000)).toBe(false);
  });

  it('ttlMs<=0 视为永不过期', () => {
    const store = createPrefetchStore();
    store.set('forever', '常驻数据', 0, 0);
    expect(store.get('forever', 10 ** 15)).toBe('常驻数据');
    expect(store.prune(10 ** 15)).toBe(0);
    const fresh = store.freshItems(10 ** 15);
    expect(fresh[0].expiresAt).toBeNull();
  });

  it('set 覆盖同 key 并刷新新鲜度', () => {
    const store = createPrefetchStore();
    store.set('w', '旧值', 1000, 0);   // 过期点 1000
    store.set('w', '新值', 1000, 5000); // 覆盖，过期点 6000
    expect(store.get('w', 5500)).toBe('新值');
  });

  it('空 key 被忽略，set 返回 false', () => {
    const store = createPrefetchStore();
    expect(store.set('', 'x', 1000, 0)).toBe(false);
    expect(store.set('   ', 'x', 1000, 0)).toBe(false);
    expect(store.set(null, 'x', 1000, 0)).toBe(false);
    expect(store.size()).toBe(0);
    expect(store.get('', 0)).toBeNull();
  });

  it('get 命中过期项时惰性删除', () => {
    const store = createPrefetchStore();
    store.set('a', 'AA', 1000, 0);
    expect(store.size()).toBe(1);
    expect(store.get('a', 5000)).toBeNull(); // 触发惰性删除
    expect(store.size()).toBe(0);
  });

  it('未给 ttlMs 时用 defaultTtlMs', () => {
    const store = createPrefetchStore({ defaultTtlMs: 2000 });
    store.set('a', 'AA', undefined, 0); // 用默认 2000，过期点 2000
    expect(store.get('a', 1999)).toBe('AA');
    expect(store.get('a', 2000)).toBeNull();
  });

  it('maxEntries 上限：超限淘汰最旧（Codex 审发现7，防开放 key 无界增长）', () => {
    const store = createPrefetchStore({ maxEntries: 3 });
    store.set('a', 'A', 0, 0); store.set('b', 'B', 0, 0); store.set('c', 'C', 0, 0);
    expect(store.size()).toBe(3);
    store.set('d', 'D', 0, 0); // 超限淘汰最旧 a（ttl=0 永不过期，删的是被淘汰非过期）
    expect(store.size()).toBe(3);
    expect(store.get('a', 1)).toBeNull();
    expect(store.get('d', 1)).toBe('D');
  });

  it('maxEntries 下 set 同 key 是 touch 到尾、不增长', () => {
    const store = createPrefetchStore({ maxEntries: 2 });
    store.set('a', 'A', 0, 0); store.set('b', 'B', 0, 0);
    store.set('a', 'A2', 0, 0); // touch a 到尾 + 覆盖值，size 不变
    expect(store.size()).toBe(2);
    store.set('c', 'C', 0, 0); // 此时最旧是 b（a 刚 touch），淘汰 b
    expect(store.get('b', 1)).toBeNull();
    expect(store.get('a', 1)).toBe('A2');
    expect(store.get('c', 1)).toBe('C');
  });

  it('默认无 maxEntries：不限条数（向后兼容天气/新闻预取，零回归）', () => {
    const store = createPrefetchStore();
    for (let i = 0; i < 50; i++) store.set(`k${i}`, i, 0, 0);
    expect(store.size()).toBe(50);
  });

  it('maxEntries LRU：get 命中刷新 recency，热 key 不被新写淘汰（Finding 3 真 LRU）', () => {
    const store = createPrefetchStore({ maxEntries: 2 });
    store.set('a', 'A', 0, 0); store.set('b', 'B', 0, 0);
    expect(store.get('a', 1)).toBe('A'); // 命中 a → a 刷到尾
    store.set('c', 'C', 0, 0);           // 淘汰最旧——此时最旧是 b（a 刚被 get 刷新）
    expect(store.get('b', 1)).toBeNull(); // b 被淘汰
    expect(store.get('a', 1)).toBe('A');  // a 因命中刷新而存活
    expect(store.get('c', 1)).toBe('C');
  });

  it('maxEntries=0：get 不 touch（天气/新闻顺序不变，零回归）', () => {
    const store = createPrefetchStore(); // maxEntries=0
    store.set('a', 'A', 0, 0); store.set('b', 'B', 0, 0);
    store.get('a', 1); // maxEntries=0 → 不 touch
    expect(store.freshItems(1).map((i) => i.key)).toEqual(['a', 'b']); // 插入序不变
  });
});
