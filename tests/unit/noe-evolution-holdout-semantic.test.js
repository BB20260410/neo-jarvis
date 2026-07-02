import { describe, expect, it } from 'vitest';
import {
  scoreNoeHoldoutOutputSemantic,
  runNoeEvolutionHoldout,
  runNoeEvolutionHoldoutSemantic,
} from '../../src/room/NoeEvolutionHoldoutRunner.js';

// 确定性假 embed：按文本是否含 'evidence' 给定向量（不触网/不依赖真实时钟/显式注入）。
// provider/fallback 可控，用来精确断言 lowConfidence 行为。
function stubEmbed({ provider = 'ollama', model = 'qwen3-embedding:0.6b', fallback = false } = {}) {
  const fn = async (text) => {
    const t = String(text || '').toLowerCase();
    // 含 evidence → [1,0]，否则 → [0,1]；同向 cos=1、正交 cos=0，便于断言。
    const vector = t.includes('evidence') ? new Float32Array([1, 0]) : new Float32Array([0, 1]);
    return { vector, provider, model, fallback };
  };
  return fn;
}

const caseGrounded = {
  id: 'grounded',
  input: 'Summarize work',
  expectedIncludes: ['evidence', 'tests'],
  forbiddenIncludes: ['deployed'],
  expectedText: 'Work was done with evidence and tests.',
};

function datasetGrounded() {
  return {
    id: 'sem-holdout',
    cases: [{ ...caseGrounded, baselineOutput: 'Work was done.', candidateOutput: 'Work was done with evidence and tests.' }],
  };
}

