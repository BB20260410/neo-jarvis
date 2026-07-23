import { describe, expect, it } from 'vitest';
import { evaluateNoeEvolutionCandidateGate } from '../../src/room/NoeEvolutionCandidateGate.js';

function validCandidate(extra = {}) {
  return {
    id: 'skill-candidate-a',
    type: 'skill',
    baselineRef: 'output/eval/baseline.json',
    candidateRef: 'output/eval/candidate.json',
    size: { changedFiles: 2, addedLines: 80, removedLines: 12, totalBytes: 24_000 },
    growth: { currentTotalBytes: 200_000, projectedTotalBytes: 206_000, maxGrowthRatio: 1.05 },
    structure: { ok: true, touchesDefaultConfig: false },
    tests: [{ name: 'unit', ok: true, reportRef: 'output/eval/unit.json' }],
    holdout: { baselineScore: 0.72, candidateScore: 0.76, minDelta: 0.01, reportRef: 'output/eval/holdout.json' },
    rollbackRef: 'output/eval/rollback.md',
    ...extra,
  };
}

describe('NoeEvolutionCandidateGate', () => {
  it('allows a bounded candidate with tests, holdout improvement, and rollback', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate());

    expect(out.ok).toBe(true);
    expect(out.gates).toMatchObject({
      size: true,
      growth: true,
      structure: true,
      tests: true,
      holdout: true,
      rollback: true,
    });
  });

  it('blocks adoption when holdout does not improve', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      holdout: { baselineScore: 0.72, candidateScore: 0.721, minDelta: 0.01, reportRef: 'output/eval/holdout.json' },
    }));

    expect(out.ok).toBe(false);
    expect(out.errors[0]).toMatch(/candidate_holdout_improvement_required/);
  });

  it('blocks default config writes without structure validation and rollback', () => {
    const candidate = validCandidate({
      writesDefaultConfig: true,
      structure: { ok: false, touchesDefaultConfig: true },
      rollbackRef: '',
    });

    const out = evaluateNoeEvolutionCandidateGate(candidate);

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('candidate_structure_validation_required');
    expect(out.errors).toContain('candidate_default_config_write_requires_structure_ok');
    expect(out.errors).toContain('candidate_rollback_ref_required');
    expect(out.gates.defaultConfigWrite).toBe(false);
  });

  it('blocks oversized and over-growth candidates without approval evidence', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      size: { changedFiles: 12, addedLines: 600, removedLines: 40, totalBytes: 300_000 },
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 120_000, maxGrowthRatio: 1.05 },
    }));

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('candidate_size_changed_files_exceeded:12/10');
    expect(out.errors).toContain('candidate_size_changed_lines_exceeded:640/500');
    expect(out.errors).toContain('candidate_size_total_bytes_exceeded:300000/250000');
    expect(out.errors).toContain('candidate_growth_ratio_exceeded:1.2/1.05');
  });

  it('requires concrete test evidence for candidate adoption', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      tests: [{ name: 'unit', ok: false, reportRef: '' }],
    }));

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('candidate_test_failed:unit');
    expect(out.errors).toContain('candidate_test_report_ref_required:unit');
  });

  it('does not let a candidate lower minHoldoutDelta below the hard floor', () => {
    // 候选自报 minDelta:-1 想让退步也算通过；护栏应取 Math.max(自报, 硬下限)。
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      holdout: { baselineScore: 0.72, candidateScore: 0.7201, minDelta: -1, reportRef: 'output/eval/holdout.json' },
    }), { minHoldoutDelta: 0.01 });

    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.startsWith('candidate_holdout_improvement_required'))).toBe(true);
    // 报错里用的是被夹紧后的硬下限 0.01，不是候选自设的 -1。
    expect(out.errors.find((e) => e.startsWith('candidate_holdout_improvement_required'))).toContain('/0.01');
    expect(out.metrics.holdout.minDelta).toBe(0.01);
    expect(out.gates.holdout).toBe(false);
  });

  it('still honors a candidate minHoldoutDelta that is stricter than the floor', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      holdout: { baselineScore: 0.72, candidateScore: 0.74, minDelta: 0.05, reportRef: 'output/eval/holdout.json' },
    }), { minHoldoutDelta: 0.01 });

    // delta=0.02 < 候选自设的更严 0.05 → 仍应拒。
    expect(out.ok).toBe(false);
    expect(out.metrics.holdout.minDelta).toBe(0.05);
  });

  it('does not let a candidate raise maxGrowthRatio above the hard ceiling', () => {
    // 候选自报 maxGrowthRatio:99 想放过 1.5 倍膨胀；护栏应取 Math.min(自报, 硬上限)。
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 150_000, maxGrowthRatio: 99 },
    }), { maxGrowthRatio: 1.05 });

    expect(out.ok).toBe(false);
    const err = out.errors.find((e) => e.startsWith('candidate_growth_ratio_exceeded'));
    expect(err).toBeTruthy();
    // 比对的上限是被夹紧后的 1.05，不是候选自设的 99。
    expect(err).toContain('/1.05');
    expect(out.gates.growth).toBe(false);
  });

  it('still honors a candidate maxGrowthRatio that is stricter than the ceiling', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 102_000, maxGrowthRatio: 1.01 },
    }), { maxGrowthRatio: 1.05 });

    // ratio=1.02 > 候选自设的更严 1.01 → 仍应拒。
    expect(out.ok).toBe(false);
    expect(out.errors.find((e) => e.startsWith('candidate_growth_ratio_exceeded'))).toContain('/1.01');
  });

  it('rejects an arbitrary non-ref string as a growth approval exemption', () => {
    // approvalRef 只是任意非空字符串（"yes"）不能豁免膨胀硬规则。
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 150_000, maxGrowthRatio: 1.05, approvalRef: 'yes' },
    }), { maxGrowthRatio: 1.05 });

    expect(out.ok).toBe(false);
    expect(out.errors.some((e) => e.startsWith('candidate_growth_ratio_exceeded'))).toBe(true);
  });

  it('rejects a path-traversal / absolute approvalRef as a growth exemption', () => {
    const traversal = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 150_000, maxGrowthRatio: 1.05, approvalRef: '../../etc/passwd' },
    }), { maxGrowthRatio: 1.05 });
    expect(traversal.ok).toBe(false);
    expect(traversal.errors.some((e) => e.startsWith('candidate_growth_ratio_exceeded'))).toBe(true);

    const absolute = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: { currentTotalBytes: 100_000, projectedTotalBytes: 150_000, maxGrowthRatio: 1.05, approvalRef: '/etc/passwd' },
    }), { maxGrowthRatio: 1.05 });
    expect(absolute.ok).toBe(false);
    expect(absolute.errors.some((e) => e.startsWith('candidate_growth_ratio_exceeded'))).toBe(true);
  });

  it('does NOT let a candidate-self-declared approvalRef exempt the growth hard cap (codex post-review)', () => {
    const out = evaluateNoeEvolutionCandidateGate(validCandidate({
      growth: {
        currentTotalBytes: 100_000,
        projectedTotalBytes: 150_000,
        maxGrowthRatio: 1.05,
        approvalRef: 'output/eval/growth-approval.json',
      },
    }), { maxGrowthRatio: 1.05 });

    // codex post-review 返工：候选自报的 approvalRef（即使"像"仓库相对路径、即使指向不存在的文件）
    // 不能豁免膨胀硬上限——NoeSelfEvolutionGate 只消费 candidateGate.ok 不补 ref 存在/passed 校验，
    // 任意 plausible ref 即豁免就是绕过。真授权须走上层 passed ledger，不是 candidate 自带字段。
    expect(out.errors.some((e) => e.startsWith('candidate_growth_ratio_exceeded'))).toBe(true);
    expect(out.ok).toBe(false);
  });
});
