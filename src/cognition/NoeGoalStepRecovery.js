// @ts-check
// P7-G0: extracted stale/retriable goal-step recovery from NoeGoalSystem.
import { appendGoalCheckpoint } from './NoeGoalCheckpoints.js';

const RETRIABLE_BROWSER_HOST_MISMATCH = 'browser_dom_host_mismatch';
const RETRIABLE_BROWSER_HOST_MISMATCH_MAX_RETRIES = 2;

function safeUrlHost(value) {
  try { return new URL(String(value || '')).host.toLowerCase(); } catch { return ''; }
}

function inferStepTargetUrl(plan = [], stepIndex = 0, step = {}) {
  const direct = step?.payload?.url || step?.payload?.targetUrl || step?.payload?.href;
  if (direct) return String(direct);
  for (let i = stepIndex - 1; i >= 0; i -= 1) {
    const prior = plan[i] || {};
    const action = String(prior.action || '');
    if (!['browser.open_url', 'browser.open', 'noe.browser.open_url'].includes(action)) continue;
    const url = prior?.payload?.url || prior?.payload?.targetUrl || prior?.payload?.href;
    if (url) return String(url);
  }
  return '';
}

function activeRows(getdb, rowOut) {
  return getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
}

export function recoverStaleGoalSteps({
  getdb,
  rowOut,
  t = Date.now(),
  staleStepMs = 6 * 3600_000,
  staleResearchStepMs = 90_000,
  staleActStepMs = 5 * 60_000,
} = {}) {
  const olderThanMs = staleStepMs;
  if (!(Number(olderThanMs) > 0)) return 0;
  try {
    const rows = activeRows(getdb, rowOut);
    const upd = getdb().prepare('UPDATE noe_goals SET plan = ?, updated_at = ? WHERE id = ?');
    let changed = 0;
    for (const g of rows) {
      let dirty = false;
      const plan = g.plan.map((s, index) => {
        if (s.status !== 'doing') return s;
        const baseLimit = Number(olderThanMs) > 0 ? Number(olderThanMs) : staleStepMs;
        const stepLimit = s.kind === 'research'
          ? Math.min(baseLimit, Math.max(1000, Number(staleResearchStepMs) || baseLimit))
          : s.kind === 'act'
            ? Math.min(baseLimit, Math.max(1000, Number(staleActStepMs) || baseLimit))
            : baseLimit;
        const touched = Number(s.updatedAt || g.updated_at || 0);
        if (!touched || t - touched < stepLimit) return s;
        dirty = true;
        const prior = String(s.note || '').trim();
        const note = `自动恢复：步骤执行中超过 ${Math.round(stepLimit / 1000)}s 未产生完成证据，已标记 recovered；不会自动重放。${prior ? ` 前序：${prior}` : ''}`.slice(0, 500);
        const recovered = { ...s, status: 'recovered', note, updatedAt: t };
        appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'recovered', note, replaySafe: false });
        return recovered;
      });
      if (dirty) {
        upd.run(JSON.stringify(plan), t, g.id);
        changed += 1;
      }
    }
    return changed;
  } catch {
    return 0;
  }
}

export function recoverRetriableBlockedGoalSteps({ getdb, rowOut, t = Date.now() } = {}) {
  try {
    const rows = activeRows(getdb, rowOut);
    const upd = getdb().prepare('UPDATE noe_goals SET plan = ?, updated_at = ? WHERE id = ?');
    let changed = 0;
    for (const g of rows) {
      let dirty = false;
      const plan = g.plan.map((s, index) => {
        const action = String(s.action || '');
        const note = String(s.note || '');
        const retryCount = Number(s.retryCount || 0);
        const isRetriableMismatch = s.status === 'blocked'
          && s.kind === 'act'
          && ['browser.observe_page', 'noe.browser.observe_page'].includes(action)
          && note.includes(RETRIABLE_BROWSER_HOST_MISMATCH);
        if (!isRetriableMismatch) return s;
        if (retryCount >= RETRIABLE_BROWSER_HOST_MISMATCH_MAX_RETRIES) {
          dirty = true;
          const recoveredNote = `自动恢复：浏览器 host mismatch 已重试 ${retryCount} 次仍未成功，标记 recovered 释放后续目标步骤；这一步没有伪装为完成。前序：${note}`.slice(0, 500);
          const recovered = { ...s, status: 'recovered', note: recoveredNote, updatedAt: t };
          appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'recovered', note: recoveredNote, replaySafe: false });
          return recovered;
        }
        const targetUrl = inferStepTargetUrl(g.plan, index, s);
        if (!targetUrl) return s;
        const host = String(s?.payload?.expectedHost || safeUrlHost(targetUrl)).toLowerCase();
        const expectedHosts = Array.from(new Set([
          ...(Array.isArray(s?.payload?.expectedHosts) ? s.payload.expectedHosts.map((h) => String(h || '').toLowerCase()).filter(Boolean) : []),
          host,
        ].filter(Boolean)));
        const retryNote = `自动重试：浏览器前台 host 不匹配，已把观察目标固定到 ${targetUrl} 并重新排队。前序：${note}`.slice(0, 500);
        const recovered = {
          ...s,
          status: 'open',
          note: retryNote,
          retryCount: retryCount + 1,
          payload: {
            ...(s.payload && typeof s.payload === 'object' ? s.payload : {}),
            url: targetUrl,
            ...(host ? { expectedHost: host } : {}),
            ...(expectedHosts.length ? { expectedHosts } : {}),
          },
          updatedAt: t,
        };
        dirty = true;
        appendGoalCheckpoint(getdb(), { now: () => t, goal: g, goalId: g.id, stepIndex: index, phase: 'step_recovered', status: 'open', note: retryNote, replaySafe: false });
        return recovered;
      });
      if (dirty) {
        upd.run(JSON.stringify(plan), t, g.id);
        changed += 1;
      }
    }
    return changed;
  } catch {
    return 0;
  }
}
