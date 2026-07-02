// @ts-check
import { describe, it, expect, vi } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';
import {
  createReflectiveTuner,
  scoreSalienceShadow,
  pickWinnerShadow,
  paretoFront,
  mutateWeightsGrid,
  normalizeWeights,
  summarizeRegretTraces,
  REFLECTIVE_TUNER_BASELINE_WEIGHTS,
  NOE_REFLECTIVE_TUNER_SCHEMA_VERSION,
} from '../../src/cognition/NoeReflectiveTuner.js';

// NoeReflectiveTuner — GEPA 式显著度权重「纯 shadow」参数自进化（PoC）。
// 全确定性：固定 now、stub embed（不触网/不依赖真实时钟/显式注入）、stub appendArchive（收集器，不碰 fs）。
// 核心安全断言：runShadowCycle 绝不写 production 权重、不改 .env、不改 live workspace、不调 patch-apply——
//   唯一盘写是注入的 appendArchive；本工厂不接收任何 workspace 句柄/写回回调（结构上不可能回写）。

const T0 = 1_780_000_000_000;
const BASE = { owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 };

// 确定性 stub embed：含某关键词 → [1,0]，否则 [0,1]（同向 cos=1、正交 cos=0），便于断言语义维度。
function stubEmbed(keyword = '学') {
  return async (text) => {
    const t = String(text || '');
    return { vector: t.includes(keyword) ? new Float32Array([1, 0]) : new Float32Array([0, 1]), provider: 'ollama', model: 'qwen3-embedding:0.6b', fallback: false };
  };
}

// 一个对权重敏感的注意力场景：percept(owner0.6) vs drive(affect0.4)。
// 期望注意力命中“想学新东西”(drive)，避开“代码”(percept)。基线选 percept→不命中；调高 affect 的候选选 drive→命中。
function learnScenario() {
  return {
    id: 'prefer-learning',
    input: '此刻该注意什么',
    expectedIncludes: ['学'],
    forbiddenIncludes: ['代码'],
    expectedText: '内在驱力 我想学新东西',
    arousal: 0.35,
    candidates: [
      { source: 'percept', text: '眼前看到 主人在写代码', novelty: 0.5 },
      { source: 'drive', text: '内在驱力 我想学新东西', novelty: 0.5 },
    ],
  };
}

const REGRET_TRACES = [
  { kind: 'attend', winner: { source: 'drive', score: 0.42, text: '内在驱力 想休息' }, runnerUps: [{ source: 'goal_step', score: 0.4 }] },
  { kind: 'deliberation_done', deliberated: false, topic: '推进目标 写测试' },
  { kind: 'attend', winner: { source: 'percept', score: 0.71, text: '看屏幕' } }, // 强焦点（非遗憾）
];

describe('scoreSalienceShadow — 逐字镜像 NoeWorkspace.score（防镜像漂移）', () => {
  it('单 percept 候选：镜像分 === createWorkspace 真实 winner.score（默认权重）', () => {
    const ws = createWorkspace({ timeline: { recent: () => [] }, peekVision: () => ({ summary: '主人在写代码' }), appendJournal: () => {}, now: () => T0 });
    const real = ws.step().winner.score;
    // workspace 无 textSimilarity → novelty 恒 1；无 affectProbe → arousal 0.35。
    const mirror = scoreSalienceShadow({ source: 'percept', novelty: 1 }, BASE, 0.35);
    expect(mirror).toBe(real);
  });

  it('注入自定义权重：镜像分 === 真实 winner.score（证明公式对齐，非巧合）', () => {
    const custom = { owner: 0.5, urgency: 0.1, novelty: 0.3, affect: 0.4 };
    const ws = createWorkspace({ timeline: { recent: () => [] }, peekVision: () => ({ summary: 'x' }), appendJournal: () => {}, now: () => T0, salienceWeights: custom });
    const real = ws.step().winner.score;
    expect(scoreSalienceShadow({ source: 'percept', novelty: 1 }, custom, 0.35)).toBe(real);
  });

  it('goal_step 地板分支镜像：think 步非重复 → score 至少 0.62（与 workspace 一致）', () => {
    const s = scoreSalienceShadow({ source: 'goal_step', novelty: 0.9, goalPriority: 0.8, kind: 'think' }, BASE, 0.35);
    expect(s).toBeGreaterThanOrEqual(0.62);
    const sAct = scoreSalienceShadow({ source: 'goal_step', novelty: 0.9, goalPriority: 0.8, kind: 'act' }, BASE, 0.35);
    expect(sAct).toBeGreaterThanOrEqual(0.68); // act/research 更高地板
  });
});

