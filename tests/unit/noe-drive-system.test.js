// @ts-check
// NoeDriveSystem（内稳态驱力系统）单测：全注入假探针+假时钟，验证驱力计算/竞争/简报克制/fail-open。
import { describe, it, expect } from 'vitest';
import { createDriveSystem, parsePmsetBatt, createBatteryProbe } from '../../src/loop/NoeDriveSystem.js';

const HOUR = 3600_000;
const T0 = 1_700_000_000_000; // 固定假时钟基准

describe('社交驱力', () => {
  it('随距上次交互时长线性饱和（0h→0，2h→0.5，4h+→1）', () => {
    const mk = (elapsed) => createDriveSystem({
      now: () => T0,
      lastInteractionAt: () => T0 - elapsed,
    }).snapshot().drives.find((d) => d.id === 'social');
    expect(mk(0)?.value).toBe(0);
    expect(mk(2 * HOUR)?.value).toBeCloseTo(0.5);
    expect(mk(4 * HOUR)?.value).toBe(1);
    expect(mk(9 * HOUR)?.value).toBe(1); // cap
  });

  it('强度高时文案表达想念', () => {
    const ds = createDriveSystem({ now: () => T0, lastInteractionAt: () => T0 - 5 * HOUR });
    const social = ds.snapshot().drives.find((d) => d.id === 'social');
    expect(social?.desc).toContain('想他');
  });
});

describe('好奇/牵挂/胜任驱力', () => {
  it('好奇按新观察数饱和（8 条满格）', () => {
    const ds = createDriveSystem({ observationCount: () => 4 });
    expect(ds.snapshot().drives.find((d) => d.id === 'curiosity')?.value).toBeCloseTo(0.5);
  });
  it('牵挂按 open 承诺数饱和（4 条满格）', () => {
    const ds = createDriveSystem({ openCommitments: () => 2 });
    expect(ds.snapshot().drives.find((d) => d.id === 'care')?.value).toBeCloseTo(0.5);
  });
  it('胜任直接取失败率', () => {
    const ds = createDriveSystem({ actFailureRate: () => 0.3 });
    expect(ds.snapshot().drives.find((d) => d.id === 'competence')?.value).toBeCloseTo(0.3);
  });
});

describe('资源驱力（抑制器）', () => {
  it('充电中恒为 0', () => {
    const ds = createDriveSystem({ battery: () => ({ percent: 5, charging: true }) });
    expect(ds.snapshot().drives.find((d) => d.id === 'energy')?.value).toBe(0);
  });
  it('电量低于阈值（25%）按缺口比例上升', () => {
    const ds = createDriveSystem({ battery: () => ({ percent: 10, charging: false }) });
    const e = ds.snapshot().drives.find((d) => d.id === 'energy');
    expect(e?.value).toBeCloseTo((25 - 10) / 25);
  });
  it('电量充足为 0', () => {
    const ds = createDriveSystem({ battery: () => ({ percent: 80, charging: false }) });
    expect(ds.snapshot().drives.find((d) => d.id === 'energy')?.value).toBe(0);
  });
});

describe('dominant 竞争与 brief 克制', () => {
  it('dominant 取强度最高的驱力', () => {
    const ds = createDriveSystem({
      now: () => T0,
      lastInteractionAt: () => T0 - 1 * HOUR, // social 0.25
      observationCount: () => 8,              // curiosity 1.0
    });
    expect(ds.snapshot().dominant?.id).toBe('curiosity');
  });

  it('全部驱力低于阈值 → brief 为 null（安静不注入噪声）', () => {
    const ds = createDriveSystem({
      now: () => T0,
      lastInteractionAt: () => T0 - 1 * HOUR, // 0.25
      observationCount: () => 1,              // 0.125
    });
    expect(ds.brief()).toBeNull();
  });

  it('dominant 超阈 → brief 为含数据的中文文案', () => {
    const ds = createDriveSystem({ now: () => T0, lastInteractionAt: () => T0 - 6 * HOUR });
    const brief = ds.brief();
    expect(brief).toContain('社交');
    expect(brief).toContain('6.0 小时');
  });

  it('energy 超阈且非 dominant 时仍附加（抑制器特权）', () => {
    const ds = createDriveSystem({
      now: () => T0,
      lastInteractionAt: () => T0 - 9 * HOUR,             // social 1.0 主导
      battery: () => ({ percent: 5, charging: false }),   // energy 0.8 超阈
    });
    const brief = ds.brief();
    expect(brief).toContain('社交');
    expect(brief).toContain('资源');
    expect(brief).toContain('电量只剩 5%');
  });
});

describe('fail-open（探针缺失/抛错不崩、退出竞争）', () => {
  it('全部探针缺省 → 空驱力、dominant null、brief null', () => {
    const ds = createDriveSystem({});
    const snap = ds.snapshot();
    expect(snap.drives).toEqual([]);
    expect(snap.dominant).toBeNull();
    expect(ds.brief()).toBeNull();
  });

  it('探针抛错 → 仅该驱力退出，其余正常', () => {
    const ds = createDriveSystem({
      observationCount: () => { throw new Error('探针炸了'); },
      openCommitments: () => 4,
    });
    const snap = ds.snapshot();
    expect(snap.drives.map((d) => d.id)).toEqual(['care']);
    expect(snap.dominant?.id).toBe('care');
  });

  it('探针返回非法值（负数/NaN）→ 该驱力退出', () => {
    const ds = createDriveSystem({
      observationCount: () => -3,
      actFailureRate: () => Number.NaN,
      openCommitments: () => 1,
    });
    expect(ds.snapshot().drives.map((d) => d.id)).toEqual(['care']);
  });
});

describe('snapshot TTL 缓存（审查 P1：高频同步路径不放大 SQLite 查询）', () => {
  it('TTL 内复用缓存（探针只跑一次），过 TTL 重新探测', () => {
    let probeCalls = 0;
    let t = T0;
    const ds = createDriveSystem({
      now: () => t,
      openCommitments: () => { probeCalls += 1; return 2; },
      cacheTtlMs: 3000,
    });
    ds.snapshot();
    ds.brief();      // 同一帧内 brief 也走缓存
    ds.snapshot();
    expect(probeCalls).toBe(1);
    t += 5000;       // 过 TTL
    ds.snapshot();
    expect(probeCalls).toBe(2);
  });
});

describe('电池探针', () => {
  it('parsePmsetBatt 解析放电/充电/无电池三态', () => {
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t37%; discharging; 3:20 remaining"))
      .toEqual({ percent: 37, charging: false });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t95%; charging; 0:40 remaining"))
      .toEqual({ percent: 95, charging: true });
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n")).toBeNull(); // 台式机无电池行
  });

  it('createBatteryProbe：首次 null、回调后出值、TTL 内不重复 spawn', () => {
    let calls = 0;
    /** @type {any} */
    let savedCb = null;
    const fakeExec = (_cmd, _args, _opts, cb) => { calls += 1; savedCb = cb; };
    let t = T0;
    const probe = createBatteryProbe({ execFileImpl: /** @type {any} */ (fakeExec), ttlMs: 1000, now: () => t });
    expect(probe()).toBeNull();          // 首次：触发 spawn，但同步返回 null
    expect(calls).toBe(1);
    savedCb(null, '\t60%; discharging;'); // 异步回调写缓存
    t += 100;
    expect(probe()).toEqual({ percent: 60, charging: false }); // TTL 内读缓存
    expect(calls).toBe(1);               // 没有重复 spawn
    t += 2000;
    probe();                             // 过 TTL 再触发
    expect(calls).toBe(2);
  });
});
