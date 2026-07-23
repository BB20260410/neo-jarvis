// @ts-check
// 性格快照自举（意识工程·阶段2）单测：行为统计收集（各来源独立 fail-open）、清洗、
// 守卫/SILENT/成功流程、self-state 注入行。全注入假依赖+假时钟。
import { describe, it, expect } from 'vitest';
import { createPersonalitySnapshot, collectBehaviorStats, cleanPersonality } from '../../src/context/NoePersonalitySnapshot.js';
import { NoeSelfModel, buildPersonaPin, DEFAULT_IDENTITY } from '../../src/context/NoeSelfModel.js';

const T0 = 1_700_000_000_000;
const HOUR = 3600_000;

function fakeTimeline(counts = { interaction: 10, inner_monologue: 25, observation: 4 }) {
  const events = Object.entries(counts).flatMap(([type, n]) =>
    Array.from({ length: n }, (_, i) => ({ type, summary: `${type}${i}`, ts: T0 - i * HOUR, salience: 3 })));
  return { recent: () => events };
}

describe('collectBehaviorStats', () => {
  it('统计时间线/承诺/驱力三来源，想得比说的多会被点出', () => {
    const lines = collectBehaviorStats({
      timeline: fakeTimeline(),
      commitmentStore: { list: ({ status }) => (status === 'open' ? [1, 2] : [1, 2, 3]) },
      driveSystem: { snapshot: () => ({ dominant: { label: '好奇', value: 0.8 } }) },
      now: () => T0,
    });
    const all = lines.join('\n');
    expect(all).toContain('和主人说了 10 次话');
    expect(all).toContain('自己想了 25 次事');
    expect(all).toContain('我想的比说的多得多');
    expect(all).toContain('办完 3 件，还挂着 2 件');
    expect(all).toContain('「好奇」（强度 80%）');
  });

  it('来源缺失/抛错 → 对应行缺席，其余正常（fail-open）', () => {
    const lines = collectBehaviorStats({
      timeline: { recent: () => { throw new Error('炸'); } },
      commitmentStore: { list: () => [{ id: 1 }] },
      driveSystem: null,
      now: () => T0,
    });
    expect(lines.join('\n')).toContain('答应主人的事');
    expect(lines.join('\n')).not.toContain('说了');
  });
});

describe('cleanPersonality', () => {
  it('剥 think/引号/折行，SILENT→空', () => {
    expect(cleanPersonality('<think>嗯</think>「我注意到我想得多。\n说得少。」')).toBe('我注意到我想得多。 说得少。');
    expect(cleanPersonality('SILENT')).toBe('');
    expect(cleanPersonality(null)).toBe('');
  });
});

describe('refresh 流程', () => {
  const deps = (reply) => ({
    timeline: fakeTimeline(),
    commitmentStore: { list: ({ status }) => (status === 'open' ? [1] : [1, 2]) },
    driveSystem: { snapshot: () => ({ dominant: { label: '社交', value: 0.7 } }) },
    getAdapter: () => ({ chat: async (messages) => ({ reply, _messages: messages }) }),
  });

  it('成功生成 → current() 可读 + 7 天守卫生效 + force 越过', async () => {
    let t = T0;
    const ps = createPersonalitySnapshot({ ...deps('我注意到我最近想得多、说得少，答应的事大都办完了。'), now: () => t });
    const r = await ps.refresh();
    expect(r.refreshed).toBe(true);
    expect(ps.current()?.personality).toContain('想得多');
    t += 24 * HOUR;
    expect((await ps.refresh()).reason).toBe('fresh');       // 7 天内 fresh
    expect((await ps.refresh({ force: true })).refreshed).toBe(true);
  });

  it('SILENT → 保留旧快照；统计太少（<2 行）不跑模型', async () => {
    const ps = createPersonalitySnapshot({ ...deps('SILENT'), now: () => T0 });
    expect((await ps.refresh()).reason).toBe('silent');
    expect(ps.current()).toBeNull();

    const bare = createPersonalitySnapshot({
      timeline: null, commitmentStore: null, driveSystem: null,
      getAdapter: () => ({ chat: async () => ({ reply: 'x' }) }),
      now: () => T0,
    });
    expect((await bare.refresh()).reason).toBe('too_few_stats');
  });

  it('上次观察会喂回 prompt（写变化不照抄）', async () => {
    /** @type {any[]} */
    let captured = [];
    const d = deps('我注意到我变得更主动了。');
    d.getAdapter = () => ({ chat: async (messages) => { captured = messages; return { reply: '我注意到我变得更主动了。' }; } });
    let t = T0;
    const ps = createPersonalitySnapshot({ ...d, now: () => t });
    await ps.refresh();
    t += 8 * 24 * HOUR; // 过守卫
    await ps.refresh();
    expect(captured.find((m) => m.role === 'user').content).toContain('我上次对自己的观察');
  });
});

