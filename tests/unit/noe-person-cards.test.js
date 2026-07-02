import { describe, expect, it } from 'vitest';
import {
  canonicalPersonId,
  createPersonCardStore,
  normalizePersonKey,
} from '../../src/memory/NoePersonCards.js';

// 注入式时钟 / id 生成，保证测试确定性。
function makeStore(startMs = 1_000) {
  let clock = startMs;
  let seq = 0;
  const store = createPersonCardStore({
    now: () => clock,
    idGen: () => `id_${++seq}`,
  });
  return {
    store,
    advance: (ms) => {
      clock += ms;
    },
    setClock: (ms) => {
      clock = ms;
    },
  };
}

describe('NoePersonCards', () => {
  it('upsert 新建卡，用注入 idGen 生成 id 并归一别名', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['小明', 'Xiao Ming', '小明'], relationship: '同事' });
    expect(card.id).toBe('id_1');
    // 重复别名应去重
    expect(card.aliases).toEqual(['小明', 'Xiao Ming']);
    expect(card.relationship).toBe('同事');
    expect(store.size()).toBe(1);
  });

  it('getByAlias 命中任一别名（含大小写不敏感映射）', () => {
    const { store } = makeStore();
    const created = store.upsert({ aliases: ['Alice', '爱丽丝'] });
    expect(store.getByAlias('alice').id).toBe(created.id); // 大小写不敏感
    expect(store.getByAlias('爱丽丝').id).toBe(created.id);
  });

  it('未知别名返回 null', () => {
    const { store } = makeStore();
    store.upsert({ aliases: ['Bob'] });
    expect(store.getByAlias('查无此人')).toBeNull();
    expect(store.getByAlias('')).toBeNull();
    expect(store.getByAlias(null)).toBeNull();
  });

  it('upsert 按别名匹配已有卡并累加别名，而非重复建卡', () => {
    const { store } = makeStore();
    const first = store.upsert({ aliases: ['老王'], relationship: '邻居' });
    const again = store.upsert({ aliases: ['老王', 'Wang'], relationship: '老邻居' });
    expect(again.id).toBe(first.id); // 同一张卡
    expect(again.aliases).toEqual(['老王', 'Wang']);
    expect(again.relationship).toBe('老邻居'); // relationship 被覆盖更新
    expect(store.size()).toBe(1);
    // 新别名也能查到同一张卡
    expect(store.getByAlias('Wang').id).toBe(first.id);
  });

  it('recordEvent 追加事件，保持顺序；未知 id 返回 null', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['丽丽'] });
    store.recordEvent(card.id, '第一次见面');
    const updated = store.recordEvent(card.id, { summary: '一起吃饭' });
    expect(updated.keyEvents).toEqual(['第一次见面', { summary: '一起吃饭' }]);
    expect(store.recordEvent('不存在的id', '事件')).toBeNull();
  });

  it('setPreference 读写偏好；getByAlias 取回时偏好可见', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['Cathy'] });
    store.setPreference(card.id, '咖啡', '美式');
    store.setPreference(card.id, '语言', '中文');
    const fetched = store.getByAlias('cathy');
    expect(fetched.preferences).toEqual({ 咖啡: '美式', 语言: '中文' });
    expect(store.setPreference('不存在', 'k', 'v')).toBeNull();
  });

  it('touch 用 nowMs 或注入 now() 更新 lastSeenAt', () => {
    const { store, setClock } = makeStore(5_000);
    const card = store.upsert({ aliases: ['Dan'] });
    expect(card.lastSeenAt).toBeNull();
    // 显式传 nowMs
    expect(store.touch(card.id, 8_888).lastSeenAt).toBe(8_888);
    // 不传则用注入 now()
    setClock(9_999);
    expect(store.touch(card.id).lastSeenAt).toBe(9_999);
    expect(store.touch('missing')).toBeNull();
  });

  it('toContextHint 含名字、关系与偏好', () => {
    const { store } = makeStore();
    const card = store.upsert({
      aliases: ['小红', 'Hong'],
      relationship: '好朋友',
      preferences: { 爱好: '画画' },
    });
    const hint = store.toContextHint(card);
    expect(hint).toContain('你正在和小红对话');
    expect(hint).toContain('又称Hong');
    expect(hint).toContain('关系：好朋友');
    expect(hint).toContain('偏好：爱好=画画');
  });

  it('toContextHint 渲染最近关键事件（取最后 3 条）且空卡返回空串', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['Eve'] });
    store.recordEvent(card.id, 'e1');
    store.recordEvent(card.id, 'e2');
    store.recordEvent(card.id, 'e3');
    const updated = store.recordEvent(card.id, { summary: 'e4' });
    const hint = store.toContextHint(updated);
    expect(hint).toContain('最近关键事件：e2；e3；e4'); // 只保留最后 3 条
    expect(hint).not.toContain('e1');
    // 空 / 无效输入
    expect(store.toContextHint(null)).toBe('');
    expect(store.toContextHint({ aliases: [] })).toBe('');
  });

  it('快照是深拷贝：改返回值不污染内部状态', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['Frank'], preferences: { a: 1 } });
    card.aliases.push('注入的别名');
    card.preferences.a = 999;
    const fresh = store.getById(card.id);
    expect(fresh.aliases).toEqual(['Frank']);
    expect(fresh.preferences).toEqual({ a: 1 });
  });

  it('remove / reset 清理卡与别名索引', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['Grace', '格蕾丝'] });
    expect(store.remove(card.id)).toBe(true);
    expect(store.getByAlias('grace')).toBeNull(); // 别名索引同步清掉
    expect(store.remove(card.id)).toBe(false);
    store.upsert({ aliases: ['Henry'] });
    store.reset();
    expect(store.size()).toBe(0);
    expect(store.getByAlias('henry')).toBeNull();
  });

  it('normalizePersonKey 归一中英文/大小写/标点', () => {
    expect(normalizePersonKey('  Hello World!! ')).toBe('helloworld');
    expect(normalizePersonKey('小-明_123')).toBe('小明123');
    expect(normalizePersonKey('')).toBe('');
    expect(normalizePersonKey(null)).toBe('');
  });

  it('快照是真·深拷贝:改嵌套对象不污染内部(防假深拷贝回归)', () => {
    const { store } = makeStore();
    const card = store.upsert({ aliases: ['Ivy'], keyEvents: [{ summary: '初识', meta: { tag: 'x' } }], preferences: { food: { spicy: false } } });
    const snap = store.getById(card.id);
    snap.keyEvents[0].meta.tag = 'TAMPERED';
    snap.preferences.food.spicy = true;
    const fresh = store.getById(card.id);
    expect(fresh.keyEvents[0].meta.tag).toBe('x');
    expect(fresh.preferences.food.spicy).toBe(false);
  });

  it('别名/事件/偏好超长被截断(防撑爆 prompt)', () => {
    const { store } = makeStore();
    const huge = 'a'.repeat(100000);
    const card = store.upsert({ aliases: [huge], keyEvents: [huge], preferences: { note: huge } });
    const snap = store.getById(card.id);
    expect(snap.aliases[0].length).toBeLessThanOrEqual(120);
    expect(snap.keyEvents[0].length).toBeLessThanOrEqual(2000);
    expect(snap.preferences.note.length).toBeLessThanOrEqual(2000);
  });

  it('keyEvents 数量有上限,只保留最近 N 条', () => {
    const { store } = makeStore();
    let card = store.upsert({ aliases: ['Jack'] });
    for (let i = 0; i < 80; i += 1) card = store.recordEvent(card.id, `e${i}`);
    expect(card.keyEvents.length).toBeLessThanOrEqual(50);
    expect(card.keyEvents.at(-1)).toBe('e79');
  });
});

