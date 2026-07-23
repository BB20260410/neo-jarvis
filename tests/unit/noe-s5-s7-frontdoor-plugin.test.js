// @ts-check
import { describe, expect, it, beforeEach } from 'vitest';
import {
  evaluatePluginLoad,
  auditPluginSourceText,
} from '../../src/runtime/NoePluginHostPolicy.js';
import {
  buildFrontDoorManifest,
  renderOrdinaryReceipt,
  ORDINARY_FRONT_DOOR_ENTRIES,
} from '../../src/runtime/NoeTaskReceiptView.js';
import {
  UnifiedTaskStore,
  resetUnifiedTaskStoreForTests,
} from '../../src/runtime/UnifiedTaskStore.js';

describe('NoePluginHostPolicy fail-closed', () => {
  it('denies third-party without OS sandbox / host / ipc / broker', () => {
    const r = evaluatePluginLoad({ trustLevel: 'third_party' });
    expect(r.allowed).toBe(false);
    expect(r.failClosed).toBe(true);
    expect(r.blockers).toContain('os_sandbox_required_fail_closed');
  });

  it('denies new Function and main-process dynamic import', () => {
    const r = evaluatePluginLoad({
      trustLevel: 'third_party',
      osSandboxAvailable: true,
      pluginHostIsolated: true,
      typedIpc: true,
      permissionBroker: true,
      usesNewFunction: true,
      mainProcessDynamicImport: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.blockers).toContain('new_function_eval_forbidden');
    expect(r.blockers).toContain('main_process_dynamic_import_forbidden');
  });

  it('allows only when full host+ipc+broker+sandbox', () => {
    const r = evaluatePluginLoad({
      trustLevel: 'third_party',
      osSandboxAvailable: true,
      pluginHostIsolated: true,
      typedIpc: true,
      permissionBroker: true,
    });
    expect(r.allowed).toBe(true);
    expect(r.defaultCapabilities.fs).toBe(false);
  });

  it('audits unsafe source text', () => {
    const bad = auditPluginSourceText('const f = new Function("return 1")');
    expect(bad.ok).toBe(false);
    const ok = auditPluginSourceText('export function run(){ return 1 }');
    expect(ok.ok).toBe(true);
  });
});

describe('Front door + ordinary receipt (S5)', () => {
  beforeEach(() => {
    resetUnifiedTaskStoreForTests();
  });

  it('exposes five ordinary entries', () => {
    const m = buildFrontDoorManifest();
    expect(m.ordinaryEntries).toHaveLength(5);
    expect(ORDINARY_FRONT_DOOR_ENTRIES.map((e) => e.id)).toEqual([
      'chat', 'tasks', 'memory', 'doctor', 'settings',
    ]);
    expect(m.expertMode.sameTaskTruth).toBe(true);
    expect(m.firstTaskSlaMinutes).toBe(10);
  });

  it('ordinary and expert share UnifiedTask truth', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const t = store.create({ goal: 'first task', sourceDigest: 'sha256:x' });
    store.transition(t.id, 'running');
    store.transition(t.id, 'completed', {
      exitCode: 0,
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      sourceDigestMatch: true,
      approvalsSettled: true,
      highRiskActsSettled: true,
      artifacts: [{ path: 'a.md', sha256: '1' }],
      resultSummary: 'done',
    });
    const view = renderOrdinaryReceipt(t.id, { taskStore: store });
    expect(view.ok).toBe(true);
    expect(view.sameTruth).toBe(true);
    expect(view.ordinary.completed).toBe(true);
    expect(view.ordinary.artifactCount).toBe(1);
    expect(view.expert.sourceDigest).toBe('sha256:x');
    // ordinary must not dump verification internals as primary fields
    expect(view.ordinary.verification).toBeUndefined();
  });
});
