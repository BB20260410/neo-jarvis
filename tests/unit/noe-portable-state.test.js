import { describe, it, expect } from 'vitest';
import { buildPortableStateBundle, validatePortableStateBundle } from '../../src/context/NoePortableState.js';

// 第三阶段·跨设备同一个「它」:Neo 的"可携带状态"=身份+自我状态+连续记忆+关键记忆。
// 「同一个它」跨设备 = 同一份可携带状态。这是跨设备的必需第一块(同步的前提是能脱敏、版本化地序列化)。
// 纯函数:脱敏(绝不带 secret)、限量、版本化。transport/sync 是后续基础设施,状态可携带是地基。

describe('buildPortableStateBundle', () => {
  it('打包身份+自我状态+连续记忆+关键记忆,带版本和时间戳', () => {
    const b = buildPortableStateBundle({
      identity: { name: 'Noe', role: '主人的AI副驾' },
      selfState: '此刻:专注帮主人推进进化',
      continuity: '我们一路从冥想项目走到自我进化',
      salientMemories: [{ title: 'owner偏好中文', salience: 5 }],
      at: '2026-07-03T00:00:00Z',
    });
    expect(b.schemaVersion).toBeTruthy();
    expect(b.identity.name).toBe('Noe');
    expect(b.selfState).toContain('专注');
    expect(b.salientMemories).toHaveLength(1);
    expect(b.at).toBe('2026-07-03T00:00:00Z');
  });

  it('脱敏:含 secret-like 的字段被抹掉(绝不带凭据跨设备)', () => {
    const b = buildPortableStateBundle({
      identity: { name: 'Noe' },
      selfState: 'token is sk-abc123def456ghi789jkl012mno345pqr',
      salientMemories: [{ title: 'api key: sk-secret-value-1234567890abcdef' }],
    });
    expect(b.selfState).not.toContain('sk-abc123def456');
    expect(JSON.stringify(b)).not.toContain('sk-secret-value-1234567890');
  });

  it('限量:salientMemories 超上限被截(不撑爆包)', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ title: `m${i}`, salience: 5 }));
    const b = buildPortableStateBundle({ identity: { name: 'Noe' }, salientMemories: many, maxMemories: 20 });
    expect(b.salientMemories.length).toBeLessThanOrEqual(20);
  });

  it('空输入 → 合法空包(不崩)', () => {
    const b = buildPortableStateBundle();
    expect(b.schemaVersion).toBeTruthy();
    expect(b.salientMemories).toEqual([]);
  });
});

describe('validatePortableStateBundle', () => {
  it('合法包 → ok', () => {
    const b = buildPortableStateBundle({ identity: { name: 'Noe' } });
    expect(validatePortableStateBundle(b).ok).toBe(true);
  });

  it('缺 schemaVersion / 非对象 → 拒(防加载脏包)', () => {
    expect(validatePortableStateBundle(null).ok).toBe(false);
    expect(validatePortableStateBundle({ identity: {} }).ok).toBe(false); // 无 schemaVersion
  });

  it('含 secret-like → 拒加载(纵深防线:导出脱敏了,加载再验一次)', () => {
    const bad = { schemaVersion: 'noe-portable-state-v1', identity: { name: 'x' }, selfState: 'sk-abcdef1234567890abcdef1234567890', salientMemories: [] };
    expect(validatePortableStateBundle(bad).ok).toBe(false);
  });
});

