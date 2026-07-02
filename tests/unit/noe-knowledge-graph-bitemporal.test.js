// @ts-check
// P5 记忆双时态（event-time + ingestion-time，对标 Graphiti bitemporal）测试。
// 覆盖：双时态字段/supersede 关旧窗/asOf/迁移向后兼容/两轴不设反/反向 probe。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, close, getDb } from '../../src/storage/SqliteStore.js';
import { NoeKnowledgeGraph, NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION } from '../../src/memory/NoeKnowledgeGraph.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-kg-bt-'));
  initSqlite(path.join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 造三个实体并返回其 id（owner / 三座城市）。 */
function seedOwnerAndCities(graph) {
  const owner = graph.upsertEntity({ name: 'owner', type: 'other' });
  const chengdu = graph.upsertEntity({ name: '成都', type: 'other' });
  const shanghai = graph.upsertEntity({ name: '上海', type: 'other' });
  const beijing = graph.upsertEntity({ name: '北京', type: 'other' });
  return { owner, chengdu, shanghai, beijing };
}

describe('NoeKnowledgeGraph 双时态 — 字段与 schema', () => {
  it('schema version 升到 2，noe_kg_relation 有 event_start_at/event_end_at/ingested_at 三列', () => {
    new NoeKnowledgeGraph();
    expect(NOE_KNOWLEDGE_GRAPH_SCHEMA_VERSION).toBe(2);
    const db = getDb();
    const cols = new Set(db.prepare('PRAGMA table_info(noe_kg_relation)').all().map((r) => r.name));
    expect(cols.has('event_start_at')).toBe(true);
    expect(cols.has('event_end_at')).toBe(true);
    expect(cols.has('ingested_at')).toBe(true);
    const ver = db.prepare("SELECT v FROM kv WHERE k = 'noe_knowledge_graph_schema'").get();
    expect(Number(ver.v)).toBe(2);
  });

  it('新插边默认开窗：event_end_at IS NULL、event_start_at 与 ingested_at 已落值', () => {
    const graph = new NoeKnowledgeGraph();
    const { owner, chengdu } = seedOwnerAndCities(graph);
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    const row = getDb().prepare('SELECT * FROM noe_kg_relation WHERE rel_type = ?').get('lives_in');
    expect(row.event_end_at).toBeNull();
    expect(Number.isFinite(row.event_start_at)).toBe(true);
    expect(Number.isFinite(row.ingested_at)).toBe(true);
  });
});

describe('NoeKnowledgeGraph 双时态 — supersede 关旧窗（单值关系）', () => {
  it('owner lives_in 成都→上海→北京：旧边关窗+新边 NULL+旧边不物理删，asOf 三态正确', () => {
    let clockVal = 1_000_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai, beijing } = seedOwnerAndCities(graph);

    const tA = 1_000_000; clockVal = tA;
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    const tB = 2_000_000; clockVal = tB;
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' });
    const tC = 3_000_000; clockVal = tC;
    graph.upsertRelation({ srcId: owner, dstId: beijing, relType: 'lives_in' });

    const db = getDb();
    // 三条边都还在（旧边不物理删）。
    const all = db.prepare('SELECT dst, event_start_at, event_end_at FROM noe_kg_relation WHERE rel_type = ? ORDER BY event_start_at').all('lives_in');
    expect(all.length).toBe(3);
    // 只有最新（北京）开窗，前两条已关窗。
    const open = all.filter((r) => r.event_end_at === null);
    expect(open.length).toBe(1);
    expect(open[0].dst).toBe(beijing);
    // 关窗时刻 = 下一条事实开始时刻（成都在 tB 关、上海在 tC 关）。
    const chengduRow = all.find((r) => r.dst === chengdu);
    const shanghaiRow = all.find((r) => r.dst === shanghai);
    expect(chengduRow.event_end_at).toBe(tB);
    expect(shanghaiRow.event_end_at).toBe(tC);

    // asOf 三态：中间 t（tB 与 tC 之间）→ 上海；当前（默认 oneHop / asOf now）→ 北京；全历史 → 3 条。
    const mid = graph.asOf({ t: 2_500_000, srcId: owner, relType: 'lives_in' });
    expect(mid.count).toBe(1);
    expect(mid.edges[0].dst).toBe(shanghai);

    const nowView = graph.asOf({ t: 3_500_000, srcId: owner, relType: 'lives_in' });
    expect(nowView.count).toBe(1);
    expect(nowView.edges[0].dst).toBe(beijing);

    // 默认（当前有效）oneHop 只出北京邻居，不出成都/上海。
    const hopNow = graph.oneHop({ id: owner });
    const liveCities = hopNow.edges.filter((e) => e.rel_type === 'lives_in').map((e) => e.name);
    expect(liveCities).toEqual(['北京']);

    // 全历史 oneHop 出 3 座城市。
    const hopHist = graph.oneHop({ id: owner, includeHistory: true });
    const histCities = hopHist.edges.filter((e) => e.rel_type === 'lives_in').map((e) => e.name).sort();
    expect(histCities).toEqual(['上海', '北京', '成都']);
  });

  it('同三元组多窗口：成都→上海→成都 again 能再开窗（不被旧 UNIQUE 卡住、不覆盖历史窗）', () => {
    let clockVal = 100;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 100; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    clockVal = 200; graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' });
    clockVal = 300; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' }); // 又搬回成都
    const cdRows = getDb().prepare('SELECT event_start_at, event_end_at FROM noe_kg_relation WHERE rel_type = ? AND dst = ? ORDER BY event_start_at').all('lives_in', chengdu);
    expect(cdRows.length).toBe(2); // 成都出现两个窗口（历史窗 + 当前窗），未被覆盖
    expect(cdRows[0].event_end_at).toBe(200); // 第一段成都已关窗
    expect(cdRows[1].event_end_at).toBeNull(); // 回成都后当前开窗
    // asOf 三段：t=150→成都(一段)、t=250→上海、t=350→成都(二段)
    expect(graph.asOf({ t: 150, srcId: owner }).edges[0].dst).toBe(chengdu);
    expect(graph.asOf({ t: 250, srcId: owner }).edges[0].dst).toBe(shanghai);
    expect(graph.asOf({ t: 350, srcId: owner }).edges[0].dst).toBe(chengdu);
  });

  it('重申同一仍为真的事实（同 dst）并入开窗，不新开窗、不关自己', () => {
    let clockVal = 1_000_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu } = seedOwnerAndCities(graph);
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', description: '第一次' });
    clockVal = 2_000_000;
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', description: '再次确认' });
    const rows = getDb().prepare('SELECT * FROM noe_kg_relation WHERE rel_type = ?').all('lives_in');
    expect(rows.length).toBe(1); // 没新开窗
    expect(rows[0].event_end_at).toBeNull(); // 仍开窗
    expect(rows[0].description).toBe('再次确认'); // 描述并入更新
  });
});

