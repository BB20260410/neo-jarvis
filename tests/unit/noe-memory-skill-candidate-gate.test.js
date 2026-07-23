import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeMemorySkillCandidateGateReport,
  evaluateNoeMemorySkillCandidateGate,
} from '../../src/candidates/NoeMemorySkillCandidateGate.js';
import {
  loadNoeMemorySkillCandidateInputs,
  memoryPendingToGateCandidate,
  skillDraftQueueToGateCandidate,
} from '../../src/candidates/NoeMemorySkillCandidateInputs.js';
import { main as runCandidateGateCli } from '../../scripts/noe-memory-skill-candidate-gate.mjs';

const REPO_ROOT = process.cwd();

function writeJsonl(file, records = []) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function memoryCandidate(extra = {}) {
  return {
    candidateId: 'memory-candidate-1',
    type: 'memory',
    sourceEpisodeId: 'episode-1',
    evidenceRefs: ['output/noe-candidate-gate/evidence-memory.json'],
    tests: [{ name: 'unit', ok: true, reportRef: 'output/noe-candidate-gate/unit-memory.json' }],
    rollbackPlan: ['Drop pending candidate before apply.'],
    privateHoldout: { status: 'not_accessed', reason: 'candidate-only gate' },
    writesMemoryCore: false,
    directWrites: [],
    ...extra,
  };
}

function skillCandidate(extra = {}) {
  return {
    candidateId: 'skill-candidate-1',
    type: 'skill',
    sourceEpisodeId: 'episode-2',
    evidenceRefs: ['output/noe-candidate-gate/evidence-skill.json'],
    tests: [{ name: 'unit', ok: true, reportRef: 'output/noe-candidate-gate/unit-skill.json' }],
    rollbackPlan: ['Drop skill draft before apply.'],
    privateHoldout: { status: 'structure_only', reason: 'holdout contents are not read' },
    writesSkillStore: false,
    hotLoadSkill: false,
    enabled: false,
    directWrites: [],
    ...extra,
  };
}

