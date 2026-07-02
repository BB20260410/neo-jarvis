// NoeEpisodeSublimation（内在世界·支柱②：梦境升华 久远情景→语义记忆）单测。
// 纪律：全 fake 注入（timeline/memoryCore/chat），绝不连真库；水位线持久化用 os.tmpdir 临时目录。
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicTimeline } from '../../src/memory/EpisodicTimeline.js';
import { close as closeSqlite, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import {
  createEpisodeSublimationLoop, createSublimateHook,
  groupEpisodesByWeek, buildDeterministicDigest, weekBucketOf, weekLabelOf, DEFAULT_AGED_DAYS,
} from '../../src/memory/NoeEpisodeSublimation.js';

const DAY = 86400000;
const T0 = 1_780_000_000_000;
// 三段久远情景：两段同一周、一段更早一周（都远在 90 天阈值之外）。
const OLD_A_TS = T0 - 120 * DAY;
const OLD_B_TS = OLD_A_TS + 2 * DAY;   // 与 A 不保证同周（2 天差可能跨桶），测试里按 bucket 分桶断言
const OLD_C_TS = T0 - 140 * DAY;
const FRESH_TS = T0 - 10 * DAY;        // 90 天内：不该被升华

function ep(ts, summary, extra = {}) {
  return { id: ts, ts, type: 'interaction', summary, detail: '', selfState: null, salience: 3, ...extra };
}

// fake EpisodicTimeline：忠实模拟 aged 的 sinceTs/untilTs/minSalience/types 语义 + record 记录。
function makeFakeTimeline(episodes = []) {
  const calls = { aged: [], record: [] };
  return {
    calls,
    aged(opts = {}) {
      calls.aged.push(opts);
      const wanted = Array.isArray(opts.types) && opts.types.length ? new Set(opts.types) : null;
      return episodes
        .filter((e) => (opts.sinceTs == null || e.ts >= opts.sinceTs)
          && (opts.untilTs == null || e.ts <= opts.untilTs)
          && e.salience >= (opts.minSalience ?? 0)
          && (!wanted || wanted.has(e.type)))
        .sort((a, b) => a.ts - b.ts)
        .slice(0, opts.limit ?? 200);
    },
    record(e) { calls.record.push(e); return calls.record.length; },
  };
}

// fake MemoryCore：记录 write，全程监视 merge/downgrade/setSalience 绝不被碰（protectedScopes 防线）。
function makeFakeMemoryCore() {
  const writes = []; const forbidden = [];
  return {
    writes, forbidden,
    write(input) { writes.push(input); return { id: `mem-${writes.length}` }; },
    merge(...a) { forbidden.push(['merge', a]); },
    downgrade(...a) { forbidden.push(['downgrade', a]); },
    setSalience(...a) { forbidden.push(['setSalience', a]); },
  };
}

describe('纯函数：按周分组与确定性摘要', () => {
  it('groupEpisodesByWeek：按 7 天定宽桶分组，桶正序，label 含 ISO 日期', () => {
    const eps = [ep(OLD_B_TS, 'b'), ep(OLD_A_TS, 'a'), ep(OLD_C_TS, 'c')];
    const groups = groupEpisodesByWeek(eps);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.map((g) => g.bucket)).toEqual([...groups.map((g) => g.bucket)].sort((x, y) => x - y));
    for (const g of groups) {
      expect(g.label).toMatch(/^\d{4}-\d{2}-\d{2} 那一周$/);
      expect(g.label).toBe(weekLabelOf(g.bucket));
      for (const e of g.episodes) expect(weekBucketOf(e.ts)).toBe(g.bucket);
    }
    expect(groupEpisodesByWeek([])).toEqual([]);
    expect(groupEpisodesByWeek([{ ts: NaN, summary: 'x' }])).toEqual([]); // 非法 ts 被滤
  });

  it('buildDeterministicDigest：第一人称拼接 summary，超长截断', () => {
    const g = { label: '2026-01-05 那一周', episodes: [ep(1, '聊了意识'), ep(2, '修好 bug'), { ts: 3, summary: '' }] };
    const d = buildDeterministicDigest(g);
    expect(d).toBe('我回想起2026-01-05 那一周：聊了意识；修好 bug');
    const long = { label: 'x', episodes: Array.from({ length: 100 }, (_, i) => ep(i, '很长的往事'.repeat(10))) };
    expect(buildDeterministicDigest(long).length).toBeLessThanOrEqual(1000);
  });
});

