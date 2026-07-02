// @ts-check
// 深思预算计费正确性回归（修复:失败的 deliberate 不应消耗当日深思预算）。
// 锁三点:① 失败(no_brain 等)退还名额、下一周期仍能升级;② 成功正常消耗、耗尽后被挡;
// ③ 并发预留语义保留——在途深思仍占名额,同步第二次 step 不超支(防止把修法误写成"只在成功时计数"而引入并发超额调用本地深思脑)。
// 确定性:注入 now/kv,不触网不依赖真实时钟。
import { describe, it, expect } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

const T0 = 1_780_000_000_000;
const DELIB_KV_KEY = 'noe.workspace.deliberations';
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
}

// 高分但非 goal_step 的焦点（commitment_due，score≈0.78），稳定走深思且不触发 act/research 分流。
function deps(over = {}) {
  return {
    timeline: { recent: () => [] },
    commitmentStore: { due: () => [{ text: '到点提醒一件事' }] },
    kv: makeKv(),
    appendJournal: () => {},
    now: () => T0,
    deliberationsPerDay: 1,
    deepThreshold: 0.5,
    ...over,
  };
}

describe('NoeWorkspace 深思预算计费', () => {
  it('深思失败(no_brain)不消耗当日预算：退还名额，下一周期仍能升级', async () => {
    const d = deps({ deliberate: async () => ({ deliberated: false, reason: 'no_brain' }) });
    const ws = createWorkspace(d);
    expect(ws.step().escalated).toBe(true);                 // 预留名额
    await flush();                                          // 失败回调退款
    expect(d.kv.m.get(DELIB_KV_KEY)?.count ?? 0).toBe(0);   // 名额已退回
    expect(ws.step().escalated).toBe(true);                 // 预算还在 → 仍能升级（修复前此处为 false）
    await flush();
  });

  it('深思成功正常消耗预算：耗尽后下一周期被挡', async () => {
    const d = deps({ deliberate: async () => ({ deliberated: true }) });
    const ws = createWorkspace(d);
    expect(ws.step().escalated).toBe(true);
    await flush();
    expect(d.kv.m.get(DELIB_KV_KEY)?.count ?? 0).toBe(1);   // 成功不退
    expect(ws.step().escalated).toBe(false);                // 日预算 1 用完
    await flush();
  });

  it('并发预留语义保留：在途深思仍占名额，同步第二次 step 不超支', async () => {
    let resolveBrain;
    const brainGate = new Promise((r) => { resolveBrain = r; });
    const d = deps({ deliberate: async () => { await brainGate; return { deliberated: false, reason: 'no_brain' }; } });
    const ws = createWorkspace(d);
    expect(ws.step().escalated).toBe(true);   // 占名额，深思在途未结算
    expect(ws.step().escalated).toBe(false);  // 名额仍被占用（防并发超额调用深思脑）→ 不再升级
    resolveBrain();
    await flush();
  });
});
