// @ts-nocheck
// P3.3 自改失败入 memory（复用 NoeFailureLessons，非平行体系）集成验证：
//   证明 selfEvolve 失败 act（action='noe.self_evolution'）走 NoeFailureLessons.observe 时
//   分类 + cooldown 去重 + cleanText 脱敏都生效（server.js recordSelfEvolutionFailure 即调此路径）。
import { describe, it, expect } from 'vitest';
import { createNoeFailureLessons } from '../../src/cognition/NoeFailureLessons.js';

function makeFL({ now = () => 1000, cooldownMs = 60000 } = {}) {
  const writes = [];
  const store = new Map();
  const fl = createNoeFailureLessons({
    memoryWrite: (e) => { writes.push(e); return { id: 'm' + writes.length }; },
    now,
    cooldownMs,
    state: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
  });
  return { fl, writes };
}

describe('P3.3 selfEvolve 失败复用 NoeFailureLessons（分类+脱敏+去重）', () => {
  it('selfEvolve 失败 act → 写一条 failure_lesson + 脱敏（不写 secret）', () => {
    const { fl, writes } = makeFL();
    const r = fl.observe({ action: 'noe.self_evolution', status: 'failed', failure_reason: 'numFailedTests=3 api_key=sk-SECRETSECRETSECRET0123 leaked' });
    expect(r.created).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].sourceType).toBe('failure_lesson');
    expect(writes[0].body).not.toContain('sk-SECRETSECRET'); // 脱敏防泄密（cleanText=redactSensitiveText）
  });

  it('同 action+根因 cooldown 窗口内去重（防自改失败刷屏 memory）', () => {
    const { fl, writes } = makeFL({ now: () => 1000, cooldownMs: 60000 });
    fl.observe({ action: 'noe.self_evolution', status: 'failed', failure_reason: 'numFailedTests=3' });
    const r2 = fl.observe({ action: 'noe.self_evolution', status: 'failed', failure_reason: 'numFailedTests=5 again' });
    expect(r2.deduped).toBe(true);
    expect(writes.length).toBe(1); // 去重，不重复写
  });

  it('反向 probe：status 非 failed 不记', () => {
    const { fl, writes } = makeFL();
    const r = fl.observe({ action: 'noe.self_evolution', status: 'ok' });
    expect(r.created).toBeFalsy();
    expect(writes.length).toBe(0);
  });
});
