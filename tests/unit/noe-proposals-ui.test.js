import { describe, expect, it, vi } from 'vitest';
import {
  applySelfModelProposalFromUi,
  dryRunMemoryCandidateApply,
  dryRunMemoryCandidateRollback,
  executeProposalMaterialization,
  installNoeProposalInbox,
  loadProposalDetail,
  recordProposalDecision,
  refreshMemoryCandidateStatus,
  refreshProposalInbox,
  renderMemoryCandidateStatus,
  reviewMemoryCandidateQueue,
  renderProposalDetail,
  renderProposalRows,
} from '../../public/src/web/noe-proposals-ui.js';

function makeNode(id = '') {
  return {
    id,
    className: '',
    dataset: {},
    value: '',
    checked: false,
    textContent: '',
    style: {},
    listeners: {},
    _innerHTML: '',
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    closest(selector) {
      if (selector === '[data-noe-proposal-id]' && this.dataset.noeProposalId) return this;
      return null;
    },
  };
}

function makeRoot() {
  const nodes = new Map();
  const grid = makeNode('brain-grid');
  grid.appended = [];
  grid.appendChild = (node) => {
    grid.appended.push(node);
    nodes.set(`#${node.id}`, node);
    for (const id of [
      'noeProposalInboxStatus',
      'noeProposalSource',
      'noeProposalStatus',
      'btnNoeProposalRefresh',
      'btnNoeMemoryCandidateReview',
      'btnNoeMemoryCandidateApplyDryRun',
      'noeMemoryRollbackRef',
      'btnNoeMemoryCandidateRollbackDryRun',
      'btnNoeMemoryCandidateStatus',
      'noeMemoryCandidateStatus',
      'noeProposalInboxList',
      'noeProposalDetail',
    ]) nodes.set(`#${id}`, makeNode(id));
  };
  nodes.set('.noe-brain-grid', grid);
  nodes.set('#noeBrainArea .noe-brain-grid', grid);
  return {
    grid,
    createElement: () => makeNode(),
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
    setNode(selector, node) {
      nodes.set(selector, node);
      return node;
    },
  };
}

function proposal(overrides = {}) {
  return {
    id: 'proposal-ui-1',
    source: 'background_review',
    sourceReportRef: 'output/noe-background-review/report.json',
    kind: 'review',
    type: 'background_review_candidate',
    status: 'proposed',
    title: 'Review candidate',
    summary: 'Owner should review this candidate.',
    proposalOnly: true,
    applySupported: false,
    requiresGatedApply: true,
    directWrites: [],
    ...overrides,
  };
}

