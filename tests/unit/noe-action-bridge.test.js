import { describe, expect, it } from 'vitest';
import { detectAction, runAction } from '../../src/voice/NoeActionBridge.js';

describe('NoeActionBridge 动作桥（说→真做）', () => {
  it('detectAction 区分 记住/提醒/危险/无', () => {
    expect(detectAction('记住我喜欢喝美式咖啡')).toMatchObject({ type: 'remember' });
    expect(detectAction('提醒我下午三点喝水')).toMatchObject({ type: 'remind' });
    expect(detectAction('帮我删掉那个文件')).toMatchObject({ type: 'danger' });
    expect(detectAction('帮我发个微信给老王')).toMatchObject({ type: 'danger' });
    expect(detectAction('今天天气真好')).toBeNull();
  });

  it('记住 → 真写记忆库', async () => {
    const writes = [];
    const memory = { write: (x) => writes.push(x) };
    const r = await runAction(detectAction('记住我喜欢美式咖啡'), { memory });
    expect(r).toMatchObject({ ok: true, executed: true });
    expect(writes[0]).toMatchObject({ scope: 'user', tags: ['user-note'] });
    expect(writes[0].body).toContain('美式咖啡');
    expect(r.reply).toContain('美式咖啡');
  });

  it('记住 → 优先走 write gate 并携带来源证据', async () => {
    const commits = [];
    const memoryWriteGate = { commit: (x) => { commits.push(x); return { ok: true, memory: { id: 'm1' } }; } };
    const r = await runAction(detectAction('记住我喜欢拿铁'), {
      memoryWriteGate,
      sourceEpisodeId: 'ep-action',
      evidenceRefs: ['episode:ep-action'],
    });

    expect(r).toMatchObject({ ok: true, executed: true });
    expect(commits[0]).toMatchObject({
      scope: 'user',
      sourceType: 'voice_note',
      sourceEpisodeId: 'ep-action',
      evidenceRefs: ['episode:ep-action'],
    });
    expect(commits[0].body).toContain('拿铁');
  });

  it('提醒 → 真建承诺(到点 proactiveTick 叫)', async () => {
    const added = [];
    const commitmentStore = { add: (x) => added.push(x) };
    const r = await runAction(detectAction('提醒我喝水'), { commitmentStore });
    expect(r).toMatchObject({ ok: true, executed: true });
    expect(added[0].text).toContain('喝水');
  });

  it('提醒但没装 commitmentStore → 退到记忆当待办，仍真存', async () => {
    const writes = [];
    const r = await runAction(detectAction('提醒我交房租'), { memory: { write: (x) => writes.push(x) } });
    expect(r.executed).toBe(true);
    expect(writes[0].tags).toContain('todo');
  });

  it('危险动作 → 不执行、不假装，明确要授权', async () => {
    const writes = [];
    const r = await runAction(detectAction('帮我把这个文件删掉'), { memory: { write: (x) => writes.push(x) } });
    expect(r).toMatchObject({ executed: false });
    expect(r.reply).toMatch(/授权|确认|不会(偷偷|假装)/);
    expect(writes.length).toBe(0); // 危险动作绝不偷偷写任何东西
  });
});
