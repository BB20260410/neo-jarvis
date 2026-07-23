import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { atomicWriteFile, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

export const NOE_TASKFLOW_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_TASKFLOW_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const NOE_SELF_EVOLUTION_FLOW_STEPS = [
  'preflight',
  'plan',
  'council',
  'implement',
  'verify',
  'post_review',
  'writeback',
  'retrospective',
];

export const NOE_TASKFLOW_STEP_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped', 'cancelled']);

function clean(value, max = 2000) {
  return redactSensitiveText(String(value || '').trim()).slice(0, max);
}

function now() {
  return new Date().toISOString();
}

function safeId(value = '') {
  return clean(value, 120).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '') || randomUUID();
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function normalizeStep(step) {
  const id = clean(step?.id || step, 120);
  if (!id) return null;
  return {
    id,
    title: clean(step?.title || id, 240),
    status: NOE_TASKFLOW_STEP_STATUSES.has(step?.status) ? step.status : 'pending',
    evidenceRefs: Array.isArray(step?.evidenceRefs) ? step.evidenceRefs.map((ref) => clean(ref, 1000)).filter(Boolean) : [],
    startedAt: step?.startedAt || null,
    finishedAt: step?.finishedAt || null,
    notes: clean(step?.notes || '', 2000),
  };
}

function safeMetadata(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return clean(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return clean(value, 200);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    const k = clean(key, 120);
    out[k] = /secret|token|key|password|authorization/i.test(k) ? '[redacted]' : safeMetadata(item, depth + 1);
  }
  return out;
}

export class NoeTaskFlowStore {
  constructor({ root = DEFAULT_NOE_TASKFLOW_ROOT, baseDir = 'output/noe-taskflows' } = {}) {
    this.root = resolve(root);
    this.baseDir = resolve(this.root, baseDir);
  }

  flowDir(flowId) {
    return resolve(this.baseDir, safeId(flowId));
  }

  flowFile(flowId) {
    return join(this.flowDir(flowId), 'flow.json');
  }

  createFlow({ flowId, kind = 'task', goal = '', steps = [], metadata = {} } = {}) {
    const id = safeId(flowId || `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const normalizedSteps = (steps.length ? steps : NOE_SELF_EVOLUTION_FLOW_STEPS)
      .map(normalizeStep)
      .filter(Boolean);
    const flow = {
      schemaVersion: NOE_TASKFLOW_SCHEMA_VERSION,
      flowId: id,
      kind: clean(kind, 120) || 'task',
      goal: clean(goal, 4000),
      status: 'running',
      cancelRequested: false,
      createdAt: now(),
      updatedAt: now(),
      metadata: safeMetadata(metadata),
      revision: 1,
      steps: normalizedSteps,
      events: [{ at: now(), type: 'flow.created', status: 'running' }],
    };
    this.write(flow);
    return flow;
  }

  load(flowId) {
    const file = this.flowFile(flowId);
    // 强健工程：损坏 flow.json 自动备份 .corrupted-*.bak 并返 null（旧实现裸 JSON.parse 直接抛
    // SyntaxError 崩调用方；null 契约与两类调用方天然兼容：list 过滤掉、transition 报"not found"）
    return readJsonWithCorruptBackup(file, { label: 'noe-taskflow' });
  }

  list({ limit = 20 } = {}) {
    if (!existsSync(this.baseDir)) return [];
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.load(entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, max)
      .map((flow) => this.summarize(flow));
  }

  summarize(flow = {}) {
    const steps = Array.isArray(flow.steps) ? flow.steps : [];
    return {
      schemaVersion: flow.schemaVersion,
      flowId: clean(flow.flowId, 160),
      kind: clean(flow.kind, 120),
      goal: clean(flow.goal, 500),
      status: clean(flow.status, 80),
      cancelRequested: flow.cancelRequested === true,
      updatedAt: flow.updatedAt || null,
      revision: Number(flow.revision) || 0,
      stepCounts: [...NOE_TASKFLOW_STEP_STATUSES].reduce((acc, status) => {
        acc[status] = steps.filter((step) => step.status === status).length;
        return acc;
      }, {}),
      currentStep: steps.find((step) => step.status === 'running') || steps.find((step) => step.status === 'pending') || null,
      evidenceCount: steps.reduce((count, step) => count + (Array.isArray(step.evidenceRefs) ? step.evidenceRefs.length : 0), 0),
    };
  }

  write(flow) {
    const dir = this.flowDir(flow.flowId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = this.flowFile(flow.flowId);
    // 强健工程：原子写+一代备份（任务流是证据链，半截 JSON = 链断且不可恢复）
    atomicWriteFile(file, `${JSON.stringify(flow, null, 2)}\n`);
    return { file, ref: rel(this.root, file) };
  }

  transition(flowId, stepId, status, { evidenceRefs = [], notes = '' } = {}) {
    if (!NOE_TASKFLOW_STEP_STATUSES.has(status)) throw new Error(`invalid taskflow step status: ${status}`);
    const flow = this.load(flowId);
    if (!flow) throw new Error(`taskflow not found: ${flowId}`);
    const step = flow.steps.find((item) => item.id === stepId);
    if (!step) throw new Error(`taskflow step not found: ${stepId}`);
    if (status === 'running' && !step.startedAt) step.startedAt = now();
    if (['passed', 'failed', 'skipped', 'cancelled'].includes(status)) step.finishedAt = now();
    step.status = status;
    step.evidenceRefs = [...new Set([...step.evidenceRefs, ...evidenceRefs.map((ref) => clean(ref, 1000)).filter(Boolean)])];
    if (notes) step.notes = clean(notes, 2000);
    flow.revision += 1;
    flow.updatedAt = now();
    flow.events.push({ at: now(), type: 'step.transition', stepId, status, evidenceRefs: step.evidenceRefs });
    flow.status = this.deriveStatus(flow);
    this.write(flow);
    return flow;
  }

  requestCancel(flowId, reason = 'cancel_requested') {
    const flow = this.load(flowId);
    if (!flow) throw new Error(`taskflow not found: ${flowId}`);
    flow.cancelRequested = true;
    flow.cancelReason = clean(reason, 1000);
    flow.revision += 1;
    flow.updatedAt = now();
    flow.events.push({ at: now(), type: 'flow.cancel_requested', reason: flow.cancelReason });
    this.write(flow);
    return flow;
  }

  deriveStatus(flow) {
    const required = flow.steps.filter((step) => step.status !== 'skipped');
    if (required.some((step) => step.status === 'failed')) return 'failed';
    if (required.some((step) => step.status === 'cancelled')) return 'cancelled';
    if (required.length && required.every((step) => step.status === 'passed')) return 'succeeded';
    return 'running';
  }

  validate(flow = {}) {
    const errors = [];
    if (flow.schemaVersion !== NOE_TASKFLOW_SCHEMA_VERSION) errors.push('unsupported_taskflow_schema_version');
    if (!clean(flow.flowId)) errors.push('flow_id_required');
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) errors.push('flow_steps_required');
    for (const step of flow.steps || []) {
      if (!clean(step.id)) errors.push('step_id_required');
      if (!NOE_TASKFLOW_STEP_STATUSES.has(step.status)) errors.push(`invalid_step_status:${step.id}:${step.status}`);
      if (step.status === 'passed' && !Array.isArray(step.evidenceRefs)) errors.push(`step_evidence_refs_array_required:${step.id}`);
    }
    return { ok: errors.length === 0, errors };
  }
}