describe('NoeKnowledgeGraph 双时态 — asOf 实现', () => {
  it('asOf 半开区间 [start,end)：关窗时刻 t=end 命中新窗而非旧窗（边界不双命中）', () => {
    let clockVal = 100;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 100;
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    clockVal = 200; // 成都在 t=200 关窗，上海在 t=200 开窗
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' });
    const atBoundary = graph.asOf({ t: 200, srcId: owner, relType: 'lives_in' });
    expect(atBoundary.count).toBe(1);
    expect(atBoundary.edges[0].dst).toBe(shanghai); // 边界归新窗
  });
});

describe('NoeKnowledgeGraph 双时态 — 反向 probe', () => {
  it('probe①多值关系（mentions）dst 变不关旧窗，多条并存全开窗', () => {
    const graph = new NoeKnowledgeGraph();
    const file = graph.upsertEntity({ name: 'a.md', type: 'file' });
    const t1 = graph.upsertEntity({ name: 'alpha', type: 'term' });
    const t2 = graph.upsertEntity({ name: 'beta', type: 'term' });
    graph.upsertRelation({ srcId: file, dstId: t1, relType: 'mentions' });
    graph.upsertRelation({ srcId: file, dstId: t2, relType: 'mentions' });
    const rows = getDb().prepare('SELECT dst, event_end_at FROM noe_kg_relation WHERE rel_type = ?').all('mentions');
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.event_end_at === null)).toBe(true); // 都还开着，没互相关窗
  });

  it('probe③ asOf 很早的 t 返回空、不崩；asOf 非法 t 返回空', () => {
    const graph = new NoeKnowledgeGraph();
    const { owner, chengdu } = seedOwnerAndCities(graph);
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', eventStartAt: 5_000_000 });
    const early = graph.asOf({ t: 1, srcId: owner, relType: 'lives_in' });
    expect(early.count).toBe(0);
    expect(early.edges).toEqual([]);
    expect(() => graph.asOf({ t: NaN })).not.toThrow();
    expect(graph.asOf({ t: NaN }).count).toBe(0);
  });

  it('probe④两轴不设反：昨天记录(ingested)、声称上周生效(event_start) → asOf(上周)命中、asOf(两周前)不命中', () => {
    const DAY = 86_400_000;
    const nowTs = 10_000_000_000;
    const yesterday = nowTs - DAY;
    const lastWeek = nowTs - 7 * DAY;
    const twoWeeksAgo = nowTs - 14 * DAY;

    const graph = new NoeKnowledgeGraph();
    const { owner, chengdu } = seedOwnerAndCities(graph);
    // event-time = 上周开始为真；ingestion-time = 昨天才记录下来。
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', eventStartAt: lastWeek, ingestedAt: yesterday });

    const row = getDb().prepare('SELECT event_start_at, ingested_at FROM noe_kg_relation WHERE rel_type = ?').get('lives_in');
    expect(row.event_start_at).toBe(lastWeek);
    expect(row.ingested_at).toBe(yesterday);

    // event-time 控有效性：asOf(上周) 命中（事实那时已为真），asOf(两周前) 不命中（事实那时还没为真）。
    expect(graph.asOf({ t: lastWeek, srcId: owner }).count).toBe(1);
    expect(graph.asOf({ t: twoWeeksAgo, srcId: owner }).count).toBe(0);
    // 关键反证：若两轴设反（用 ingested_at 当有效性），asOf(上周=ingest 之前) 会错误返回 0。
    // 这里 asOf(上周)=1 证明 asOf 走的是 event-time 而非 ingestion-time。
    // 再证 asOf(昨天和上周之间) 也命中（事实持续有效，与 ingest 时刻无关）。
    expect(graph.asOf({ t: nowTs - 3 * DAY, srcId: owner }).count).toBe(1);
  });
});

