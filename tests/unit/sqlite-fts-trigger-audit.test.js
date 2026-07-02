// noe_memory_au FTS UPDATE trigger 守卫测试（审计 §3.3 P0-4）
// 验证 trigger 仅在 hidden 切换或内容变化时同步 FTS：内容变更删旧插新、bumpHit 后保持一致、hide/unhide 进出 FTS。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;
let core;
let ftsOk;

function rowidOf(id) {
  return core.db().prepare('SELECT rowid FROM noe_memory WHERE id = ?').get(id)?.rowid;
}
function ftsMatch(term) {
  return core.db().prepare('SELECT rowid FROM noe_memory_fts WHERE noe_memory_fts MATCH ?').all(`"${term}"`).map((r) => r.rowid);
}

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-fts-trigger-'));
  initSqlite(join(tmp, 'panel.db'));
  core = new MemoryCore();
  ftsOk = core.ftsAvailable();
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('noe_memory_au FTS trigger 守卫（审计 §3.3 P0-4）', () => {
  it('schema 已迁移到版本 ≥6（trigger 已重建）', () => {
    const v = core.db().prepare("SELECT v FROM kv WHERE k = 'schema_version'").get();
    expect(Number(v.v)).toBeGreaterThanOrEqual(6);
  });

  it('内容变更时 FTS 删旧插新', () => {
    if (!ftsOk) return;
    core.write({ id: 'm', title: 'note', body: 'uniquekeyword alpha beta' });
    const rid = rowidOf('m');
    expect(ftsMatch('uniquekeyword')).toContain(rid);

    core.write({ id: 'm', title: 'note', body: 'freshcontent gamma delta' }); // UPDATE 改 body
    expect(ftsMatch('freshcontent')).toContain(rid);
    expect(ftsMatch('uniquekeyword')).not.toContain(rid); // 旧 FTS 项已删
  });

  it('bumpHit（仅改 hit_count/updated_at）后 FTS 仍一致', () => {
    if (!ftsOk) return;
    core.write({ id: 'm', title: 'note', body: 'uniquekeyword alpha' });
    const rid = rowidOf('m');
    core.bumpHitMany(['m']);
    core.bumpHitMany(['m']);
    expect(ftsMatch('uniquekeyword')).toContain(rid); // 内容没变 → FTS 保持可召回
    expect(core.get('m').hitCount).toBe(2);
  });

  it('hide 从 FTS 移除，unhide 重新插入', () => {
    if (!ftsOk) return;
    core.write({ id: 'm', title: 'note', body: 'freshcontent zeta eta' });
    const rid = rowidOf('m');
    expect(ftsMatch('freshcontent')).toContain(rid);
    core.hide('m');
    expect(ftsMatch('freshcontent')).not.toContain(rid);
    core.unhide('m');
    expect(ftsMatch('freshcontent')).toContain(rid);
  });

  it('FTS recall 端到端仍正确（trigger 重写未破坏召回）', () => {
    core.write({ id: 'a', title: 'note', body: 'searchablecontent first' });
    core.write({ id: 'b', title: 'note', body: 'searchablecontent second' });
    const ids = core.recall({ q: 'searchablecontent' }).map((m) => m.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});
