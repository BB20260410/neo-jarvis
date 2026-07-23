// 审计 §3.3 P1③ 测试：MemoryCore.getMany 批量取（recallFused 补取改用，避免逐条 get N+1）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-getmany-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('§3.3 P1③ MemoryCore.getMany 批量取', () => {
  it('一次取多条，hidden 默认过滤、不存在的跳过', () => {
    const core = new MemoryCore();
    core.write({ id: 'a', body: 'AAA' });
    core.write({ id: 'b', body: 'BBB' });
    core.write({ id: 'c', body: 'CCC' });
    core.hide('c');
    const map = core.getMany(['a', 'b', 'c', 'nope']);
    expect(map.size).toBe(2);
    expect(map.get('a').body).toBe('AAA');
    expect(map.get('b').body).toBe('BBB');
    expect(map.has('c')).toBe(false); // hidden 默认不返回（与 get 一致）
    expect(map.has('nope')).toBe(false);
  });

  it('includeHidden:true 返回隐藏记忆', () => {
    const core = new MemoryCore();
    core.write({ id: 'h', body: 'HID' });
    core.hide('h');
    expect(core.getMany(['h']).has('h')).toBe(false);
    expect(core.getMany(['h'], { includeHidden: true }).get('h').body).toBe('HID');
  });

  it('空/去重 id 安全', () => {
    const core = new MemoryCore();
    core.write({ id: 'x', body: 'X' });
    expect(core.getMany([]).size).toBe(0);
    expect(core.getMany(['x', 'x', '', null]).size).toBe(1);
  });
});