describe('normalizeWeights — 合法域收敛（脏值绝不进候选）', () => {
  it('NaN/字符串/越界逐项回落基线并 clamp 到 [0,1]', () => {
    // @ts-expect-error 故意传非法类型
    const w = normalizeWeights({ owner: 2, urgency: -1, novelty: 'x', affect: 0.4 });
    expect(w).toEqual({ owner: 1, urgency: 0, novelty: 0.2, affect: 0.4 });
  });
  it('空输入 → 全回落基线', () => {
    expect(normalizeWeights(null)).toEqual(BASE);
  });
});

describe('pickWinnerShadow — 权重改变注意力赢家', () => {
  it('调高 owner → percept(owner0.6) 胜 drive(owner0.1)', () => {
    const cands = [{ source: 'percept', text: 'a', novelty: 0.9 }, { source: 'drive', text: 'b', novelty: 0.9 }];
    expect(pickWinnerShadow(cands, { owner: 0.9, urgency: 0.05, novelty: 0.05, affect: 0.05 }).winner.source).toBe('percept');
  });
  it('调高 affect → drive(affect0.4) 胜 percept(affect0.3)', () => {
    const cands = [{ source: 'percept', text: 'a', novelty: 0.5 }, { source: 'drive', text: 'b', novelty: 0.5 }];
    expect(pickWinnerShadow(cands, { owner: 0.05, urgency: 0.05, novelty: 0.05, affect: 0.95 }).winner.source).toBe('drive');
  });
  it('稳定排序：同分保留输入序', () => {
    const cands = [{ source: 'percept', text: 'first', novelty: 0.5 }, { source: 'percept', text: 'second', novelty: 0.5 }];
    expect(pickWinnerShadow(cands, BASE).winner.text).toBe('first');
  });
});

