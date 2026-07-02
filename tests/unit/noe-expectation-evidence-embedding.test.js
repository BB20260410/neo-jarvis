import { describe, it, expect } from 'vitest';
import { buildEventsEvidence } from '../../src/cognition/NoeExpectationResolver.js';
import { DEGRADED_KEY } from '../../src/cognition/NoeExpectationSemanticRecall.js';

// P1-A 集成测试：buildEventsEvidence 双形态 + embedding 语义召回。
// 验证 R1 根因修复（词面 hits=0 但语义相关的事件被召回）、P1-003（embed coverage 进 alignment）、
// P1-004（embed 事件不被 maxLines 截掉）、分层（0.5~0.6 进证据但不算高置信 linked）、不伪造（空召回空证据）。

// 与 claim 词面完全不重合（bigram hits=0）但语义相关的 action 事件
const SEMANTIC_EVENT = {
  ts: 1700000005000,
  kind: 'activity',
  payload: {
    action: 'noe.goal_step.act',
    status: 'succeeded',
    ok: true,
    result: 'done',
    details: { stdoutSummary: '把空调设成 24 度制冷模式' },
  },
};
const EXP = { claim: '让卧室温度更舒适', created_at: 1700000000000 };

// mock recall：按 ev 对象引用返回相似度（与真 recall 同契约：返回 Map<ev,{similarity}>）
const mkRecall = (simByEv) => async (_claimText, events) => {
  const m = new Map();
  for (const e of events) {
    const sim = simByEv.get(e.ev);
    if (typeof sim === 'number') m.set(e.ev, { similarity: sim });
  }
  return m;
};

