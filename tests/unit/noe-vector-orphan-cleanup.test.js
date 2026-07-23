// NoeVectorOrphanCleanup（P8 向量孤儿/废维清理）测试。
// 纯函数（dominantDim / isOrphanVector / isDeadDimVector）零 DB；scan/cleanup 用真 temp 库端到端，
// 重点验证：孤儿(指向 hidden 行)+废维(异维)被删、visible 行当维向量零回归、apply=false 不删、可逆。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { deleteEmbedding } from '../../src/embeddings/VectorIndex.js';
import {
  dominantDim, isOrphanVector, isDeadDimVector, scanVectorOrphans, cleanupVectorOrphans,
} from '../../src/memory/NoeVectorOrphanCleanup.js';

describe('dominantDim', () => {
  it('取计数最多的维度', () => {
    expect(dominantDim([{ dim: 128, c: 18 }, { dim: 1024, c: 1019 }])).toBe(1024);
  });
  it('空表 → null', () => {
    expect(dominantDim([])).toBe(null);
    expect(dominantDim(null)).toBe(null);
  });
  it('平票取最大维度（高维更可能是当前 provider 主体）', () => {
    expect(dominantDim([{ dim: 128, c: 5 }, { dim: 1024, c: 5 }])).toBe(1024);
  });
  it('忽略非法/零计数行', () => {
    expect(dominantDim([{ dim: 0, c: 100 }, { dim: 1024, c: 3 }, { dim: NaN, c: 99 }])).toBe(1024);
  });
});

describe('isOrphanVector', () => {
  const hidden = new Set(['h1', 'h2']);
  it('ref 指向 hidden 行 → 孤儿', () => {
    expect(isOrphanVector('h1', hidden)).toBe(true);
  });
  it('ref 指向非 hidden / 不存在 → 非孤儿（按本集合判定）', () => {
    expect(isOrphanVector('v1', hidden)).toBe(false);
  });
  it('数字 ref 归一化为字符串比较', () => {
    expect(isOrphanVector(123, new Set(['123']))).toBe(true);
  });
  it('空集合 / null → false', () => {
    expect(isOrphanVector('x', null)).toBe(false);
    expect(isOrphanVector(null, hidden)).toBe(false);
  });
});

describe('isDeadDimVector', () => {
  it('维度不等于当维 → 废维', () => {
    expect(isDeadDimVector(128, 1024)).toBe(true);
  });
  it('维度等于当维 → 非废维', () => {
    expect(isDeadDimVector(1024, 1024)).toBe(false);
  });
  it('维度缺失/非法 → 废维', () => {
    expect(isDeadDimVector(null, 1024)).toBe(true);
    expect(isDeadDimVector(undefined, 1024)).toBe(true);
  });
  it('当维 null（无法判定）→ 一律不判废维（宁漏不误删）', () => {
    expect(isDeadDimVector(128, null)).toBe(false);
    expect(isDeadDimVector(null, null)).toBe(false);
  });
});

