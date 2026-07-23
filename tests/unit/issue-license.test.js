// @ts-check
// issue-license CLI 失败路径单测：参数校验 + 私钥缺失。
// 全程用临时 HOME 隔离，绝不触碰真实 ~/.noe-panel-keys 私钥；成功签发路径(需真私钥)不在此覆盖。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/issue-license.js');

function run(args, homeDir) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  });
}

describe('issue-license CLI 失败路径(参数校验/私钥缺失)', () => {
  let tmpHome;
  beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-issue-license-')); });
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

  it('无参数 → exit 1 且打印用法', () => {
    const r = run([], tmpHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('用法');
  });

  it('email 不含 @ → exit 1 且打印用法', () => {
    const r = run(['foo'], tmpHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('用法');
  });

  it('合法 email 但私钥不存在(隔离空HOME) → exit 1 且提示私钥路径', () => {
    const r = run(['buyer@x.com', 'pro', '365'], tmpHome);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('私钥不存在');
    expect(r.stderr).toContain('panel-license-private-key.pem');
  });

  it('测试隔离正确:用的是临时HOME,没碰真实 .noe-panel-keys', () => {
    expect(tmpHome).not.toContain('.noe-panel-keys');
    expect(fs.existsSync(path.join(tmpHome, '.noe-panel-keys'))).toBe(false);
  });
});