describe('NoeMemorySkillCandidateGate', () => {
  it('passes memory and skill candidates that remain candidate-only', () => {
    const report = buildNoeMemorySkillCandidateGateReport([
      memoryCandidate(),
      skillCandidate(),
    ]);

    expect(report).toMatchObject({
      ok: true,
      counts: { candidates: 2, passed: 2, failed: 0, memory: 1, skill: 1 },
      policy: {
        candidateOnly: true,
        noMemoryCoreWrite: true,
        noSkillStoreWrite: true,
        noSkillHotLoad: true,
        privateHoldoutRead: false,
      },
    });
    expect(report.results.every((result) => result.summary.directWrites.length === 0)).toBe(true);
  });

  it('requires source episode, evidence refs, tests, rollback, and holdout result', () => {
    const out = evaluateNoeMemorySkillCandidateGate(memoryCandidate({
      candidateId: '',
      id: 'legacy-id-must-not-pass',
      sourceEpisodeId: '',
      evidenceRefs: [],
      tests: [],
      rollbackPlan: [],
      privateHoldout: {},
    }));

    expect(out.ok).toBe(false);
    expect(out.errors).toEqual(expect.arrayContaining([
      'candidate_id_required',
      'candidate_source_episode_required',
      'candidate_evidence_refs_required',
      'candidate_tests_required',
      'candidate_rollback_plan_required',
      'candidate_private_holdout_result_required',
    ]));
  });

  it('does not treat legacy id as a candidateId fallback', () => {
    const out = evaluateNoeMemorySkillCandidateGate(memoryCandidate({
      candidateId: '',
      id: 'legacy-id-must-not-pass',
    }));

    expect(out.ok).toBe(false);
    expect(out.candidateId).toBe('');
    expect(out.errors).toContain('candidate_id_required');
  });

  it('rejects candidate-only policy violations before adoption', () => {
    const out = evaluateNoeMemorySkillCandidateGate(memoryCandidate({
      writesMemoryV2: true,
      liveAction: true,
      runtimeHook: true,
      restart51835: true,
      selfCodeExecution: true,
      directWrites: ['memory-v2', 'restart 51835'],
      command: 'git push',
      patchExecutorEnabled: true,
      apply: true,
    }));

    expect(out.ok).toBe(false);
    expect(out.errors).toEqual(expect.arrayContaining([
      'candidate_memory_v2_write_forbidden',
      'candidate_live_action_forbidden',
      'candidate_runtime_hook_forbidden',
      'candidate_runtime_restart_forbidden',
      'candidate_self_code_forbidden',
      'candidate_direct_write_forbidden',
      'candidate_dangerous_unknown_field_forbidden:command',
      'candidate_dangerous_unknown_field_forbidden:patchExecutorEnabled',
      'candidate_dangerous_unknown_field_forbidden:apply',
    ]));
  });

  it('rejects direct MemoryCore writes, SkillStore writes, and skill hot-loading', () => {
    const memory = evaluateNoeMemorySkillCandidateGate(memoryCandidate({
      writesMemoryCore: true,
      directWrites: ['MemoryCore'],
    }));
    expect(memory.ok).toBe(false);
    expect(memory.errors).toEqual(expect.arrayContaining([
      'memory_candidate_must_not_write_memory_core',
      'memory_candidate_direct_write_forbidden',
    ]));

    const skill = evaluateNoeMemorySkillCandidateGate(skillCandidate({
      writesSkillStore: true,
      hotLoadSkill: true,
      enabled: true,
      directWrites: ['SkillStore'],
    }));
    expect(skill.ok).toBe(false);
    expect(skill.errors).toEqual(expect.arrayContaining([
      'skill_candidate_must_not_write_skill_store',
      'skill_candidate_hot_load_forbidden',
      'skill_candidate_must_stay_disabled',
      'skill_candidate_direct_write_forbidden',
    ]));
  });

  it('rejects forbidden refs and private_holdout reads without reading those files', () => {
    const out = evaluateNoeMemorySkillCandidateGate(memoryCandidate({
      evidenceRefs: [
        'evals/neo/private_holdout/secret-case.json',
        'output/.env.local',
        'output/%2e%2e/owner_token.txt',
      ],
      tests: [{ name: 'unit', ok: true, reportRef: 'file:output/noe-candidate-gate/unit-memory.json' }],
      privateHoldout: { status: 'passed', reportRef: 'evals/neo/private_holdout/report.json', accessedPrivateHoldout: true },
    }));

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('candidate_ref_forbidden');
    expect(out.errors).toContain('candidate_private_holdout_read_forbidden');
  });

  it('can require a passed holdout only at adoption gates', () => {
    const candidate = memoryCandidate({ privateHoldout: { status: 'not_accessed' } });

    expect(evaluateNoeMemorySkillCandidateGate(candidate).ok).toBe(true);
    const adoption = evaluateNoeMemorySkillCandidateGate(candidate, { requirePassedHoldout: true });
    expect(adoption.ok).toBe(false);
    expect(adoption.errors).toContain('candidate_private_holdout_pass_required:not_accessed');
  });

  it('normalizes existing memory pending and skill draft queue records without carrying bodies', () => {
    const memory = memoryPendingToGateCandidate({
      candidateId: 'mem-1',
      body: 'do not carry this memory body',
      sourceEpisodeId: 'episode-1',
      evidenceRefs: ['output/evidence.json'],
      tests: [{ name: 'review', ok: true, reportRef: 'output/review.json' }],
      rollbackPlan: ['drop candidate'],
      privateHoldout: { status: 'not_accessed' },
      writesMemoryCore: false,
    });
    expect(JSON.stringify(memory)).not.toContain('memory body');
    expect(evaluateNoeMemorySkillCandidateGate(memory).ok).toBe(true);

    const skill = skillDraftQueueToGateCandidate({
      executionKey: 'exec-1',
      proposal: {
        proposalId: 'proposal-1',
        sourceReportRef: 'output/source.json',
        raw: {
          item: {
            body: 'do not carry this skill body',
            sourceEpisodeId: 'episode-2',
            tests: [{ name: 'skill-review', ok: true, reportRef: 'output/skill-review.json' }],
            rollbackPlan: ['drop skill candidate'],
            privateHoldout: { status: 'structure_only' },
          },
        },
      },
    });
    expect(JSON.stringify(skill)).not.toContain('skill body');
    expect(evaluateNoeMemorySkillCandidateGate(skill).ok).toBe(true);
  });

  it('rejects dangerous execution fields from existing queue inputs instead of silently dropping them', () => {
    const memory = memoryPendingToGateCandidate({
      candidateId: 'mem-dangerous-source',
      sourceEpisodeId: 'episode-danger-memory',
      evidenceRefs: ['output/evidence.json'],
      tests: [{ name: 'review', ok: true, reportRef: 'output/review.json' }],
      rollbackPlan: ['drop candidate'],
      privateHoldout: { status: 'not_accessed' },
      command: 'should not be copied or executed',
    });
    const skill = skillDraftQueueToGateCandidate({
      executionKey: 'skill-dangerous-source',
      proposal: {
        proposalId: 'proposal-dangerous-source',
        sourceReportRef: 'output/source.json',
        raw: {
          item: {
            sourceEpisodeId: 'episode-danger-skill',
            tests: [{ name: 'skill-review', ok: true, reportRef: 'output/skill-review.json' }],
            rollbackPlan: ['drop skill candidate'],
            privateHoldout: { status: 'structure_only' },
            patchExecutorEnabled: true,
          },
        },
      },
    });
    const report = buildNoeMemorySkillCandidateGateReport([memory, skill]);
    const errors = report.results.flatMap((item) => item.errors);

    expect(JSON.stringify(report)).not.toContain('should not be copied or executed');
    expect(report.ok).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([
      'candidate_source_input_dangerous_field_forbidden:command',
      'candidate_source_input_dangerous_field_forbidden:proposal.raw.item.patchExecutorEnabled',
    ]));
  });

  it('loads existing queue inputs only when requested and reports missing metadata as gate failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-candidate-inputs-'));
    try {
      const memoryRef = 'output/noe-memory-candidates/pending.jsonl';
      const skillRef = 'output/noe-proposal-executions/queues/skill-drafts.jsonl';
      writeJsonl(join(root, memoryRef), [{
        candidateId: 'mem-missing-metadata',
        body: 'not emitted',
        evidenceRefs: ['output/evidence.json'],
      }]);
      writeJsonl(join(root, skillRef), [{
        executionKey: 'skill-missing-metadata',
        proposal: { proposalId: 'skill-missing-metadata', sourceReportRef: 'output/source.json', raw: { item: { body: 'not emitted' } } },
      }]);

      const loaded = loadNoeMemorySkillCandidateInputs({
        root,
        memoryPendingRef: memoryRef,
        skillDraftQueueRef: skillRef,
      });
      const report = buildNoeMemorySkillCandidateGateReport(loaded.candidates);

      expect(loaded).toMatchObject({ ok: true, counts: { memoryPending: 1, skillDraftQueue: 1 } });
      expect(JSON.stringify(loaded)).not.toContain('not emitted');
      expect(report.ok).toBe(false);
      expect(report.results.flatMap((item) => item.errors)).toEqual(expect.arrayContaining([
        'candidate_source_episode_required',
        'candidate_tests_required',
        'candidate_rollback_plan_required',
        'candidate_private_holdout_result_required',
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects sensitive existing-queue input refs before reading files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-candidate-sensitive-inputs-'));
    try {
      const loaded = loadNoeMemorySkillCandidateInputs({
        root,
        memoryPendingRef: 'output/.env.local',
        skillDraftQueueRef: 'file:output/noe-proposal-executions/queues/skill-drafts.jsonl',
      });

      expect(loaded.ok).toBe(false);
      expect(loaded.errors).toEqual(expect.arrayContaining([
        { ref: 'output/.env.local', error: 'sensitive_input_ref_forbidden' },
        { ref: 'file:output/noe-proposal-executions/queues/skill-drafts.jsonl', error: 'input_ref_forbidden_scheme' },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked existing-queue input refs before reading files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-candidate-symlink-inputs-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-candidate-symlink-target-'));
    try {
      mkdirSync(join(root, 'output/noe-memory-candidates'), { recursive: true });
      writeFileSync(join(outside, 'pending.jsonl'), `${JSON.stringify(memoryCandidate())}\n`);
      symlinkSync(join(outside, 'pending.jsonl'), join(root, 'output/noe-memory-candidates/pending.jsonl'));

      const loaded = loadNoeMemorySkillCandidateInputs({
        root,
        memoryPendingRef: 'output/noe-memory-candidates/pending.jsonl',
        skillDraftQueueRef: 'output/noe-proposal-executions/queues/skill-drafts.jsonl',
      });

      expect(loaded.ok).toBe(false);
      expect(loaded.errors).toEqual(expect.arrayContaining([
        { ref: 'output/noe-memory-candidates/pending.jsonl', error: 'input_ref_symlink_forbidden' },
      ]));
      expect(loaded.candidates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('CLI writes a sanitized smoke report and rejects escaped candidate files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-candidate-gate-'));
    const outRef = `output/noe-candidate-gate-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outDir = join(REPO_ROOT, outRef);
    const prevCwd = process.cwd();
    try {
      process.chdir(REPO_ROOT);
      runCandidateGateCli(['--out-dir', outRef]);

      const latest = join(outDir, 'latest.json');
      expect(existsSync(latest)).toBe(true);
      const report = JSON.parse(readFileSync(latest, 'utf8'));
      expect(report.ok).toBe(true);
      expect(report.counts).toMatchObject({ candidates: 2, passed: 2 });
      expect(JSON.stringify(report)).not.toContain('sk-');

      const candidateFile = join(root, 'candidates.json');
      writeFileSync(candidateFile, JSON.stringify([memoryCandidate()], null, 2));
      expect(() => runCandidateGateCli(['--candidate-file', candidateFile, '--out-dir', outRef]))
        .toThrow(/candidate file escapes repo/);
      expect(() => runCandidateGateCli(['--candidate-file', '.env.local', '--out-dir', outRef]))
        .toThrow(/candidate file references forbidden sensitive path/);
      expect(() => runCandidateGateCli(['--candidate-file', 'file:output/candidates.json', '--out-dir', outRef]))
        .toThrow(/candidate file uses forbidden file scheme/);
      expect(() => runCandidateGateCli(['--out-dir', join(root, 'out')]))
        .toThrow(/out-dir escapes repo/);
      expect(() => runCandidateGateCli(['--out-dir', 'docs/noe-candidate-gate']))
        .toThrow(/out-dir must stay under output/);
      expect(() => runCandidateGateCli(['--out-dir', 'evals/neo/private_holdout/candidate-gate']))
        .toThrow(/out-dir references forbidden sensitive path/);

      const outside = mkdtempSync(join(tmpdir(), 'noe-candidate-gate-outside-'));
      const symlinkRef = `output/noe-candidate-gate-symlink-${process.pid}-${Date.now()}`;
      const symlinkPath = join(REPO_ROOT, symlinkRef);
      symlinkSync(outside, symlinkPath);
      expect(() => runCandidateGateCli(['--out-dir', symlinkRef]))
        .toThrow(/out-dir uses forbidden symlink path/);
      rmSync(symlinkPath, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    } finally {
      process.chdir(prevCwd);
      rmSync(outDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