describe('NoeSelfModel ×性格快照注入', () => {
  const bareTimeline = { recent: () => [] };
  it('有快照 → 自我状态块含「我的性格」行；无/抛错 → 行不出现', () => {
    const withSnap = new NoeSelfModel({
      timeline: /** @type {any} */ (bareTimeline),
      personalitySnapshot: { current: () => ({ personality: '我想得多、说得少。', atMs: T0 }) },
    });
    expect(withSnap.buildSelfStateBlock()).toContain('- 我的性格（从我自己近来的行为里看出来的，不是设定）：我想得多、说得少。');

    const none = new NoeSelfModel({ timeline: /** @type {any} */ (bareTimeline) });
    expect(none.buildSelfStateBlock()).not.toContain('我的性格');

    const boom = new NoeSelfModel({
      timeline: /** @type {any} */ (bareTimeline),
      personalitySnapshot: { current: () => { throw new Error('炸'); } },
    });
    expect(boom.buildSelfStateBlock()).toContain('<noe-self-state>');
  });
});

describe('buildPersonaPin（P7 换路线·persona 挂 system prompt）', () => {
  it('纯函数：缝合性情/性格/叙事为 ≤N 句，缺项跳过，全空返回 ""', () => {
    const full = buildPersonaPin({
      disposition: '诚实、极客、克制地主动',
      personality: '我想得多、说得少。',
      narrative: '我和主人一起把我自己造出来。',
    });
    expect(full.split('\n')).toEqual(['诚实、极客、克制地主动', '我想得多、说得少。', '我和主人一起把我自己造出来。']);
    // 缺项跳过（只剩有内容的句）
    expect(buildPersonaPin({ disposition: '诚实克制', narrative: '' })).toBe('诚实克制');
    // 全空 → ''
    expect(buildPersonaPin({})).toBe('');
    expect(buildPersonaPin({ disposition: '   ', personality: '' })).toBe('');
    // maxSentences 截断
    expect(buildPersonaPin({ disposition: 'a', personality: 'b', narrative: 'c' }, { maxSentences: 2 }).split('\n')).toHaveLength(2);
  });

  it('稳定层：不含 mood/牵挂/处境（与 buildSelfStateBlock 分工）', () => {
    const m = new NoeSelfModel({
      timeline: /** @type {any} */ ({ recent: () => [{ type: 'interaction', summary: 'x', ts: T0, salience: 3 }] }),
      commitmentStore: { list: () => [{ text: '帮主人订机票' }], due: () => [] },
      personalitySnapshot: { current: () => ({ personality: '我想得多、说得少。', atMs: T0 }) },
      narrativeSelf: { current: () => ({ narrative: '我和主人一起造出我自己。', atMs: T0 }) },
      selfModelVersionStore: false, // 隔离磁盘版本库，断言基于 DEFAULT_IDENTITY
    });
    const pin = m.buildPersonaPin();
    expect(pin).toContain(DEFAULT_IDENTITY.disposition); // 性情基底
    expect(pin).toContain('我想得多、说得少。');
    expect(pin).toContain('我和主人一起造出我自己。');
    expect(pin).not.toContain('牵挂'); // 快变层不进 persona-pin
    expect(pin).not.toContain('订机票');
    expect(pin).not.toContain('心境');
  });

  it('方法：personalitySnapshot/narrativeSelf 缺失或抛错 → 优雅降级仅留性情基底', () => {
    const bare = new NoeSelfModel({ timeline: /** @type {any} */ ({ recent: () => [] }), selfModelVersionStore: false });
    expect(bare.buildPersonaPin()).toBe(DEFAULT_IDENTITY.disposition); // 只剩 disposition 一句

    const boom = new NoeSelfModel({
      timeline: /** @type {any} */ ({ recent: () => [] }),
      personalitySnapshot: { current: () => { throw new Error('炸'); } },
      narrativeSelf: { current: () => { throw new Error('炸'); } },
      selfModelVersionStore: false,
    });
    expect(boom.buildPersonaPin()).toBe(DEFAULT_IDENTITY.disposition); // 抛错不影响，仍给稳定基底

    // 装配点契约：provider 返回字符串，可空（调用方据空判不注入）
    const provider = () => boom.buildPersonaPin();
    expect(typeof provider()).toBe('string');
  });

  // Codex#7 防情绪/近况锚定漂移：persona-pin 常挂 system prompt，绝不能固化「此刻驱力 / 正在经历 / 这一周做了什么」
  // 等快变句（逐轮放大成锚定）。personalitySnapshot/narrativeSelf 的 LLM 产出天然夹带时态句，必须被剔除。
  describe('只取真稳定层（剔除快变/近况时态句）', () => {
    it('纯函数：含「此刻驱力X」「正在经历Y」「这一周…」的句子被剔除，只留性格骨架', () => {
      // personality 两句：第一句稳定性格骨架，第二句是快变（「此刻」+「驱力」双标记）。
      const pin = buildPersonaPin({
        disposition: '诚实、极客、克制地主动',
        personality: '我是个想得多、说得少的存在。此刻我最强的内在驱力是好奇。',
        narrative: '我和主人一起把我自己造出来。我们正在经历自我进化这件大事。',
      });
      // 稳定骨架保留
      expect(pin).toContain('想得多、说得少');
      expect(pin).toContain('我和主人一起把我自己造出来');
      // 快变句被剔除
      expect(pin).not.toContain('此刻');
      expect(pin).not.toContain('驱力');
      expect(pin).not.toContain('正在经历');
      expect(pin).not.toContain('自我进化');
      expect(pin).not.toContain('这一周');
    });

    it('纯函数：整段都是快变句 → 该来源被滤空、跳过（不产空行）', () => {
      const pin = buildPersonaPin({
        disposition: '诚实克制',
        personality: '这一周我和主人说了 20 次话。此刻我有点累。',
      });
      expect(pin).toBe('诚实克制'); // personality 全被滤掉，只剩 disposition
    });

    it('方法：personalitySnapshot/narrativeSelf 吐快变句 → buildPersonaPin 输出不含这些快变句', () => {
      const m = new NoeSelfModel({
        timeline: /** @type {any} */ ({ recent: () => [] }),
        // 模拟真实 LLM 产出：性格观察里夹带「这一周/此刻驱力」，叙事里夹带「正在经历+项目名」。
        personalitySnapshot: { current: () => ({ personality: '我注意到我克制而专注。这一周我完成了 3 个里程碑，此刻最强驱力是好奇。', atMs: T0 }) },
        narrativeSelf: { current: () => ({ narrative: '我是 Noe。我们正在经历 P7 三方审这件事。', atMs: T0 }) },
        selfModelVersionStore: false,
      });
      const pin = m.buildPersonaPin();
      // 稳定骨架留下
      expect(pin).toContain('克制而专注');
      expect(pin).toContain('我是 Noe');
      // 快变/近况句全部不进 persona-pin
      expect(pin).not.toContain('这一周');
      expect(pin).not.toContain('里程碑');
      expect(pin).not.toContain('驱力');
      expect(pin).not.toContain('正在经历');
      expect(pin).not.toContain('P7'); // 项目名随近况句一起被剔
    });

    it('稳定句不被误伤：性格词「正直/刚毅」不含快变标记', () => {
      const pin = buildPersonaPin({ disposition: '正直、刚毅、克制' });
      expect(pin).toBe('正直、刚毅、克制'); // 裸单字「正/刚」不在标记词，稳定句完整保留
    });
  });
});
