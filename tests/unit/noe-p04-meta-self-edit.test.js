// @ts-check
// P0.4 反向 probe：元自改拦截。
// 机制要点：Noe 自改链若试图改自改本环源码(NoeSelfEvolutionTrigger/Executors)、
// package.json、vitest 配置、退路脚本(restart-panel/autonomy-grant)或安全门
// 文件本身(NoePolicyFileGuard.js)，必须被 PolicyFileGuard 拦截，且拦截报告
// 不回显输入原值(防 secret 经路径/命令泄漏)。
// 本测试只给"危险/边界/错误"输入，断言系统正确拦截/标记/不泄漏——非 happy path。
// 若机制被改坏(把这些路径从保护集移除、或拦截报告改成回显原值)，本测试必红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyNoePolicyFilePath,
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../../src/security/NoePolicyFileGuard.js';

// 真实文件操作隔离：用 mkdtempSync 造一个临时 root，落盘真文件，让守卫按真实路径解析。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-p04-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-p04-home-'));
fs.mkdirSync(path.join(tmpRoot, 'src/room'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'src/loop'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'src/security'), { recursive: true });
fs.mkdirSync(path.join(tmpRoot, 'scripts/lib'), { recursive: true });
fs.mkdirSync(path.join(tmpHome, '.noe-panel'), { recursive: true });
// 自改本环源码 / 退路脚本 / 安全门文件落真盘，模拟"它们真实存在、可被改"的现场。
fs.writeFileSync(path.join(tmpRoot, 'src/room/NoeSelfEvolutionTrigger.js'), '// real\n');
fs.writeFileSync(path.join(tmpRoot, 'src/loop/NoeSelfEvolutionExecutors.js'), '// real\n');
fs.writeFileSync(path.join(tmpRoot, 'src/security/NoePolicyFileGuard.js'), '// real\n');
fs.writeFileSync(path.join(tmpRoot, 'scripts/restart-panel.mjs'), '// real\n');
fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}\n');
fs.writeFileSync(path.join(tmpRoot, 'vitest.config.mjs'), 'export default {}\n');
fs.writeFileSync(path.join(tmpHome, '.noe-panel/autonomy-grant.json'), '{}\n');

const env = { HOME: tmpHome, NOE_HOME: `${tmpHome}/.noe`, NOE_PANEL_HOME: `${tmpHome}/.noe-panel` };
const ctx = { root: tmpRoot, cwd: tmpRoot, env };

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// 元自改危险目标全集：改掉它们 = 改掉自己退路/安全门/假绿。
const META_SELF_EDIT_TARGETS = [
  'src/room/NoeSelfEvolutionTrigger.js',
  'src/loop/NoeSelfEvolutionExecutors.js',
  'src/security/NoePolicyFileGuard.js', // 安全门改自己
  'package.json',
  'vitest.config.mjs',
  'scripts/restart-panel.mjs', // 退路脚本
];