describe('NoeKnowledgeGraph 双时态 — P5 两路审 findings 回归', () => {
  // BLOCKER：同毫秒/同 eventStartAt 单值往返 ≥5 次。修复前：closeStaleWindows 已关旧窗 + 新窗 id 撞历史窗
  // PRIMARY KEY 抛错（退避只 +1 一次） + 非事务 → 该 rel_type 当下无任何开窗（丢真事实）。
  it('BLOCKER 同毫秒往返 ≥5 次不崩，且任何时刻开窗数始终=1（不丢有效事实）', () => {
    const clockVal = 1_000; // 冻结：所有写入同一毫秒
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    const db = getDb();
    const seq = [chengdu, shanghai, chengdu, shanghai, chengdu, shanghai, chengdu]; // 7 次往返（>5）
    for (const dst of seq) {
      expect(() => graph.upsertRelation({ srcId: owner, dstId: dst, relType: 'lives_in' })).not.toThrow();
      // 每一步后：单值 lives_in 必须恰好 1 个开窗（不丢有效事实、不并存双开窗）。
      const open = db.prepare("SELECT dst FROM noe_kg_relation WHERE rel_type = 'lives_in' AND src = ? AND event_end_at IS NULL").all(owner);
      expect(open.length).toBe(1);
    }
    // 最后一次落在成都 → 当前开窗 = 成都。
    const finalOpen = db.prepare("SELECT dst FROM noe_kg_relation WHERE rel_type = 'lives_in' AND src = ? AND event_end_at IS NULL").get(owner);
    expect(finalOpen.dst).toBe(chengdu);
    // 关掉的旧窗全是正长区间（无零/负长死窗）：event_end_at > event_start_at。
    const closed = db.prepare("SELECT event_start_at, event_end_at FROM noe_kg_relation WHERE rel_type = 'lives_in' AND src = ? AND event_end_at IS NOT NULL").all(owner);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((r) => r.event_end_at > r.event_start_at)).toBe(true);
  });

  // BLOCKER 原子性：模拟新窗 INSERT 失败（DB 抛错）→ 事务回滚，旧开窗不被半截关掉（仍有 1 个有效值）。
  it('BLOCKER 原子性：新窗 INSERT 抛错时事务回滚，旧开窗不丢（仍 1 个有效值）', () => {
    let clockVal = 1_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 1_000; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    const db = getDb();
    // 注入故障：让下一条 INSERT noe_kg_relation 抛错（建一个 BEFORE INSERT 触发器强制 RAISE）。
    db.exec("CREATE TRIGGER kg_fail_insert BEFORE INSERT ON noe_kg_relation BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    let threw = false;
    try {
      clockVal = 2_000; graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' });
    } catch { threw = true; }
    db.exec('DROP TRIGGER kg_fail_insert');
    expect(threw).toBe(true);
    // 关键：事务回滚 → 成都仍是唯一开窗（没有「关了成都又没插上海」的半截破坏）。
    const open = db.prepare("SELECT dst FROM noe_kg_relation WHERE rel_type = 'lives_in' AND src = ? AND event_end_at IS NULL").all(owner);
    expect(open.length).toBe(1);
    expect(open[0].dst).toBe(chengdu);
  });

  // MAJOR1：oneHop 当前视图必须查起点（event_start_at <= now），未来生效边不入当前视图。
  it('MAJOR1 oneHop 当前视图不返回未来生效边（event_start > now）', () => {
    let clockVal = 1_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 1_000; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' }); // 当前有效
    // 一条「未来才生效」的多值边：event_start=5000 > now=1000，event_end=NULL。
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'related_to', eventStartAt: 5_000 });
    const hop = graph.oneHop({ id: owner }); // now 仍 = 1000
    const names = hop.edges.map((e) => e.name);
    expect(names).toContain('成都'); // 当前有效边在
    expect(names).not.toContain('上海'); // 未来生效边不在当前视图
    // 时钟推进到 5000 后，未来边变成当前有效。
    clockVal = 5_000;
    const hopLater = graph.oneHop({ id: owner });
    expect(hopLater.edges.map((e) => e.name)).toContain('上海');
    // includeHistory 任何时刻都能看到（不受起点过滤）。
    clockVal = 1_000;
    const hist = graph.oneHop({ id: owner, includeHistory: true });
    expect(hist.edges.map((e) => e.name)).toContain('上海');
  });

  // MAJOR2：relType 大小写混用（lives_in vs Lives_In）必须归一化后仍正确关旧窗。
  it('MAJOR2 大小写混用 lives_in/Lives_In 仍正确关旧窗（只 1 个开窗）', () => {
    let clockVal = 1_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 1_000; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    clockVal = 2_000; graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'Lives_In' }); // 大小写不同
    const db = getDb();
    // 写库 rel_type 统一小写。
    const types = db.prepare('SELECT DISTINCT rel_type FROM noe_kg_relation WHERE src = ?').all(owner).map((r) => r.rel_type);
    expect(types).toContain('lives_in');
    expect(types).not.toContain('Lives_In');
    // 只 1 个开窗（成都被上海关掉，没有两个大小写各开一窗）。
    const open = db.prepare("SELECT dst FROM noe_kg_relation WHERE rel_type = 'lives_in' AND src = ? AND event_end_at IS NULL").all(owner);
    expect(open.length).toBe(1);
    expect(open[0].dst).toBe(shanghai);
    // asOf 用大小写不同的 relType 查询也能命中（查询侧也归一化）。
    const at = graph.asOf({ t: 2_500, srcId: owner, relType: 'LIVES_IN' });
    expect(at.count).toBe(1);
    expect(at.edges[0].dst).toBe(shanghai);
  });

  // MAJOR3：补录策略。同序补录（显式 eventStart >= 旧窗 start）应用；乱序补录返回 needs_review，不静默写脏。
  it('MAJOR3 同序补录显式 eventStartAt 关窗时刻按事实生效点（不双命中）', () => {
    let clockVal = 10_000; // 物理 now 远晚于补录的 event-time
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    // 补录：成都从 1000 起为真、上海从 2000 起为真（都早于物理 now=10000，但时间顺序正确）。
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', eventStartAt: 1_000 });
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in', eventStartAt: 2_000 });
    // 关窗时刻 = 上海 eventStart=2000（而非物理 now=10000）→ asOf(3000) 只命中上海，不双命中成都。
    const at = graph.asOf({ t: 3_000, srcId: owner, relType: 'lives_in' });
    expect(at.count).toBe(1);
    expect(at.edges[0].dst).toBe(shanghai);
    // 成都 [1000,2000)：asOf(1500) 命中成都。
    expect(graph.asOf({ t: 1_500, srcId: owner }).edges[0].dst).toBe(chengdu);
    // 成都关窗时刻 = 2000（不是 10000）。
    const cd = getDb().prepare("SELECT event_end_at FROM noe_kg_relation WHERE rel_type='lives_in' AND dst = ?").get(chengdu);
    expect(cd.event_end_at).toBe(2_000);
  });

  it('MAJOR3 乱序补录（新 eventStart 早于既有开窗 start，dst 不同）返回 needs_review，不写脏', () => {
    let clockVal = 10_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in', eventStartAt: 5_000 }); // 既有开窗 start=5000
    // 乱序补录：声称成都从 1000（早于 5000）起为真 = 要在历史中间插窗的区间手术 → 拒绝。
    const res = graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in', eventStartAt: 1_000 });
    expect(res && res.ok).toBe(false);
    expect(res.reason).toBe('needs_review');
    expect(res.conflict.existingDst).toBe(shanghai);
    expect(res.conflict.attemptedDst).toBe(chengdu);
    // 没写脏：仍只有上海 1 条边、仍开窗。
    const rows = getDb().prepare("SELECT dst, event_end_at FROM noe_kg_relation WHERE rel_type='lives_in' AND src = ?").all(owner);
    expect(rows.length).toBe(1);
    expect(rows[0].dst).toBe(shanghai);
    expect(rows[0].event_end_at).toBeNull();
  });

  // MINOR1：零/负长死窗——同毫秒 supersede 不得产生 [t,t) 或 start>end 的死窗。
  it('MINOR1 同毫秒 supersede 关旧窗为正长区间，无零/负长死窗', () => {
    const clockVal = 1_000; // 冻结同毫秒
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' }); // 同毫秒切换
    const cd = getDb().prepare("SELECT event_start_at, event_end_at FROM noe_kg_relation WHERE rel_type='lives_in' AND dst = ?").get(chengdu);
    expect(cd.event_end_at).not.toBeNull();
    expect(cd.event_end_at).toBeGreaterThan(cd.event_start_at); // 正长，非 [1000,1000)
  });

  // MINOR2：白名单收窄——owner_of 等已移出单值，多 dst 并存不互相关窗。
  it('MINOR2 owner_of（已移出单值白名单）多 dst 并存，不互相关窗', () => {
    let clockVal = 1_000;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal });
    const owner = graph.upsertEntity({ name: 'owner', type: 'other' });
    const objA = graph.upsertEntity({ name: 'objA', type: 'other' });
    const objB = graph.upsertEntity({ name: 'objB', type: 'other' });
    clockVal = 1_000; graph.upsertRelation({ srcId: owner, dstId: objA, relType: 'owner_of' });
    clockVal = 2_000; graph.upsertRelation({ srcId: owner, dstId: objB, relType: 'owner_of' });
    const open = getDb().prepare("SELECT dst FROM noe_kg_relation WHERE rel_type='owner_of' AND src = ? AND event_end_at IS NULL").all(owner);
    expect(open.length).toBe(2); // 两个对象并存，没被错当单值关窗
  });
});

