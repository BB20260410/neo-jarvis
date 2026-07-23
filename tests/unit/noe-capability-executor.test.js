import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerNoeCapabilityExecutors, NOE_CAPABILITY_DIR, listInstalledCapabilities, loadInstalledCapability } from '../../src/capabilities/NoeCapabilityExecutor.js';

// ③ 能力安装执行器（高危核心）。mock spawn 不真装；验多重安全门 + 隔离安装 + 失败回滚。

let root;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'noe-cap-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function spawnMock({ installCode = 0, verifyCode = 0 } = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'npm') return { exitCode: installCode, stdout: '', stderr: '' };
    if (cmd === 'node') return { exitCode: verifyCode, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

function makeExec({ authorized = true, spawnFn, appendEvent } = {}) {
  const executors = registerNoeCapabilityExecutors(new Map(), {
    root,
    evaluateGrant: () => ({ authorized }),
    spawnFn,
    appendEvent,
  });
  return executors.get('noe.capability.install');
}

const npmAct = (name = 'turndown') => ({ act: { payload: { capability: { type: 'npm', name, installSpec: name } } } });

describe('NoeCapabilityExecutor — 安装执行器多重安全门', () => {
  it('合法 npm + 装成功 + 验证通过 → installed（隔离目录，不碰主 node_modules）', async () => {
    const spawnFn = spawnMock({ installCode: 0, verifyCode: 0 });
    const events = [];
    const exec = makeExec({ spawnFn, appendEvent: (e) => { events.push(e); return 'evt-1'; } });
    const out = await exec(npmAct('turndown'));
    expect(out.installed).toBe(true);
    expect(out.verified).toBe(true);
    expect(out.installDir).toContain(NOE_CAPABILITY_DIR);
    expect(out.secretValuesReturned).toBe(false);
    // 隔离安装：npm install 带 --prefix 到隔离目录
    const npmCall = spawnFn.calls.find((c) => c.cmd === 'npm');
    expect(npmCall.args).toContain('--prefix');
    expect(npmCall.args).toContain('--no-save');
    expect(events[0].kind).toBe('noe_capability_installed');
  });

  it('standing grant 未授权 → throw（主门，最先拦）', async () => {
    const exec = makeExec({ authorized: false, spawnFn: spawnMock() });
    await expect(exec(npmAct())).rejects.toThrow('capability_acquire_requires_standing_grant');
  });

  it('非 npm 类型 → throw（不自动装 github/binary）', async () => {
    const exec = makeExec({ spawnFn: spawnMock() });
    await expect(exec({ act: { payload: { capability: { type: 'mcp_or_repo', name: 'org/x' } } } }))
      .rejects.toThrow('capability_type_not_supported_for_auto_install');
  });

  it('非法包名 → throw（源白名单/包名校验）', async () => {
    const exec = makeExec({ spawnFn: spawnMock() });
    await expect(exec(npmAct('../../etc/passwd'))).rejects.toThrow('capability_invalid_npm_name');
  });

  it('安装失败 → throw + 回滚（删隔离目录）', async () => {
    const spawnFn = spawnMock({ installCode: 1 });
    const exec = makeExec({ spawnFn });
    await expect(exec(npmAct('badpkg'))).rejects.toThrow('capability_install_failed');
    expect(existsSync(resolve(root, NOE_CAPABILITY_DIR, 'badpkg'))).toBe(false);
  });

  it('验证失败（require 崩）→ throw + 回滚', async () => {
    const spawnFn = spawnMock({ installCode: 0, verifyCode: 1 });
    const exec = makeExec({ spawnFn });
    await expect(exec(npmAct('brokenpkg'))).rejects.toThrow('capability_verify_failed');
    expect(existsSync(resolve(root, NOE_CAPABILITY_DIR, 'brokenpkg'))).toBe(false);
  });
});

describe('NoeCapabilityExecutor — 运用层（列举/加载已装能力）', () => {
  it('listInstalledCapabilities：空 → []，有 node_modules → 列出', () => {
    expect(listInstalledCapabilities(root)).toEqual([]);
    mkdirSync(join(root, NOE_CAPABILITY_DIR, 'foo', 'node_modules'), { recursive: true });
    expect(listInstalledCapabilities(root)).toContain('foo');
  });

  it('loadInstalledCapability 未装 → throw capability_not_installed', async () => {
    await expect(loadInstalledCapability(root, 'nope')).rejects.toThrow('capability_not_installed');
  });
});
