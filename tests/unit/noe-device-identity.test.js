import { describe, it, expect } from 'vitest';
import { resolveDeviceIdentity, tagBundleWithDevice, describeBundleOrigin } from '../../src/context/NoeDeviceIdentity.js';

// 第三阶段·跨设备同一个「它」:设备身份 building block。每台机器稳定身份;状态包标注来源设备,
// 加载时知道「这是哪台机器的它、几时导的」——多设备不混淆,冲突可判。纯函数(hostname/platform 注入)。

describe('resolveDeviceIdentity', () => {
  it('据 hostname+platform 产稳定 deviceId(同机器同 id)', () => {
    const a = resolveDeviceIdentity({ hostname: 'MacBook-hxx', platform: 'darwin' });
    const b = resolveDeviceIdentity({ hostname: 'MacBook-hxx', platform: 'darwin' });
    expect(a.deviceId).toBe(b.deviceId); // 稳定
    expect(a.deviceId).toMatch(/^dev-/);
    expect(a.label).toContain('MacBook-hxx');
  });

  it('不同机器 → 不同 deviceId', () => {
    const a = resolveDeviceIdentity({ hostname: 'MacA', platform: 'darwin' });
    const b = resolveDeviceIdentity({ hostname: 'MacB', platform: 'darwin' });
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});

describe('tagBundleWithDevice / describeBundleOrigin', () => {
  it('给状态包盖来源设备戳(deviceId+label+导出时间)', () => {
    const bundle = { schemaVersion: 'noe-portable-state-v1', identity: { name: 'Noe' } };
    const tagged = tagBundleWithDevice(bundle, { hostname: 'MacBook-hxx', platform: 'darwin' }, '2026-07-03T00:00:00Z');
    expect(tagged.originDevice.deviceId).toMatch(/^dev-/);
    expect(tagged.originDevice.label).toContain('MacBook-hxx');
    expect(tagged.originDevice.exportedAt).toBe('2026-07-03T00:00:00Z');
    expect(tagged.identity.name).toBe('Noe'); // 原内容不动
  });

  it('describeBundleOrigin:加载时读得出「来自哪台机器」', () => {
    const tagged = tagBundleWithDevice({ schemaVersion: 'x' }, { hostname: 'MacB', platform: 'darwin' }, '2026-07-03T00:00:00Z');
    const desc = describeBundleOrigin(tagged);
    expect(desc).toContain('MacB');
  });

  it('无来源戳的旧包 → describeBundleOrigin 返「未知来源」不崩', () => {
    expect(describeBundleOrigin({ schemaVersion: 'x' })).toContain('未知');
    expect(describeBundleOrigin(null)).toContain('未知');
  });
});
