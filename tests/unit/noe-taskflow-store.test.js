import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOE_TASKFLOW_ROOT,
  NOE_SELF_EVOLUTION_FLOW_STEPS,
  NoeTaskFlowStore,
} from '../../src/runtime/NoeTaskFlowStore.js';

describe('NoeTaskFlowStore', () => {
  it('uses a module-derived root by default instead of the caller cwd', () => {
    const oldCwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-cwd-'));
    try {
      process.chdir(dir);
      const store = new NoeTaskFlowStore();

      expect(store.root).toBe(DEFAULT_NOE_TASKFLOW_ROOT);
      expect(store.root).not.toBe(dir);
    } finally {
      process.chdir(oldCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a durable self-evolution taskflow ledger and validates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-'));
    try {
      const store = new NoeTaskFlowStore({ root: dir });
      const flow = store.createFlow({ flowId: 'cycle-1', kind: 'self-evolution', goal: 'improve Noe' });
      const validation = store.validate(flow);

      expect(validation.ok).toBe(true);
      expect(flow.steps.map((step) => step.id)).toEqual(NOE_SELF_EVOLUTION_FLOW_STEPS);
      expect(readFileSync(join(dir, 'output/noe-taskflows/cycle-1/flow.json'), 'utf8')).toContain('improve Noe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('transitions steps with evidence and derives succeeded status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-'));
    try {
      const store = new NoeTaskFlowStore({ root: dir });
      store.createFlow({ flowId: 'simple', steps: ['preflight', 'verify'] });
      store.transition('simple', 'preflight', 'passed', { evidenceRefs: ['output/a.json'] });
      const flow = store.transition('simple', 'verify', 'passed', { evidenceRefs: ['output/b.json'] });

      expect(flow.status).toBe('succeeded');
      expect(flow.steps[0].evidenceRefs).toEqual(['output/a.json']);
      expect(flow.revision).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists summaries with current step and evidence counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-'));
    try {
      const store = new NoeTaskFlowStore({ root: dir });
      store.createFlow({ flowId: 'visible', goal: 'show long task progress', steps: ['plan', 'verify'] });
      store.transition('visible', 'plan', 'passed', { evidenceRefs: ['output/plan.json'] });
      const [summary] = store.list();

      expect(summary).toMatchObject({
        flowId: 'visible',
        status: 'running',
        currentStep: { id: 'verify', status: 'pending' },
        evidenceCount: 1,
      });
      expect(summary.stepCounts.passed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts secret-like taskflow metadata, notes, and evidence refs before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-taskflow-'));
    try {
      const store = new NoeTaskFlowStore({ root: dir });
      const secret = 'tp-unitsecret000000000000000000000000000000';
      store.createFlow({
        flowId: 'redacted',
        goal: `verify ${secret}`,
        steps: ['verify'],
        metadata: { apiKey: secret, nested: { note: `safe ${secret}` } },
      });
      const flow = store.transition('redacted', 'verify', 'passed', {
        evidenceRefs: [`output/${secret}.json`],
        notes: `finished ${secret}`,
      });
      const raw = readFileSync(join(dir, 'output/noe-taskflows/redacted/flow.json'), 'utf8');

      expect(JSON.stringify(flow)).not.toContain(secret);
      expect(raw).not.toContain(secret);
      expect(flow.metadata.apiKey).toBe('[redacted]');
      expect(flow.goal).toContain('[redacted-api-key]');
      expect(flow.steps[0].notes).toContain('[redacted-api-key]');
      expect(flow.steps[0].evidenceRefs[0]).toContain('[redacted-api-key]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
