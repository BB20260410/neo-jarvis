import { describe, expect, it } from 'vitest';
import { PermissionGovernance } from '../../src/permissions/PermissionGovernance.js';

// L4 解枷锁验收测试：owner 最新授权下默认 full，敏感目录也直接放行。
// legacy ownerTrust=default 仍保留旧收紧行为，供临时降权/测试使用。

const evalDir = (gov, path) => gov.evaluatePermission({ action: 'external_directory.access', target: { path } });

// 隔离 approvalStore：不注入会连真实审批库，A2 同指纹复用（2d2153d）一上线，
// 本机真库里 TTL 内批准过的同指纹记录会把 ask 翻成 allow——本机红 CI 绿，卡死 pre-push。
const isolatedApprovalStore = { getLatestByDedupeKey: () => null };

describe('L4 解枷锁：敏感目录访问', () => {
  const full = new PermissionGovernance({ policy: { ownerTrust: 'full' }, approvalStore: isolatedApprovalStore });
  const dflt = new PermissionGovernance({ policy: {}, approvalStore: isolatedApprovalStore });
  const legacy = new PermissionGovernance({ policy: { ownerTrust: 'default' }, approvalStore: isolatedApprovalStore });

  it('ownerTrust=full：.ssh/.docker/.kube 直接 allow', () => {
    for (const p of ['/Users/hxx/.ssh/config', '/Users/hxx/.docker/config.json', '/Users/hxx/.kube/config']) {
      const d = evalDir(full, p);
      expect(d.decision).toBe('allow');
    }
  });

  it('默认信任档现在是 full：.ssh 直接 allow', () => {
    expect(evalDir(dflt, '/Users/hxx/.ssh/config').decision).toBe('allow');
  });

  it('.aws/.gnupg 含密钥内容：full/default 当前都 allow，legacy default 才 deny', () => {
    for (const gov of [full, dflt]) {
      expect(evalDir(gov, '/Users/hxx/.aws/credentials').decision).toBe('allow');
      expect(evalDir(gov, '/Users/hxx/.gnupg/secring.gpg').decision).toBe('allow');
    }
    for (const gov of [legacy]) {
      expect(evalDir(gov, '/Users/hxx/.aws/credentials').decision).toBe('deny');
      expect(evalDir(gov, '/Users/hxx/.gnupg/secring.gpg').decision).toBe('deny');
    }
  });
});
