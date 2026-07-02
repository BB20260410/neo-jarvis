import { describe, it, expect, beforeEach } from 'vitest';
import {
  isIncompleteChatResult,
  truncationFinishReason,
  markTruncatedReply,
} from '../../src/room/chatTruncation.js';
import { CrossVerifyDispatcher } from '../../src/room/CrossVerifyDispatcher.js';
import { DebateDispatcher } from '../../src/room/DebateDispatcher.js';

// 回归:四种多 AI 模式以前从不检查 finishReason/incomplete,半截提案/verdict/签字 JSON 被当完整消费。
// 本套测试锁住「截断感知」:复用 SoloChatDispatcher 同口径判定,截断结果被标出/不当完整。

describe('chatTruncation 共享判定', () => {
  it('finishReason=length / max_tokens / incomplete / continuationRequired 都判为截断', () => {
    expect(isIncompleteChatResult({ finishReason: 'length' })).toBe(true);
    expect(isIncompleteChatResult({ finish_reason: 'max_tokens' })).toBe(true);
    expect(isIncompleteChatResult({ incomplete: true })).toBe(true);
    expect(isIncompleteChatResult({ truncated: true })).toBe(true);
    expect(isIncompleteChatResult({ continuationRequired: true })).toBe(true);
    expect(isIncompleteChatResult({ completionStatus: 'incomplete_length' })).toBe(true);
  });

  it('finishReason=stop / 空 / 非对象 不判为截断', () => {
    expect(isIncompleteChatResult({ finishReason: 'stop' })).toBe(false);
    expect(isIncompleteChatResult({})).toBe(false);
    expect(isIncompleteChatResult(null)).toBe(false);
    expect(isIncompleteChatResult('x')).toBe(false);
  });

  it('truncationFinishReason 取原因,缺省回退 length', () => {
    expect(truncationFinishReason({ finishReason: 'max_tokens' })).toBe('max_tokens');
    expect(truncationFinishReason({ completionStatus: 'incomplete_length' })).toBe('incomplete_length');
    expect(truncationFinishReason({ incomplete: true })).toBe('length');
  });

  it('markTruncatedReply 追加标注,且让半截 JSON 解析失败', () => {
    const marked = markTruncatedReply('{"agree":true', { finishReason: 'length' });
    expect(marked).toContain('输出被截断');
    expect(marked).toContain('finish_reason=length');
    // 关键:截断的签字 JSON 加标注后不再是合法 JSON,无法被当作有效 verdict。
    expect(() => JSON.parse(marked.trim())).toThrow();
  });
});

describe('CrossVerifyDispatcher._call 截断感知', () => {
  let store;
  let broadcasts;

  beforeEach(() => {
    broadcasts = [];
    store = {
      _rooms: new Map(),
      get(id) { return this._rooms.get(id); },
      update(id, patch) { const r = this._rooms.get(id); if (r) Object.assign(r, patch); return r; },
      flush() {},
    };
  });

  const makeDispatcher = (adapter) => new CrossVerifyDispatcher({
    store,
    adapters: new Map([['codex', adapter]]),
    broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
  });

  const room = (id) => {
    store._rooms.set(id, { id, mode: 'cross_verify', status: 'running', cwd: '/tmp/project' });
    return store._rooms.get(id);
  };

  it('完整结果原样返回(不破坏既有契约)', async () => {
    const d = makeDispatcher({ async chat() { return { reply: 'ok', tokensIn: 1, tokensOut: 1 }; } });
    const r = room('cv-complete');
    const reply = await d._call({ adapterId: 'codex', model: 'gpt-5.5' }, 'p', new AbortController().signal, { room: r, taskId: 'T', stageId: 's', turn: 'propose-1-r1' });
    expect(reply).toBe('ok');
    // 完整时不应有截断广播
    expect(broadcasts.some((b) => b.type === 'cluster_member_truncated')).toBe(false);
  });

  it('截断的提案被标注 + 广播 cluster_member_truncated', async () => {
    const d = makeDispatcher({
      async chat() {
        return { reply: '# 方案\n第一步是', tokensIn: 1, tokensOut: 8192, finishReason: 'length', incomplete: true };
      },
    });
    const r = room('cv-trunc-propose');
    const reply = await d._call({ adapterId: 'codex', model: 'gpt-5.5' }, 'p', new AbortController().signal, { room: r, taskId: 'T', stageId: 's', turn: 'propose-1-r1' });
    // 修复后:reply 被标注为截断,而不是把半截提案当完整方案返回
    expect(reply).toContain('输出被截断');
    expect(reply).toContain('第一步是');
    expect(broadcasts.some((b) => b.type === 'cluster_member_truncated' && b.adapterId === 'codex')).toBe(true);
  });

  it('截断的签字 verdict 经 _parseAck 不被当作有效签字(agree=false)', async () => {
    // 半截但「碰巧能 JSON.parse」的签字:{"agree":true} —— 修复前会被当成有效同意签字。
    const d = makeDispatcher({
      async chat() {
        return { reply: '{"agree":true}', tokensIn: 1, tokensOut: 8192, finishReason: 'length' };
      },
    });
    const r = room('cv-trunc-signoff');
    const raw = await d._call({ adapterId: 'codex', model: 'gpt-5.5' }, 'p', new AbortController().signal, { room: r, taskId: 'T', stageId: 's', turn: 'review-1-r1' });
    const ack = d._parseAck(raw);
    // 修复后:截断标注让 JSON 解析失败 → 降级为不同意,不会蒙混过签
    expect(ack.agree).toBe(false);
  });
});

