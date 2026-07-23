import { describe, expect, it } from 'vitest';
import {
  buildHostContextBlock,
  collectHostContext,
  formatDesktopBlock,
  formatGitIdentityBlock,
  formatSshInventoryBlock,
  formatSystemInfoBlock,
} from '../../src/context/NoeHostContext.js';

describe('formatSshInventoryBlock', () => {
  it('渲染 host 元数据（alias → user@host:port）', () => {
    const block = formatSshInventoryBlock([
      { alias: 'prod', hostName: '1.2.3.4', user: 'deploy', port: 2222 },
      { alias: 'gh', hostName: 'github.com', user: 'git' },
    ]);
    expect(block).toContain('已配置的 SSH 主机');
    expect(block).toContain('prod');
    expect(block).toContain('deploy@1.2.3.4:2222');
    expect(block).toContain('git@github.com');
  });
  it('空列表返回空串', () => {
    expect(formatSshInventoryBlock([])).toBe('');
    expect(formatSshInventoryBlock(null)).toBe('');
  });
});

describe('formatGitIdentityBlock', () => {
  it('渲染 name + email', () => {
    expect(formatGitIdentityBlock({ name: '张三', email: 'z@x.com' })).toBe('Git 身份：张三 <z@x.com>');
  });
  it('无身份返回空', () => {
    expect(formatGitIdentityBlock(null)).toBe('');
    expect(formatGitIdentityBlock({})).toBe('');
  });
});

describe('formatDesktopBlock', () => {
  it('应用与文件分组', () => {
    const block = formatDesktopBlock([
      { name: 'Xcode', kind: 'app' },
      { name: '报告.pdf', kind: 'file' },
    ]);
    expect(block).toContain('桌面应用：Xcode');
    expect(block).toContain('桌面文件：报告.pdf');
  });
  it('空返回空', () => {
    expect(formatDesktopBlock([])).toBe('');
  });
});

describe('formatSystemInfoBlock', () => {
  it('渲染芯片/内存/电量', () => {
    const block = formatSystemInfoBlock({ chip: 'Apple M3 Max', memGB: 128 }, { percent: 78, charging: false });
    expect(block).toContain('芯片：Apple M3 Max');
    expect(block).toContain('内存：128GB');
    expect(block).toContain('电量：78%（使用电池）');
  });
  it('充电中标注', () => {
    expect(formatSystemInfoBlock(null, { percent: 50, charging: true })).toContain('充电中');
  });
  it('无信息返回空', () => {
    expect(formatSystemInfoBlock(null, null)).toBe('');
  });
});

describe('buildHostContextBlock', () => {
  it('拼接非空块，空块略过', () => {
    const combined = buildHostContextBlock({ ssh: 'A', git: '', desktop: 'C', system: '' });
    expect(combined).toBe('A\n\nC');
  });
  it('全空返回空串', () => {
    expect(buildHostContextBlock({})).toBe('');
  });
});

describe('collectHostContext PII 门控（默认不出境）', () => {
  const readers = {
    sshReader: () => [{ alias: 'srv', hostName: 'srv.example.com', user: 'deploy' }],
    gitReader: () => ({ name: '真实姓名', email: 'real@example.com' }),
    desktopReader: () => [{ name: '私密项目目录', kind: 'file' }],
    hwDetector: async () => ({ chip: 'M3', memGB: 64 }),
  };

  it('默认（无 flag）git/desktop/ssh 全不采集，即使 reader 有数据；system 保留', async () => {
    const r = await collectHostContext({ ...readers, env: {} });
    expect(r.git).toBe('');
    expect(r.desktop).toBe('');
    expect(r.ssh).toBe('');
    expect(r.system).toContain('M3');
    expect(r.combined).not.toContain('real@example.com');
    expect(r.combined).not.toContain('真实姓名');
    expect(r.combined).not.toContain('私密项目目录');
    expect(r.combined).not.toContain('srv.example.com');
  });

  it('单独开 NOE_HOST_CONTEXT_GIT_IDENTITY=1 时只放行 git 块', async () => {
    const r = await collectHostContext({ ...readers, env: { NOE_HOST_CONTEXT_GIT_IDENTITY: '1' } });
    expect(r.git).toContain('real@example.com');
    expect(r.desktop).toBe('');
    expect(r.ssh).toBe('');
  });

  it('三 flag 全开时全放行', async () => {
    const r = await collectHostContext({
      ...readers,
      env: { NOE_HOST_CONTEXT_GIT_IDENTITY: '1', NOE_HOST_CONTEXT_DESKTOP: '1', NOE_HOST_CONTEXT_SSH: '1' },
    });
    expect(r.git).toContain('真实姓名');
    expect(r.desktop).toContain('私密项目目录');
    expect(r.ssh).toContain('srv.example.com');
  });
});

describe('collectHostContext', () => {
  it('注入 readers 采集并格式化 combined（三 PII flag 全开）', async () => {
    const r = await collectHostContext({
      env: { NOE_HOST_CONTEXT_GIT_IDENTITY: '1', NOE_HOST_CONTEXT_DESKTOP: '1', NOE_HOST_CONTEXT_SSH: '1' },
      sshReader: () => [{ alias: 'srv', hostName: 'srv.com', user: 'u' }],
      gitReader: () => ({ name: 'N', email: 'e@x.com' }),
      desktopReader: () => [{ name: 'App', kind: 'app' }],
      hwDetector: async () => ({ chip: 'M3', memGB: 64 }),
      batteryReader: async () => ({ percent: 90, charging: true }),
    });
    expect(r.ssh).toContain('srv');
    expect(r.git).toContain('N <e@x.com>');
    expect(r.desktop).toContain('App');
    expect(r.system).toContain('M3');
    expect(r.combined).toContain('srv');
    expect(r.combined).toContain('90%');
  });

  it('reader 出错/无数据时不崩，返回空 combined', async () => {
    const r = await collectHostContext({
      env: { NOE_HOST_CONTEXT_GIT_IDENTITY: '1', NOE_HOST_CONTEXT_DESKTOP: '1', NOE_HOST_CONTEXT_SSH: '1' },
      sshReader: () => [],
      gitReader: () => null,
      desktopReader: () => [],
    });
    expect(r.combined).toBe('');
  });
});
