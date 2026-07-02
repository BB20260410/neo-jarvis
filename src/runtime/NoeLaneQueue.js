import { randomUUID } from 'node:crypto';

export const NOE_LANE_QUEUE_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const PRIORITY = { background: 0, normal: 1, user: 2 };

function normalizeLane(value) {
  return String(value || '').trim().replace(/\s+/g, '-').slice(0, 160);
}

function normalizeLanes(lanes = []) {
  const input = Array.isArray(lanes) ? lanes : [lanes];
  const out = input.map(normalizeLane).filter(Boolean);
  return [...new Set(out.length ? out : ['global'])];
}

function normalizePriority(value) {
  const key = String(value || 'normal').trim().toLowerCase();
  return Object.hasOwn(PRIORITY, key) ? key : 'normal';
}

function sharesLane(a = [], b = []) {
  const set = new Set(a);
  return b.some((lane) => set.has(lane));
}

export class NoeLaneQueue {
  constructor() {
    this.jobs = new Map();
    this.activeLanes = new Set();
  }

  enqueue({ id = randomUUID(), title = '', lanes = ['global'], priority = 'normal', preempt = false, run } = {}) {
    if (typeof run !== 'function') throw new Error('NoeLaneQueue.enqueue: run function required');
    const normalizedPriority = normalizePriority(priority);
    const job = {
      id,
      title: String(title || id),
      lanes: normalizeLanes(lanes),
      priority: normalizedPriority,
      priorityValue: PRIORITY[normalizedPriority],
      status: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: '',
      cancelRequested: false,
      run,
      promise: null,
    };
    job.promise = new Promise((resolve) => {
      job._resolve = resolve;
    });
    this.jobs.set(id, job);
    if (preempt === true || normalizedPriority === 'user') {
      this.preempt({ lanes: job.lanes, priority: normalizedPriority, exceptId: id, reason: `preempted_by:${id}` });
    }
    queueMicrotask(() => this.pump());
    return { id, promise: job.promise };
  }

  preempt({ lanes = ['global'], priority = 'user', exceptId = '', reason = 'preempted' } = {}) {
    const targetLanes = normalizeLanes(lanes);
    const priorityValue = PRIORITY[normalizePriority(priority)];
    const affected = [];
    for (const job of this.jobs.values()) {
      if (job.id === exceptId || ['succeeded', 'failed', 'cancelled'].includes(job.status)) continue;
      if (!sharesLane(targetLanes, job.lanes)) continue;
      if (job.priorityValue >= priorityValue) continue;
      job.cancelRequested = true;
      job.cancelReason = String(reason || 'preempted');
      affected.push({ id: job.id, status: job.status, priority: job.priority });
      if (job.status === 'queued') this.finish(job, 'cancelled', { ok: false, cancelled: true, reason: job.cancelReason });
    }
    return { ok: true, affected };
  }

  cancel(id, reason = 'cancel_requested') {
    const job = this.jobs.get(id);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return false;
    job.cancelRequested = true;
    job.cancelReason = String(reason || 'cancel_requested');
    if (job.status === 'queued') this.finish(job, 'cancelled', { ok: false, cancelled: true, reason: job.cancelReason });
    return true;
  }

  pump() {
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued') continue;
      if (job.lanes.some((lane) => this.activeLanes.has(lane))) continue;
      this.start(job);
    }
  }

  async start(job) {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    for (const lane of job.lanes) this.activeLanes.add(lane);
    try {
      if (job.cancelRequested) {
        this.finish(job, 'cancelled', { ok: false, cancelled: true, reason: job.cancelReason || 'cancel_requested' });
        return;
      }
      const result = await job.run({ id: job.id, lanes: job.lanes, isCancelRequested: () => job.cancelRequested });
      this.finish(job, job.cancelRequested ? 'cancelled' : 'succeeded', result);
    } catch (e) {
      this.finish(job, 'failed', null, e);
    }
  }

  finish(job, status, result, error = null) {
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.result = result;
    job.error = error?.message || '';
    for (const lane of job.lanes) this.activeLanes.delete(lane);
    job._resolve({
      id: job.id,
      status: job.status,
      result: job.result,
      error: job.error,
      cancelled: status === 'cancelled',
    });
    queueMicrotask(() => this.pump());
  }

  snapshot() {
    return {
      activeLanes: [...this.activeLanes].sort(),
      jobs: [...this.jobs.values()].map((job) => ({
        id: job.id,
        title: job.title,
        lanes: job.lanes,
        priority: job.priority,
        status: job.status,
        queuedAt: job.queuedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        cancelRequested: job.cancelRequested,
        cancelReason: job.cancelReason || '',
        error: job.error,
      })),
    };
  }
}
