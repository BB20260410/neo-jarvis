import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;
let core;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-gc-'));
  initSqlite(join(tmp, 'panel.db'));
  core = new MemoryCore();
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MemoryCore.runGc', () => {
  const past = Date.now() - 100000;

  it('dry-run 列出 GC 候选但不改库；身份级(salience5)即使过期也保护', () => {
    core.write({ id: 'exp', body: '过期记忆', expiresAt: past });
    core.write({ id: 'vip', body: '身份级记忆', salience: 5, expiresAt: past });
    core.write({ id: 'ok', body: '健康记忆', salience: 3 });

    const r = core.runGc();
    expect(r.applied).toBe(false);
    expect(r.plan.gcCandidates).toContain('exp');
    expect(r.plan.gcCandidates).not.toContain('vip');   // 身份级铁律保护
    expect(r.plan.gcCandidates).not.toContain('ok');
    expect(r.hidden).toEqual([]);
    expect(core.get('exp')).not.toBeNull();             // dry-run 没动库
  });

  it('apply=true 真 hide 候选，且可 unhide 恢复；身份级不动', () => {
    core.write({ id: 'exp', body: '过期记忆', expiresAt: past });
    core.write({ id: 'vip', body: '身份级记忆', salience: 5, expiresAt: past });

    const r = core.runGc({ apply: true });
    expect(r.applied).toBe(true);
    expect(r.hidden).toContain('exp');
    expect(core.get('exp')).toBeNull();                  // 已隐藏（默认查询不返回）
    expect(core.get('exp', { includeHidden: true })).not.toBeNull();  // 可恢复
    expect(core.get('vip')).not.toBeNull();              // 身份级未被 GC

    // unhide 恢复
    core.unhide('exp');
    expect(core.get('exp')).not.toBeNull();
  });

  it('空库返回空计划', () => {
    const r = core.runGc({ apply: true });
    expect(r.plan.gcCandidates).toEqual([]);
    expect(r.hidden).toEqual([]);
  });

  it('projectId 限定只 GC 该项目，不误伤其他项目(B1/B2 修复)', () => {
    core.write({ id: 'a-exp', body: 'A 过期', projectId: 'projA', expiresAt: past });
    core.write({ id: 'b-exp', body: 'B 过期', projectId: 'projB', expiresAt: past });
    const r = core.runGc({ apply: true, projectId: 'projA' });
    expect(r.hidden).toEqual(['a-exp']);
    expect(core.get('a-exp')).toBeNull();          // 本项目过期被 hide
    expect(core.get('b-exp')).not.toBeNull();      // 其他项目未被误伤
  });

  it('超过 maxScan 时 truncated=true(不静默截断,E2 防 OOM)', () => {
    core.write({ id: 'e1', body: '1', expiresAt: past });
    core.write({ id: 'e2', body: '2', expiresAt: past });
    core.write({ id: 'e3', body: '3', expiresAt: past });
    const r = core.runGc({ maxScan: 2 });
    expect(r.truncated).toBe(true);
  });
});