describe('Noe proposal inbox UI', () => {
  it('renders proposal rows and details as read-only without leaking secret-like strings', () => {
    const rows = renderProposalRows([
      proposal({
        source: 'self_model',
        kind: 'identity',
        type: 'self_model_diff',
        title: 'Candidate sk-unitsecret000000000000000000000000000000',
        summary: 'url https://example.test/?token=secret-value',
      }),
    ]);
    const detail = renderProposalDetail(proposal());

    expect(rows).toContain('Candidate [redacted]');
    expect(rows).toContain('token=[redacted]');
    expect(rows).toContain('Self-model');
    expect(rows).toContain('identity');
    expect(rows).not.toContain('sk-unitsecret');
    expect(rows).not.toContain('secret-value');
      expect(detail).toContain('not supported here');
      expect(detail).toContain('requires gated apply');
      expect(detail).toContain('Approve gated');
      expect(detail).toContain('Materialize');
      expect(detail).toContain('direct writes');
      expect(detail).toContain('none');
  });

  it('renders boot self-check repair proposals as a distinct Chinese source', () => {
    const rows = renderProposalRows([
      proposal({
        source: 'boot_self_check',
        kind: 'runtime_repair',
        type: 'boot_self_check_manual_repair',
        title: '切换到较新的开爪候选版本',
        summary: 'Noe 只排队，不自动改 PATH。',
      }),
    ]);

    expect(rows).toContain('开机自检');
    expect(rows).toContain('runtime_repair');
    expect(rows).toContain('切换到较新的开爪候选版本');
  });

  it('renders self-model apply controls only for self-model diff proposals', () => {
    const selfModelDetail = renderProposalDetail(proposal({
      source: 'self_model',
      type: 'self_model_diff',
      status: 'approved_for_gated_apply',
      title: 'Self-model diff proposal: disposition',
    }));
    const backgroundDetail = renderProposalDetail(proposal());

    expect(selfModelDetail).toContain('data-noe-self-model-confirm-id');
    expect(selfModelDetail).toContain('Self-model dry-run');
    expect(selfModelDetail).toContain('Apply self-model');
    expect(selfModelDetail).toContain('owner checkbox required');
    expect(backgroundDetail).not.toContain('data-noe-self-model-confirm-id');
    expect(backgroundDetail).not.toContain('Apply self-model');
  });

  it('renders memory candidate status as a read-only summary', () => {
    const html = renderMemoryCandidateStatus({
      ok: true,
      queue: { records: 2 },
      pending: { records: 1, pendingOwnerReview: 1 },
      reports: { apply: { latest: { ref: 'output/noe-memory-candidates/apply-reports/a.json' } } },
      readiness: {
        latestReviewStatus: 'ready_for_owner_review',
        latestApplyStatus: 'dry_run_ready',
        latestRollbackStatus: 'skipped',
        latestApplyReportRef: 'output/noe-memory-candidates/apply-reports/a.json?token=secret-value',
      },
    });

    expect(html).toContain('queue 2');
    expect(html).toContain('pending 1');
    expect(html).toContain('dry_run_ready');
    expect(html).toContain('token=[redacted]');
    expect(html).not.toContain('secret-value');
  });

  it('does not call protected proposal API when owner token is missing', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => false } };
    try {
      const out = installNoeProposalInbox({ root });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(out.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(root.grid.appended[0]).toMatchObject({
        id: 'noeProposalInboxPanel',
        className: 'noe-brain-panel noe-brain-panel-wide',
      });
      expect(root.querySelector('#noeProposalInboxStatus').textContent).toBe('blocked');
      expect(root.querySelector('#noeProposalInboxList').innerHTML).toContain('owner token missing');
      expect(root.querySelector('#noeProposalDetail').innerHTML).toContain('这里只读');
      expect(root.grid.appended[0].innerHTML).toContain('value="self_model"');
      expect(root.grid.appended[0].innerHTML).toContain('value="boot_self_check"');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('loads the proposal list and keeps selection in the read-only detail panel', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(async (path) => {
      if (String(path).startsWith('/api/noe/proposals?')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            counts: { total: 1 },
            proposals: [proposal()],
          }),
        };
      }
      if (String(path).startsWith('/api/noe/proposals/proposal-ui-1')) {
        return { ok: true, json: async () => ({ ok: true, proposal: proposal({ summary: 'Detailed proposal' }) }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      installNoeProposalInbox({ root });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchSpy.mock.calls[0][0]).toContain('/api/noe/proposals?');
      expect(root.querySelector('#noeProposalInboxStatus').textContent).toBe('1/1');
      expect(root.querySelector('#noeProposalInboxList').innerHTML).toContain('Review candidate');
      expect(root.querySelector('#noeProposalDetail').innerHTML).toContain('not supported here');

      const detailOut = await loadProposalDetail('proposal-ui-1', root);
      expect(detailOut.ok).toBe(true);
      expect(root.querySelector('#noeProposalDetail').innerHTML).toContain('Detailed proposal');
      expect(root.querySelector('#noeProposalDetail').innerHTML).not.toContain('Apply');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('refreshes with source and status filters without writing state back to the server', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    root.querySelector('#noeProposalSource').value = 'skill_curator';
    root.querySelector('#noeProposalStatus').value = 'proposed';
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, counts: { total: 0 }, proposals: [] }) }));
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      await refreshProposalInbox(root);

      expect(fetchSpy.mock.calls[0][0]).toContain('source=skill_curator');
      expect(fetchSpy.mock.calls[0][0]).toContain('status=proposed');
      expect(fetchSpy.mock.calls[0][1]?.method || 'GET').toBe('GET');
      expect(root.querySelector('#noeProposalInboxList').innerHTML).toContain('暂无 proposal');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('records an owner-confirmed proposal decision and refreshes the inbox', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    const fetchSpy = vi.fn(async (path, _opts = {}) => {
      if (String(path).includes('/decision')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            proposal: proposal({
              status: 'approved_for_gated_apply',
              ownerDecision: { status: 'approved_for_gated_apply', decidedAt: '2026-06-13T01:00:00.000Z' },
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, counts: { total: 1 }, proposals: [proposal({ status: 'approved_for_gated_apply' })] }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      const out = await recordProposalDecision('proposal-ui-1', 'approve_for_gated_apply', root);

      expect(out.ok).toBe(true);
      const postCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('/decision'));
      expect(postCall[0]).toBe('/api/noe/proposals/proposal-ui-1/decision');
      expect(postCall[1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(postCall[1].body)).toMatchObject({
        decision: 'approve_for_gated_apply',
        confirmOwner: true,
      });
      expect(root.querySelector('#noeProposalInboxStatus').textContent).toBe('1/1');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('materializes an approved proposal through the protected execute endpoint', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    const fetchSpy = vi.fn(async (path, _opts = {}) => {
      if (String(path).includes('/execute')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            dryRun: false,
            execution: {
              status: 'materialized',
              reportRef: 'output/noe-proposal-executions/execution-a.json',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, counts: { total: 1 }, proposals: [proposal({ status: 'approved_for_gated_apply' })] }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      const out = await executeProposalMaterialization('proposal-ui-1', root);

      expect(out).toMatchObject({ ok: true, execution: { status: 'materialized' } });
      const postCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('/execute'));
      expect(postCall[0]).toBe('/api/noe/proposals/proposal-ui-1/execute');
      expect(postCall[1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(postCall[1].body)).toMatchObject({
        dryRun: false,
        confirmOwner: true,
      });
      expect(root.querySelector('#noeProposalInboxStatus').textContent).toBe('1/1');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('requires the owner confirmation checkbox before calling self-model apply', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    const checkbox = makeNode('selfModelConfirm');
    root.setNode('[data-noe-self-model-confirm-id="proposal-ui-1"]', checkbox);
    const fetchSpy = vi.fn(async (path, _opts = {}) => {
      if (String(path).includes('/self-model-apply')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            dryRun: false,
            selfModelApply: { ok: true, versionId: 'v002', identityFields: ['disposition'] },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, counts: { total: 1 }, proposals: [proposal({ source: 'self_model', type: 'self_model_diff' })] }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      const blocked = await applySelfModelProposalFromUi('proposal-ui-1', { dryRun: false }, root);
      expect(blocked).toMatchObject({ ok: false, error: 'owner_confirmation_required' });
      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('/self-model-apply'))).toBe(false);
      expect(root.querySelector('#noeProposalInboxStatus').textContent).toBe('owner confirm required');

      checkbox.checked = true;
      const out = await applySelfModelProposalFromUi('proposal-ui-1', { dryRun: false }, root);

      expect(out).toMatchObject({ ok: true, selfModelApply: { versionId: 'v002' } });
      const postCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('/self-model-apply'));
      expect(postCall[0]).toBe('/api/noe/proposals/proposal-ui-1/self-model-apply');
      expect(postCall[1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(postCall[1].body)).toEqual({ dryRun: false, confirmOwner: true });
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('drives memory candidate review/apply/rollback through protected dry-run endpoints', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    root.querySelector('#noeMemoryRollbackRef').value = 'output/noe-memory-candidates/apply-reports/apply.json';
    const fetchSpy = vi.fn(async (path, _opts = {}) => {
      if (String(path).endsWith('/review')) {
        return { ok: true, json: async () => ({ ok: true, status: 'ready_for_owner_review', pendingRef: 'output/noe-memory-candidates/pending.jsonl' }) };
      }
      if (String(path).endsWith('/apply')) {
        return { ok: true, json: async () => ({ ok: true, status: 'dry_run_ready', reportRef: 'output/noe-memory-candidates/apply-reports/a.json' }) };
      }
      if (String(path).endsWith('/rollback')) {
        return { ok: true, json: async () => ({ ok: true, status: 'dry_run_ready', reportRef: 'output/noe-memory-candidates/rollback-reports/r.json' }) };
      }
      if (String(path).startsWith('/api/noe/memory-candidates/status')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            queue: { records: 1 },
            pending: { records: 1, pendingOwnerReview: 1 },
            readiness: {
              latestReviewStatus: 'ready_for_owner_review',
              latestApplyStatus: 'dry_run_ready',
              latestRollbackStatus: 'dry_run_ready',
              latestApplyReportRef: 'output/noe-memory-candidates/apply-reports/a.json',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true, counts: { total: 0 }, proposals: [] }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      expect(await reviewMemoryCandidateQueue(root)).toMatchObject({ ok: true, status: 'ready_for_owner_review' });
      expect(await dryRunMemoryCandidateApply(root)).toMatchObject({ ok: true, status: 'dry_run_ready' });
      expect(await dryRunMemoryCandidateRollback(root)).toMatchObject({ ok: true, status: 'dry_run_ready' });

      const reviewCall = fetchSpy.mock.calls.find((call) => String(call[0]).endsWith('/review'));
      expect(reviewCall[0]).toBe('/api/noe/memory-candidates/review');
      expect(JSON.parse(reviewCall[1].body)).toMatchObject({ dryRun: false, confirmOwner: true });
      const applyCall = fetchSpy.mock.calls.find((call) => String(call[0]).endsWith('/apply'));
      expect(JSON.parse(applyCall[1].body)).toEqual({ dryRun: true });
      const rollbackCall = fetchSpy.mock.calls.find((call) => String(call[0]).endsWith('/rollback'));
      expect(JSON.parse(rollbackCall[1].body)).toEqual({
        applyReportRef: 'output/noe-memory-candidates/apply-reports/apply.json',
        dryRun: true,
      });
      expect(root.querySelector('#noeMemoryCandidateStatus').innerHTML).toContain('owner review 1');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('refreshes memory candidate status and fills rollback input from latest apply report', async () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeProposalInboxPanel'));
    const fetchSpy = vi.fn(async (path) => {
      if (String(path).startsWith('/api/noe/memory-candidates/status')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            queue: { records: 1 },
            pending: { records: 2, pendingOwnerReview: 1 },
            reports: {},
            readiness: {
              latestReviewStatus: 'ready_for_owner_review',
              latestApplyStatus: 'dry_run_ready',
              latestRollbackStatus: '',
              latestApplyReportRef: 'output/noe-memory-candidates/apply-reports/latest.json',
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      const out = await refreshMemoryCandidateStatus(root);

      expect(out.ok).toBe(true);
      expect(fetchSpy.mock.calls[0][0]).toBe('/api/noe/memory-candidates/status?limit=10');
      expect(root.querySelector('#noeMemoryCandidateStatus').innerHTML).toContain('pending 2');
      expect(root.querySelector('#noeMemoryRollbackRef').value).toBe('output/noe-memory-candidates/apply-reports/latest.json');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });
});