describe('NoeKnowledgeGraph 双时态 — 迁移向后兼容（probe②）', () => {
  it('v1 旧 schema 数据迁移后：补三列+回填+老 oneHop 用例仍通过', () => {
    // 用裸 better-sqlite3 造一个「v1 风格」的 noe_kg_relation（无双时态列、带旧 UNIQUE、schema=1）。
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS noe_kg_relation');
    db.exec(`
      CREATE TABLE noe_kg_relation (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'noe',
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        rel_type TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        refs TEXT NOT NULL DEFAULT '[]',
        strength INTEGER NOT NULL DEFAULT 5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_id, src, dst, rel_type)
      );
    `);
    // 实体也得有（oneHop join entity）。
    const graph0 = new NoeKnowledgeGraph(); // 触发实体表建表（relation 表已是 v1 风格，会被补列）
    const fileId = graph0.upsertEntity({ name: 'legacy.md', type: 'file' });
    const termId = graph0.upsertEntity({ name: 'legacyterm', type: 'term' });
    // 直插一条「老边」（无双时态列，模拟旧库已有数据），并把 schema 版本退回 1。
    const oldTs = 7_777_000;
    // 重新插旧边前要确认列还在（graph0 构造已补列，这里显式写老风格：不带双时态列，让回填生效）。
    db.prepare('UPDATE kv SET v = ? WHERE k = ?').run('1', 'noe_knowledge_graph_schema');
    db.exec('DROP TABLE IF EXISTS noe_kg_relation');
    db.exec(`
      CREATE TABLE noe_kg_relation (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'noe', src TEXT NOT NULL, dst TEXT NOT NULL,
        rel_type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '[]',
        strength INTEGER NOT NULL DEFAULT 5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(project_id, src, dst, rel_type)
      );
    `);
    db.prepare(`
      INSERT INTO noe_kg_relation(id, project_id, src, dst, rel_type, description, refs, strength, created_at, updated_at)
      VALUES(?, 'noe', ?, ?, 'mentions', 'legacy edge', '[]', 5, ?, ?)
    `).run('legacyid01', fileId, termId, oldTs, oldTs);

    // 新建图实例 → 触发迁移（补三列 + 回填 + 版本升到 2）。
    const graph = new NoeKnowledgeGraph();
    const ver = db.prepare("SELECT v FROM kv WHERE k = 'noe_knowledge_graph_schema'").get();
    expect(Number(ver.v)).toBe(2);

    // 回填正确：老边 event_start_at=created_at、ingested_at=created_at、event_end_at=NULL（当前有效）。
    const migrated = db.prepare('SELECT * FROM noe_kg_relation WHERE id = ?').get('legacyid01');
    expect(migrated.event_start_at).toBe(oldTs);
    expect(migrated.ingested_at).toBe(oldTs);
    expect(migrated.event_end_at).toBeNull();

    // 老用例：oneHop 默认（当前有效）仍能查到这条迁移来的老边（证明回填后默认视图不丢老数据）。
    const hop = graph.oneHop({ id: fileId });
    expect(hop.found).toBe(true);
    expect(hop.edges.some((e) => e.name === 'legacyterm' && e.rel_type === 'mentions')).toBe(true);

    // 老边也能被 asOf 命中（event_start_at 回填后参与有效性）。
    expect(graph.asOf({ t: oldTs + 1, srcId: fileId }).count).toBe(1);
  });

  it('v1 迁移**整表重建移除 UNIQUE**：迁移后单值回旧值重开窗(成都→上海→成都)不撞旧 UNIQUE 约束', () => {
    // 主线实证 probe 坐实的 blocker：SQLite ALTER 无法 DROP 约束，若迁移只补列不重建，
    //   live v1 表的 UNIQUE(project_id,src,dst,rel_type) 仍在 → 回旧值重开窗撞 "UNIQUE constraint failed"。
    // 子代理原 v1 迁移测试只测 mentions(多值不 supersede)漏了此组合。本用例锁死：v1 迁移后 UNIQUE 必被移除。
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS noe_kg_relation');
    db.exec(`
      CREATE TABLE noe_kg_relation (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'noe', src TEXT NOT NULL, dst TEXT NOT NULL,
        rel_type TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '[]',
        strength INTEGER NOT NULL DEFAULT 5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(project_id, src, dst, rel_type)
      );
    `);
    db.prepare('UPDATE kv SET v = ? WHERE k = ?').run('1', 'noe_knowledge_graph_schema');

    let clockVal = 100;
    const graph = new NoeKnowledgeGraph({ clock: () => clockVal }); // 触发 v1→v2 整表重建
    // 重建后 UNIQUE 必被移除。
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='noe_kg_relation'").get();
    expect(/UNIQUE\s*\(/i.test(String(ddl.sql))).toBe(false);

    const { owner, chengdu, shanghai } = seedOwnerAndCities(graph);
    clockVal = 100; graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' });
    clockVal = 200; graph.upsertRelation({ srcId: owner, dstId: shanghai, relType: 'lives_in' });
    // 关键：v1 迁移库上回旧值(成都again)重开窗——修复前撞 UNIQUE，修复后不撞。
    clockVal = 300;
    expect(() => graph.upsertRelation({ srcId: owner, dstId: chengdu, relType: 'lives_in' })).not.toThrow();
    const cdRows = db.prepare('SELECT event_end_at FROM noe_kg_relation WHERE rel_type = ? AND dst = ? ORDER BY event_start_at').all('lives_in', chengdu);
    expect(cdRows.length).toBe(2); // 成都两个窗口(历史关窗 + 当前开窗)，未被旧 UNIQUE 卡住
    expect(cdRows[0].event_end_at).toBe(200);
    expect(cdRows[1].event_end_at).toBeNull();
  });

  it('二次构造图实例幂等：不重复 ALTER、不报 NOE_KG_SCHEMA_MISMATCH', () => {
    expect(() => {
      new NoeKnowledgeGraph();
      new NoeKnowledgeGraph();
    }).not.toThrow();
  });
});

describe('NoeKnowledgeGraph 双时态 — ingestFileIndex 集成不回归', () => {
  it('ingestFileIndex 后边都带双时态列且开窗', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-kg-bt-files-'));
    fs.writeFileSync(path.join(root, 'X.md'), '# X\nAlphaTerm BetaTerm appear here.\n');
    // 复用 FileIndex（与既有 noe-knowledge-graph.test.js 同路径）。
    return import('../../src/memory/FileIndex.js').then(({ FileIndex }) => {
      const fileIndex = new FileIndex({ allowedRoots: [root] });
      fileIndex.indexPath({ root, projectId: 'noe' });
      const graph = new NoeKnowledgeGraph();
      const res = graph.ingestFileIndex({ fileIndex, projectId: 'noe' });
      expect(res.ok).toBe(true);
      const rows = getDb().prepare('SELECT event_start_at, ingested_at, event_end_at FROM noe_kg_relation').all();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => Number.isFinite(r.event_start_at) && Number.isFinite(r.ingested_at))).toBe(true);
      expect(rows.every((r) => r.event_end_at === null)).toBe(true);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});
