// NoeCircadian（内在世界·支柱⑦ 时间节律）单测：
// 纯函数边界小时 + 各消费方门控行为（proactiveTick / NoeSelfModel.inferMood / 反刍 tick 判定）。
// 纪律：全 fake 注入不连真库；断言三件事——注入时行为正确、未注入时零影响（与现状逐字一致）、依赖抛错 fail-open。
import { describe, expect, it } from 'vitest';
import {
  phaseOf, isQuiet, shouldRunQuietTick, defaultCircadian,
  CIRCADIAN_MULTIPLIERS, PHASES, QUIET_START_HOUR, QUIET_END_HOUR,
} from '../../src/loop/NoeCircadian.js';
import { createProactiveTickHandler } from '../../src/loop/proactiveTick.js';
import { NoeSelfModel, inferMood } from '../../src/context/NoeSelfModel.js';

// 用本机时区构造时间戳（模块按本机时区取小时），测试结果与机器时区无关。
const at = (hour, minute = 0) => new Date(2026, 5, 10, hour, minute).getTime();

describe('phaseOf：四相边界小时（本机时区）', () => {
  it('night→morning 边界：04:59 night / 05:00 morning', () => {
    expect(phaseOf(at(4, 59))).toBe('night');
    expect(phaseOf(at(5, 0))).toBe('morning');
  });
  it('morning→day 边界：10:59 morning / 11:00 day', () => {
    expect(phaseOf(at(10, 59))).toBe('morning');
    expect(phaseOf(at(11, 0))).toBe('day');
  });
  it('day→evening 边界：17:59 day / 18:00 evening', () => {
    expect(phaseOf(at(17, 59))).toBe('day');
    expect(phaseOf(at(18, 0))).toBe('evening');
  });
  it('evening→night 边界：22:59 evening / 23:00 night；午夜也是 night', () => {
    expect(phaseOf(at(22, 59))).toBe('evening');
    expect(phaseOf(at(23, 0))).toBe('night');
    expect(phaseOf(at(0, 0))).toBe('night');
  });
  it('返回值恒在 PHASES 白名单内；非法时间戳回落 day（fail-open 不调制）', () => {
    for (let h = 0; h < 24; h += 1) expect(PHASES).toContain(phaseOf(at(h)));
    expect(phaseOf(NaN)).toBe('day');
    expect(phaseOf(Infinity)).toBe('day');
  });
});

describe('isQuiet：静默时段 23:00-08:00 边界', () => {
  it('入静边界：22:59 否 / 23:00 是', () => {
    expect(isQuiet(at(22, 59))).toBe(false);
    expect(isQuiet(at(23, 0))).toBe(true);
  });
  it('出静边界：07:59 是 / 08:00 否', () => {
    expect(isQuiet(at(7, 59))).toBe(true);
    expect(isQuiet(at(8, 0))).toBe(false);
  });
  it('午夜/白天/非法时间戳', () => {
    expect(isQuiet(at(0, 0))).toBe(true);
    expect(isQuiet(at(14, 0))).toBe(false);
    expect(isQuiet(NaN)).toBe(false);   // 判不出节律 → 非静默（fail-open）
  });
  it('常量与倍率表形状（消费方引用点）', () => {
    expect(QUIET_START_HOUR).toBe(23);
    expect(QUIET_END_HOUR).toBe(8);
    expect(CIRCADIAN_MULTIPLIERS.innerMonologueQuietFactor).toBe(4);
    expect(CIRCADIAN_MULTIPLIERS.proactiveQuietSpeak).toBe(false);
    expect(Object.isFrozen(CIRCADIAN_MULTIPLIERS)).toBe(true);
    expect(Object.isFrozen(defaultCircadian)).toBe(true);
    expect(defaultCircadian.phaseOf).toBe(phaseOf);
    expect(defaultCircadian.isQuiet).toBe(isQuiet);
  });
});

describe('shouldRunQuietTick：反刍 timer tick 内判定（消费方=server.js 反刍块）', () => {
  const base = { nowMs: 1_000_000, intervalMs: 100 };
  it('非静默时段每 tick 照常跑', () => {
    expect(shouldRunQuietTick({ ...base, quiet: false, lastRunAt: base.nowMs - 1 })).toBe(true);
  });
  it('静默时段有效间隔×4：不足 4 倍间隔跳过，到 4 倍才跑', () => {
    expect(shouldRunQuietTick({ ...base, quiet: true, lastRunAt: base.nowMs - 399 })).toBe(false);
    expect(shouldRunQuietTick({ ...base, quiet: true, lastRunAt: base.nowMs - 400 })).toBe(true);
  });
  it('首次（lastRunAt=0）允许执行一次', () => {
    expect(shouldRunQuietTick({ ...base, quiet: true })).toBe(true);
  });
  it('参数非法 → 照常跑（fail-open 不拦截反刍）', () => {
    expect(shouldRunQuietTick({ quiet: true, nowMs: NaN, intervalMs: 100 })).toBe(true);
    expect(shouldRunQuietTick({ quiet: true, nowMs: 1000, intervalMs: 0 })).toBe(true);
    expect(shouldRunQuietTick()).toBe(true);
  });
});

