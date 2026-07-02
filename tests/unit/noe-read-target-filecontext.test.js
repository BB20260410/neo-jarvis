import { describe, it, expect } from 'vitest';
import { readTargetFileContext } from '../../src/loop/NoeSelfEvolutionExecutors.js';

// 路 2 真信号实测坐实：implement 对靠后函数（NoeActionCatalog.js:268）失败，因 readTargetFileContext 死板取前 160 行、
//   看不到 268 行函数 → 模型编 from → apply patch_replace_from_not_found。修：objective 含 path:line 时按目标行附近取。
//   DI（fsRead/fileExists）便于测试，不真碰盘。

const mk = (content) => ({ fsRead: () => content, fileExists: () => true });
const bigFile = Array.from({ length: 300 }, (_, i) => (i === 267 ? 'export function targetFn() { return 42; }' : `// line ${i + 1}`)).join('\n');

describe('readTargetFileContext line-based 提取', () => {
  it('objective 含 :LINE 且靠后(>maxLines) → 提取目标行附近（含靠后函数）', () => {
    const ctx = readTargetFileContext('为 src/a.js:268 的 targetFn 补 JSDoc', '/p', { maxLines: 160, ...mk(bigFile) });
    expect(ctx).toContain('targetFn'); // 前 160 行截断看不到，line-based 能看到
    expect(ctx).toContain('目标行 268');
  });

  it('objective 无 :LINE → 前 maxLines（逐字现状 fallback，看不到 268）', () => {
    const ctx = readTargetFileContext('改 src/a.js 某处', '/p', { maxLines: 160, ...mk(bigFile) });
    expect(ctx).not.toContain('targetFn');
    expect(ctx).toContain('line 1');
  });

  it('objective :LINE 靠前(<maxLines) → 前 maxLines 覆盖（不变）', () => {
    const early = Array.from({ length: 300 }, (_, i) => (i === 12 ? 'export function early() {}' : `// line ${i + 1}`)).join('\n');
    const ctx = readTargetFileContext('为 src/a.js:13 的 early 补 JSDoc', '/p', { maxLines: 160, ...mk(early) });
    expect(ctx).toContain('early');
  });

  it('沙箱：逃逸路径(src/../..)不读', () => {
    const ctx = readTargetFileContext('改 src/../../../etc/x.js:1', '/p', mk('secret'));
    expect(ctx).toBe('');
  });

  it('文件不存在 → 跳过（空）', () => {
    const ctx = readTargetFileContext('改 src/a.js:5', '/p', { fsRead: () => 'x', fileExists: () => false });
    expect(ctx).toBe('');
  });

  it('无目标文件路径 → 空', () => {
    expect(readTargetFileContext('纯抒情无路径', '/p', mk('x'))).toBe('');
  });

  it('多行聚合 :75,342 → 覆盖所有目标行的窗口（同文件多函数一次取）', () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i === 74 ? 'export function f1(){}' : (i === 341 ? 'export function f2(){}' : `// line ${i + 1}`))).join('\n');
    const ctx = readTargetFileContext('为 src/a.js:75,342 补 JSDoc', '/p', { maxLines: 160, ...mk(lines) });
    expect(ctx).toContain('f1'); // 75
    expect(ctx).toContain('f2'); // 342（前160看不到，多行窗口覆盖到）
    expect(ctx).toContain('目标行 75,342');
  });
});