describe('EpisodicTimeline.aged（untilTs 透传 + 正序 + 过滤）', () => {
  function makeFakeStore() {
    const rows = [];
    let id = 0;
    const append = ({ kind, ts, tag, sessionId, roomId, entityType, ...payload }) => {
      rows.push({ id: ++id, ts, kind, tag, room_id: roomId, session_id: sessionId, entity_type: entityType, payload });
      return id;
    };
    const list = ({ kind, sinceTs, untilTs, limit = 200, order = 'DESC' }) => {
      let out = rows.filter((r) => (!kind || r.kind === kind)
        && (sinceTs == null || r.ts >= sinceTs) && (untilTs == null || r.ts <= untilTs));
      out = out.sort((a, b) => (order === 'ASC' ? a.ts - b.ts : b.ts - a.ts)).slice(0, limit);
      return out.map((r) => ({ ...r, roomId: r.room_id, sessionId: r.session_id, entityType: r.entity_type }));
    };
    return { append, list, count: () => rows.length };
  }

  it('只取 untilTs 之前、sinceTs 之后，最老在前；minSalience/types 过滤', () => {
    const fake = makeFakeStore();
    const tl = new EpisodicTimeline({ append: fake.append, list: fake.list, count: fake.count, now: () => T0 });
    tl.record({ type: 'interaction', summary: '老一', ts: OLD_C_TS, salience: 3 });
    tl.record({ type: 'observation', summary: '老二', ts: OLD_A_TS, salience: 5 });
    tl.record({ type: 'dream', summary: '老梦', ts: OLD_A_TS + DAY, salience: 3 });
    tl.record({ type: 'interaction', summary: '琐碎', ts: OLD_B_TS, salience: 1 });
    tl.record({ type: 'interaction', summary: '新事', ts: FRESH_TS, salience: 3 });

    const all = tl.aged({ untilTs: T0 - 90 * DAY });
    expect(all.map((e) => e.summary)).toEqual(['老一', '老二', '老梦', '琐碎']);   // 正序最老在前，新事被 untilTs 挡住
    const since = tl.aged({ untilTs: T0 - 90 * DAY, sinceTs: OLD_A_TS });
    expect(since.map((e) => e.summary)).toEqual(['老二', '老梦', '琐碎']);
    const salient = tl.aged({ untilTs: T0 - 90 * DAY, minSalience: 2 });
    expect(salient.map((e) => e.summary)).toEqual(['老一', '老二', '老梦']);
    const typed = tl.aged({ untilTs: T0 - 90 * DAY, types: ['interaction', 'observation'] });
    expect(typed.map((e) => e.summary)).toEqual(['老一', '老二', '琐碎']);   // dream 被滤
  });
});

describe('createSublimateHook（LLM 摘要钩子）', () => {
  const group = { bucket: 1, label: '2026-01-05 那一周', episodes: [ep(1, '聊了意识')] };

  it('chat 注入：回复清洗(<think> 剥除、截断)后返回', async () => {
    const hook = createSublimateHook({ chat: async () => '<think>推理</think>  那周我们聊了意识。  ' });
    expect(await hook(group)).toBe('那周我们聊了意识。');
  });

  it('chat 抛错/缺失/空组 → 返回 ""（调用方走确定性兜底）', async () => {
    expect(await createSublimateHook({ chat: async () => { throw new Error('挂了'); } })(group)).toBe('');
    expect(await createSublimateHook({})(group)).toBe('');
    expect(await createSublimateHook({ chat: async () => 'x' })({ label: 'x', episodes: [] })).toBe('');
  });
});