describe('消费方：proactiveTick 夜间静默门控', () => {
  const T = 100_000_000; // 远大于默认冷却
  function makeTick({ isQuiet: quietFn, adapterCalls = { n: 0 }, store = null } = {}) {
    return createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户在写代码' }) },
      getAdapter: () => ({ chat: async () => { adapterCalls.n += 1; return { reply: '歇会儿吧' }; } }),
      commitmentStore: store,
      isQuiet: quietFn,
      now: () => T,
    });
  }

  it('注入 isQuiet=夜间 → 不开口(quiet_hours)、不跑大脑、不消费到期承诺（留店=顺延到出静后）', async () => {
    const adapterCalls = { n: 0 };
    let dueCalls = 0;
    const resolved = [];
    const store = { due: () => { dueCalls += 1; return [{ id: 'c1', text: '提醒喝水' }]; }, resolve: (id) => resolved.push(id) };
    const r = await makeTick({ isQuiet: () => true, adapterCalls, store })();
    expect(r).toEqual({ spoke: false, reason: 'quiet_hours' });
    expect(adapterCalls.n).toBe(0);
    expect(dueCalls).toBe(0);       // due 没被取 → earliest 已到的承诺仍 open，明早第一个 tick 自然提起
    expect(resolved).toEqual([]);   // 绝没被 resolve 掉（不丢提醒）
  });

  it('force=true 手动/调试绕过夜间静默，照常开口', async () => {
    const r = await makeTick({ isQuiet: () => true })({ force: true });
    expect(r.spoke).toBe(true);
    expect(r.text).toBe('歇会儿吧');
  });

  it('未注入 isQuiet（门控 OFF）→ 行为与现状一致，照常开口', async () => {
    const r = await makeTick({})();
    expect(r.spoke).toBe(true);
  });

  it('isQuiet 抛错 → 按非夜处理照常开口（fail-open 不破坏主流程）', async () => {
    const r = await makeTick({ isQuiet: () => { throw new Error('boom'); } })();
    expect(r.spoke).toBe(true);
  });

  it('出静后（isQuiet=false）到期承诺照常消费提起', async () => {
    const resolved = [];
    const store = { due: () => [{ id: 'c1', text: '提醒喝水' }], resolve: (id) => resolved.push(id) };
    const r = await makeTick({ isQuiet: () => false, store })();
    expect(r.spoke).toBe(true);
    expect(resolved).toEqual(['c1']);
  });
});

describe('消费方：NoeSelfModel 时间节律（timeOfDay + 深夜心境）', () => {
  const NIGHT = at(2, 0);   // 深夜 02:00（night + quiet）
  const NOON = at(12, 0);   // 白天 12:00
  const ep = (type, summary, sinceMs, t = NIGHT, salience = 3) => ({ type, summary, salience, ts: t - sinceMs });
  const make = ({ recent = [], circadian, now = NIGHT } = {}) => new NoeSelfModel({
    timeline: { recent: () => recent },
    hostContextBlock: () => '',
    circadian,
    now: () => now,
  });

  it('未注入 circadian（门控 OFF）→ snapshot 无 timeOfDay 键、深夜心境不出现（与现状逐字一致）', () => {
    const recent = [ep('observation', '看了眼屏幕', 2 * 3600000)];
    const s = make({ recent }).snapshot();
    expect('timeOfDay' in s.situation).toBe(false);
    expect(s.state.mood).toBe(inferMood(recent, NIGHT));   // 与既有两参启发式逐字一致
    expect(s.state.mood).toBe('有阵子没 owner 的消息了，有点惦记');   // 无 interaction → 既有「惦记」分支，深夜分支未启用
  });

  it('inferMood 第三参缺省/null 与两参调用逐字一致（含空经历）', () => {
    expect(inferMood([], NIGHT, null)).toBe(inferMood([], NIGHT));
    const recent = [ep('interaction', '聊天', 26 * 3600000)];
    expect(inferMood(recent, NIGHT, null)).toBe(inferMood(recent, NIGHT));
  });

  it('注入 circadian + 深夜无即时活动 → timeOfDay=night、心境「夜深了，安静守着」', () => {
    const s = make({ recent: [ep('observation', '看了眼屏幕', 2 * 3600000)], circadian: defaultCircadian }).snapshot();
    expect(s.situation.timeOfDay).toBe('night');
    expect(s.state.mood).toBe('夜深了，安静守着');
  });

  it('深夜空经历也安静守着；深夜盖过「有点惦记」背景态', () => {
    expect(inferMood([], NIGHT, defaultCircadian)).toBe('夜深了，安静守着');
    expect(inferMood([ep('observation', '看屏幕', 26 * 3600000)], NIGHT, defaultCircadian)).toBe('夜深了，安静守着');
  });

  it('深夜但即时活动优先：聊得正起劲/刚反刍仍盖过夜', () => {
    const chatting = [ep('interaction', 'a', 1000), ep('interaction', 'b', 5 * 60000)];
    expect(inferMood(chatting, NIGHT, defaultCircadian)).toBe('和 owner 聊得正起劲');
    expect(inferMood([ep('inner_monologue', '想事', 5 * 60000)], NIGHT, defaultCircadian)).toBe('刚自己想了会儿事，思绪还在飘');
  });

  it('白天注入 circadian → timeOfDay=day、心境不带夜（节律只在静默时段起作用）', () => {
    const recent = [ep('observation', '看屏幕', 2 * 3600000, NOON)];
    const s = make({ recent, circadian: defaultCircadian, now: NOON }).snapshot();
    expect(s.situation.timeOfDay).toBe('day');
    expect(s.state.mood).toBe(inferMood(recent, NOON));
  });

  it('circadian 依赖抛错 → fail-open：快照正常返回、无 timeOfDay、心境回落既有启发式', () => {
    const bad = { phaseOf: () => { throw new Error('boom'); }, isQuiet: () => { throw new Error('boom'); } };
    const recent = [ep('observation', '看屏幕', 2 * 3600000)];
    const s = make({ recent, circadian: bad }).snapshot();
    expect('timeOfDay' in s.situation).toBe(false);
    expect(s.state.mood).toBe(inferMood(recent, NIGHT));
  });
});
