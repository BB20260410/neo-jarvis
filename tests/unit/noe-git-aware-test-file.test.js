import { describe, it, expect } from 'vitest';
import { gitAwareTestFileExists } from '../../src/security/NoePolicyFileGuard.js';

// A2 治本：区分 tracked 人维护测试(A2 该挡改它防假绿) vs untracked 飞轮残留测试(A2 放行覆盖重写)。
//   根治 test_only 补测试 verify_failed→测试残留→self_repair 重写被 A2 挡(只放新建)→preflight_blocked 死循环
//   （实测 focus-chain/roomStartCluster 反复占住 selfEvolve、自主定方向 goal 永走不到 complete）。纯 DI 可测。
describe('gitAwareTestFileExists', () => {
  it('文件不存在 → false(新建，A2 放行新建)', () => {
    expect(gitAwareTestFileExists('/p/x.test.js', '/p', { fileExists: () => false, isTracked: () => true })).toBe(false);
  });

  it('存在且 git tracked → true(人维护现有，A2 挡改它防假绿)', () => {
    expect(gitAwareTestFileExists('/p/x.test.js', '/p', { fileExists: () => true, isTracked: () => true })).toBe(true);
  });

  it('存在但 untracked → false(飞轮残留，视为可覆盖，A2 放行重写 = 根治残留死循环)', () => {
    expect(gitAwareTestFileExists('/p/x.test.js', '/p', { fileExists: () => true, isTracked: () => false })).toBe(false);
  });

  it('isTracked 抛错 → 默认参数兜底不崩(传入的 isTracked 自身负责 fail-open)', () => {
    expect(() => gitAwareTestFileExists('/p/x.test.js', '/p', { fileExists: () => false, isTracked: () => { throw new Error('x'); } })).not.toThrow();
  });
});
