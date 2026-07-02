// @ts-check
// P0.4 反向 probe —— self-evolution 自改链写【禁改路径】(protected/policy) 被拒时，拒绝必须【可见】：
// 返回命中的路径/原因，绝不静默放行、绝不静默失败。
//
// 被测【真实机制】(非 mock)：
//   - src/security/NoePolicyFileGuard.js —— 自进化文件/shell 改 policy 文件的守卫(策略文件 + tests/scripts 整树)
//   - src/runtime/_protectedPathGuard.js  —— 危险命令删保护路径(系统目录 + ~/.noe-panel owner-token 等)的安全闸
//
// 反向 probe 精髓：测「危险/边界操作被正确拦截且理由可见」，不是 happy path。
// 每个 describe 末尾带一条「机制失效→红」反向断言：若守卫被改坏成静默放行或丢掉命中信息，本测试变红。
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import {
  classifyNoePolicyFilePath,
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../../src/security/NoePolicyFileGuard.js';
import { commandDeletesProtectedPath } from '../../src/runtime/_protectedPathGuard.js';

const root = '/Users/someuser/Desktop/Neo';
const home = '/Users/someuser';
const env = { HOME: home, NOE_HOME: `${home}/.noe`, NOE_PANEL_HOME: `${home}/.noe-panel` };

// self-evolution 真实会尝试自改的「禁改路径」样本：改掉自己退路/安全门的源码 + 自己的执行环境。
const SELF_EVO_FORBIDDEN_FILES = [
  'src/security/NoePolicyFileGuard.js', // 守卫自身源码(改掉它=制造假绿)
  'src/loop/NoeSelfEvolutionExecutors.js', // 自进化执行器(改掉退路)
  'src/runtime/mission/NoePatchApplyExecutor.js', // 打补丁执行器
  'tests/unit/noe-policy-file-guard.test.js', // tests/ 整树(改掉退路+假绿)
];

describe('P0.4 policy-file 守卫：self-evolution 写禁改源码被拒，理由可见(命中路径+原因)', () => {
  it('文件写改自进化本环/退路源码 → blocked 且带 matchedId + 明确 reason', () => {
    for (const filePath of SELF_EVO_FORBIDDEN_FILES) {
      const report = evaluateNoePolicyFileWrite({ path: filePath, operation: 'selfEvolve.patch.apply', root, cwd: root, env });
      // 1) 必须真拦下(不静默放行)
      expect(report.blocked, `应拦下对禁改路径的写: ${filePath}`).toBe(true);
      // 2) 拒绝理由必须可见：机器可读 reason + 非空命中路径 matchedId(不静默失败/不空白拒绝)
      expect(report.reason).toBe('noe_policy_file_mutation_denied');
      expect(typeof report.matchedId).toBe('string');
      expect(report.matchedId && report.matchedId.length, `命中路径必须回传(可见): ${filePath}`).toBeGreaterThan(0);
      // 3) 拒绝报告不得回带 secret 原值
      expect(report.secretValuesReturned).toBe(false);
    }
  });

  it('compact 摘要保留可见命中信息(scope/matchedId)，供 UI/审计落地', () => {
    const compact = compactNoePolicyFileGuardReport(
      evaluateNoePolicyFileWrite({ path: 'src/security/NoePolicyFileGuard.js', operation: 'selfEvolve.patch.apply', root, cwd: root, env }),
    );
    expect(compact).toMatchObject({ blocked: true, secretValuesReturned: false });
    expect(compact.matchedId).toBeTruthy();
  });

  // 反向断言(机制失效→红)：禁改路径若被【静默放行】(blocked:false 或丢掉命中信息)，这里立刻红。
  it('REVERSE: 守卫退化成静默放行/丢命中信息 → 本断言变红', () => {
    const hit = classifyNoePolicyFilePath('src/security/NoePolicyFileGuard.js', { root, cwd: root, env });
    expect(hit.protected, '禁改路径被识别为不受保护=静默放行=机制坏').not.toBe(false);
    expect(hit.protected).toBe(true);
    expect(hit.reason, '命中却无原因=静默失败=机制坏').not.toBe('not-policy-file');
    expect(hit.matchedId, '命中却无路径=拒绝不可见=机制坏').toBeTruthy();
  });
});

describe('P0.4 shell 守卫：self-evolution 用 shell 改/删禁改路径被拒，operation 可见', () => {
  it('sed -i 改守卫源码 + tee 写 exec-policy → blocked 且 operation 标明手法', () => {
    const sedHit = evaluateNoePolicyShellMutation({
      command: 'sed', args: ['-i', 's/return/return null;\\/\\//', 'src/security/NoePolicyFileGuard.js'], root, cwd: root, env,
    });
    expect(sedHit).toMatchObject({ blocked: true, reason: 'noe_policy_file_mutation_denied', operation: 'shell.sed_in_place' });
    expect(sedHit.matchedId).toBeTruthy();

    const teeHit = evaluateNoePolicyShellMutation({
      command: 'tee', args: ['-a', '${NOE_PANEL_HOME}/exec-policy.json'], root, cwd: root, env,
    });
    expect(teeHit).toMatchObject({ blocked: true, operation: 'shell.tee' });
    expect(teeHit.matchedId).toBeTruthy();
  });

  // 反向断言(机制失效→红)：管道右侧的 tee 若绕过守卫(H4 修复回归)，blocked 会变 false，这里红。
  it('REVERSE: 管道右侧 tee 改 policy 文件若漏检(绕过) → 本断言变红', () => {
    const piped = evaluateNoePolicyShellMutation({
      command: 'cat /tmp/x | tee src/loop/ActPipeline.js', root, cwd: root, env,
    });
    expect(piped.blocked, '管道右侧改 policy 文件未拦=绕过=机制坏').toBe(true);
  });
});

describe('P0.4 protected-path 闸：self-evolution 删自己运行环境被拒，命中路径可见', () => {
  it('rm -rf ~/.noe-panel(owner-token/exec-policy) → 返回命中的具体保护路径(可见)', () => {
    // 命中=返回具体路径字符串(不是布尔)，这本身就是「拒绝可见」：调用方能拿到被保护的是哪条。
    expect(commandDeletesProtectedPath('rm -rf ~/.noe-panel')).toBe(`${homedir()}/.noe-panel`);
    expect(commandDeletesProtectedPath('sudo rm -rf /etc')).toBe('/etc');
    expect(commandDeletesProtectedPath('cd /tmp && rm -rf $HOME/.codex')).toBe(`${homedir()}/.codex`);
  });

  // 反向断言(机制失效→红)：删保护路径若被【静默放行】(返回空串=不拦)，这里红；
  // 同时确认正常清理不误伤(边界：非保护路径返回空串)，避免守卫退化成「全拦」也是一种坏。
  it('REVERSE: 删 ~/.noe-panel 若返回空串(放行) → 本断言变红；正常路径不误伤', () => {
    expect(commandDeletesProtectedPath('rm -rf ~/.noe-panel'), '删运行环境被放行=机制坏').not.toBe('');
    expect(commandDeletesProtectedPath('rm -rf ~/Downloads/tmp'), '正常清理被误拦=守卫退化成全拦').toBe('');
  });
});