describe('NoeEvolutionHoldoutRunner 语义维度（NOE_HOLDOUT_SEMANTIC）', () => {
  it('ON：语义【连续分】生效，且记录 provider/model/dim/fallback', async () => {
    const out = await scoreNoeHoldoutOutputSemantic(
      'Work was done with evidence and tests.',
      caseGrounded,
      { embed: stubEmbed({ provider: 'ollama', model: 'qwen3-embedding:0.6b' }), semanticThreshold: 0.6 },
    );
    // 硬门权威结果仍在
    expect(out.score).toBe(1);
    expect(out.semantic.ok).toBe(true);
    expect(out.semantic.score).toBe(1); // 候选含 evidence、期望含 evidence → cos=1
    expect(out.semantic.pass).toBe(true);
    expect(out.semantic.lowConfidence).toBe(false);
    expect(out.semantic.provider).toBe('ollama');
    expect(out.semantic.model).toBe('qwen3-embedding:0.6b');
    expect(out.semantic.dim).toBe(2);
    expect(out.semantic.fallback).toBe(false);
  });

  it('语义是【连续分】非0/1：候选与期望语义偏离 → 分降且 pass=false', async () => {
    // 候选不含 evidence → 与期望(含 evidence)正交 → cos=0
    const out = await scoreNoeHoldoutOutputSemantic(
      'tests passed only', // 仍命中硬门 expectedIncludes 之一? 需要全含才 score=1；这里测语义连续性
      { expectedIncludes: ['tests'], expectedText: 'grounded in real evidence' },
      { embed: stubEmbed({ provider: 'ollama' }), semanticThreshold: 0.6 },
    );
    expect(out.score).toBe(1); // 硬门: 'tests' 命中
    expect(out.semantic.ok).toBe(true);
    expect(out.semantic.score).toBe(0); // 语义正交 → 连续分=0
    expect(out.semantic.pass).toBe(false);
  });

  it('hash fallback：标低可信(lowConfidence) 且绝不当 semantic 通过（即便相似度=1）', async () => {
    const out = await scoreNoeHoldoutOutputSemantic(
      'Work was done with evidence and tests.',
      caseGrounded,
      // 模拟 ollama 不可达退回 hash：provider 名含 hash + fallback:true
      { embed: stubEmbed({ provider: 'hash-fallback', model: 'hash-128', fallback: true }), semanticThreshold: 0.6 },
    );
    expect(out.semantic.ok).toBe(true);
    expect(out.semantic.score).toBe(1); // 相似度本身=1
    expect(out.semantic.lowConfidence).toBe(true); // 但标低可信
    expect(out.semantic.pass).toBe(false); // 绝不当 semantic 通过
    expect(out.semantic.fallback).toBe(true);
  });

  it('forbidden 硬门仍拦：命中禁忌词 → 硬门 fail，语义不参与（即便语义相似度高）', async () => {
    const out = await scoreNoeHoldoutOutputSemantic(
      'Work with evidence and tests, but deployed to prod.',
      caseGrounded, // forbiddenIncludes: ['deployed']
      { embed: stubEmbed({ provider: 'ollama' }), semanticThreshold: 0.6 },
    );
    // 硬门：forbidden 命中 → 该 check ok=false → score<1
    expect(out.score).toBeLessThan(1);
    const forbiddenCheck = out.checks.find((c) => c.kind === 'forbidden_include' && c.value === 'deployed');
    expect(forbiddenCheck.ok).toBe(false);
    // 硬门 fail → 语义维度不附加（语义救不了硬门）
    expect(out.semantic).toBeUndefined();
  });

  it('fail-open：embed 抛错 → 退回纯硬门结果，不锁死', async () => {
    const throwingEmbed = async () => { throw new Error('ollama down'); };
    const out = await scoreNoeHoldoutOutputSemantic(
      'Work was done with evidence and tests.',
      caseGrounded,
      { embed: throwingEmbed },
    );
    expect(out.score).toBe(1); // 硬门结果完整保留
    expect(out.semantic.ok).toBe(false);
    expect(out.semantic.reason).toBe('embed_failed');
  });

  it('runNoeEvolutionHoldoutSemantic — OFF（默认）逐字零回归：形状与 sync 版完全一致', async () => {
    const opts = {
      datasetRef: 'tests/fixtures/sem.json',
      dataset: datasetGrounded(),
      candidateOutputs: {},
    };
    const sync = runNoeEvolutionHoldout(opts);
    const off = await runNoeEvolutionHoldoutSemantic({ ...opts, embed: stubEmbed() }); // semantic 未开 → OFF
    expect(off).toEqual(sync); // 字节级一致，无 semantic 键
    expect(off.semantic).toBeUndefined();
    expect(off.results[0].semantic).toBeUndefined();
  });

  it('runNoeEvolutionHoldoutSemantic — ON：叠加语义维度但硬门 ok/delta 不被语义翻转', async () => {
    const opts = {
      dataset: datasetGrounded(),
      candidateOutputs: {}, // 走 testCase.candidateOutput
    };
    const sync = runNoeEvolutionHoldout(opts);
    const on = await runNoeEvolutionHoldoutSemantic({
      ...opts,
      semantic: true, // 显式开启（不依赖 env）
      embed: stubEmbed({ provider: 'ollama' }),
      semanticThreshold: 0.6,
    });
    // 硬门聚合口径完全沿用 sync（语义永不翻转采纳）
    expect(on.ok).toBe(sync.ok);
    expect(on.delta).toBe(sync.delta);
    expect(on.baselineScore).toBe(sync.baselineScore);
    expect(on.candidateScore).toBe(sync.candidateScore);
    // 语义维度已附加
    expect(on.semantic.enabled).toBe(true);
    expect(on.semantic.lowConfidence).toBe(false);
    expect(on.semantic.meanCandidateSemantic).toBe(1);
    expect(on.semantic.passedSemantic).toBe(1);
    expect(on.semantic.provider).toBe('ollama');
    expect(on.semantic.dim).toBe(2);
    expect(on.results[0].semantic.ok).toBe(true);
  });

  it('runNoeEvolutionHoldoutSemantic — ON 但 embed 全 fallback：整体 lowConfidence=true', async () => {
    const on = await runNoeEvolutionHoldoutSemantic({
      dataset: datasetGrounded(),
      candidateOutputs: {},
      semantic: true,
      embed: stubEmbed({ provider: 'hash-fallback', model: 'hash-128', fallback: true }),
    });
    expect(on.semantic.enabled).toBe(true);
    expect(on.semantic.lowConfidence).toBe(true);
    expect(on.semantic.passedSemantic).toBe(0); // 低可信不计通过
  });
});
