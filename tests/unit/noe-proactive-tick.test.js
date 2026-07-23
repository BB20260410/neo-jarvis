import { describe, it, expect } from 'vitest';
import { createProactiveTickHandler } from '../../src/loop/proactiveTick.js';

const mkAdapter = (reply) => ({ chat: async () => ({ reply }) });
let clock = 100_000_000; // 远大于默认 30 分钟冷却，避免测试一上来就被判进冷却
const now = () => clock;

describe('proactiveTick 主动交互（克制）', () => {
  it('默认沉默：大脑回 SILENT 不开口', async () => {
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户在写代码' }) },
      getAdapter: () => mkAdapter('SILENT'), now,
    });
    const r = await tick();
    expect(r.spoke).toBe(false);
    expect(r.reason).toBe('chose_silent');
  });

  it('真值得才开口 + TTS + 播放', async () => {
    const played = [];
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户盯着屏幕很久了，看起来很累' }) },
      getAdapter: () => mkAdapter('累了就歇会儿吧'),
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a') }) },
      play: async (b) => played.push(b), now,
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
    expect(r.text).toBe('累了就歇会儿吧');
    expect(played.length).toBe(1);
  });

  it('冷却期内不打扰', async () => {
    clock = 5_000_000;
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: 'A' }) },
      getAdapter: () => mkAdapter('歇会儿'),
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a') }) },
      cooldownMs: 1_000_000, now,
    });
    expect((await tick()).spoke).toBe(true);   // 第一次开口
    clock += 100; // 冷却期内
    expect((await tick()).reason).toBe('cooldown');
  });

  it('高频触发不并发叠加主动判断', async () => {
    let releaseChat = null;
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '主人在快速切换任务' }) },
      getAdapter: () => ({
        chat: async () => new Promise((resolve) => { releaseChat = () => resolve({ reply: '我看到你在切任务，先抓住主线。' }); }),
      }),
      cooldownMs: 0,
      now,
    });

    const first = tick();
    await Promise.resolve();
    const second = await tick();
    expect(second).toMatchObject({ spoke: false, reason: 'in_flight' });

    releaseChat();
    const done = await first;
    expect(done.spoke).toBe(true);
  });

  it('视觉没变化不重复分析', async () => {
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: 'A' }) },
      getAdapter: () => mkAdapter('SILENT'), cooldownMs: 0, now,
    });
    await tick(); // lastVisionSummary=A
    expect((await tick()).reason).toBe('no_change');
  });

  it('没视觉时不开口', async () => {
    const tick = createProactiveTickHandler({ visionSession: { latest: () => null }, getAdapter: () => mkAdapter('x'), now });
    expect((await tick()).reason).toBe('no_vision');
  });

  it('跑飞防护：>300 字重复体不开口（长短分寸已交还模型，2026-06-11 owner 裁决）', async () => {
    const longText = '这是一段非常非常长的废话'.repeat(30);
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户在做某事' }) },
      getAdapter: () => mkAdapter(longText), now,
    });
    expect((await tick()).reason).toBe('chose_silent');
  });

  it('把结构化视觉处境注入主动判断 prompt', async () => {
    let seenPrompt = '';
    const tick = createProactiveTickHandler({
      visionSession: {
        latest: () => ({
          summary: '主人在多个窗口之间频繁切换任务',
          situation: { activity: 'task_switching', attention: 'distracted', possibleNeed: 'task_refocus', shouldInterrupt: true, confidence: 0.82 },
        }),
      },
      getAdapter: () => ({ chat: async (messages) => { seenPrompt = messages[1].content; return { reply: '先抓住一件最要紧的事就好。' }; } }),
      now,
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
    expect(seenPrompt).toContain('处境判断');
    expect(seenPrompt).toContain('activity=task_switching');
    expect(seenPrompt).toContain('shouldInterrupt=是');
  });
});

// 内在素材开口（NOE_PROACTIVE_INNER，2026-06-11 治"不主动"）：无视觉也能为"值得说的事"开口。
describe('proactiveTick 内在素材开口', () => {
  const nowBig = () => 200_000_000;
  it('无视觉无到期无熟人 + 有内在素材 → 不再 no_vision，正常开口且上限放宽到 80 字', async () => {
    const longSay = '主人，你交办我查的语音断声问题查完了：剩余段线上合成偶发失败且本地兜底没起，我已经修了重试';
    const tick = createProactiveTickHandler({
      visionSession: { latest: () => null },
      getAdapter: () => ({ chat: async () => ({ reply: longSay }) }),
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a') }) },
      innerBrief: () => '你刚完成了主人交办的「查语音断声」，要点：续播偶发失败已修重试',
      now: nowBig,
    });
    const r = await tick();
    expect(r.spoke).toBe(true);
    expect(r.text).toBe(longSay);
  });

  it('无内在素材且无视觉 → 仍 no_vision（原行为零变化）；素材探针抛错 fail-open', async () => {
    const base = { visionSession: { latest: () => null }, getAdapter: () => ({ chat: async () => ({ reply: '说点啥' }) }), now: nowBig };
    expect((await createProactiveTickHandler({ ...base })()).reason).toBe('no_vision');
    expect((await createProactiveTickHandler({ ...base, innerBrief: () => { throw new Error('炸'); } })()).reason).toBe('no_vision');
  });

  it('长短交还模型判断（owner 裁决）：35 字正常话不再被丢弃；>300 字跑飞仍拦', async () => {
    const say35 = '主人，这份文档里第三节的结论和你上周的判断有出入，建议你重点看一眼那段';
    const ok = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户在看文档' }) },
      getAdapter: () => ({ chat: async () => ({ reply: say35 }) }),
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('a') }) },
      now: nowBig,
    });
    expect((await ok()).spoke).toBe(true);
    const runaway = createProactiveTickHandler({
      visionSession: { latest: () => ({ summary: '用户在看文档' }) },
      getAdapter: () => ({ chat: async () => ({ reply: '重复体'.repeat(120) }) }),
      now: nowBig,
    });
    expect((await runaway()).reason).toBe('chose_silent');
  });
});
