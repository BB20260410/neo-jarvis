import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// P5（2026-07-02）：KG 参与主召回。图谱此前只进不出（KG_INGEST 摄入活跃、主召回链零消费=白攒资产）。
//   NOE_KG_RECALL=1 且注入 graph 时，recallFused 增加第三路：query 命中图实体 → 1-hop 邻居实体名 →
//   FTS 扩展召回 → 第三列喂 RRF。默认 OFF 零回归。

let tmp;

const fakeGraph = {
  search: ({ q }) => (String(q).includes('爱因斯坦')
    ? { entities: [{ id: 'ent-1', name: '爱因斯坦', type: 'person' }] }
    : { entities: [] }),
  oneHop: ({ id }) => (id === 'ent-1'
    ? { found: true, entity: { id: 'ent-1', name: '爱因斯坦' }, edges: [{ name: '量子纠缠', rel_type: 'related_to' }] }
    : { found: false, entity: null, edges: [] }),
};

// 语义索引空转桩：向量路无命中，逼出「图谱路独立带回结果」的判定。
const emptySemantic = { search: async () => [] };

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-kg-recall-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MemoryCore recallFused × 知识图谱扩展路', () => {
  it('默认 OFF：图谱邻居不参与召回（零回归）', async () => {
    const core = new MemoryCore({ semanticIndex: emptySemantic, logger: null, kgRecall: { graph: fakeGraph } });
    core.write({ id: 'qm', body: '量子纠缠现象的观测实验笔记' });
    const items = await core.recallFused({ q: '爱因斯坦', bumpHits: false });
    expect(items.map((m) => m.id)).not.toContain('qm');
  });

  it('开启后：query 命中实体 → 邻居名扩展召回 → 邻居记忆进结果', async () => {
    const core = new MemoryCore({ semanticIndex: emptySemantic, logger: null, kgRecall: { enabled: true, graph: fakeGraph } });
    core.write({ id: 'qm', body: '量子纠缠现象的观测实验笔记' });
    const items = await core.recallFused({ q: '爱因斯坦', bumpHits: false });
    expect(items.map((m) => m.id)).toContain('qm');
  });

  it('graph 为 thunk（延迟注入）同样可用', async () => {
    const core = new MemoryCore({ semanticIndex: emptySemantic, logger: null, kgRecall: { enabled: true, graph: () => fakeGraph } });
    core.write({ id: 'qm', body: '量子纠缠现象的观测实验笔记' });
    const items = await core.recallFused({ q: '爱因斯坦', bumpHits: false });
    expect(items.map((m) => m.id)).toContain('qm');
  });

  it('graph 抛错 → fail-open 不拖累主召回', async () => {
    const boom = { search: () => { throw new Error('kg down'); } };
    const core = new MemoryCore({ semanticIndex: emptySemantic, logger: null, kgRecall: { enabled: true, graph: boom } });
    core.write({ id: 'direct', body: '爱因斯坦生平传记' });
    const items = await core.recallFused({ q: '爱因斯坦', bumpHits: false });
    expect(items.map((m) => m.id)).toContain('direct');
  });
});
