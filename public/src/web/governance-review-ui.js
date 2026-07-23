// @ts-check
// governance-review-ui.js — 治理中心 Preflight/Resume Review 子域（从 governance-ui.js 分文件；app.js 模块化第三波批26 2026-06-11）
// governance-ui.js 602 行超 <500 文件约束 → 把 review 子域整块原样搬入本文件（纯机械搬移零逻辑改动）：
//   stagedDiffFileMeta/governanceCommandKey/governanceCommandChips/governanceRiskReasons/
//   governanceCoverageExplanations/orderedGovernanceReviewFiles/renderGovernanceCoverageFilter/
//   renderGovernanceResumeReview/renderGovernanceCenterApprovals，外加只作用于 review 区 DOM 的
//   command-jump 滚动高亮与 coverage filter 两段绑定（收进 bindReviewEvents(root)，绑定与渲染同属主）。
// modal 壳/governanceCenterState/主渲染/三个 async 动作（approveAndResumeGovernanceRun 安全关键路径
// 整体留主文件不动）仍在 governance-ui.js，经 window.PanelGovernanceReview 懒解析调用（与全仓桥模式一致）。
// ⚠️ data-gov-center-* 属性族是 e2e 与 agent-graph-ui 跳转探针的跨模块契约，一字不能变。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      escapeHtml, safeClassToken,
      stagedDiffReviewText, governanceCenterBytes, governanceShortHash,
    } = window.PanelCore;

    function stagedDiffFileMeta(file = {}) {
      const coverage = file.commandCoverage || {};
      const status = file.coverageStatus || coverage.status || '-';
      const verifyCount = Number(file.verificationCommandCount ?? coverage.verificationCommandCount ?? 0)
        + Number(file.projectWideVerificationCommandCount ?? coverage.projectWideVerificationCommandCount ?? 0);
      const evidenceCount = Number(file.workEvidenceCommandCount ?? coverage.workEvidenceCommandCount ?? 0)
        + Number(file.projectWideWorkEvidenceCommandCount ?? coverage.projectWideWorkEvidenceCommandCount ?? 0);
      const risk = `${file.riskLevel || '-'}#${Number(file.riskRank || 0) || '-'} score ${Number(file.riskScore || 0)}`;
      return `coverage ${status} · verify ${verifyCount} · evidence ${evidenceCount} · risk ${risk}`;
    }

    function governanceCommandKey(command = '') {
      const text = String(command || '');
      let hash = 2166136261;
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `cmd-${(hash >>> 0).toString(16)}`;
    }

    function governanceCommandChips(file = {}) {
      const coverage = file.commandCoverage || {};
      const items = [
        ...(Array.isArray(coverage.verificationCommands) ? coverage.verificationCommands.map(command => ({ kind: 'verify', command })) : []),
        ...(Array.isArray(coverage.projectWideVerificationCommands) ? coverage.projectWideVerificationCommands.map(command => ({ kind: 'verify-all', command })) : []),
        ...(Array.isArray(coverage.workEvidenceCommands) ? coverage.workEvidenceCommands.map(command => ({ kind: 'evidence', command })) : []),
        ...(Array.isArray(coverage.projectWideWorkEvidenceCommands) ? coverage.projectWideWorkEvidenceCommands.map(command => ({ kind: 'evidence-all', command })) : []),
      ].filter(item => item.command?.command);
      if (!items.length) return '';
      return `<div class="governance-center-command-links">
    ${items.map(item => `<button type="button" class="governance-center-command-chip" data-gov-center-command-jump="${escapeHtml(governanceCommandKey(item.command.command))}" title="${escapeHtml(item.command.command)}">${escapeHtml(item.kind)}</button>`).join('')}
  </div>`;
    }

    function governanceRiskReasons(file = {}) {
      const reasons = Array.isArray(file.riskReasons) ? file.riskReasons : [];
      if (!reasons.length) return '';
      return `<details class="governance-center-risk-explain">
    <summary>Risk reasons</summary>
    <div>${reasons.map(item => `<span>+${Number(item.points || 0)} ${escapeHtml(item.reason || '')}</span>`).join('')}</div>
  </details>`;
    }

    function governanceCoverageExplanations(file = {}) {
      const coverage = file.commandCoverage || {};
      const explanations = Array.isArray(file.coverageExplanations)
        ? file.coverageExplanations
        : Array.isArray(coverage.coverageExplanations) ? coverage.coverageExplanations : [];
      if (!explanations.length) return '';
      return `<details class="governance-center-coverage-explain">
    <summary>Coverage explanation</summary>
    <div>${explanations.map(item => `<span><b>${escapeHtml(item.kind || 'coverage')}</b> ${escapeHtml(item.status || '-')} ${item.command ? `<code>${escapeHtml(item.command)}</code>` : ''} ${escapeHtml(item.reason || '')}</span>`).join('')}</div>
  </details>`;
    }

    function orderedGovernanceReviewFiles(files = [], stagedDiff = {}) {
      const rankMap = new Map((stagedDiff.prioritizedFiles || []).map((item, index) => [`${item.operation || ''}:${item.path || ''}`, Number(item.riskRank || index + 1)]));
      return [...files].sort((a, b) => {
        const ar = Number(a.riskRank || rankMap.get(`${a.operation || ''}:${a.path || ''}`) || 999);
        const br = Number(b.riskRank || rankMap.get(`${b.operation || ''}:${b.path || ''}`) || 999);
        return ar - br || String(a.path || '').localeCompare(String(b.path || ''));
      });
    }

    function renderGovernanceCoverageFilter(files = []) {
      const statuses = ['verified', 'project_wide_verified', 'evidence_only', 'uncovered', 'blocked'];
      const counts = files.reduce((acc, file) => {
        const status = file.coverageStatus || file.commandCoverage?.status || 'uncovered';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
      return `<div class="governance-center-coverage-filter" data-gov-center-coverage-filter>
    <span>Coverage filter</span>
    <button type="button" class="is-active" data-gov-center-coverage-status="all">All ${files.length}</button>
    ${statuses.map(status => `<button type="button" data-gov-center-coverage-status="${escapeHtml(status)}">${escapeHtml(status)} ${counts[status] || 0}</button>`).join('')}
  </div>`;
    }

    function renderGovernanceResumeReview(approval = {}) {
      const review = approval.resumeReview;
      if (!approval.canApproveResume || !review) return '';
      const stagedDiff = review.stagedDiffReview || review.diffReview || {};
      const files = orderedGovernanceReviewFiles(Array.isArray(review.fileChanges) ? review.fileChanges : [], stagedDiff);
      const commands = Array.isArray(review.commands) ? review.commands : [];
      const workCommands = Array.isArray(review.workEvidenceCommands) ? review.workEvidenceCommands : [];
      const risks = Array.isArray(review.risks) ? review.risks : [];
      const gate = review.gate || {};
      const stagedDiffText = stagedDiffReviewText(stagedDiff);
      return `<div class="governance-center-resume-review" data-gov-center-resume-review="${escapeHtml(approval.id)}">
    <div class="governance-center-review-head">
      <span>Preflight Review</span>
      <span class="${review.safeToResume ? 'sev-info' : 'sev-error'}">${review.safeToResume ? 'safe manifest' : 'needs attention'}</span>
    </div>
    <div class="governance-center-review-stats">
      <span>${Number(review.fileChangeCount || files.length)} files</span>
      <span>${Number(review.commandCount || commands.length)} verify cmds</span>
      <span>${Number(review.workEvidenceCommandCount || workCommands.length)} evidence cmds</span>
      <span>Gate ${escapeHtml(gate.id || review.reviewGateId || '-')}</span>
    </div>
    ${stagedDiffText ? `<div class="governance-center-review-diff" data-gov-center-staged-diff="${escapeHtml(stagedDiff.id || '')}">
      <strong>Staged Diff</strong>
      <span>${escapeHtml(stagedDiffText)}</span>
    </div>` : ''}
    ${renderGovernanceCoverageFilter(files)}
    <div class="governance-center-review-note" data-gov-center-coverage-empty hidden>No files match this coverage filter.</div>
    ${files.map(file => `<details class="governance-center-review-file" data-gov-center-review-file="${escapeHtml(file.path || '')}" data-gov-center-coverage="${escapeHtml(file.coverageStatus || file.commandCoverage?.status || 'uncovered')}" open>
      <summary class="governance-center-review-file-row">
        <span class="op">${escapeHtml(file.operation || '-')}</span>
        <span class="risk ${escapeHtml(safeClassToken(file.riskLevel || 'low'))}">#${Number(file.riskRank || 0) || '-'} ${escapeHtml(file.riskLevel || 'low')}</span>
        <code>${escapeHtml(file.path || '-')}</code>
        ${file.diffStats ? `<span>+${Number(file.diffStats.additions || 0)}/-${Number(file.diffStats.removals || 0)}</span>` : ''}
        <span>${governanceCenterBytes(file.contentBytes)}</span>
        <span>sha ${escapeHtml(governanceShortHash(file.contentSha256))}</span>
      </summary>
      ${Array.isArray(file.attentionFlags) && file.attentionFlags.length
        ? `<div class="governance-center-review-note">flags ${file.attentionFlags.map(escapeHtml).join(' · ')}</div>`
        : ''}
      ${file.coverageStatus || file.commandCoverage ? `<div class="governance-center-review-note">${escapeHtml(stagedDiffFileMeta(file))}</div>` : ''}
      ${governanceCoverageExplanations(file)}
      ${governanceCommandChips(file)}
      ${governanceRiskReasons(file)}
      ${file.summary ? `<div class="governance-center-review-note">${escapeHtml(file.summary)}</div>` : ''}
      ${file.reason && !file.ok ? `<div class="governance-center-review-risk">${escapeHtml(file.reason)}</div>` : ''}
      ${Array.isArray(file.previewLines) && file.previewLines.length
        ? `<pre class="governance-center-diff-preview">${file.previewLines.map(line => escapeHtml(line)).join('\n')}</pre>`
        : `<div class="governance-center-review-note">${escapeHtml(file.previewSkipped || 'No preview lines')}</div>`}
    </details>`).join('')}
    ${commands.length || workCommands.length ? `<div class="governance-center-review-commands">
      ${[...workCommands, ...commands].map(cmd => `<code class="${cmd.ok ? '' : 'is-risk'}" data-gov-center-command-id="${escapeHtml(governanceCommandKey(cmd.command || ''))}" title="${escapeHtml(cmd.reason || '')}">${escapeHtml(cmd.command || '')}</code>`).join('')}
    </div>` : ''}
    ${risks.length ? `<div class="governance-center-review-risk">${risks.map(escapeHtml).join(' · ')}</div>` : ''}
  </div>`;
    }

    function renderGovernanceCenterApprovals(approvals = []) {
      if (!approvals.length) {
        return `<section class="governance-center-section">
      <h3>Approval Actions</h3>
      <div class="governance-center-empty">当前没有 pending approval。</div>
    </section>`;
      }
      return `<section class="governance-center-section">
    <h3>Approval Actions</h3>
    <div class="governance-center-approval-list">
      ${approvals.map((approval) => {
        const reviewGate = approval.resumeReview?.gate || {};
        const canResumeWithGate = approval.canApproveResume
          && approval.resumeReview?.safeToResume !== false
          && Boolean(reviewGate.id || approval.resumeReview?.reviewGateId);
        return `<div class="governance-center-approval ${approval.canApproveResume ? 'sev-warn' : ''}">
        <button class="governance-center-approval-main" data-gov-center-open="approval" data-gov-center-id="${escapeHtml(approval.id)}">
          <span class="title">${escapeHtml(approval.title || approval.type || approval.id)}</span>
          <span class="meta">${escapeHtml(approval.type || '-')} · ${escapeHtml(approval.action || 'manual')} · ${escapeHtml(approval.resumeRunId || approval.agentRunId || '-')}</span>
        </button>
        ${approval.canApproveResume ? `<button class="cxbtn cxbtn-primary cxbtn-sm" data-gov-center-approve-resume="${escapeHtml(approval.id)}" data-gov-center-run="${escapeHtml(approval.resumeRunId)}" data-gov-center-review-gate="${escapeHtml(reviewGate.id || approval.resumeReview?.reviewGateId || '')}" data-gov-center-review-sha="${escapeHtml(reviewGate.sha256 || approval.resumeReview?.reviewSha256 || '')}" ${canResumeWithGate ? '' : 'disabled'}>批准并续跑</button>` : `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-gov-center-open="approval" data-gov-center-id="${escapeHtml(approval.id)}">打开审批</button>`}
        ${renderGovernanceResumeReview(approval)}
      </div>`;
      }).join('')}
    </div>
  </section>`;
    }

    // review 区两段事件绑定（command-jump 滚动高亮 + coverage filter 委托）——只作用于本文件渲染的 DOM，
    // 主文件 renderGovernanceCenter 绑定段经 window.PanelGovernanceReview?.bindReviewEvents?.(root) 调入
    function bindReviewEvents(root) {
      if (!root) return;
      root.querySelectorAll('[data-gov-center-command-jump]').forEach(btn => {
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          const id = btn.dataset.govCenterCommandJump;
          const target = id ? root.querySelector(`[data-gov-center-command-id="${CSS.escape(id)}"]`) : null;
          if (!target) return;
          root.querySelectorAll('.governance-center-review-commands code.is-highlighted')
            .forEach(node => node.classList.remove('is-highlighted'));
          target.classList.add('is-highlighted');
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      });
      root.querySelectorAll('[data-gov-center-coverage-filter]').forEach(filter => {
        filter.addEventListener('click', (event) => {
          const btn = event.target?.closest?.('[data-gov-center-coverage-status]');
          if (!btn) return;
          const status = btn.dataset.govCenterCoverageStatus || 'all';
          const review = filter.closest('[data-gov-center-resume-review]');
          if (!review) return;
          filter.querySelectorAll('[data-gov-center-coverage-status]').forEach(node => node.classList.toggle('is-active', node === btn));
          const files = [...review.querySelectorAll('[data-gov-center-review-file]')];
          let visible = 0;
          for (const file of files) {
            const matches = status === 'all' || file.dataset.govCenterCoverage === status;
            file.hidden = !matches;
            if (matches) visible += 1;
          }
          const empty = review.querySelector('[data-gov-center-coverage-empty]');
          if (empty) empty.hidden = visible > 0;
        });
      });
    }

    window.PanelGovernanceReview = {
      stagedDiffFileMeta,
      governanceCommandKey,
      governanceCommandChips,
      governanceRiskReasons,
      governanceCoverageExplanations,
      orderedGovernanceReviewFiles,
      renderGovernanceCoverageFilter,
      renderGovernanceResumeReview,
      renderGovernanceCenterApprovals,
      bindReviewEvents,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
