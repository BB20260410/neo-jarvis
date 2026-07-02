import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { buildMirrorDocuments, writeMirrorDocuments } from '../../src/memory/NoeMemoryMarkdownMirror.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// MemoryCore.topBySalience（高显著记忆查询）+ Basic Memory MD 镜像端到端（记忆→Markdown）。

let tmp;
let core;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-tbs-'));
  initSqlite(join(tmp, 'panel.db'));
  core = new MemoryCore({});
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MemoryCore.topBySalience', () => {
  it('按 salience DESC 取，过滤低于 minSalience', () => {
    core.write({ id: 'low', body: '低显著', salience: 2 });
    core.write({ id: 'mid', body: '中显著', salience: 4 });
    core.write({ id: 'high', body: '高显著', salience: 5 });
    const ids = core.topBySalience({ minSalience: 4, limit: 10 }).map((m) => m.id);
    expect(ids).toEqual(['high', 'mid']); // salience DESC；low(2<4) 过滤
  });

  it('limit 生效 + 默认 minSalience=4 过滤低显著', () => {
    core.write({ id: 'a', body: 'A', salience: 5 });
    core.write({ id: 'b', body: 'B', salience: 5 });
    core.write({ id: 'c', body: 'C', salience: 3 }); // <4 过滤
    expect(core.topBySalience({ limit: 1 })).toHaveLength(1);
    expect(core.topBySalience().map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('hidden 默认排除', () => {
    core.write({ id: 'h', body: '隐藏内容', salience: 5 });
    core.hide('h');
    expect(core.topBySalience().map((m) => m.id)).not.toContain('h');
  });
});

describe('记忆 Markdown 镜像端到端（topBySalience → buildMirrorDocuments）', () => {
  it('NOE_MEMORY_MD_MIRROR=1：高显著记忆导出成含原文的 Markdown', () => {
    const prev = process.env.NOE_MEMORY_MD_MIRROR;
    process.env.NOE_MEMORY_MD_MIRROR = '1';
    try {
      core.write({ id: 'x', body: '主人偏好在傍晚做深度工作', salience: 5 });
      const memories = core.topBySalience({ minSalience: 4 });
      const { enabled, files } = buildMirrorDocuments({ memories }, { env: process.env });
      expect(enabled).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.content.includes('主人偏好在傍晚做深度工作'))).toBe(true);
      expect(files[0].relPath).toMatch(/\.md$/);
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_MD_MIRROR;
      else process.env.NOE_MEMORY_MD_MIRROR = prev;
    }
  });

  it('NOE_MEMORY_MD_MIRROR 默认 OFF：buildMirrorDocuments 返回 enabled:false（零回归）', () => {
    const prev = process.env.NOE_MEMORY_MD_MIRROR;
    delete process.env.NOE_MEMORY_MD_MIRROR;
    try {
      core.write({ id: 'x', body: 'X', salience: 5 });
      const out = buildMirrorDocuments({ memories: core.topBySalience() }, { env: process.env });
      expect(out.enabled).toBe(false);
      expect(out.files).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.NOE_MEMORY_MD_MIRROR = prev;
    }
  });

  it('writeMirrorDocuments 写盘：文件落地且内容正确', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-mdw-'));
    try {
      const written = writeMirrorDocuments({ files: [{ relPath: 'memory/x.md', content: '# 标题\n内容' }], baseDir: dir });
      expect(written).toBe(1);
      const abs = join(dir, 'memory/x.md');
      expect(existsSync(abs)).toBe(true);
      expect(readFileSync(abs, 'utf8')).toContain('# 标题');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writeMirrorDocuments 缺 baseDir/files → 返 0（fail-safe）', () => {
    expect(writeMirrorDocuments({ files: [{ relPath: 'a.md', content: 'x' }] })).toBe(0);
    expect(writeMirrorDocuments({ baseDir: '/tmp' })).toBe(0);
  });
});