describe('scanVectorOrphans / cleanupVectorOrphans（真库端到端）', () => {
  let tmp;
  beforeEach(() => {
    close();
    tmp = mkdtempSync(join(tmpdir(), 'noe-orphan-'));
    initSqlite(join(tmp, 'panel.db'));
  });
  afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

  // 造一个迷你库：visible 行 v1/v2(各 1 条 4 维当维向量)、hidden 行 h1/h2(各 1 条 4 维孤儿向量)、
  // 废维 dead(2 维，指向 visible v1——即「废维但行还在」的边界)。当维=4（计数最多）。
  function seed() {
    const db = getDb();
    db.prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('v1', 'default', 'project', '', 'visible one', 'manual', '[]', 0, 0, 1, 1, 0.9, '[]', 3);
    db.prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('v2', 'default', 'project', '', 'visible two', 'manual', '[]', 0, 0, 1, 1, 0.9, '[]', 3);
    db.prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('h1', 'default', 'project', '', 'hidden one', 'manual', '[]', 1, 0, 1, 1, 0.9, '[]', 3);
    db.prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('h2', 'default', 'project', '', 'hidden two', 'manual', '[]', 1, 0, 1, 1, 0.9, '[]', 3);
    // P8-fix:dead 行设 visible——dead 向量是「废维但行还在」边界（非孤儿）；新 missing-ref 逻辑要求行存在才不算孤儿。
    db.prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('dead', 'default', 'project', '', 'dead row', 'manual', '[]', 0, 0, 1, 1, 0.9, '[]', 3);
    const ins = db.prepare('INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES (?,?,?,?,?,?)');
    const v4 = Buffer.alloc(4 * 4); // 4 维
    const v2dim = Buffer.alloc(2 * 4); // 2 维（废维）
    ins.run('noe_memory', 'v1', 'visible one', v4, 4, 'm');   // visible 当维（必须保留）
    ins.run('noe_memory', 'v2', 'visible two', v4, 4, 'm');   // visible 当维（必须保留）
    ins.run('noe_memory', 'h1', 'hidden one', v4, 4, 'm');    // 孤儿（指向 hidden）
    ins.run('noe_memory', 'h2', 'hidden two', v4, 4, 'm');    // 孤儿（指向 hidden）
    ins.run('noe_memory', 'dead', 'dead dim', v2dim, 2, 'm'); // 废维（2 维，指向不存在/此处独立）
    // 另造一条废维且指向 visible v1 的需要换 ref——UNIQUE(kind,ref_id) 不允许 v1 两条，故 dead 用独立 ref
    return db;
  }

  it('scan：当维=4，孤儿 2(h1,h2)，废维 1(dead)，将删 3，visible 当维向量不在删单', () => {
    const db = seed();
    const s = scanVectorOrphans({ db, kind: 'noe_memory', expectedDim: 4 }); // 多维库需显式锁维清废维(P8-fix)
    expect(s.expectedDim).toBe(4);
    expect(s.counts.orphan).toBe(2);
    expect(s.counts.dead_dim).toBe(1);
    expect(s.counts.to_delete).toBe(3);
    expect(s.deleteRefIds.sort()).toEqual(['dead', 'h1', 'h2']);
    expect(s.deleteRefIds).not.toContain('v1'); // visible 当维向量绝不入删单
    expect(s.deleteRefIds).not.toContain('v2');
    expect(s.counts.keep).toBe(2); // 删后只剩 v1/v2
  });

  it('cleanup apply=false（dry-run）：返回扫描但不删任何向量', () => {
    const db = seed();
    const r = cleanupVectorOrphans({ db, kind: 'noe_memory', apply: false, expectedDim: 4 });
    expect(r.applied).toBe(false);
    expect(r.deleted).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='noe_memory'").get().c).toBe(5); // 一条没删
  });

  it('cleanup apply=true：删 3 条孤儿+废维，visible 当维向量零回归', () => {
    const db = seed();
    const r = cleanupVectorOrphans({ db, kind: 'noe_memory', apply: true, expectedDim: 4, deleteFn: deleteEmbedding });
    expect(r.applied).toBe(true);
    expect(r.deleted).toBe(3);
    // 删后只剩 visible v1/v2 的当维向量
    const left = getDb().prepare("SELECT ref_id FROM embeddings WHERE kind='noe_memory' ORDER BY ref_id").all().map((x) => x.ref_id);
    expect(left).toEqual(['v1', 'v2']);
    // visible 行的当维(4)向量一条不少
    const visVec = getDb().prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='noe_memory' AND dim=4 AND ref_id IN (SELECT id FROM noe_memory WHERE hidden=0)").get().c;
    expect(visVec).toBe(2);
  });

  it('apply=true 缺 deleteFn → 抛错（防误用真删却无删除器）', () => {
    const db = seed();
    expect(() => cleanupVectorOrphans({ db, kind: 'noe_memory', apply: true })).toThrow(/deleteFn/);
  });

  it('explicit expectedDim 覆盖自适应：指定 2 维为当维时，4 维全成废维（含 visible）', () => {
    const db = seed();
    const s = scanVectorOrphans({ db, kind: 'noe_memory', expectedDim: 2 });
    expect(s.expectedDim).toBe(2);
    // 4 维的 v1,v2,h1,h2 都成废维；2 维 dead 是当维不删；h1,h2 还是孤儿
    expect(s.deleteRefIds.sort()).toEqual(['h1', 'h2', 'v1', 'v2']);
    expect(s.counts.dead_dim_pointing_visible).toBe(2); // v1,v2 是废维且 visible
  });

  it('无 db → 抛错', () => {
    expect(() => scanVectorOrphans({})).toThrow(/db required/);
  });
});

describe('P8-fix（三方审回归·向量清理）', () => {
  let tmp;
  beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-orphan-fix-')); initSqlite(join(tmp, 'panel.db')); });
  afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

  const mkMem = (id, hidden) => getDb().prepare("INSERT INTO noe_memory(id,project_id,scope,title,body,source_type,tags,hidden,hit_count,created_at,updated_at,confidence,merge_trace,salience) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, 'default', 'project', '', id, 'manual', '[]', hidden, 0, 1, 1, 0.9, '[]', 3);
  const insVec = (refId, dim) => getDb().prepare('INSERT INTO embeddings(kind, ref_id, text, vector, dim, model) VALUES (?,?,?,?,?,?)')
    .run('noe_memory', refId, refId, Buffer.alloc(dim * 4), dim, 'm');

  it('多维分布 + 无 expectedDim：跳过废维只清孤儿（防 dominantDim 翻转误删 visible 当维）', () => {
    // 迁移期：hidden 旧维 1024 占多数(dominantDim 会误选 1024)，visible 新维 128 是当前 provider
    for (const id of ['o1', 'o2', 'o3']) { mkMem(id, 1); insVec(id, 1024); }
    mkMem('vnew', 0); insVec('vnew', 128); // visible 当维(新 provider)——绝不能被当废维删
    const s = scanVectorOrphans({ db: getDb(), kind: 'noe_memory' });
    expect(s.expectedDimSource).toBe('skipped-multidim');
    expect(s.expectedDim).toBe(null);
    expect(s.counts.dead_dim).toBe(0);
    expect(s.deleteRefIds.sort()).toEqual(['o1', 'o2', 'o3']); // 只清孤儿
    expect(s.deleteRefIds).not.toContain('vnew'); // visible 当维向量绝不误删
  });

  it('单维分布 auto：安全自适应（无歧义）', () => {
    mkMem('v', 0); insVec('v', 1024);
    const s = scanVectorOrphans({ db: getDb(), kind: 'noe_memory' });
    expect(s.expectedDimSource).toBe('auto-single');
    expect(s.expectedDim).toBe(1024);
  });

  it('孤儿含 missing ref（NOT EXISTS）：指向不存在行的向量也算孤儿', () => {
    mkMem('vreal', 0); insVec('vreal', 1024); // 指向存在 visible 行
    insVec('ghost', 1024);                    // 指向不存在行(missing)
    const s = scanVectorOrphans({ db: getDb(), kind: 'noe_memory' });
    expect(s.orphanRefIds).toContain('ghost');
    expect(s.orphanRefIds).not.toContain('vreal');
  });
});
