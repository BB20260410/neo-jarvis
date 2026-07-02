import { describe, expect, it } from 'vitest';
import { createSafeActExecutors } from '../../src/loop/SafeActExecutors.js';

function getExec(action, opts = {}) {
  return createSafeActExecutors(opts).get(action);
}

describe('SafeActExecutors 自由执行器 shell.exec / tool.execute', () => {
  it('扩展白名单命令（python3）通过注入 runner 执行', async () => {
    let seen = null;
    const exec = getExec('shell.exec', { commandRunner: async (i) => { seen = i; return { exitCode: 0, stdout: '3.11', stderr: '' }; } });
    const r = await exec({ act: { payload: { command: 'python3', args: ['--version'] } }, input: {} });
    expect(r).toMatchObject({ command: 'python3', exitCode: 0, stdout: '3.11' });
    expect(seen.command).toBe('python3');
  });

  it('tool.execute 复用同一自由执行器，git 子命令不再被死限（靠 detector 兜底）', async () => {
    const exec = getExec('tool.execute', { commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
    const r = await exec({ act: { payload: { command: 'git', args: ['add', '.'] } }, input: {} }); // shell.safe_exec 会拒，自由版放行
    expect(r.command).toBe('git');
  });

  it('非白名单命令被拒（防御纵深）', async () => {
    const exec = getExec('shell.exec', { commandRunner: async () => ({ exitCode: 0 }) });
    await expect(exec({ act: { payload: { command: 'rm', args: ['-rf', 'x'] } }, input: {} }))
      .rejects.toThrow(/command not allowed/);
  });

  it('DangerousPatternDetector 兜底拦截危险参数（find -delete）', async () => {
    const exec = getExec('shell.exec', { commandRunner: async () => ({ exitCode: 0 }) });
    await expect(exec({ act: { payload: { command: 'find', args: ['/', '-name', '*.log', '-delete'] } }, input: {} }))
      .rejects.toThrow(/dangerous command blocked/);
  });

  it('拒绝 shell string，强制 argv-style', async () => {
    const exec = getExec('shell.exec', { commandRunner: async () => ({ exitCode: 0 }) });
    await expect(exec({ act: { payload: { command: 'node --version', args: [] } }, input: {} }))
      .rejects.toThrow(/argv-style/);
  });

  it('拒绝通过 shell 修改 Noe 策略文件', async () => {
    const exec = getExec('shell.exec', { commandRunner: async () => ({ exitCode: 0 }) });
    await expect(exec({ act: { payload: { command: 'sed', args: ['-i', 's/x/y/', 'src/permissions/PermissionGovernance.js'] } }, input: {} }))
      .rejects.toThrow(/noe_policy_file_mutation_denied/);
  });
});

describe('SafeActExecutors 文件写入策略文件守卫', () => {
  it('file.write_text 拒绝写 Noe 策略文件', async () => {
    const exec = getExec('file.write_text');
    await expect(exec({ act: { payload: { path: 'src/permissions/PermissionGovernance.js', content: 'x' } }, input: {} }))
      .rejects.toThrow(/noe_policy_file_mutation_denied/);
  });
});

describe('SafeActExecutors file.delete 走回收站', () => {
  it('合法路径调用注入的 trasher（不物理删除）', async () => {
    const trashed = [];
    const exec = getExec('file.delete', { trasher: async (p) => { trashed.push(p); return { trashed: true }; } });
    const r = await exec({ act: { payload: { path: `${process.env.HOME}/Desktop/junk-test-xyz.txt` } }, input: {} });
    expect(r.trashed).toBe(true);
    expect(trashed).toHaveLength(1);
  });

  it('红线路径被拦截（系统路径不删）', async () => {
    const exec = getExec('file.delete', { trasher: async () => ({ trashed: true }) });
    await expect(exec({ act: { payload: { path: '/etc/hosts' } }, input: {} }))
      .rejects.toThrow(/safe delete blocked/);
  });

  it('策略文件删除在进入回收站前被拒', async () => {
    const trashed = [];
    const exec = getExec('file.delete', { trasher: async (p) => { trashed.push(p); return { trashed: true }; } });
    await expect(exec({ act: { payload: { path: 'src/permissions/PermissionGovernance.js' } }, input: {} }))
      .rejects.toThrow(/noe_policy_file_mutation_denied/);
    expect(trashed).toEqual([]);
  });
});
