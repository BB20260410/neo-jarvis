// @ts-check
// 共享原子写 helper 的行为锁定测试（强健工程：持久化 bug 家族的统一地基）
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { atomicWriteFile, atomicWriteJson, readJsonWithCorruptBackup } from '../../src/state/atomicJsonFile.js';

const dir = mkdtempSync(join(tmpdir(), 'noe-atomic-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('atomicJsonFile helper', () => {
  it('写读回环 + 自动建目录 + 不留 .tmp', () => {
    const f = join(dir, 'sub', 'a.json');
    atomicWriteJson(f, { x: 1, 中文: '值' });
    expect(readJsonWithCorruptBackup(f)).toEqual({ x: 1, 中文: '值' });
    expect(existsSync(f + '.tmp')).toBe(false);
  });

  it('第二次写之前备份上一代到 .bak-latest', () => {
    const f = join(dir, 'b.json');
    atomicWriteJson(f, { gen: 1 });
    expect(existsSync(f + '.bak-latest')).toBe(false); // 首写无旧可备
    atomicWriteJson(f, { gen: 2 });
    expect(JSON.parse(readFileSync(f + '.bak-latest', 'utf-8'))).toEqual({ gen: 1 });
    expect(readJsonWithCorruptBackup(f)).toEqual({ gen: 2 });
  });

  it('backup:false 可关备份', () => {
    const f = join(dir, 'c.json');
    atomicWriteJson(f, { gen: 1 }, { backup: false });
    atomicWriteJson(f, { gen: 2 }, { backup: false });
    expect(existsSync(f + '.bak-latest')).toBe(false);
  });

  it('损坏 JSON：备份成 .corrupted-*.bak 并返 null，原始证据不灭失', () => {
    const f = join(dir, 'd.json');
    writeFileSync(f, '{ 半截损坏', 'utf-8');
    expect(readJsonWithCorruptBackup(f, { label: 'test' })).toBe(null);
    const corrupted = readdirSync(dir).filter((n) => n.startsWith('d.json.corrupted-'));
    expect(corrupted.length).toBe(1);
    expect(readFileSync(join(dir, corrupted[0]), 'utf-8')).toBe('{ 半截损坏');
  });

  it('文件不存在返 null 且不产生备份', () => {
    expect(readJsonWithCorruptBackup(join(dir, '不存在.json'))).toBe(null);
  });

  it('atomicWriteFile 文本版同样原子+备份', () => {
    const f = join(dir, 'e.md');
    atomicWriteFile(f, '# 第一代');
    atomicWriteFile(f, '# 第二代');
    expect(readFileSync(f, 'utf-8')).toBe('# 第二代');
    expect(readFileSync(f + '.bak-latest', 'utf-8')).toBe('# 第一代');
    expect(existsSync(f + '.tmp')).toBe(false);
  });
});
