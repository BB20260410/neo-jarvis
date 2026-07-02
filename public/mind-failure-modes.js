// @ts-check
// P7-H1 只读故障归因，挂在 public/mind.html 的证明门后面。

function ownerToken() {
  try {
    return localStorage.getItem('panel-owner-token') || sessionStorage.getItem('panel-owner-token') || '';
  } catch {
    return '';
  }
}

async function api(path) {
  const res = await fetch(path, {
    cache: 'no-store',
    headers: { 'X-Panel-Owner-Token': ownerToken() },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || `请求失败 ${res.status}`);
  return j;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEVERITY_CN = { critical: '严重', high: '高', low: '低', warn: '警告', unknown: '未知' };
const LEVEL_CN = {
  read_only_replay_ok: '只读回放通过',
  'read only replay ok': '只读回放通过',
  approval_required: '需要审批',
  'approval required': '需要审批',
  diagnostic_only: '仅诊断',
  'diagnostic only': '仅诊断',
  ready: '就绪',
  blocked: '阻塞',
};
const CLUSTER_CN = {
  'browser_dom_host_mismatch': '浏览器主机不一致',
  'act:blocked': '行动被审批阻塞',
  'goal_checkpoint:evidence_blocked': '目标检查点缺证据',
  'goal_checkpoint:step_recovered': '目标步骤反复恢复',
  'act_executor_missing': '缺少行动执行器',
};
const SOURCE_CN = { source: '原始', derived: '推导' };

function cn(value, fallback = '未知') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (LEVEL_CN[raw]) return LEVEL_CN[raw];
  const spaced = raw.replace(/_/g, ' ');
  return /[A-Za-z]{3,}/.test(spaced) ? fallback : spaced;
}

function publicError(message, fallback = '加载失败') {
  const raw = String(message || '').trim();
  if (!raw) return fallback;
  if (/owner\s*token|required|owner-token|unauth|401|forbidden|permission/i.test(raw)) {
    return '受保护端点需要授权；公开运行状态仍会显示。';
  }
  return raw.replace(/HTTP/gi, '请求失败').replace(/_/g, ' ').trim();
}

function cnSeverity(value) {
  return SEVERITY_CN[String(value || '')] || cn(value);
}

function cnCluster(value) {
  return CLUSTER_CN[String(value || '')] || cn(value, '未知归因');
}

function cnNextAction(value = '') {
  const raw = String(value || '');
  const mapped = [
    ['Add a read-only browser host preflight report that records active app, adapter host, URL/title metadata, and whether observe_page can run before the goal step is marked failed.', '增加只读浏览器主机预检：记录当前应用、适配器主机、页面信息，以及观察能力是否可用。'],
    ['Add a blocked-action settlement report that maps blocked action kind to required approval, evidence ref, and safe fallback action.', '增加被阻塞行动结算报告：把行动类型映射到所需审批、证据引用和安全兜底动作。'],
    ['Add an evidence-contract checker that explains which evidence ref, action result, or checkpoint payload is missing before settlement.', '增加证据契约检查：在结算前说明缺少哪条证据、行动结果或检查点载荷。'],
    ['Add a recovery-cause summary to each recovered step and promote recurring causes into preflight checks.', '为每个恢复步骤记录恢复原因，并把反复出现的原因升级成预检项。'],
    ['Add capability discovery coverage for unregistered action kinds before the goal planner can choose them.', '增加行动能力发现覆盖，避免目标规划器选择未注册的行动类型。'],
  ].find(([source]) => raw === source);
  return mapped ? mapped[1] : cn(raw, '下一步已记录');
}

function ensureBox() {
  let box = document.getElementById('proofFailureModes');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'proofFailureModes';
  box.className = 'proof-failure-modes';
  const grid = document.querySelector('.proof-grid');
  if (grid?.parentElement) grid.insertAdjacentElement('afterend', box);
  else document.getElementById('proofCard')?.append(box);
  return box;
}

function renderFailureModes(fm) {
  const box = ensureBox();
  if (!box) return;
  if (!fm?.enabled) {
    box.classList.add('off');
    box.innerHTML = '<details class="proof-failure-details"><summary><div class="proof-failure-head"><span>故障归因</span><em>无归因报告</em></div></summary></details>';
    return;
  }
  box.classList.remove('off');
  const clusters = Array.isArray(fm.clusters) ? fm.clusters : [];
  const rows = clusters.length
    ? clusters.map((c) => `
      <div class="failure-mode-row ${esc(c.severity || '')}">
        <div class="row1">
          <span class="badge ${c.severity === 'critical' ? 'b-fire' : c.severity === 'high' ? 'b-deep' : 'b-src'}">${esc(cnSeverity(c.severity || 'unknown'))}</span>
          <b>${esc(cnCluster(c.cluster || 'unknown'))}</b>
          <span class="t">${esc(c.derived ? SOURCE_CN.derived : SOURCE_CN.source)} · ${esc(c.count || 0)} 条 / 证据 ${esc(c.matchedEvidenceCount || 0)} 条</span>
        </div>
        <div class="meta">
          <span class="chip">${c.seedId ? '种子已记录' : '无种子'}</span>
          <span class="chip">${esc(cn(c.replayLevel || 'diagnostic'))}</span>
          ${c.readyForJ0Lite ? '<span class="chip">可进入轻量复盘</span>' : ''}
        </div>
        ${c.nextAction ? `<div class="failure-next">${esc(cnNextAction(c.nextAction))}</div>` : ''}
      </div>`).join('')
    : '<div class="empty">没有故障归因类</div>';
  box.innerHTML = `
    <details class="proof-failure-details">
      <summary>
        <div class="proof-failure-head">
          <span>故障归因</span>
          <em>${esc(fm.clusterCount || 0)} 类 · ${esc(fm.j0LiteGapSeedCount || 0)} 个复盘种子 · 已记录</em>
        </div>
      </summary>
      ${fm.blockers?.length ? `<div class="proof-blockers">${fm.blockers.map((b) => `<span class="badge b-fire">${esc(cn(b))}</span>`).join('')}</div>` : ''}
      <div class="failure-mode-list">${rows}</div>
    </details>`;
}

async function loadFailureModes() {
  try {
    const proof = await api('/api/noe/mind/proof');
    renderFailureModes(proof.failureModes);
  } catch (e) {
    const box = ensureBox();
    if (box) box.innerHTML = `<details class="proof-failure-details"><summary><div class="proof-failure-head"><span>故障归因</span><em>${esc(publicError(e.message))}</em></div></summary></details>`;
  }
}

loadFailureModes();
setInterval(loadFailureModes, 30_000);
