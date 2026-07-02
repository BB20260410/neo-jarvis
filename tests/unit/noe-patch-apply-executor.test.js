import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoePatchApplyPlan,
  buildNoePatchRollbackPlan,
  runNoePatchApply,
  runNoePatchRollback,
} from '../../src/runtime/mission/NoePatchApplyExecutor.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function patchOutput(overrides = {}) {
  return {
    ok: true,
    provenance: 'cloud',
    provider: 'minimax',
    patchPlan: {
      kind: 'noe_patch_plan',
      providerId: 'minimax-m3',
      objective: 'write safe local proof',
      operations: [{
        id: 'write-proof',
        op: 'write_file',
        path: 'output/noe-patch-apply-test/proof.txt',
        content: 'safe proof\n',
      }],
    },
    ...overrides,
  };
}

describe('NoePatchApplyExecutor', () => {
  it('builds a content-redacted patch apply plan without returning patch body', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const out = buildNoePatchApplyPlan({
        root,
        patchPlan: patchOutput().patchPlan,
        patchPlanRef: 'output/cloud-task-output.json',
      });

      expect(out).toMatchObject({
        ok: true,
        plan: {
          status: 'ready_for_apply',
          operationCount: 1,
          requiresOwnerConfirmation: true,
          rollbackEvidenceRequired: true,
          operations: [{
            path: 'output/noe-patch-apply-test/proof.txt',
            contentSha256: expect.any(String),
            contentBytes: 11,
          }],
        },
      });
      expect(JSON.stringify(out)).not.toContain('safe proof');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('安全门：自改链路命中受保护策略文件/测试/脚本/本环源码 → 硬挡（patch_path_policy_protected），且不写盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      for (const target of [
        'package.json',
        'vitest.config.mjs',
        'tests/unit/noe-self-evolution-trigger.test.js',
        'scripts/lib/noe-standing-autonomy-grant.mjs',
        'src/loop/NoeSelfEvolutionExecutors.js',
        'src/security/NoePolicyFileGuard.js',
      ]) {
        const built = buildNoePatchApplyPlan({
          root,
          patchPlan: { kind: 'noe_patch_plan', operations: [{ id: 'evil', op: 'write_file', path: target, content: 'x\n' }] },
          patchPlanRef: 'output/x.json',
        });
        expect(built.ok).toBe(false);
        expect(built.blockers.join('\n')).toContain(`patch_path_policy_protected:${target}`);

        // 即便强行尝试真实 apply（confirmOwner:true）也必须被挡，绝不写盘。
        writeJson(join(root, 'output/x.json'), { kind: 'noe_patch_plan', operations: [{ id: 'evil', op: 'write_file', path: target, content: 'x\n' }] });
        const report = runNoePatchApply({ root, patchPlanRef: 'output/x.json', dryRun: false, confirmOwner: true });
        expect(report.status).toBe('blocked');
        expect(JSON.stringify(report.blocked)).toContain('patch_path_policy_protected');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs a cloud patch output without writing target files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      writeJson(join(root, 'output/cloud-task-output.json'), patchOutput());

      const report = runNoePatchApply({
        root,
        patchPlanRef: 'output/cloud-task-output.json',
        dryRun: true,
      });

      expect(report).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        dryRun: true,
        counts: { operations: 1, changedFiles: 0 },
        directWrites: [],
        writesRepoFiles: false,
      });
      expect(existsSync(join(root, 'output/noe-patch-apply-test/proof.txt'))).toBe(false);
      expect(readFileSync(join(root, report.reportRef), 'utf8')).not.toContain('safe proof');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires owner confirmation before real patch apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      writeJson(join(root, 'output/cloud-task-output.json'), patchOutput());

      const report = runNoePatchApply({
        root,
        patchPlanRef: 'output/cloud-task-output.json',
        dryRun: false,
      });

      expect(report).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'owner_confirmation_required' }],
      });
      expect(existsSync(join(root, 'output/noe-patch-apply-test/proof.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies confirmed patches and rolls them back from backup evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'output/noe-patch-apply-test/proof.txt');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'previous proof\n');
      writeJson(join(root, 'output/cloud-task-output.json'), patchOutput({
        patchPlan: {
          ...patchOutput().patchPlan,
          operations: [{
            id: 'overwrite-proof',
            op: 'write_file',
            path: 'output/noe-patch-apply-test/proof.txt',
            content: 'next proof\n',
          }],
        },
      }));

      const applied = runNoePatchApply({
        root,
        patchPlanRef: 'output/cloud-task-output.json',
        dryRun: false,
        confirmOwner: true,
        now: new Date('2026-06-13T03:00:00.000Z'),
      });

      expect(applied).toMatchObject({
        ok: true,
        status: 'applied',
        counts: { operations: 1, changedFiles: 1 },
        writesRepoFiles: true,
        changedFiles: ['output/noe-patch-apply-test/proof.txt'],
        backupManifestRef: expect.stringContaining('manifest.json'),
      });
      expect(readFileSync(target, 'utf8')).toBe('next proof\n');
      const applyReportText = readFileSync(join(root, applied.reportRef), 'utf8');
      expect(applyReportText).not.toContain('previous proof');
      expect(applyReportText).not.toContain('next proof');

      const dryRollback = runNoePatchRollback({
        root,
        applyReportRef: applied.reportRef,
        dryRun: true,
      });
      expect(dryRollback).toMatchObject({
        ok: true,
        status: 'dry_run_ready',
        counts: { rollbackItems: 1, rolledBack: 0 },
      });
      expect(readFileSync(target, 'utf8')).toBe('next proof\n');

      const rolledBack = runNoePatchRollback({
        root,
        applyReportRef: applied.reportRef,
        dryRun: false,
        confirmOwner: true,
      });
      expect(rolledBack).toMatchObject({
        ok: true,
        status: 'rolled_back',
        counts: { rollbackItems: 1, rolledBack: 1 },
        rolledBack: [{
          path: 'output/noe-patch-apply-test/proof.txt',
          action: 'restore_file',
          status: 'restored',
        }],
      });
      expect(readFileSync(target, 'utf8')).toBe('previous proof\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('A2：rollback 删除新建 tests/ 测试文件被放行(NOE_ALLOW_NEW_TEST_FILES=1)，真删不残留', () => {
    // A2 第三处遗漏(实测死循环教训)：apply 放行新建 tests/ 测试，但 rollback 删它时文件已被 apply 写入(存在)，
    //   policyFileBlockReason 用默认 existsSync → 误判「改现有受保护测试」→ 挡 rollback → 新建测试删不掉、
    //   残留污染全量 baseline → self_repair 反复失败死循环。manifest existed=false 已证明是 apply 新建，须放行删除。
    const prev = process.env.NOE_ALLOW_NEW_TEST_FILES;
    process.env.NOE_ALLOW_NEW_TEST_FILES = '1';
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      writeJson(join(root, 'output/cloud-task-output.json'), patchOutput({
        patchPlan: {
          ...patchOutput().patchPlan,
          operations: [{ id: 'add-test', op: 'write_file', path: 'tests/unit/some-new.test.js', content: "import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n" }],
        },
      }));
      const applied = runNoePatchApply({ root, patchPlanRef: 'output/cloud-task-output.json', dryRun: false, confirmOwner: true });
      expect(applied.status).toBe('applied'); // A2 放行新建测试 apply
      expect(existsSync(join(root, 'tests/unit/some-new.test.js'))).toBe(true);
      const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true });
      expect(rolledBack.ok).toBe(true);
      expect(rolledBack.status).toBe('rolled_back');
      expect(existsSync(join(root, 'tests/unit/some-new.test.js'))).toBe(false); // 新建测试真被删,不残留
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (prev === undefined) delete process.env.NOE_ALLOW_NEW_TEST_FILES; else process.env.NOE_ALLOW_NEW_TEST_FILES = prev;
    }
  });

  it('rolls back newly created files by deleting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      writeJson(join(root, 'output/cloud-task-output.json'), patchOutput());
      const applied = runNoePatchApply({
        root,
        patchPlanRef: 'output/cloud-task-output.json',
        dryRun: false,
        confirmOwner: true,
      });
      expect(existsSync(join(root, 'output/noe-patch-apply-test/proof.txt'))).toBe(true);

      const rolledBack = runNoePatchRollback({
        root,
        applyReportRef: applied.reportRef,
        dryRun: false,
        confirmOwner: true,
      });

      expect(rolledBack).toMatchObject({
        ok: true,
        status: 'rolled_back',
        rolledBack: [{
          path: 'output/noe-patch-apply-test/proof.txt',
          action: 'remove_new_file',
          status: 'removed_or_already_missing',
        }],
      });
      expect(existsSync(join(root, 'output/noe-patch-apply-test/proof.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks path escape, secret paths, and secret-like content before apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      writeJson(join(root, 'output/unsafe.json'), patchOutput({
        patchPlan: {
          kind: 'noe_patch_plan',
          operations: [
            { id: 'escape', op: 'write_file', path: '../escape.txt', content: 'x\n' },
            { id: 'env', op: 'write_file', path: '.env', content: 'x\n' },
            { id: 'secret', op: 'write_file', path: 'output/proof.txt', content: 'sk-unitsecret000000000000000000000000000000\n' },
          ],
        },
      }));

      const report = runNoePatchApply({
        root,
        patchPlanRef: 'output/unsafe.json',
        dryRun: false,
        confirmOwner: true,
      });

      expect(report.ok).toBe(false);
      expect(report.status).toBe('blocked');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_path_outside_root');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_path_blocked:.env');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_content_contains_secret_like_value:output/proof.txt');
      expect(existsSync(join(root, 'output/proof.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks forged rollback reports and apply report path escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      expect(runNoePatchRollback({ root, applyReportRef: '../escape.json' })).toMatchObject({
        ok: false,
        status: 'blocked',
        errors: [{ error: 'apply_report_outside_root' }],
      });

      const forged = {
        status: 'applied',
        rollbackEvidenceRequired: true,
        applyId: 'patch-apply-forged',
        backupManifestRef: 'output/manifest.json',
      };
      expect(buildNoePatchRollbackPlan(forged, {
        applyReportRef: 'apply.json',
        backupManifest: { applyId: 'different', entries: [] },
      })).toMatchObject({
        ok: false,
        blockers: expect.arrayContaining(['backup_manifest_apply_id_mismatch']),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a skipped report when no patch plan ref is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const apply = runNoePatchApply({ root });
      const rollback = runNoePatchRollback({ root });

      expect(apply).toMatchObject({ ok: true, status: 'skipped', reason: 'patch_plan_ref_required' });
      expect(rollback).toMatchObject({ ok: true, status: 'skipped', reason: 'apply_report_required' });
      expect(existsSync(join(root, apply.reportRef))).toBe(true);
      expect(existsSync(join(root, rollback.reportRef))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace op：精确单次替换并可回滚', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const a = 1;\nconst b = old_value;\nconst c = 3;\n');
      writeJson(join(root, 'output/replace.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'r1', op: 'replace', path: 'src/sample.js', from: 'old_value', to: 'new_value' }],
      });
      const applied = runNoePatchApply({ root, patchPlanRef: 'output/replace.json', dryRun: false, confirmOwner: true });
      expect(applied).toMatchObject({ ok: true, status: 'applied', counts: { operations: 1, changedFiles: 1 } });
      expect(readFileSync(target, 'utf8')).toBe('const a = 1;\nconst b = new_value;\nconst c = 3;\n');

      const rolledBack = runNoePatchRollback({ root, applyReportRef: applied.reportRef, dryRun: false, confirmOwner: true });
      expect(rolledBack).toMatchObject({ ok: true, status: 'rolled_back', counts: { rolledBack: 1 } });
      expect(readFileSync(target, 'utf8')).toBe('const a = 1;\nconst b = old_value;\nconst c = 3;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace op：from 在文件中不存在 → blocked 且不写盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const a = 1;\n');
      writeJson(join(root, 'output/replace.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'r1', op: 'replace', path: 'src/sample.js', from: 'does_not_exist', to: 'x' }],
      });
      const report = runNoePatchApply({ root, patchPlanRef: 'output/replace.json', dryRun: false, confirmOwner: true });
      expect(report.ok).toBe(false);
      expect(report.status).toBe('blocked');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_replace_from_not_found:r1');
      expect(readFileSync(target, 'utf8')).toBe('const a = 1;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace op：from 多处出现（歧义）→ blocked 且不写盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'x = 1;\nx = 1;\n');
      writeJson(join(root, 'output/replace.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'r1', op: 'replace', path: 'src/sample.js', from: 'x = 1;', to: 'x = 2;' }],
      });
      const report = runNoePatchApply({ root, patchPlanRef: 'output/replace.json', dryRun: false, confirmOwner: true });
      expect(report.ok).toBe(false);
      expect(report.status).toBe('blocked');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_replace_from_ambiguous:r1:2');
      expect(readFileSync(target, 'utf8')).toBe('x = 1;\nx = 1;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace op：to 含 $& / $1 不被正则替换语义解释，字面写入', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const t = MARK;\n');
      writeJson(join(root, 'output/replace.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'r1', op: 'replace', path: 'src/sample.js', from: 'MARK', to: 'A$&B$1C' }],
      });
      const applied = runNoePatchApply({ root, patchPlanRef: 'output/replace.json', dryRun: false, confirmOwner: true });
      expect(applied.status).toBe('applied');
      expect(readFileSync(target, 'utf8')).toBe('const t = A$&B$1C;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace op：from/to 含 secret-like 值 → blocked 且不写盘', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const k = PLACEHOLDER;\n');
      writeJson(join(root, 'output/replace.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'r1', op: 'replace', path: 'src/sample.js', from: 'PLACEHOLDER', to: 'sk-unitsecret000000000000000000000000000000' }],
      });
      const report = runNoePatchApply({ root, patchPlanRef: 'output/replace.json', dryRun: false, confirmOwner: true });
      expect(report.ok).toBe(false);
      expect(report.status).toBe('blocked');
      expect(report.blocked[0].blockers.join('\n')).toContain('patch_content_contains_secret_like_value');
      expect(readFileSync(target, 'utf8')).toBe('const k = PLACEHOLDER;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 多op同文件：op1 吃掉 op2 的 from → op2 blocked(虚拟串行,不静默丢失)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'line_with_SUB = 1;\nother = 2;\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: 'line_with_SUB = 1;', to: 'line_clean = 9;' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: 'SUB', to: 'XXX' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('blocked');
      expect(r.blocked[0].blockers.join('\n')).toContain('patch_replace_from_not_found:op2');
      expect(readFileSync(target, 'utf8')).toBe('line_with_SUB = 1;\nother = 2;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 多op同文件：op1 注入第二处匹配 → op2 blocked(ambiguous,防越改越歪)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'header = "x";\nconf = PORT;\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: 'header = "x";', to: 'header = PORT;' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: 'PORT', to: '8080' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('blocked');
      expect(r.blocked[0].blockers.join('\n')).toContain('patch_replace_from_ambiguous:op2');
      expect(readFileSync(target, 'utf8')).toBe('header = "x";\nconf = PORT;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 多op同文件：合法链式(op1 产物喂 op2) → applied', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const v = STAGE1;\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: 'STAGE1', to: 'STAGE2' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: 'STAGE2', to: 'STAGE3' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.status).toBe('applied');
      expect(readFileSync(target, 'utf8')).toBe('const v = STAGE3;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 拆分写 secret：两 op 拼成完整 key → blocked(finalText 全文检测)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const k = AB;\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: 'A', to: 'sk-abcdefghij' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: 'B', to: 'klmnopqrstuvwxyz1234' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('blocked');
      expect(r.blocked[0].blockers.join('\n')).toContain('patch_content_contains_secret_like_value');
      expect(readFileSync(target, 'utf8')).toBe('const k = AB;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 空 to = 删除片段(合法语义) → applied', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'keep1\nDELETE_ME\nkeep2\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'op1', op: 'replace', path: 'src/sample.js', from: 'DELETE_ME\n', to: '' }],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.status).toBe('applied');
      expect(readFileSync(target, 'utf8')).toBe('keep1\nkeep2\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rollback：伪造 manifest 指向受保护文件(tests/) → blocked(policy guard 纵深防御)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const forged = { status: 'applied', rollbackEvidenceRequired: true, applyId: 'patch-apply-forged', backupManifestRef: 'output/m.json' };
      const built = buildNoePatchRollbackPlan(forged, {
        applyReportRef: 'apply.json',
        backupManifest: { applyId: 'patch-apply-forged', entries: [{ path: 'tests/unit/noe-patch-apply-executor.test.js', existed: true, backupRef: 'output/b.bak', previousSha256: 'x' }] },
        root,
      });
      expect(built.ok).toBe(false);
      expect(built.blockers.join('\n')).toContain('rollback_path_policy_protected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace 拆分写 secret(文件原本已含其他 secret)：净引入新 key → blocked(不被整文件豁免绕过)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      // 文件原本已含一个 secret-like 片段(模板/示例)，旧的"整文件豁免"会因此放行新注入
      writeFileSync(target, 'const legacy = "sk-aaaaaaaaaaaaaaaaaaaaaaaa";\nconst k = "<<L>><<R>>";\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: '<<L>>', to: '123456789:ABCdefGHIj' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: '<<R>>', to: 'klMNOpqrstUVWxyz0123456789' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('blocked');
      expect(r.blocked[0].blockers.join('\n')).toContain('patch_content_contains_secret_like_value');
      expect(readFileSync(target, 'utf8')).toContain('<<L>>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replace：文件原含 secret，合法改无关行(不引入新 secret) → applied(不误拦)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'const legacy = "sk-aaaaaaaaaaaaaaaaaaaaaaaa";\nconst v = OLD;\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [{ id: 'op1', op: 'replace', path: 'src/sample.js', from: 'OLD', to: 'NEW' }],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.status).toBe('applied');
      expect(readFileSync(target, 'utf8')).toContain('const v = NEW;');
      expect(readFileSync(target, 'utf8')).toContain('sk-aaaa');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('净持平对冲：删旧 secret + 拼新 secret(redact 计数 1==1 持平) → 仍 blocked(值集合差集,非计数差)', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-patch-apply-'));
    try {
      const target = join(root, 'src/sample.js');
      mkdirSync(join(target, '..'), { recursive: true });
      // 原文恰好含 1 个 secret(sk-old) + 拆分占位；攻击：删 sk-old + 拼出新 telegram token，净占位数持平
      writeFileSync(target, 'const old = "sk-aaaaaaaaaaaaaaaaaaaaaaaa";\nconst k = "<<L>><<R>>";\n');
      writeJson(join(root, 'output/p.json'), {
        kind: 'noe_patch_plan',
        operations: [
          { id: 'op1', op: 'replace', path: 'src/sample.js', from: '"sk-aaaaaaaaaaaaaaaaaaaaaaaa"', to: '"removed"' },
          { id: 'op2', op: 'replace', path: 'src/sample.js', from: '<<L>>', to: '123456789:ABCdefGHIj' },
          { id: 'op3', op: 'replace', path: 'src/sample.js', from: '<<R>>', to: 'klMNOpqrstUVWxyz0123456789' },
        ],
      });
      const r = runNoePatchApply({ root, patchPlanRef: 'output/p.json', dryRun: false, confirmOwner: true });
      expect(r.ok).toBe(false);
      expect(r.status).toBe('blocked');
      expect(r.blocked[0].blockers.join('\n')).toContain('patch_content_contains_secret_like_value');
      expect(readFileSync(target, 'utf8')).toContain('sk-aaaa');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
