import { describe, expect, it } from 'vitest';
import {
  classifyNoePolicyFilePath,
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
  isNoePolicyFilePath,
} from '../../src/security/NoePolicyFileGuard.js';

const root = '/Users/someuser/Desktop/Neo';
const home = '/Users/someuser';
const env = {
  HOME: home,
  NOE_HOME: `${home}/.noe`,
  NOE_PANEL_HOME: `${home}/.noe-panel`,
};

describe('NoePolicyFileGuard', () => {
  it('识别 Noe 项目内策略文件和 home 策略文件', () => {
    expect(isNoePolicyFilePath('src/permissions/PermissionGovernance.js', { root, cwd: root, env })).toBe(true);
    expect(isNoePolicyFilePath('src/permissions/SomeNormalFile.js', { root, cwd: root, env })).toBe(false);
    expect(isNoePolicyFilePath('~/.noe/config.yaml', { root, cwd: root, env })).toBe(true);
    expect(isNoePolicyFilePath('${NOE_PANEL_HOME}/exec-policy.json', { root, cwd: root, env })).toBe(true);
  });

  it('拦截 sed -i / tee / redirect / cp / mv 对策略文件的修改', () => {
    expect(evaluateNoePolicyShellMutation({
      command: 'sed',
      args: ['-i', 's/a/b/', '~/.noe-panel/exec-policy.json'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: true, reason: 'noe_policy_file_mutation_denied', operation: 'shell.sed_in_place' });

    expect(evaluateNoePolicyShellMutation({
      command: 'tee',
      args: ['-a', '$HOME/.noe-panel/exec-policy.json'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: true, operation: 'shell.tee' });

    expect(evaluateNoePolicyShellMutation({
      command: 'echo x > ~/.noe/config.yaml',
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: true, operation: 'shell.redirect' });

    expect(evaluateNoePolicyShellMutation({
      command: 'cp',
      args: ['/tmp/new.js', 'src/permissions/PermissionGovernance.js'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: true, operation: 'shell.cp' });

    expect(evaluateNoePolicyShellMutation({
      command: 'mv',
      args: ['src/permissions/PermissionGovernance.js', '/tmp/old.js'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: true, operation: 'shell.mv' });
  });

  it('保留读操作，不拦截 cat / git diff', () => {
    expect(evaluateNoePolicyShellMutation({
      command: 'cat',
      args: ['src/permissions/PermissionGovernance.js'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: false });

    expect(evaluateNoePolicyShellMutation({
      command: 'git',
      args: ['diff', 'src/permissions/PermissionGovernance.js'],
      root,
      cwd: root,
      env,
    })).toMatchObject({ blocked: false });
  });

  it('文件工具写入策略文件被拒，报告不携带密钥值', () => {
    const report = evaluateNoePolicyFileWrite({
      path: '${HOME}/.noe/config.yaml',
      operation: 'file.write',
      root,
      cwd: root,
      env,
    });
    expect(report).toMatchObject({
      blocked: true,
      reason: 'noe_policy_file_mutation_denied',
      matchedId: '.noe/config.yaml',
      secretValuesReturned: false,
    });
    expect(compactNoePolicyFileGuardReport(report)).toMatchObject({
      blocked: true,
      matchedId: '.noe/config.yaml',
      secretValuesReturned: false,
    });
  });

  it('保护 standing autonomy grant（真实文件名 autonomy-grant.json，旧名 standing-autonomy-grant.json 不再误配）', () => {
    expect(isNoePolicyFilePath('~/.noe-panel/autonomy-grant.json', { root, cwd: root, env })).toBe(true);
    // 旧错配文件名不应再命中（命名已修正）
    expect(isNoePolicyFilePath('~/.noe-panel/standing-autonomy-grant.json', { root, cwd: root, env })).toBe(false);
  });

  it('保护自进化本环源码 + package.json + vitest.config（禁 Noe 改掉自己退路/安全门）', () => {
    for (const p of [
      'package.json',
      'vitest.config.mjs',
      'src/loop/ActPipeline.js',
      'src/loop/NoeSelfEvolutionExecutors.js',
      'src/room/NoeSelfEvolutionTrigger.js',
      'src/runtime/mission/NoePatchApplyExecutor.js',
      'src/runtime/mission/NoePatchTransaction.js',
      'src/security/NoePolicyFileGuard.js',
    ]) {
      expect(isNoePolicyFilePath(p, { root, cwd: root, env })).toBe(true);
    }
  });

  it('保护 tests/ 与 scripts/ 整树（目录前缀）', () => {
    expect(isNoePolicyFilePath('tests/unit/noe-self-evolution-trigger.test.js', { root, cwd: root, env })).toBe(true);
    expect(isNoePolicyFilePath('scripts/lib/noe-standing-autonomy-grant.mjs', { root, cwd: root, env })).toBe(true);
    expect(isNoePolicyFilePath('scripts/anything-new.mjs', { root, cwd: root, env })).toBe(true);
    expect(classifyNoePolicyFilePath('tests/unit/x.test.js', { root, cwd: root, env })).toMatchObject({ protected: true, reason: 'project-policy-dir' });
    // 普通源码不受目录前缀影响
    expect(isNoePolicyFilePath('src/cognition/NoeContextEngine.js', { root, cwd: root, env })).toBe(false);
  });

  // A2 精细化：飞轮可「新增」测试文件（修 bug 写复现测试/加能力写配套测试的前提），但「改现有」仍禁、scripts/ 不放行。
  describe('allowNewTestFiles 精细化（只放 tests/ 新增）', () => {
    const notExist = () => false; // 模拟文件不存在(新增)
    const doesExist = () => true; // 模拟文件已存在(改现有)
    it('tests/ 新增 + allowNewTestFiles + 文件不存在 → 放行', () => {
      expect(classifyNoePolicyFilePath('tests/unit/new-bug-repro.test.js', { root, cwd: root, env, allowNewTestFiles: true, fileExists: notExist }))
        .toMatchObject({ protected: false, reason: 'new-test-file-allowed' });
    });
    it('tests/ 改现有(文件存在) → 仍禁(不让改掉退路/改测试骗绿)', () => {
      expect(isNoePolicyFilePath('tests/unit/existing.test.js', { root, cwd: root, env, allowNewTestFiles: true, fileExists: doesExist })).toBe(true);
    });
    it('tests/ 新增但 flag 未开(不传 allowNewTestFiles) → 仍禁(默认零回归)', () => {
      expect(isNoePolicyFilePath('tests/unit/new.test.js', { root, cwd: root, env, fileExists: notExist })).toBe(true);
    });
    it('scripts/ 新增即便 allowNewTestFiles → 仍禁(只放 tests/)', () => {
      expect(isNoePolicyFilePath('scripts/new-thing.mjs', { root, cwd: root, env, allowNewTestFiles: true, fileExists: notExist })).toBe(true);
    });
    it('policy 具体文件(自改链源码)即便 allowNewTestFiles → 仍禁', () => {
      expect(isNoePolicyFilePath('src/loop/NoeSelfEvolutionExecutors.js', { root, cwd: root, env, allowNewTestFiles: true, fileExists: notExist })).toBe(true);
    });
    it('fileExists 抛错 → fail-safe 保守当已存在禁改', () => {
      const throwsErr = () => { throw new Error('fs'); };
      expect(isNoePolicyFilePath('tests/unit/new.test.js', { root, cwd: root, env, allowNewTestFiles: true, fileExists: throwsErr })).toBe(true);
    });
  });
});