describe('createEpisodeSublimationLoop', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-subl-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function make(extra = {}) {
    const timeline = extra.timeline ?? makeFakeTimeline(extra.episodes ?? [ep(OLD_C_TS, '更早的事'), ep(OLD_A_TS, '聊了意识'), ep(OLD_B_TS, '修好 bug'), ep(FRESH_TS, '新事')]);
    const memoryCore = extra.memoryCore ?? makeFakeMemoryCore();
    const loop = createEpisodeSublimationLoop({ timeline, memoryCore, now: () => T0, ...extra.opts });
    return { timeline, memoryCore, loop };
  }

  it('注入时行为正确形状：只升华 90 天前，按周沉淀 episodic_digest，写回 dream 情景', async () => {
    const { timeline, memoryCore, loop } = make();
    const r = await loop.tick();
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(3);              // 三段久远；FRESH_TS 不动
    expect(r.digests).toBeGreaterThanOrEqual(2);
    expect(r.errors).toBe(0);
    // aged 调用形状：untilTs=now-90天，默认排除 dream 类型
    expect(timeline.calls.aged[0].untilTs).toBe(T0 - DEFAULT_AGED_DAYS * DAY);
    expect(timeline.calls.aged[0].types).not.toContain('dream');
    // 沉淀形状
    for (const w of memoryCore.writes) {
      expect(w.scope).toBe('episodic_digest');
      expect(w.sourceType).toBe('dream_sublimation');
      expect(w.projectId).toBe('noe');
      expect(w.sourceId).toMatch(/^epiweek-\d+$/);
      expect(w.body).toContain('我回想起');     // 默认无 LLM → 确定性拼接
      expect(w.salience).toBeLessThanOrEqual(4); // 永不进身份级(>=5)保护带
    }
    expect(memoryCore.writes.map((w) => w.body).join('')).toContain('聊了意识');
    // 写回一条 dream 情景
    expect(timeline.calls.record).toHaveLength(1);
    expect(timeline.calls.record[0].type).toBe('dream');
    expect(timeline.calls.record[0].summary).toContain('我梦里整理了 3 段往事');
  });

  it('水位线推进 + 不重复升华：第二轮 tick 零新沉淀', async () => {
    const { timeline, memoryCore, loop } = make();
    await loop.tick();
    const firstWrites = memoryCore.writes.length;
    expect(loop.currentWatermark()).toBe(OLD_B_TS);   // 推进到已处理的最大 ts
    const r2 = await loop.tick();
    expect(r2.processed).toBe(0);
    expect(memoryCore.writes.length).toBe(firstWrites);   // 没有重复沉淀
    expect(timeline.calls.aged[1].sinceTs).toBe(OLD_B_TS + 1);   // 增量消费
    expect(timeline.calls.record).toHaveLength(1);   // 第二轮没有"整理了 0 段"的空写回
  });

  it('水位线持久化：落盘 atomicJson，新实例从文件续传', async () => {
    const file = join(dir, 'wm.json');
    const a = make({ opts: { watermarkFile: file } });
    await a.loop.tick();
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, lastTs: OLD_B_TS });
    // 同文件起新实例（模拟重启）：水位线续传，不重复升华
    const b = make({ opts: { watermarkFile: file } });
    expect(b.loop.currentWatermark()).toBe(OLD_B_TS);
    const r = await b.loop.tick();
    expect(r.processed).toBe(0);
    expect(b.memoryCore.writes).toHaveLength(0);
  });

  it('llm 钩子注入：摘要用 LLM 输出；钩子抛错/输出空 → 确定性兜底', async () => {
    const ok = make({ opts: { llmSublimate: async (g) => `那周的印象（${g.episodes.length} 件事）` } });
    await ok.loop.tick();
    expect(ok.memoryCore.writes.some((w) => w.body.includes('那周的印象'))).toBe(true);
    const bad = make({ opts: { llmSublimate: async () => { throw new Error('模型挂了'); } } });
    const r = await bad.loop.tick();
    expect(r.errors).toBe(0);   // 钩子失败不算组失败
    expect(bad.memoryCore.writes.length).toBeGreaterThan(0);
    for (const w of bad.memoryCore.writes) expect(w.body).toContain('我回想起');   // 兜底
  });

  it('protectedScopes 防线：只 write episodic_digest（salience≤4），绝不碰 merge/downgrade/setSalience', async () => {
    const { memoryCore, loop } = make({ episodes: [ep(OLD_A_TS, '身份大事', { salience: 10, type: 'milestone' })] });
    await loop.tick();
    expect(memoryCore.forbidden).toHaveLength(0);   // 身份级记忆的改动通道零触碰
    expect(memoryCore.writes).toHaveLength(1);
    expect(memoryCore.writes[0].scope).toBe('episodic_digest');   // 永不写 identity/person scope
    expect(memoryCore.writes[0].salience).toBe(4);   // salience 10 的周也被钳制到 4
  });

  it('夜间限制门控：注入 phaseOf 非 night 跳过零调用；night 照常；未注入不受限', async () => {
    const day = make({ opts: { phaseOf: () => 'day' } });
    const r1 = await day.loop.tick();
    expect(r1).toEqual({ skipped: 'not_night', phase: 'day' });
    expect(day.timeline.calls.aged).toHaveLength(0);
    expect(day.memoryCore.writes).toHaveLength(0);
    const night = make({ opts: { phaseOf: () => 'night' } });
    expect((await night.loop.tick()).processed).toBe(3);
    const free = make();   // 未开节律门控（phaseOf=null）不受限
    expect((await free.loop.tick()).processed).toBe(3);
    const broken = make({ opts: { phaseOf: () => { throw new Error('坏'); } } });
    expect((await broken.loop.tick()).processed).toBe(3);   // 判定抛错 fail-open 照常跑
  });

  it('未注入依赖时零调用零影响：timeline/memoryCore 缺失 → skipped 不抛', async () => {
    const noTl = createEpisodeSublimationLoop({ memoryCore: makeFakeMemoryCore(), now: () => T0 });
    expect(await noTl.tick()).toEqual({ skipped: 'deps_missing' });
    const tl = makeFakeTimeline();
    const noMc = createEpisodeSublimationLoop({ timeline: tl, now: () => T0 });
    expect(await noMc.tick()).toEqual({ skipped: 'deps_missing' });
    expect(tl.calls.aged).toHaveLength(0);
    expect(tl.calls.record).toHaveLength(0);
  });

  it('依赖抛错 fail-open：write 单组失败不阻断整批，水位线照样推进', async () => {
    const memoryCore = makeFakeMemoryCore();
    const origWrite = memoryCore.write.bind(memoryCore);
    let n = 0;
    memoryCore.write = (input) => { n += 1; if (n === 1) throw new Error('第一组写失败'); return origWrite(input); };
    const { loop, timeline } = make({ memoryCore });
    const r = await loop.tick();
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(1);
    expect(r.digests).toBeGreaterThanOrEqual(1);   // 其余组照常沉淀
    expect(loop.currentWatermark()).toBe(OLD_B_TS);   // 失败组不重试、不重复
    expect(timeline.calls.record).toHaveLength(1);   // 写回仍发生（成功部分）
  });

  it('依赖抛错 fail-open：aged 抛错返回 ok:false 不抛；record 写回抛错不破坏结果', async () => {
    const badTl = { aged() { throw new Error('库炸了'); }, record() {} };
    const a = createEpisodeSublimationLoop({ timeline: badTl, memoryCore: makeFakeMemoryCore(), now: () => T0 });
    const r1 = await a.tick();
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('库炸了');
    const tl = makeFakeTimeline([ep(OLD_A_TS, '往事')]);
    tl.record = () => { throw new Error('写回失败'); };
    const b = createEpisodeSublimationLoop({ timeline: tl, memoryCore: makeFakeMemoryCore(), now: () => T0 });
    const r2 = await b.tick();
    expect(r2.ok).toBe(true);   // 摘要已沉淀，写回失败不阻断
    expect(r2.digests).toBe(1);
  });

  it('enabled 门控：默认 OFF start() 不起 timer；enabled 才起，stop 可停', () => {
    const off = make();
    expect(off.loop.isEnabled()).toBe(false);
    expect(off.loop.start()).toBe(false);
    expect(off.loop.isRunning()).toBe(false);
    const on = make({ opts: { enabled: true, firstDelayMs: 3600000 } });
    expect(on.loop.start()).toBe(true);
    expect(on.loop.isRunning()).toBe(true);
    expect(on.loop.start()).toBe(false);   // 幂等
    on.loop.stop();
    expect(on.loop.isRunning()).toBe(false);
  });
});