describe('buildEventsEvidence × embedding 召回（P1-A）', () => {
  it('OFF（recall=null）：同步闭包；词面 hits=0 事件不进证据（确认测试数据词面不重合）', () => {
    const evidence = buildEventsEvidence(() => [SEMANTIC_EVENT]);
    const out = evidence(EXP);
    expect(typeof out).toBe('string'); // 同步返回（非 Promise）
    expect(out).toBe(''); // hits=0 → 词面路径无证据，证明 R1 根因（语义相关证据被踢出）
  });

  it('ON：hits=0 的语义相关事件被 embedding 召回进证据时间线 + 标注 embedSim', async () => {
    const evidence = buildEventsEvidence(() => [SEMANTIC_EVENT], {
      recall: mkRecall(new Map([[SEMANTIC_EVENT, 0.72]])),
    });
    const outP = evidence(EXP);
    expect(typeof outP?.then).toBe('function'); // async 返回（Promise）
    const out = await outP;
    expect(out).not.toBe('');
    expect(out).toContain('embedSim=0.720'); // 时间线标注「词面未命中但语义相关」
    expect(out).toContain('空调'); // 事件文本进了时间线，judge 能看到
    // R2+R3：embed 进独立可观测字段，但绝不点亮词面 semanticLinked（decisive reask 高置信门保持词面口径，防「语义相似→因果直链」误判放大）
    expect(out).toContain('"embedRecalledActionEvents":1');
    expect(out).toContain('"embedActionMaxCoverage":0.72');
    expect(out).toContain('"semanticLinkedActionEvents":0');
    expect(out).toContain('"semanticActionMaxCoverage":0'); // embed 不污染词面 coverage
  });

  it('R2+R3：即便高 sim（0.85）embed 也绝不点亮词面 semanticLinked（decisive reask 门保持词面，防语义相似误判成因果直链）', async () => {
    const evidence = buildEventsEvidence(() => [SEMANTIC_EVENT], {
      recall: mkRecall(new Map([[SEMANTIC_EVENT, 0.85]])),
    });
    const out = await evidence(EXP);
    expect(out).toContain('embedSim=0.850'); // 进证据时间线供 judge 自主判
    expect(out).toContain('"embedRecalledActionEvents":1'); // 独立可观测
    expect(out).toContain('"semanticLinkedActionEvents":0'); // 关键：高 sim 也不点亮高置信门
  });

  it('ON：recall 返回空（无事件达阈值）→ 证据为空，绝不伪造', async () => {
    const evidence = buildEventsEvidence(() => [SEMANTIC_EVENT], {
      recall: mkRecall(new Map()),
    });
    const out = await evidence(EXP);
    expect(out).toBe('');
  });

  it('ON：embed 事件与多条词面命中噪声共存时不被 maxLines 截掉（P1-004）', async () => {
    const exp = { claim: '完成部署部署部署', created_at: 1700000000000 };
    // 10 条词面命中「部署」的 self_talk 噪声（会占满 maxLines=8）
    const noise = Array.from({ length: 10 }, (_, i) => ({
      ts: 1700000001000 + i,
      kind: 'noe_episode',
      payload: { text: `部署部署的零碎念头第 ${i} 条`, meta: { streamType: 'self_talk' } },
    }));
    // 1 条词面不命中但高相似的 action 事件
    const embedEvent = {
      ts: 1700000009000,
      kind: 'activity',
      payload: { action: 'noe.goal_step.act', status: 'succeeded', result: 'done', details: { stdoutSummary: '把服务推上线了' } },
    };
    const evidence = buildEventsEvidence(() => [...noise, embedEvent], {
      recall: mkRecall(new Map([[embedEvent, 0.8]])),
    });
    const out = await evidence(exp);
    expect(out).toContain('embedSim=0.800'); // embed 事件挤进 maxLines，未被词面噪声截掉
  });

  it('ON：recall 抛错时安全降级为空（fail-safe，不抛）', async () => {
    const evidence = buildEventsEvidence(() => [SEMANTIC_EVENT], {
      recall: async () => { throw new Error('ollama down'); },
    });
    const out = await evidence(EXP);
    expect(out).toBe(''); // try/catch 兜底
  });

  it('R7：recall 降级（DEGRADED_KEY）时 evidence 摘要标注 embedDegraded，judge 可区分「降级」vs「真无证据」', async () => {
    const recall = async () => { const m = new Map(); m.set(SEMANTIC_EVENT, { similarity: 0.7 }); m.set(DEGRADED_KEY, { degraded: true }); return m; };
    const out = await buildEventsEvidence(() => [SEMANTIC_EVENT], { recall })(EXP);
    expect(out).toContain('embedSim=0.700');
    expect(out).toContain('embedDegraded=true');
  });

  it('R4：embed 事件被词面 matched 占满 maxLines 时保底保留相似度最高的 1 条进时间线', async () => {
    const exp = { claim: '把卧室空调温度调低', created_at: 1000 };
    // 9 条词面命中 claim 的 self_talk 噪声（占满 maxLines=8）
    const noise = Array.from({ length: 9 }, (_, i) => ({ ts: 1700000001000 + i, kind: 'noe_episode', payload: { text: `把卧室空调温度调低 的零碎念头 ${i}`, meta: { streamType: 'self_talk' } } }));
    // 1 条词面不命中但高相似的 action 事件
    const embedEvent = { ts: 1700000009000, kind: 'activity', payload: { action: 'noe.goal_step.act', status: 'succeeded', result: 'done', details: { stdoutSummary: '已启动制冷模式' } } };
    const recall = mkRecall(new Map([[embedEvent, 0.9]]));
    const out = await buildEventsEvidence(() => [...noise, embedEvent], { recall })(exp);
    expect(out).toContain('embedSim=0.900'); // 保底保留，未被词面噪声完全挤出
  });

  it('RV-1：embed 保底替换噪声、不挤掉词面直连的强 result-action（第 2 轮验收整改）', async () => {
    const exp = { claim: '部署上线服务', created_at: 1000 };
    // 8 条词面命中「部署上线服务」的 self_talk 噪声（无 result 信号）
    const noise = Array.from({ length: 8 }, (_, i) => ({ ts: 1700000001000 + i, kind: 'noe_episode', payload: { text: `部署上线服务 的零碎念头 ${i}`, meta: { streamType: 'self_talk' } } }));
    // 词面命中 + 强 result-action（result=done）
    const strongAction = { ts: 1700000005000, kind: 'activity', payload: { action: 'noe.goal_step.act', status: 'succeeded', result: 'done', ok: true, details: { stdoutSummary: '部署上线服务 这件事彻底搞定了' } } };
    // 词面不命中但高相似 embed 事件
    const embedEvent = { ts: 1700000009000, kind: 'activity', payload: { action: 'noe.x', status: 'succeeded', result: 'done', details: { stdoutSummary: '把后端推到了生产环境并通过冒烟检查' } } };
    const recall = mkRecall(new Map([[embedEvent, 0.9]]));
    const out = await buildEventsEvidence(() => [...noise, strongAction, embedEvent], { recall })(exp);
    expect(out).toContain('彻底搞定'); // 强 result-action 保留，未被 embed 挤掉
    expect(out).toContain('embedSim=0.900'); // embed 也进了（替换的是噪声）
  });

  it('P1-A 防泄漏（修三方审查 serious）：纯 embed 召回的 FAILED 事件不进判证统计——summary.matched=0 且 signals 不含 failed 信号，hint 必回 UNKNOWN 而非被抬成高置信 FAILED', async () => {
    // 词面与 claim 完全不重合、但语义相关的「失败」action 事件，仅靠 embedding 召回
    const failEvent = {
      ts: 1700000005000,
      kind: 'activity',
      payload: { action: 'noe.goal_step.act', status: 'failed', ok: false, result: 'error', details: { stdoutSummary: '把空调设成 24 度制冷模式但执行失败了' } },
    };
    const out = await buildEventsEvidence(() => [failEvent], {
      recall: mkRecall(new Map([[failEvent, 0.6]])),
    })(EXP);
    // embed 事件进时间线供 judge 自读（带 embedSim + 原始 signal）——不剥夺模型自主判断的信息
    expect(out).toContain('embedSim=0.600');
    // 关键：判证统计口径里词面 matched=0（embed 绝不凑数）→ buildEvidenceDecisionHint 走 no_matched_evidence → UNKNOWN
    const metaLine = out.split('\n').find((l) => l.startsWith('证据元数据：'));
    const summary = JSON.parse(metaLine.slice('证据元数据：'.length));
    expect(summary.matched).toBe(0);
    // summary.signals 不含 embed 事件的 failed/error/ok=false 方向性信号（不驱动 suggestedVerdict=FAILED/confidence=high）
    const sigKeys = (summary.signals || []).map((s) => (typeof s === 'string' ? s : s.signal));
    expect(sigKeys.join(',')).not.toMatch(/failed|error|ok=false/);
    // 人读摘要行明示 embed 软证据不计入判证统计
    expect(out).toContain('embed软证据1条');
  });

  it('P1-C 防丢证据（修审查 minor）：有词面 matched 时 recall 真异常不吞词面证据，降级标 embedDegraded 继续渲染', async () => {
    const exp = { claim: '部署上线服务', created_at: 1000 };
    // 词面命中 claim 的强 result-action 事件（hits>0 → 进 p.matched）
    const lexicalEvent = {
      ts: 1700000005000,
      kind: 'activity',
      payload: { action: 'noe.goal_step.act', status: 'succeeded', result: 'done', ok: true, details: { stdoutSummary: '部署上线服务 已完成' } },
    };
    // lexicalEvent 词面命中进 matched；SEMANTIC_EVENT 词面 hits=0 进 unmatched → 触发 embed recall（随后抛错）
    const evidence = buildEventsEvidence(() => [lexicalEvent, SEMANTIC_EVENT], {
      recall: async () => { throw new Error('ollama crashed'); },
    });
    const out = await evidence(exp);
    expect(out).not.toBe(''); // 词面证据没被 recall 异常吞成空（修复前外层 catch 会吞掉）
    expect(out).toContain('部署上线服务'); // 词面命中事件保留进时间线
    expect(out).toContain('embedDegraded=true'); // recall 异常降级标注，judge 可区分「语义路径降级」vs「真无证据」
    expect(out).not.toContain('embedSim='); // recall 抛错，无 embed 事件进时间线
  });
});