describe('DebateDispatcher._runRound 截断感知', () => {
  let store;
  let broadcasts;

  beforeEach(() => {
    broadcasts = [];
    store = {
      _rooms: new Map(),
      get(id) { return this._rooms.get(id); },
      update(id, patch) { const r = this._rooms.get(id); if (r) Object.assign(r, patch); return r; },
      appendTurn(id, kind, turn) {
        const r = this._rooms.get(id);
        if (!r) return;
        r.rounds = r.rounds || [];
        let round = r.rounds.find((x) => x.kind === kind);
        if (!round) { round = { kind, turns: [] }; r.rounds.push(round); }
        round.turns.push(turn);
      },
      save() {},
    };
  });

  it('截断的提案 turn 被标 incomplete + content 标注 + 广播', async () => {
    const member = { adapterId: 'codex', displayName: 'GPT', model: 'gpt-5.5', enabled: true };
    store._rooms.set('deb-trunc', { id: 'deb-trunc', name: 'r', cwd: '/tmp/p', topic: '设计方案', members: [member], rounds: [] });
    const adapter = {
      id: 'codex',
      displayName: 'GPT',
      async chat() { return { reply: '我的提案是', tokensIn: 1, tokensOut: 8192, finishReason: 'length', incomplete: true }; },
    };
    const d = new DebateDispatcher({
      store,
      adapters: new Map([['codex', adapter]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      metrics: { record() {} },
    });

    await d._runRound('deb-trunc', 'r1_propose@1', [{ member, adapter }], () => ([{ role: 'user', content: 'x' }]), new AbortController().signal, 1);

    const turn = store._rooms.get('deb-trunc').rounds[0].turns[0];
    // 修复后:turn.incomplete 标出,content 带标注,不再把半截提案当完整发言
    expect(turn.incomplete).toBe(true);
    expect(turn.content).toContain('输出被截断');
    expect(turn.content).toContain('我的提案是');
    expect(broadcasts.some((b) => b.type === 'turn_done' && b.kind === 'r1_propose@1' && b.incomplete === true)).toBe(true);
  });

  it('完整提案 turn 不被标 incomplete', async () => {
    const member = { adapterId: 'codex', displayName: 'GPT', model: 'gpt-5.5', enabled: true };
    store._rooms.set('deb-ok', { id: 'deb-ok', name: 'r', cwd: '/tmp/p', topic: '设计方案', members: [member], rounds: [] });
    const adapter = {
      id: 'codex',
      displayName: 'GPT',
      async chat() { return { reply: '完整提案', tokensIn: 1, tokensOut: 50 }; },
    };
    const d = new DebateDispatcher({
      store,
      adapters: new Map([['codex', adapter]]),
      broadcast: (id, msg) => broadcasts.push({ roomId: id, ...msg }),
      metrics: { record() {} },
    });

    await d._runRound('deb-ok', 'r1_propose@1', [{ member, adapter }], () => ([{ role: 'user', content: 'x' }]), new AbortController().signal, 1);

    const turn = store._rooms.get('deb-ok').rounds[0].turns[0];
    expect(turn.incomplete).toBeUndefined();
    expect(turn.content).toBe('完整提案');
  });
});