// 跨批次去重健壮性（B1.6①）：水位线本是去重唯一依据，但水位线文件丢失/损坏会重置到 0
// （readJsonWithCorruptBackup 失败 → watermark=0），同一周会被再次升华。若 MemoryCore.write 只按
// id upsert、不按 sourceId 去重，重复升华就会堆出两条 scope='episodic_digest' 的相同周摘要。
// 用真 MemoryCore + 真 SqliteStore 复现：sourceId 必须能兜住水位线丢失，绝不重复沉淀。
describe('跨批次去重健壮性（真 MemoryCore + 真 SqliteStore，水位线丢失不重复沉淀）', () => {
  let dbDir;
  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'noe-subl-db-'));
    initSqlite(join(dbDir, 'panel.db'));
  });
  afterEach(() => {
    closeSqlite();
    rmSync(dbDir, { recursive: true, force: true });
  });

  function countDigests() {
    return getDb().prepare(`SELECT id, source_id FROM noe_memory WHERE scope='episodic_digest'`).all();
  }

  it('水位线丢失（新实例从 0 起）再 tick 同一周，episodic_digest 不翻倍', async () => {
    const memoryCore = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    const timeline = new EpisodicTimeline({ now: () => T0 });
    // 三段久远情景（都远早于 T0-90 天），落进同一周或相邻周
    timeline.record({ type: 'interaction', summary: '聊了意识', ts: OLD_A_TS, salience: 3 });
    timeline.record({ type: 'interaction', summary: '修好 bug', ts: OLD_A_TS + 3600000, salience: 3 });
    timeline.record({ type: 'observation', summary: '更早的事', ts: OLD_C_TS, salience: 3 });

    // 第一轮：无水位线文件（in-memory 从 0），升华
    const loopA = createEpisodeSublimationLoop({ timeline, memoryCore, now: () => T0 });
    const r1 = await loopA.tick();
    expect(r1.ok).toBe(true);
    expect(r1.digests).toBeGreaterThanOrEqual(1);
    const afterFirst = countDigests();
    expect(afterFirst.length).toBe(r1.digests);   // 落库条数与本轮摘要数一致

    // 模拟水位线丢失：全新 loop 实例，watermark 重新从 0 起（等价于水位线文件被删/损坏回落 0）
    const loopB = createEpisodeSublimationLoop({ timeline, memoryCore, now: () => T0 });
    expect(loopB.currentWatermark()).toBe(0);   // 确认确实从头来
    const r2 = await loopB.tick();
    expect(r2.ok).toBe(true);
    expect(r2.digests).toBeGreaterThanOrEqual(1);   // 又"升华"了同一批（水位线没兜住）

    // 关键断言：尽管水位线丢失导致重复升华，落库的 episodic_digest 不该翻倍——
    // 同一周（同 sourceId）只能有一条（靠 sourceId→稳定 id 的 upsert 兜底）。
    const afterSecond = countDigests();
    expect(afterSecond.length).toBe(afterFirst.length);   // 不翻倍
    const sourceIds = afterSecond.map((r) => r.source_id);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);   // 每个 sourceId 唯一，无重复周
    for (const r of afterSecond) expect(r.source_id).toMatch(/^epiweek-\d+$/);
  });
});
