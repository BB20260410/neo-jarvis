import { describe, expect, it } from 'vitest';
import {
  evidenceContradictsSuccess,
  normalizeOrdinaryTaskStatus,
  ordinaryStatusLabel,
} from '../../src/runtime/NoeTaskStatusHonesty.js';

describe('NoeTaskStatusHonesty', () => {
  it('labels success as 已成功 not bare 已完成', () => {
    expect(ordinaryStatusLabel('done')).toBe('已成功');
    expect(ordinaryStatusLabel('failed')).toBe('已失败');
  });

  it('reclassifies done when summary has exit≠0 (system_repair fake-green)', () => {
    const r = normalizeOrdinaryTaskStatus({
      status: 'done',
      title: '系统自修复：目标执行链路',
      summary: 'exit=1 · Unknown command: test:p0:unit',
    });
    expect(r.status).toBe('failed');
    expect(r.contradicted).toBe(true);
    expect(r.label).toBe('已失败');
    expect(r.reason).toBeTruthy();
  });

  it('keeps done when exit=0 or clean summary', () => {
    expect(normalizeOrdinaryTaskStatus({
      status: 'done',
      summary: 'exit=0 · all green',
    }).status).toBe('done');
    expect(normalizeOrdinaryTaskStatus({
      status: 'done',
      summary: '补丁已验证并通过',
    }).status).toBe('done');
  });

  it('evidenceContradictsSuccess catches common failure patterns', () => {
    expect(evidenceContradictsSuccess('exit=1')).toBe(true);
    expect(evidenceContradictsSuccess('Unknown command: foo')).toBe(true);
    expect(evidenceContradictsSuccess('all good')).toBe(false);
  });

  it('honors explicit exitCode and ok:false', () => {
    expect(normalizeOrdinaryTaskStatus({ status: 'done', exitCode: 2 }).status).toBe('failed');
    expect(normalizeOrdinaryTaskStatus({ status: 'completed', ok: false }).status).toBe('failed');
  });
});
