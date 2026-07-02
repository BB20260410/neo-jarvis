// @ts-check
// 前置 env 装载（src/bootstrap/load-env.js）单测：
// 注意：import 本模块的瞬间，其模块体副作用已把项目根 .env 装载过一次（真实行为，
// 与生产一致）。下面的用例全部用独占变量名+临时文件，不依赖也不污染真实 .env。
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnvInto } from '../../src/bootstrap/load-env.js';

const TMP = mkdtempSync(join(tmpdir(), 'noe-loadenv-'));
const cleanupKeys = [];

afterEach(() => {
  for (const k of cleanupKeys.splice(0)) delete process.env[k];
});

describe('loadEnvInto', () => {
  it('把 .env 文件中的新变量装进 process.env', () => {
    const file = join(TMP, 'a.env');
    writeFileSync(file, 'NOE_TEST_LOADENV_NEW=hello\n');
    cleanupKeys.push('NOE_TEST_LOADENV_NEW');
    expect(loadEnvInto(file)).toBe(true);
    expect(process.env.NOE_TEST_LOADENV_NEW).toBe('hello');
  });

  it('不覆盖已存在的环境变量（launchd/shell 注入优先）', () => {
    const file = join(TMP, 'b.env');
    writeFileSync(file, 'NOE_TEST_LOADENV_KEEP=fromfile\n');
    cleanupKeys.push('NOE_TEST_LOADENV_KEEP');
    process.env.NOE_TEST_LOADENV_KEEP = 'fromshell';
    expect(loadEnvInto(file)).toBe(true);
    expect(process.env.NOE_TEST_LOADENV_KEEP).toBe('fromshell');
  });

  it('文件缺失时返回 false 且不抛（fail-open）', () => {
    expect(loadEnvInto(join(TMP, '不存在.env'))).toBe(false);
  });

  it('支持 URL 形态的路径（server.js 真实用法）', () => {
    const file = join(TMP, 'c.env');
    writeFileSync(file, 'NOE_TEST_LOADENV_URL=ok\n');
    cleanupKeys.push('NOE_TEST_LOADENV_URL');
    expect(loadEnvInto(new URL(`file://${file}`))).toBe(true);
    expect(process.env.NOE_TEST_LOADENV_URL).toBe('ok');
  });
});

// 进程退出时清掉临时目录（vitest worker 内安全）
process.on('exit', () => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 容错 */ }
});
