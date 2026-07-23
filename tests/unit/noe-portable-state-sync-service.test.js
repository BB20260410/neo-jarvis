import { describe, it, expect } from 'vitest';
import { createPortableStateSyncService } from '../../src/server/services/portable-state-sync.js';
import { buildPortableStateBundle } from '../../src/context/NoePortableState.js';

// 第三阶段·跨设备网络 sync 软件核心:两台设备通过此服务交换+调和状态。
// sync(remote):导本地态 → mergePortableStates 调和 → 落本地(applyMerged)→ 回合并态(对端也收敛)。DI,fail-open。

describe('createPortableStateSyncService', () => {
  it('收对端包 → 与本地调和 → 落本地 → 回合并态(两端收敛)', () => {
    const local = buildPortableStateBundle({ identity: { name: 'Noe' }, at: '2026-07-01T00:00:00Z', continuity: '本地叙事', salientMemories: [{ title: '本地记忆', salience: 5 }] });
    const remote = buildPortableStateBundle({ identity: { name: 'Noe' }, at: '2026-07-03T00:00:00Z', continuity: '远端叙事', salientMemories: [{ title: '远端记忆', salience: 5 }] });
    let applied = null;
    const svc = createPortableStateSyncService({ exportLocal: () => local, applyMerged: (b) => { applied = b; } });
    const r = svc.sync(remote);
    expect(r.ok).toBe(true);
    const titles = r.merged.salientMemories.map((m) => m.title).sort();
    expect(titles).toEqual(['本地记忆', '远端记忆']); // 并集
    expect(r.merged.continuity).toBe('远端叙事'); // at 较新
    expect(applied).toBe(r.merged); // 已落本地(本设备也收敛)
  });

  it('对端脏包 → 拒绝,不落本地', () => {
    let applied = false;
    const svc = createPortableStateSyncService({ exportLocal: () => buildPortableStateBundle({ identity: { name: 'Noe' } }), applyMerged: () => { applied = true; } });
    const r = svc.sync({ schemaVersion: 'wrong' });
    expect(r.ok).toBe(false);
    expect(applied).toBe(false); // 脏包绝不落本地
  });

  it('exportLocal 抛错 → fail-open 返错不崩', () => {
    const svc = createPortableStateSyncService({ exportLocal: () => { throw new Error('db'); }, applyMerged: () => {} });
    const r = svc.sync(buildPortableStateBundle({ identity: { name: 'Noe' } }));
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
