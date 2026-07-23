import { describe, expect, it } from 'vitest';
import { NoeSelfModel, inferMood, DEFAULT_IDENTITY } from '../../src/context/NoeSelfModel.js';

const T0 = 1_780_000_000_000;
const ep = (type, summary, sinceMs, salience = 3) => ({ type, summary, salience, ts: T0 - sinceMs });

function fakeTimeline(recent) {
  return { recent: () => recent };
}

describe('inferMood（行为层心境启发式）', () => {
  it('空经历 → 平稳待命', () => {
    expect(inferMood([], T0)).toBe('平稳，待命中');
  });
  it('30 分钟内 2+ 次交互 → 聊得正起劲', () => {
    const r = [ep('interaction', 'a', 1000), ep('interaction', 'b', 5 * 60000)];
    expect(inferMood(r, T0)).toBe('和 owner 聊得正起劲');
  });
  it('1 小时内高 salience 里程碑 → 踏实', () => {
    const r = [ep('milestone', '做完脊椎', 10 * 60000, 9)];
    expect(inferMood(r, T0)).toBe('刚完成了要紧的事，踏实');
  });
  it('最近一条是内心独白 → 思绪还在飘', () => {
    expect(inferMood([ep('inner_monologue', '想了想意识', 5 * 60000)], T0)).toBe('刚自己想了会儿事，思绪还在飘');
  });
  it('超 24h 没交互 → 有点惦记', () => {
    expect(inferMood([ep('observation', '看了眼屏幕', 26 * 3600000)], T0)).toBe('有阵子没 owner 的消息了，有点惦记');
  });
  it('刚做完梦境整理 → 清明', () => {
    expect(inferMood([ep('dream', '整理记忆', 10 * 60000)], T0)).toBe('梦里刚整理过记忆，清明');
  });
});

describe('NoeSelfModel', () => {
  function make(extra = {}) {
    return new NoeSelfModel({
      timeline: fakeTimeline([ep('interaction', 'owner 问 AI 意识', 2 * 60000), ep('milestone', '接上连续记忆', 30 * 60000, 8)]),
      hostContextBlock: () => '<host>...</host>',
      now: () => T0,
      ...extra,
    });
  }

  it('snapshot：三层结构齐全', () => {
    const s = make().snapshot({ ownerPresent: true });
    expect(s.identity.name).toBe('Noe');
    expect(s.state.mood).toBeTruthy();
    expect(s.state.recentThemes).toContain('owner 问 AI 意识');
    expect(s.situation.ownerPresent).toBe(true);
    expect(s.situation.sinceLastInteraction).toBe('2 分钟前');
    expect(s.situation.hasHostContext).toBe(true);
  });

  it('身份层可注入覆盖（改名/换关系不动代码）', () => {
    const s = make({ identity: { name: '伴影' } }).snapshot();
    expect(s.identity.name).toBe('伴影');
    expect(s.identity.relationship).toBe(DEFAULT_IDENTITY.relationship);   // 未覆盖项保留默认
  });

  it('commitments：优先 due，回退 list(open)', () => {
    const dueStore = { due: () => [{ text: '把脊椎做完' }], list: () => [{ text: '不该用到的' }] };
    expect(make({ commitmentStore: dueStore }).snapshot().state.commitments).toEqual(['把脊椎做完']);
    const listStore = { due: () => [], list: () => [{ text: '回退项' }] };
    expect(make({ commitmentStore: listStore }).snapshot().state.commitments).toEqual(['回退项']);
  });

  it('优雅降级：无 timeline / 无 commitmentStore 不崩', () => {
    const bare = new NoeSelfModel({ timeline: null, hostContextBlock: () => '', now: () => T0 });
    const s = bare.snapshot();
    expect(s.state.mood).toBe('平稳，待命中');
    expect(s.state.commitments).toEqual([]);
    expect(s.situation.sinceLastInteraction).toBeNull();
    expect(s.situation.hasHostContext).toBe(false);
  });

  it('commitmentStore 抛错被吞，不影响快照', () => {
    const bad = { due: () => { throw new Error('boom'); } };
    expect(make({ commitmentStore: bad }).snapshot().state.commitments).toEqual([]);
  });

  it('buildSelfStateBlock：身份恒在，状态/处境有内容才列', () => {
    const text = make({ commitmentStore: { due: () => [{ text: '做完脊椎' }, { text: '想想意识问题' }] } })
      .snapshot({ ownerPresent: true });
    const block = make({ commitmentStore: { due: () => [{ text: '做完脊椎' }] } }).buildSelfStateBlock();
    expect(block).toContain('<noe-self-state>');
    expect(block).toContain('我是谁：Noe');
    expect(block).toContain('牵挂着：1.做完脊椎');
    expect(block).toContain('距上次和 owner 说话 2 分钟前');
    expect(block).toContain('</noe-self-state>');
    void text;
  });

  it('compactState：精简供 timeline.record 的 selfState', () => {
    const c = make({ commitmentStore: { due: () => [{ text: 'x' }] } }).compactState();
    expect(c).toEqual({ mood: expect.any(String), commitmentCount: 1, sinceLastInteraction: '2 分钟前' });
  });

  describe('buildPersonaPin 合并（P8：① P7 自我人设 + ② owner 偏好下沉）', () => {
    const ownerLines = '- 用户要求用中文\n- 用户希望回复 3-5 句';
    const fakePins = (lines = ownerLines) => ({ buildOwnerPreferenceLines: () => lines });

    it('未注入 personaPins → 只剩 P7 自我人设（与现状逐字一致）', () => {
      const pin = make().buildPersonaPin(); // 默认 disposition 基底
      expect(pin).toContain(DEFAULT_IDENTITY.disposition.slice(0, 6));
      expect(pin).not.toContain('用户要求用中文');
    });

    it('注入 personaPins → ① 自我人设在前、② owner 偏好在后，拼成一段', () => {
      const pin = make({ personaPins: fakePins() }).buildPersonaPin();
      const idxSelf = pin.indexOf(DEFAULT_IDENTITY.disposition.slice(0, 6));
      const idxOwner = pin.indexOf('用户要求用中文');
      expect(idxSelf).toBeGreaterThanOrEqual(0);
      expect(idxOwner).toBeGreaterThan(idxSelf); // owner 偏好在自我人设之后
      expect(pin).toContain('用户希望回复 3-5 句');
    });

    it('owner 偏好为空 → 退回只剩 P7 自我人设（不留空行）', () => {
      const pin = make({ personaPins: fakePins('') }).buildPersonaPin();
      expect(pin).toContain(DEFAULT_IDENTITY.disposition.slice(0, 6));
      expect(pin.endsWith('\n')).toBe(false);
    });

    it('personaPins 抛错 fail-open：不破坏 P7 自我人设输出', () => {
      const bad = { buildOwnerPreferenceLines: () => { throw new Error('boom'); } };
      const pin = make({ personaPins: bad }).buildPersonaPin();
      expect(pin).toContain(DEFAULT_IDENTITY.disposition.slice(0, 6));
    });

    it('P7 stableSentencesOnly 仍生效：注入的快变性格句被剔，不混进 persona-pin', () => {
      // personalitySnapshot 给一句夹「最近」时态的句子 → 应被 stableSentencesOnly 滤掉
      const snap = { current: () => ({ personality: '最近一周我一直在改记忆层。' }) };
      const pin = make({ personalitySnapshot: snap, personaPins: fakePins() }).buildPersonaPin();
      expect(pin).not.toContain('最近一周');     // 快变句被剔
      expect(pin).toContain('用户要求用中文');     // owner 偏好仍在
    });
  });
});