describe('canonicalPersonId', () => {
  it('确定性：同一名字永远映射到同一 id', () => {
    expect(canonicalPersonId('王总')).toBe(canonicalPersonId('王总'));
    expect(canonicalPersonId('Alice')).toBe(canonicalPersonId('Alice'));
  });

  it('归一等价：大小写/标点/空白差异归一后得同一 id', () => {
    expect(canonicalPersonId(' 小-明 ')).toBe(canonicalPersonId('小明'));
    expect(canonicalPersonId('Hello World!!')).toBe(canonicalPersonId('helloworld'));
  });

  it('不同名字得不同 id', () => {
    expect(canonicalPersonId('张三')).not.toBe(canonicalPersonId('李四'));
    // 字面不同的别名（靠别名映射聚合，而非 canonicalId）
    expect(canonicalPersonId('王总')).not.toBe(canonicalPersonId('老王'));
  });

  it('格式为 person_<16位hex>，支持自定义 prefix / length', () => {
    expect(canonicalPersonId('Bob')).toMatch(/^person_[0-9a-f]{16}$/);
    expect(canonicalPersonId('Bob', { prefix: 'p' })).toMatch(/^p_[0-9a-f]{16}$/);
    expect(canonicalPersonId('Bob', { length: 8 })).toMatch(/^person_[0-9a-f]{8}$/);
  });

  it('空 / 无有效内容返回空串', () => {
    expect(canonicalPersonId('')).toBe('');
    expect(canonicalPersonId('   ')).toBe('');
    expect(canonicalPersonId('!!!')).toBe('');
    expect(canonicalPersonId(null)).toBe('');
  });

  it('用作 upsert 稳定主键：跨 store 实例同名命中同一 id', () => {
    const id = canonicalPersonId('王总');
    const s1 = createPersonCardStore({ idGen: () => 'random_1' });
    const s2 = createPersonCardStore({ idGen: () => 'random_2' });
    const c1 = s1.upsert({ id, aliases: ['王总'], relationship: '客户' });
    const c2 = s2.upsert({ id, aliases: ['王总'] });
    expect(c1.id).toBe(id);
    expect(c2.id).toBe(id); // 两个独立实例对同名实体用同一稳定主键
  });

  it('length 超过 SHA1 hex 长度(40)时 clamp 到 40，不静默误导', () => {
    const id = canonicalPersonId('Bob', { length: 64 });
    expect(id).toMatch(/^person_[0-9a-f]{40}$/); // 实际 40 位 hex，而非 64
    expect(canonicalPersonId('Bob', { length: 40 })).toBe(id);
  });

  it('非法 prefix（空 / 含特殊字符）回落默认 person', () => {
    const base = canonicalPersonId('Bob');
    expect(canonicalPersonId('Bob', { prefix: '' })).toBe(base);
    expect(canonicalPersonId('Bob', { prefix: '  ' })).toBe(base);
    expect(canonicalPersonId('Bob', { prefix: 'bad prefix!' })).toBe(base);
    expect(canonicalPersonId('Bob', { prefix: 'agent-x' })).toMatch(/^agent-x_/); // 合法 prefix 仍生效
  });
});
