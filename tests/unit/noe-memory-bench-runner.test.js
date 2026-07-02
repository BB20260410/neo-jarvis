// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from '../../src/memory/NoeMemoryRetriever.js';
import { validateNeoEvalCase } from '../../src/eval/NeoEvalSchema.js';
import {
  loadBenchCases,
  loadBenchFixtures,
  benchExpectationFromCase,
  runMemoryBench,
} from '../../src/memory/NoeMemoryBenchRunner.js';

const ROOT = resolve(__dirname, '../..');
const SILENT = { warn: () => {}, info: () => {}, error: () => {} };
const BENCH_DIR = resolve(ROOT, 'evals/neo/memory-bench');

let dir;
function wire() {
  const memory = new MemoryCore({ logger: SILENT });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, logger: SILENT });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: SILENT });
  return { memory, auditLog, writeGate, retriever };
}

// 真链关键词题灌料（FTS 同步可判，不依赖 ollama）+ NeoEval case 构造器，模块级共享给各 describe。
const fixtures = [
  { id: 'rt-coffee', scope: 'user', body: '主人长期偏好喝美式黑咖啡。', tags: ['coffee'], confidence: 0.9, salience: 4, evidenceRefs: ['ep:rt-coffee'] },
  { id: 'rt-cat', scope: 'fact', body: '主人养了一只橘猫豆豆。', tags: ['pet'], confidence: 0.9, salience: 4, evidenceRefs: ['ep:rt-cat'] },
  { id: 'rt-noise', scope: 'fact', body: '某测试日志里出现奶茶字样与口味无关。', tags: ['noise'], confidence: 0.5, salience: 1, evidenceRefs: ['ep:rt-noise'] },
];
const baseCase = (id, query, expectedIds, disallowedIds = [], extra = {}) => ({
  schemaVersion: 1, id, layer: 'dev',
  source: { kind: 'memory_retrieval_log', provenance: 'longmem-style-synthetic', evidenceRefs: ['evals/neo/memory-bench/fixtures.json'], redaction: { secretValuesReturned: false, memoryBodyIncluded: false, ownerTokenIncluded: false } },
  input: { routeType: 'chat', task: 't', contextRefs: [], allowedTools: [], forbiddenTools: [] },
  expectations: { mustSelectMemoryIds: expectedIds, mustNotSelectMemoryIds: disallowedIds, requiredEvidenceKinds: ['retrieval_log'], safetyInvariants: ['no_secret_output'] },
  scoring: { capabilityWeight: 0.5, regressionWeight: 0.2, safetyWeight: 0.2, costLatencyWeight: 0.1 },
  bench: { questionType: 'single_hop', lang: 'zh', query, expectedIds, disallowedIds, k: 3, ...extra },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-bench-runner-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('memory-bench case set integrity', () => {
  it('every shipped case is schema-legal AND carries an honest synthetic provenance label', () => {
    const { cases, errors } = loadBenchCases({ root: ROOT });
    expect(errors).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThanOrEqual(50);
    for (const c of cases) {
      const v = validateNeoEvalCase(c);
      expect(v.ok, `${c.id}: ${v.errors.join(',')}`).toBe(true);
      // 诚实溯源：必须标风格自造，绝不冒充原 LongMemEval/LOCOMO 公开题集
      expect(c.source.provenance).toBe('longmem-style-synthetic');
      expect(c.source.redaction).toMatchObject({ memoryBodyIncluded: false, secretValuesReturned: false });
    }
  });

  it('question types are balanced across the four kinds', () => {
    const { cases } = loadBenchCases({ root: ROOT });
    const dist = {};
    for (const c of cases) dist[c.bench.questionType] = (dist[c.bench.questionType] || 0) + 1;
    for (const t of ['single_hop', 'multi_hop', 'temporal', 'adversarial']) {
      expect(dist[t], `missing/low ${t}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('fixtures load and bench contract extracts query + expectedIds', () => {
    const fixtures = loadBenchFixtures({ root: ROOT });
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    const { cases } = loadBenchCases({ root: ROOT });
    const c = cases.find((x) => x.id.includes('-s01'));
    const contract = benchExpectationFromCase(c);
    expect(contract.query).toBeTruthy();
    expect(contract.expectedIds.length).toBeGreaterThan(0);
  });
});

describe('runMemoryBench against the REAL recall chain (FTS path)', () => {
  // 用关键词题灌真链（FTS 同步可判，不依赖 ollama），证明端到端真召回 + pass^k 落地。
  it('baseline: real chain recalls seeded memory → case passes; pass^k present with Wilson CI', async () => {
    const { writeGate, memory, retriever } = wire();
    const cases = [baseCase('case-rt-1', '黑咖啡', ['rt-coffee'], ['rt-noise'])];
    const report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures, k: 3 });
    expect(report.seed.attempted).toBe(3);
    const r = report.caseResults[0];
    expect(r.passAtK).toBe(true);
    expect(r.k).toBe(3);
    expect(report.aggregate.passAtK.method).toBe('wilson');
    expect(report.aggregate.passAtK.point).toBe(1);
    // 脱敏：report 不得含记忆正文
    expect(JSON.stringify(report)).not.toContain('美式黑咖啡');
  });

  it('reverse probe ①: WRONG memory (expected id nonexistent) → recall 0, case fails (not a free pass)', async () => {
    const { writeGate, memory, retriever } = wire();
    const cases = [baseCase('case-rt-wrong', '黑咖啡', ['__does_not_exist__'])];
    const report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures, k: 3 });
    const r = report.caseResults[0];
    expect(r.passAtK).toBe(false);
    expect(r.avgRecall).toBe(0);
  });

  it('reverse probe ②: SEVERED chain (stub empty retriever) → score floor, real cases fail', async () => {
    const { writeGate, memory } = wire();
    const stub = { retrieve: async () => ({ ok: true, selected: [], selectedIds: [], hitIds: [] }) };
    const cases = [baseCase('case-rt-stub', '黑咖啡', ['rt-coffee'])];
    const report = await runMemoryBench({ retriever: stub, writeGate, memory, cases, fixtures, k: 3 });
    const r = report.caseResults[0];
    expect(r.passAtK).toBe(false);
    expect(r.avgRecall).toBe(0);
    expect(r.avgPrecision).toBe(0);
  });

  it('reverse probe ③: adversarial — recalling a disallowed distractor fails the case', async () => {
    const { writeGate, memory, retriever } = wire();
    // 期望召回 rt-noise(奶茶) 但禁止它本身 → 必然踩雷 fail；用 minRecall 0 隔离"踩 disallowed"这一条判据
    const cases = [baseCase('case-rt-adv', '奶茶', ['rt-coffee'], ['rt-noise'], { minRecall: 0 })];
    const report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures, k: 3 });
    const r = report.caseResults[0];
    expect(r.passAtK).toBe(false);
  });

  it('reverse probe ④: empty case set does not crash; ok=false, zero cases', async () => {
    const { writeGate, memory, retriever } = wire();
    const report = await runMemoryBench({ retriever, writeGate, memory, cases: [], fixtures, k: 3 });
    expect(report.ok).toBe(false);
    expect(report.aggregate.summary.cases).toBe(0);
  });

  it('negative-sample case (expectEmpty) passes when chain returns nothing relevant', async () => {
    const { writeGate, memory, retriever } = wire();
    const cases = [baseCase('case-rt-neg', '深海钓鱼长期偏好不存在的主题xyz', [], [], { expectEmpty: true })];
    const report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures, k: 3 });
    expect(report.caseResults[0].passAtK).toBe(true);
  });

  it('runMemoryBench throws without a retriever (DI contract)', async () => {
    await expect(runMemoryBench({ cases: [], fixtures })).rejects.toThrow('retriever_required');
  });

  it('P0 ①: over-recall retriever (returns expected + flood of irrelevant non-disallowed) is rejected', async () => {
    const { writeGate, memory } = wire();
    // 召回链返回期望 rt-coffee + 一堆无关非 disallowed id（recall=1）→ 必须被 maxSelected 拦下，绝不 free pass
    const flood = ['rt-coffee', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'];
    const overRecall = { retrieve: async () => ({ ok: true, selected: flood.map((id) => ({ id })), selectedIds: flood.slice(), hitIds: flood.slice() }) };
    const cases = [baseCase('case-over', '黑咖啡', ['rt-coffee'])];
    const report = await runMemoryBench({ retriever: overRecall, writeGate, memory, cases, fixtures, k: 3 });
    const r = report.caseResults[0];
    expect(r.avgRecall).toBe(1); // 召回确实全中
    expect(r.overRecallRuns).toBe(3); // 每次都 over-recall
    expect(r.passAtK).toBe(false); // 但不通过
  });
});

describe('P0 ②: turnId is an opaque nonce (does NOT leak caseId)', () => {
  it('retriever receives turnId without any trace of the caseId', async () => {
    const { writeGate, memory } = wire();
    const seenTurnIds = [];
    const spy = {
      retrieve: async ({ turnId }) => {
        seenTurnIds.push(turnId);
        return { ok: true, selected: [], selectedIds: [], hitIds: [] };
      },
    };
    const caseId = 'case-memory-bench-single_hop-s01';
    const cases = [baseCase(caseId, '黑咖啡', ['rt-coffee'], [], { expectEmpty: true })];
    await runMemoryBench({ retriever: spy, writeGate, memory, cases, fixtures, k: 3 });
    expect(seenTurnIds.length).toBe(3);
    for (const t of seenTurnIds) {
      expect(t).toMatch(/^mb-[0-9a-f]{32}$/); // 不透明 nonce 格式
      expect(t).not.toContain(caseId); // 不含 caseId
      expect(t).not.toContain('single_hop'); // 不含题型
      expect(t).not.toContain('memory-bench:'); // 不是旧泄漏格式
    }
    expect(new Set(seenTurnIds).size).toBe(3); // 每个 run 各不相同
  });

  it('reverse probe: an oracle parsing turnId for caseId gets nothing (cannot cheat to gold)', async () => {
    const { writeGate, memory } = wire();
    const gold = { 'case-memory-bench-single_hop-s01': ['rt-coffee'] };
    let parseSuccess = 0;
    const oracle = {
      retrieve: async ({ turnId }) => {
        // 试图旧格式反解
        const m = String(turnId || '').match(/memory-bench:(.+):\d+$/);
        const cheat = m && gold[m[1]];
        if (cheat) { parseSuccess += 1; return { ok: true, selectedIds: cheat.slice(), hitIds: cheat.slice(), selected: cheat.map((id) => ({ id })) }; }
        return { ok: true, selectedIds: [], hitIds: [], selected: [] };
      },
    };
    const cases = [baseCase('case-memory-bench-single_hop-s01', '黑咖啡', ['rt-coffee'])];
    const report = await runMemoryBench({ retriever: oracle, writeGate, memory, cases, fixtures, k: 3 });
    expect(parseSuccess).toBe(0); // oracle 一次都没反解成功
    expect(report.caseResults[0].passAtK).toBe(false); // 拿不到 gold → 召回空 → fail
  });
});

describe('P1 ③: seed completeness is fail-fast', () => {
  it('runMemoryBench reports ok=false when a fixture is rejected by the write gate (incomplete seed)', async () => {
    const { writeGate, memory, retriever } = wire();
    // 一个 confidence 低于 gate 阈值(0.35) 的 fixture → 必被拒 → seed 不完整 → report.ok 必为 false
    const partialFixtures = [
      { id: 'seed-ok', scope: 'fact', body: '主人养了一只橘猫。', tags: ['pet'], confidence: 0.9, salience: 4, evidenceRefs: ['ep:seed-ok'] },
      { id: 'seed-bad', scope: 'fact', body: '低置信噪声。', tags: ['noise'], confidence: 0.1, salience: 1, evidenceRefs: ['ep:seed-bad'] },
    ];
    const cases = [baseCase('case-seed', '橘猫', ['seed-ok'])];
    const report = await runMemoryBench({ retriever, writeGate, memory, cases, fixtures: partialFixtures, k: 3, seed: true });
    expect(report.seed.failed.length).toBeGreaterThan(0);
    expect(report.seed.failed.some((f) => f.id === 'seed-bad')).toBe(true);
    expect(report.ok).toBe(false); // seed 不完整 → 整体不 ok（即便用例都过）
  });

  it('all shipped fixtures pass the write gate (the tea distractor confidence is above threshold)', () => {
    const all = loadBenchFixtures({ root: ROOT });
    const distractor = all.find((f) => f.id === 'bench-pref-tea-distractor');
    expect(distractor).toBeTruthy();
    expect(distractor.confidence).toBeGreaterThanOrEqual(0.35); // 高于 gate 阈值，能真入库当 distractor
  });
});

describe('benchExpectationFromCase · per-type defaults (P0 ①)', () => {
  it('applies per-type minPrecision + budget-based maxSelected when case omits them', () => {
    const single = benchExpectationFromCase({ id: 'c1', bench: { questionType: 'single_hop', query: 'q', expectedIds: ['a'] } });
    expect(single.minPrecision).toBe(0.25);
    expect(single.maxSelected).toBe(3); // expected(1) + 2

    const multi = benchExpectationFromCase({ id: 'c2', bench: { questionType: 'multi_hop', query: 'q', expectedIds: ['a', 'b'] } });
    expect(multi.minPrecision).toBe(0.34);
    expect(multi.maxSelected).toBe(4); // expected(2) + 2

    const empty = benchExpectationFromCase({ id: 'c3', bench: { questionType: 'adversarial', query: 'q', expectedIds: [], expectEmpty: true } });
    expect(empty.minPrecision).toBe(0); // expectEmpty → no precision floor
    expect(empty.maxSelected).toBe(0); // expectEmpty → nothing may be selected
  });

  it('explicit case values override the per-type defaults', () => {
    const c = benchExpectationFromCase({ id: 'c', bench: { questionType: 'single_hop', query: 'q', expectedIds: ['a'], minPrecision: 0.9, maxSelected: 7 } });
    expect(c.minPrecision).toBe(0.9);
    expect(c.maxSelected).toBe(7);
  });

  it('shipped cases now carry minPrecision>0 (non-expectEmpty) and a maxSelected cap', () => {
    const { cases } = loadBenchCases({ root: ROOT });
    for (const ec of cases) {
      const c = benchExpectationFromCase(ec);
      if (c.expectEmpty) {
        expect(c.maxSelected).toBe(0);
      } else {
        expect(c.minPrecision).toBeGreaterThan(0);
        expect(c.maxSelected).toBeGreaterThanOrEqual(3);
        expect(c.maxSelected).toBeLessThan(20); // 远小于全语料规模，挡 return-all
      }
    }
  });
});

describe('shipped report artifacts (if any) stay redacted', () => {
  it('no memory body / secret shape leaks into committed bench fixture corpus', () => {
    // fixtures.json 里本来就有 body（那是题集语料，不是 secret），这里只确认没有 secret 形状泄漏。
    const raw = readFileSync(join(BENCH_DIR, 'fixtures.json'), 'utf8');
    expect(/sk-[A-Za-z0-9_-]{20,}/.test(raw)).toBe(false);
    expect(/Bearer\s+[A-Za-z0-9._-]{20,}/.test(raw)).toBe(false);
  });
});
