// @ts-check
// 强健工程：回滚失败不再静默吞（加日志留痕，治排障黑洞）。源码结构断言防回归——
// 这三处回滚 catch 曾是空 `} catch {}`：回滚自身失败时 room 停在内存/磁盘不一致的中间态却零痕迹。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

describe('回滚失败留痕（防回退成空 catch）', () => {
  it('roomStart degrade 回滚两步都记日志', () => {
    const src = read('src/server/routes/roomStart.js');
    const fn = src.slice(src.indexOf('function restoreStartupDegradeState'), src.indexOf('export async function prepareClusterRunGate'));
    expect(fn).toContain('degrade 回滚 update 失败');
    expect(fn).toContain('degrade 回滚内存兜底失败');
    // 函数体内不得再有纯空 catch（回滚失败必须留痕）
    expect(fn).not.toMatch(/\}\s*catch\s*\{\s*\}/);
  });

  it('roomRequirements 回滚 update 失败记日志', () => {
    const src = read('src/server/routes/roomRequirements.js');
    expect(src).toContain('[room-requirements] 回滚 update 失败');
  });
});