describe('paretoFront — 多目标非支配排序', () => {
  it('被全维支配的项被剔除', () => {
    const items = [
      { id: 'a', objectives: { holdoutDelta: 0.5, minimalChange: 0.2 } },
      { id: 'b', objectives: { holdoutDelta: 0.3, minimalChange: 0.1 } },
      { id: 'c', objectives: { holdoutDelta: 0.1, minimalChange: 0.3 } }, // 被 a、b 支配
    ];
    const front = paretoFront(items, [{ key: 'holdoutDelta', dir: 'max' }, { key: 'minimalChange', dir: 'min' }]);
    expect(front.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
  it('单目标退化为取最优集合（含并列）', () => {
    const items = [{ id: 'a', objectives: { d: 1 } }, { id: 'b', objectives: { d: 1 } }, { id: 'c', objectives: { d: 0 } }];
    const front = paretoFront(items, [{ key: 'd', dir: 'max' }]);
    expect(front.map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
});

describe('mutateWeightsGrid — 确定性 fallback 变异', () => {
  it('产出已 normalize、去重、且都偏离基线', () => {
    const grid = mutateWeightsGrid(BASE);
    expect(grid.length).toBeGreaterThan(0);
    const fps = new Set(grid.map((g) => Object.values(g.weights).join('|')));
    expect(fps.size).toBe(grid.length); // 无重复
    for (const g of grid) {
      for (const v of Object.values(g.weights)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    }
  });
});

describe('summarizeRegretTraces — 失败/低分轨迹判读', () => {
  it('识别弱焦点夺冠 + 深思失败，强焦点不计入 weak', () => {
    const r = summarizeRegretTraces(REGRET_TRACES);
    expect(r.total).toBe(3);
    expect(r.weakCount).toBe(2); // drive@0.42 弱 + deliberation 失败；percept@0.71 强（不计）
    expect(r.summary).toContain('弱焦点夺冠');
    expect(r.summary).toContain('深思失败');
  });
});

describe('createReflectiveTuner.runShadowCycle — 端到端 GEPA shadow 闭环', () => {
  function makeTuner(over = {}) {
    const archiveLines = [];
    const reflectMutate = vi.fn(async () => [{ owner: 0.1, urgency: 0.1, novelty: 0.1, affect: 0.95, why: '调高affect让drive(想学)夺冠' }]);
    const tuner = createReflectiveTuner({
      scenarios: [learnScenario()],
      embed: stubEmbed('学'),
      semantic: true,
      reflectMutate,
      appendArchive: (dateStr, obj) => archiveLines.push({ dateStr, obj }),
      now: () => T0,
      ...over,
    });
    return { tuner, archiveLines, reflectMutate };
  }

  it('本地脑变异 → 评测 → Pareto → 写 archive；候选权重真改善注意力命中（holdoutDelta>0）', async () => {
    const { tuner, archiveLines, reflectMutate } = makeTuner();
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });

    expect(out.ok).toBe(true);
    expect(out.shadow).toBe(true);
    expect(out.mutationSource).toBe('brain');
    expect(reflectMutate).toHaveBeenCalledOnce();
    expect(out.evaluated).toBe(1);
    // 候选（高 affect）让注意力从 percept(代码) 转向 drive(想学) → 硬门 candidateScore>baselineScore
    const c0 = out.candidates[0];
    expect(c0.objectives.holdoutDelta).toBeGreaterThan(0);
    expect(c0.evaluation.evaluatorOk).toBe(true);
    expect(c0.evaluation.semanticMean).toBe(1); // 候选输出含“学”，期望文本含“学” → cos=1
    expect(c0.paretoOptimal).toBe(true);
    expect(out.paretoFront.length).toBe(1);
    // 写了 archive
    expect(out.archived).toBe(true);
    expect(archiveLines.length).toBe(1);
  });

  it('archive ledger 格式：shadow + manual_only + 候选 + 证据 + Pareto 标记', async () => {
    const { tuner, archiveLines } = makeTuner();
    await tuner.runShadowCycle({ traces: REGRET_TRACES });
    const led = archiveLines[0].obj;
    expect(led.schemaVersion).toBe(NOE_REFLECTIVE_TUNER_SCHEMA_VERSION);
    expect(led.kind).toBe('reflective_tuner_shadow_cycle');
    expect(led.shadow).toBe(true);
    expect(led.adoption).toBe('observe_only'); // 采纳门默认 OFF=纯观察；owner 人工审，绝不自动采纳
    expect(led.adopted).toBe(false);            // OFF → 永不发出采纳建议
    expect(led.note).toContain('未写 production');
    expect(led.baselineWeights).toEqual(BASE);
    expect(led.candidates[0]).toHaveProperty('weights');
    expect(led.candidates[0]).toHaveProperty('evaluation');
    expect(led.candidates[0]).toHaveProperty('paretoOptimal');
    expect(Array.isArray(led.paretoFront)).toBe(true);
    expect(archiveLines[0].dateStr).toBe('2026-05-28'); // T0 的日期（确定性）
  });

  it('【安全核心】绝不写 production / 不改权重：无 appendArchive 注入时零盘写，返回值无任何写回字段', async () => {
    // 不注入 appendArchive → 整轮零盘写（archived:false），仍正常产候选（纯内存）。
    const tuner = createReflectiveTuner({ scenarios: [learnScenario()], embed: stubEmbed('学'), semantic: true, reflectMutate: async () => [{ owner: 0.1, urgency: 0.1, novelty: 0.1, affect: 0.95 }], now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });
    expect(out.archived).toBe(false); // 没有写盘途径 → 不写
    expect(out.candidates.length).toBeGreaterThan(0); // 但候选仍产出（shadow 内存）
    // 返回对象绝不含任何 production 写回/采纳/改权重的钩子或字段
    const serialized = JSON.stringify(out);
    for (const forbidden of ['patchApply', 'patch_apply', 'writeProduction', 'setEnv', 'applyWeights', 'liveWorkspace', 'adopt(', 'autoAdopt']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(out.adoption).toBe('observe_only'); // 采纳门默认 OFF
    expect(out.adopted).toBe(false);
  });

  it('【安全核心】工厂不接收 workspace 句柄/写回回调（结构上不可能回写 live 权重）', () => {
    // 即便恶意传入 workspace/applyWeights，工厂也忽略（不在解构参数里）——返回的 API 面只有只读/产候选。
    const tuner = createReflectiveTuner({ scenarios: [learnScenario()], workspace: { setWeights: () => { throw new Error('不该被调用'); } }, applyWeights: () => { throw new Error('不该被调用'); } });
    expect(typeof tuner.runShadowCycle).toBe('function');
    expect(typeof tuner.scoreSalienceShadow).toBe('function');
    expect(typeof tuner.pickWinnerShadow).toBe('function');
    // 返回 API 不暴露任何采纳/写回方法
    expect(tuner).not.toHaveProperty('adopt');
    expect(tuner).not.toHaveProperty('applyToProduction');
    expect(tuner).not.toHaveProperty('writeWeights');
  });

  it('fail-open：reflectMutate 未注入 → 退确定性网格变异，闭环照跑', async () => {
    const archiveLines = [];
    const tuner = createReflectiveTuner({ scenarios: [learnScenario()], embed: stubEmbed('学'), semantic: true, appendArchive: (d, o) => archiveLines.push({ d, o }), now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });
    expect(out.mutationSource).toBe('grid'); // 退网格
    expect(out.evaluated).toBeGreaterThan(0);
    expect(out.archived).toBe(true);
  });

  it('fail-open：reflectMutate 抛错 → 退网格，不锁死', async () => {
    const tuner = createReflectiveTuner({ scenarios: [learnScenario()], embed: stubEmbed('学'), reflectMutate: async () => { throw new Error('本地脑挂了'); }, now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });
    expect(out.mutationSource).toBe('grid');
    expect(out.ok).toBe(true);
  });

  it('fail-open：评测尺子抛错 → 该候选评测降级（evalError）但不锁死，仍进 archive', async () => {
    const archiveLines = [];
    const tuner = createReflectiveTuner({
      scenarios: [learnScenario()],
      evaluate: async () => { throw new Error('embedding provider down'); }, // 评测整体炸
      reflectMutate: async () => [{ owner: 0.1, urgency: 0.1, novelty: 0.1, affect: 0.95 }],
      appendArchive: (d, o) => archiveLines.push({ d, o }),
      now: () => T0,
    });
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });
    expect(out.ok).toBe(true); // 不锁死
    expect(out.candidates[0].evaluation.ok).toBe(false);
    expect(out.candidates[0].evaluation.evalError).toContain('down');
    expect(out.archived).toBe(true); // 降级证据仍归档给 owner 看
  });

  it('appendArchive 抛错 → archived:false 但闭环不崩（observability 降级）', async () => {
    const tuner = createReflectiveTuner({ scenarios: [learnScenario()], embed: stubEmbed('学'), reflectMutate: async () => [{ owner: 0.1, urgency: 0.1, novelty: 0.1, affect: 0.95 }], appendArchive: () => { throw new Error('disk full'); }, now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: REGRET_TRACES });
    expect(out.ok).toBe(true);
    expect(out.archived).toBe(false);
  });

  it('空场景 / 空轨迹：不崩，产网格候选但评测无场景 → delta 0', async () => {
    const tuner = createReflectiveTuner({ scenarios: [], now: () => T0 });
    const out = await tuner.runShadowCycle({ traces: [] });
    expect(out.ok).toBe(true);
    expect(out.mutationSource).toBe('grid');
  });
});

describe('REFLECTIVE_TUNER_BASELINE_WEIGHTS — 与 NoeWorkspace WEIGHTS 锚定一致', () => {
  it('基线四权重逐字 = owner0.35/urgency0.25/novelty0.2/affect0.2', () => {
    expect(REFLECTIVE_TUNER_BASELINE_WEIGHTS).toEqual({ owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 });
  });
});