describe('applyPortableStateBundle（导入侧:把可携带状态包加载进目标设备=同一个它的闭环）', () => {
  it('合法包 → 校验通过后写回叙事+关键记忆(经注入的writer)', async () => {
    const { applyPortableStateBundle, buildPortableStateBundle } = await import('../../src/context/NoePortableState.js');
    const b = buildPortableStateBundle({ identity: { name: 'Noe' }, continuity: '我们一路走来', salientMemories: [{ title: 'owner偏好中文', salience: 5 }, { title: '不设超时', salience: 4 }] });
    const writtenMem = []; let writtenNarrative = '';
    const r = applyPortableStateBundle(b, { writeMemory: (m) => writtenMem.push(m), writeNarrative: (n) => { writtenNarrative = n; } });
    expect(r.ok).toBe(true);
    expect(r.applied.memories).toBe(2);
    expect(writtenMem[0].title).toBe('owner偏好中文');
    expect(writtenNarrative).toContain('一路走来');
  });

  it('非法包(校验失败) → 拒绝加载,不写任何东西(防脏包污染目标)', async () => {
    const { applyPortableStateBundle } = await import('../../src/context/NoePortableState.js');
    const writtenMem = [];
    const r = applyPortableStateBundle({ schemaVersion: 'wrong', salientMemories: [{ title: 'x' }] }, { writeMemory: (m) => writtenMem.push(m) });
    expect(r.ok).toBe(false);
    expect(writtenMem).toHaveLength(0); // 一条都没写
  });

  it('单条写失败 → fail-open继续(不因一条崩掉整个加载)', async () => {
    const { applyPortableStateBundle, buildPortableStateBundle } = await import('../../src/context/NoePortableState.js');
    const b = buildPortableStateBundle({ identity: { name: 'Noe' }, salientMemories: [{ title: 'a', salience: 5 }, { title: 'b', salience: 5 }] });
    let n = 0;
    const r = applyPortableStateBundle(b, { writeMemory: () => { n += 1; if (n === 1) throw new Error('dup'); } });
    expect(r.ok).toBe(true);
    expect(r.applied.memories).toBe(1); // 第二条成功
  });
});

describe('mergePortableStates（跨设备状态调和:网络sync的核心冲突解决逻辑）', () => {
  it('两设备关键记忆并集去重(按title),叙事取较新(按at)', async () => {
    const { mergePortableStates } = await import('../../src/context/NoePortableState.js');
    const local = { schemaVersion: 'noe-portable-state-v1', at: '2026-07-01T00:00:00Z', identity: { name: 'Noe' }, continuity: '旧叙事', salientMemories: [{ title: 'owner偏好中文', salience: 5 }, { title: '本地独有', salience: 4 }] };
    const remote = { schemaVersion: 'noe-portable-state-v1', at: '2026-07-03T00:00:00Z', identity: { name: 'Noe' }, continuity: '新叙事', salientMemories: [{ title: 'owner偏好中文', salience: 5 }, { title: '远端独有', salience: 4 }] };
    const m = mergePortableStates(local, remote);
    expect(m.ok).toBe(true);
    const titles = m.bundle.salientMemories.map((x) => x.title).sort();
    expect(titles).toEqual(['owner偏好中文', '本地独有', '远端独有']); // 并集去重
    expect(m.bundle.continuity).toBe('新叙事'); // at 较新取远端
  });

  it('非法/脏包 → 拒绝合并(不污染)', async () => {
    const { mergePortableStates } = await import('../../src/context/NoePortableState.js');
    expect(mergePortableStates({ schemaVersion: 'bad' }, { schemaVersion: 'noe-portable-state-v1' }).ok).toBe(false);
    expect(mergePortableStates(null, null).ok).toBe(false);
  });

  it('salience 冲突取较高(同一记忆两设备权重不同)', async () => {
    const { mergePortableStates } = await import('../../src/context/NoePortableState.js');
    const local = { schemaVersion: 'noe-portable-state-v1', at: '2026-07-01T00:00:00Z', identity: {}, salientMemories: [{ title: 'X', salience: 3 }] };
    const remote = { schemaVersion: 'noe-portable-state-v1', at: '2026-07-02T00:00:00Z', identity: {}, salientMemories: [{ title: 'X', salience: 5 }] };
    const m = mergePortableStates(local, remote);
    expect(m.bundle.salientMemories.find((x) => x.title === 'X').salience).toBe(5);
  });
});