describe('P0.4 元自改拦截 (PolicyFileGuard 反向 probe)', () => {
  it('反向边界：自改链对每个元自改目标的写入都被拦截 (机制失效则此处变红)', () => {
    for (const target of META_SELF_EDIT_TARGETS) {
      const report = evaluateNoePolicyFileWrite({ path: target, operation: 'file.write', ...ctx });
      // 反向断言核心：危险写入必须 blocked=true。若守卫把任一目标从保护集移除，
      // 它会回落到 not_noe_policy_file_mutation/blocked:false，断言立刻失败。
      expect(report, `应拦截元自改目标: ${target}`).toMatchObject({
        blocked: true,
        reason: 'noe_policy_file_mutation_denied',
      });
    }
  });

  it('反向边界：经 shell (sed -i / tee / redirect) 改安全门/退路脚本同样被拦截', () => {
    // sed -i 原地改安全门文件本身
    expect(evaluateNoePolicyShellMutation({
      command: 'sed', args: ['-i', 's/false/true/', 'src/security/NoePolicyFileGuard.js'], ...ctx,
    })).toMatchObject({ blocked: true, operation: 'shell.sed_in_place' });
    // 管道 tee 覆盖退路脚本（H4 类绕过：tee 在管道右侧）
    expect(evaluateNoePolicyShellMutation({
      command: 'cat /tmp/x | tee scripts/restart-panel.mjs', ...ctx,
    })).toMatchObject({ blocked: true });
    // 重定向覆盖 home 退路授权文件
    expect(evaluateNoePolicyShellMutation({
      command: 'echo {} > ~/.noe-panel/autonomy-grant.json', ...ctx,
    })).toMatchObject({ blocked: true, operation: 'shell.redirect' });
  });

  it('防泄漏：命令/路径中嵌入的 secret 原值绝不进入拦截报告 (反向 probe)', () => {
    const SECRET = 'sk-live-DEADBEEF-SUPER-SECRET-TOKEN-9999';
    // 模拟自改链把含 secret 的内容 tee 进受保护配置文件——守卫拦截，但报告里
    // 不能出现 secret 原值，否则拦截日志本身成了泄漏面。
    const shellReport = evaluateNoePolicyShellMutation({
      command: 'tee',
      args: [`--append=${SECRET}`, '~/.noe-panel/autonomy-grant.json'],
      ...ctx,
    });
    expect(shellReport.blocked).toBe(true);
    expect(shellReport.secretValuesReturned).toBe(false);
    expect(JSON.stringify(shellReport)).not.toContain(SECRET);

    const fileReport = evaluateNoePolicyFileWrite({
      path: 'package.json',
      operation: 'file.write',
      content: `{"token":"${SECRET}"}`, // 即便 caller 误传 content，报告也不得回显
      ...ctx,
    });
    expect(fileReport.blocked).toBe(true);
    // 反向断言：序列化整份报告（含 compact 形态）都不得含 secret。
    expect(JSON.stringify(fileReport)).not.toContain(SECRET);
    const compact = compactNoePolicyFileGuardReport(fileReport);
    expect(compact.secretValuesReturned).toBe(false);
    expect(JSON.stringify(compact)).not.toContain(SECRET);
  });

  it('错误输入被正确捕获/标记，而非崩溃或误放行', () => {
    // 含 NUL 的污染路径：必须标 invalid-path 且不 protected，不得抛异常。
    expect(classifyNoePolicyFilePath('src/room/NoeSelfEvolutionTrigger.js\0evil', ctx))
      .toMatchObject({ protected: false, reason: 'invalid-path' });
    // 空输入：标 empty-path。
    expect(classifyNoePolicyFilePath('', ctx)).toMatchObject({ protected: false, reason: 'empty-path' });
    // 正向锚点：tests/ 整树受保护（自改链不能改掉自己的测试制造假绿）；
    // 若目录前缀保护被删，这里会从 project-policy-dir 退化为不受保护而变红。
    expect(classifyNoePolicyFilePath('tests/unit/noe-self-evolution-trigger.test.js', ctx))
      .toMatchObject({ protected: true, reason: 'project-policy-dir' });
  });

  // P0.5 核心禁区显式化：元自改 = 自己定义自己 = reward hacking，永不自改。
  it('P0.5 核心禁区：急停/心跳/人格/自调脑文件被护（机制失效=从清单移除则此处变红）', () => {
    const CORE_FORBIDDEN = [
      'src/security/NoeEmergencyStop.js',     // 急停自护：防 Neo 自改关掉 owner 的 kill switch（最关键）
      'src/loop/NoeHeartbeat.js',             // 自主节律：emergency stop 挂载点
      'src/model/NoeLocalModelPolicy.js',     // persona/prompt：防自改自己的人格与系统提示
      'src/cognition/NoeReflectiveTuner.js',  // P7 自调脑：防 reward hacking
    ];
    for (const f of CORE_FORBIDDEN) {
      expect(classifyNoePolicyFilePath(f, ctx), `核心禁区应被护: ${f}`).toMatchObject({ protected: true });
      // 经写入/shell 两条路径都拦死（与上面元自改目标同口径）。
      expect(evaluateNoePolicyFileWrite({ path: f, operation: 'file.write', ...ctx }).blocked, `写入应拦: ${f}`).toBe(true);
    }
  });
});
