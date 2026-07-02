// @ts-check
// activity-detail-ui.js — 审计时间线提取器层 + 详情面板渲染（从 activity-ui.js 分文件；app.js 模块化第三波批25 2026-06-11）
// activity-ui.js 620 行超 <500 文件约束 → 把只读 event 对象的纯函数提取器群（activityTitle/activityAgentRunIds/
// isAgentActivityEvent 等 17 个）与详情面板渲染（renderActivityDetail/ApprovalResumeGatePanel/AgentPanel/
// ArtifactPanel/ClusterDeliveryPanel/RunButtons）原样搬入本文件（纯机械搬移零逻辑改动，单一来源）。
// modal 壳/activityState/列表渲染/全部绑定仍在 activity-ui.js，经 window.PanelActivityDetail 懒解析调用
// （与全仓桥模式一致，免疫加载顺序）。本文件无共享状态：全部函数只读传入的 event 对象，不读 activityState。
// 依赖经 window.PanelCore 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const {
      escapeHtml, activityTime, safeClassToken,
      stagedDiffReviewText, governanceCenterBytes,
    } = window.PanelCore;

    function activityTitle(e) {
      return e.action || e.tag || `${e.entityType || 'event'}.${e.status || 'recorded'}`;
    }
    function activitySearchText(e) {
      return [
        e.id, e.action, e.tag, e.roomId, e.sessionId, e.taskId,
        e.actorType, e.actorId, e.entityType, e.entityId, e.severity, e.status,
        ...activityAgentRunIds(e),
        ...activityApprovalResumeGateIds(e),
        ...activityApprovalResumeGateSha256s(e),
        JSON.stringify(e.details || {}),
      ].filter(Boolean).join(' ').toLowerCase();
    }
    function activityScopeLine(e) {
      const parts = [];
      if (e.roomId) parts.push(`room:${e.roomId}`);
      if (e.sessionId) parts.push(`session:${e.sessionId}`);
      if (e.taskId) parts.push(`task:${e.taskId}`);
      if (e.entityType || e.entityId) parts.push(`${e.entityType || 'entity'}:${e.entityId || '-'}`);
      return parts.join(' · ') || 'global';
    }
    function activityAsArray(value) {
      if (value === null || value === undefined || value === '') return [];
      return Array.isArray(value) ? value : [value];
    }
    function activityCollectValues(value, out = []) {
      if (value === null || value === undefined || value === '') return out;
      if (Array.isArray(value)) {
        value.forEach(item => activityCollectValues(item, out));
        return out;
      }
      if (typeof value === 'object') {
        if (value.name) out.push(value.name);
        else if (value.id) out.push(value.id);
        return out;
      }
      out.push(value);
      return out;
    }
    function activityUniqueStrings(values) {
      return [...new Set(activityCollectValues(values).map(v => String(v).trim()).filter(Boolean))];
    }
    function activityAgentProfileIds(e) {
      const d = e.details || {};
      const ids = [];
      if (e.entityType === 'agent_profile' && e.entityId) ids.push(e.entityId);
      ids.push(d.agentProfileId, d.profileId, d.agentProfile?.id, d.agent?.profileId);
      return activityUniqueStrings(ids);
    }
    function activityAgentRunIds(e) {
      const d = e.details || {};
      const ids = [];
      if (e.entityType === 'agent_run' && e.entityId) ids.push(e.entityId);
      ids.push(d.agentRunId, d.runId, d.agentRun?.id, d.replayPlan?.runId, d.replayResult?.runId);
      return activityUniqueStrings(ids);
    }
    function activityApprovalResumeGateIds(e) {
      const d = e.details || {};
      return activityUniqueStrings([
        d.approvalResumeGateId,
        d.reviewGateId,
        d.resumeReviewGateId,
        d.approvalResumeReviewGateId,
        d.approvalResumeGateAudit?.id,
        d.resumeReviewGateAudit?.id,
        d.resumeReviewGate?.id,
        d.resumeReview?.gate?.id,
      ]);
    }
    function activityApprovalResumeGateSha256s(e) {
      const d = e.details || {};
      return activityUniqueStrings([
        d.approvalResumeGateSha256,
        d.reviewSha256,
        d.resumeReviewSha256,
        d.approvalResumeReviewSha256,
        d.approvalResumeGateAudit?.sha256,
        d.resumeReviewGateAudit?.sha256,
        d.resumeReviewGate?.sha256,
        d.resumeReview?.gate?.sha256,
      ]);
    }
    function activityApprovalResumeGateAudit(e) {
      const d = e.details || {};
      return d.approvalResumeGateAudit || d.resumeReviewGateAudit || d.resumeReviewGate || d.resumeReview?.gate || null;
    }
    function activitySkillBindings(e) {
      const d = e.details || {};
      return [...activityAsArray(d.agentSkillBindings), ...activityAsArray(d.skillBindings)]
        .filter(item => item && typeof item === 'object' && item.name);
    }
    function activitySkillNames(e) {
      const d = e.details || {};
      return activityUniqueStrings([
        d.agentSkillNames,
        d.skillNames,
        d.skills,
        d.agentSkillBindings,
        d.skillBindings,
      ]);
    }
    function activityDispatchTags(e) {
      const d = e.details || {};
      return activityUniqueStrings([d.agentDispatchTags, d.dispatchTags]);
    }
    function activityDiagnosticItems(e) {
      const d = e.details || {};
      return [...activityAsArray(d.diagnostics), ...activityAsArray(d.agentSkillDiagnostics)]
        .map(item => (typeof item === 'string' ? { code: item } : item))
        .filter(item => item && typeof item === 'object' && (item.code || item.message));
    }
    function activityArtifacts(e) {
      const d = e.details || {};
      return activityAsArray(d.artifacts)
        .filter(item => item && typeof item === 'object' && item.path)
        .slice(0, 12);
    }
    function isAgentActivityEvent(e) {
      const action = String(e.action || '');
      return action.startsWith('agent.')
        || activityAgentRunIds(e).length > 0
        || activityAgentProfileIds(e).length > 0
        || activityApprovalResumeGateIds(e).length > 0
        || activityApprovalResumeGateSha256s(e).length > 0
        || activitySkillNames(e).length > 0
        || activityDiagnosticItems(e).length > 0;
    }

    function renderActivityRunButtons(runIds = []) {
      return runIds.length
        ? `<span class="activity-chip-line">${runIds.map(id => `<button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-open-run="${escapeHtml(id)}">${escapeHtml(id)}</button>`).join('')}</span>`
        : '';
    }

    function renderActivityApprovalResumeGatePanel(e) {
      const gateIds = activityApprovalResumeGateIds(e);
      const hashes = activityApprovalResumeGateSha256s(e);
      const audit = activityApprovalResumeGateAudit(e) || {};
      if (!gateIds.length && !hashes.length) return '';
      const counts = audit.counts || {};
      const countsText = [
        counts.fileChanges !== undefined ? `files ${counts.fileChanges}` : '',
        counts.commands !== undefined ? `commands ${counts.commands}` : '',
        counts.workEvidenceCommands !== undefined ? `evidence ${counts.workEvidenceCommands}` : '',
        counts.risks !== undefined ? `risks ${counts.risks}` : '',
      ].filter(Boolean).join(' · ') || '-';
      const safeText = audit.safeToResume === true ? 'safe' : (audit.safeToResume === false ? 'blocked' : '-');
      const statusText = [audit.status, safeText].filter(Boolean).join(' · ') || '-';
      const filePaths = activityAsArray(audit.files).map(file => file?.path).filter(Boolean).slice(0, 4);
      const commandNames = [
        ...activityAsArray(audit.commands),
        ...activityAsArray(audit.workEvidenceCommands),
      ].map(command => command?.command).filter(Boolean).slice(0, 4);
      const stagedDiffText = stagedDiffReviewText(audit.stagedDiffReview || audit.diffReview || {});
      return `
        <div class="activity-agent-panel">
          <div class="activity-agent-panel-head">
            <strong>Approval Resume Gate</strong>
            <span>${escapeHtml(statusText)}</span>
          </div>
          <div class="activity-agent-grid">
            <div class="k">Gate</div><div class="v">${gateIds.map(id => `<code>${escapeHtml(id)}</code>`).join(' ') || '-'}</div>
            <div class="k">SHA</div><div class="v">${hashes.map(sha => `<code>${escapeHtml(String(sha).slice(0, 16))}</code>`).join(' ') || '-'}</div>
            <div class="k">Runs</div><div class="v">${renderActivityRunButtons(activityAgentRunIds(e)) || '-'}</div>
            <div class="k">Counts</div><div class="v">${escapeHtml(countsText)}</div>
            ${stagedDiffText ? `<div class="k">Staged Diff</div><div class="v">${escapeHtml(stagedDiffText)}</div>` : ''}
            ${filePaths.length ? `<div class="k">Files</div><div class="v activity-chip-line">${filePaths.map(path => `<span>${escapeHtml(path)}</span>`).join('')}</div>` : ''}
            ${commandNames.length ? `<div class="k">Commands</div><div class="v activity-chip-line">${commandNames.map(command => `<span>${escapeHtml(command)}</span>`).join('')}</div>` : ''}
          </div>
        </div>
      `;
    }

    function renderActivityAgentPanel(e) {
      if (!isAgentActivityEvent(e)) return '';
      const runIds = activityAgentRunIds(e);
      const profiles = activityAgentProfileIds(e);
      const tags = activityDispatchTags(e);
      const skills = activitySkillNames(e);
      const bindings = activitySkillBindings(e);
      const diagnostics = activityDiagnosticItems(e);
      const profileText = profiles.join(', ') || '-';
      const tagsHtml = tags.length
        ? tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')
        : '<span>-</span>';
      const skillsHtml = skills.length
        ? skills.map(name => {
          const binding = bindings.find(item => item.name === name);
          const sources = Array.isArray(binding?.sources) ? binding.sources.filter(Boolean) : [];
          return `<span>${escapeHtml(name)}${sources.length ? `<em>${escapeHtml(sources.join('+'))}</em>` : ''}</span>`;
        }).join('')
        : '<span>-</span>';
      const diagnosticsHtml = diagnostics.length
        ? `<div class="activity-diagnostic-list">${diagnostics.map(item => {
          const sev = safeClassToken(item.severity || 'warn');
          const meta = [
            item.count !== undefined && item.limit !== undefined ? `${item.count}/${item.limit}` : '',
            Array.isArray(item.skills) && item.skills.length ? item.skills.join(', ') : '',
          ].filter(Boolean).join(' · ');
          return `<div class="activity-diagnostic-row ${sev}">
            <strong>${escapeHtml(item.code || 'diagnostic')}</strong>
            <span>${escapeHtml(item.message || meta || '-')}</span>
            ${meta && item.message ? `<em>${escapeHtml(meta)}</em>` : ''}
          </div>`;
        }).join('')}</div>`
        : '';
      return `
        <div class="activity-agent-panel">
          <div class="activity-agent-panel-head">
            <strong>Agent / Skill</strong>
            <span>${diagnostics.length ? `${diagnostics.length} diagnostics` : 'no diagnostics'}</span>
          </div>
          <div class="activity-agent-grid">
            <div class="k">Runs</div><div class="v">${renderActivityRunButtons(runIds) || '-'}</div>
            <div class="k">Profile</div><div class="v"><code>${escapeHtml(profileText)}</code></div>
            <div class="k">Tags</div><div class="v activity-chip-line">${tagsHtml}</div>
            <div class="k">Skills</div><div class="v activity-chip-line">${skillsHtml}</div>
          </div>
          ${diagnosticsHtml}
        </div>
      `;
    }

    function renderActivityArtifactPanel(e) {
      const artifacts = activityArtifacts(e);
      if (!artifacts.length) return '';
      const eventRunId = activityAgentRunIds(e)[0] || '';
      return `
        <div class="activity-agent-panel">
          <div class="activity-agent-panel-head">
            <strong>Archive Artifacts</strong>
            <span>${artifacts.length} recorded</span>
          </div>
          <div class="activity-artifact-list">
            ${artifacts.map((artifact) => {
              const runId = artifact.runId || eventRunId;
              const size = artifact.size ? governanceCenterBytes(artifact.size) : '-';
              const hash = artifact.sha256 ? String(artifact.sha256).slice(0, 12) : '-';
              return `<div class="activity-artifact-row">
                <div>
                  <strong>${escapeHtml(artifact.kind || 'artifact')}</strong>
                  <code>${escapeHtml(artifact.path || '-')}</code>
                  <span>${escapeHtml(size)} · sha ${escapeHtml(hash)}${artifact.sessionId ? ` · session ${escapeHtml(artifact.sessionId)}` : ''}${artifact.gateId ? ` · gate ${escapeHtml(artifact.gateId)}` : ''}</span>
                </div>
                <div class="activity-artifact-actions">
                  <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-artifact-copy="${escapeHtml(artifact.path || '')}" type="button">Copy Path</button>
                  ${artifact.downloadable && artifact.id && runId ? `<button class="cxbtn cxbtn-secondary cxbtn-sm" data-activity-artifact-download="${escapeHtml(artifact.id)}" data-activity-artifact-run="${escapeHtml(runId)}" type="button">Open Artifact</button>` : '<span>not downloadable</span>'}
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      `;
    }

    function renderActivityClusterDeliveryPanel(e) {
      if (e.action !== 'cluster.delivery.archived' && e.entityType !== 'cluster_delivery_archive') return '';
      const d = e.details || {};
      const artifacts = activityArtifacts(e);
      const fingerprint = d.manifestFingerprint ? String(d.manifestFingerprint).slice(0, 16) : '-';
      return `
        <div class="activity-agent-panel">
          <div class="activity-agent-panel-head">
            <strong>Cluster Delivery Archive</strong>
            <span>${escapeHtml(d.deliveryStatus || e.status || 'unknown')}</span>
          </div>
          <div class="activity-agent-grid">
            <div class="k">Archive</div><div class="v"><code>${escapeHtml(d.archiveId || e.entityId || '-')}</code></div>
            <div class="k">Path</div><div class="v"><code>${escapeHtml(d.archiveDir || '-')}</code></div>
            <div class="k">Manifest</div><div class="v"><code>${escapeHtml(fingerprint)}</code></div>
            <div class="k">Artifacts</div><div class="v">${escapeHtml(String(d.artifactCount ?? artifacts.length ?? 0))}</div>
          </div>
        </div>
      `;
    }

    function renderActivityDetail(e) {
      const details = JSON.stringify(e.details || {}, null, 2);
      const runButtons = renderActivityRunButtons(activityAgentRunIds(e));
      return `
        <div class="activity-detail-grid">
          <div class="k">ID</div><div class="v">${escapeHtml(e.id)}</div>
          <div class="k">时间</div><div class="v">${activityTime(e.ts)}</div>
          <div class="k">Action</div><div class="v">${escapeHtml(activityTitle(e))}</div>
          <div class="k">严重度</div><div class="v"><span class="activity-severity ${safeClassToken(e.severity)}">${escapeHtml(e.severity || 'info')}</span></div>
          <div class="k">状态</div><div class="v">${escapeHtml(e.status || '-')}</div>
          <div class="k">Actor</div><div class="v">${escapeHtml(e.actorType || '-')} / ${escapeHtml(e.actorId || '-')}</div>
          <div class="k">Entity</div><div class="v">${escapeHtml(e.entityType || '-')} / ${escapeHtml(e.entityId || '-')}</div>
          <div class="k">Agent Run</div><div class="v">${runButtons || '-'}</div>
          <div class="k">Room</div><div class="v">${e.roomId ? `<code>${escapeHtml(e.roomId)}</code> <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-activity-open-room="${escapeHtml(e.roomId)}">打开房间</button>` : '-'}</div>
          <div class="k">Session</div><div class="v">${e.sessionId ? `<code>${escapeHtml(e.sessionId)}</code>` : '-'}</div>
          <div class="k">Task</div><div class="v">${e.taskId ? `<code>${escapeHtml(e.taskId)}</code>` : '-'}</div>
        </div>
        ${renderActivityApprovalResumeGatePanel(e)}
        ${renderActivityAgentPanel(e)}
        ${renderActivityClusterDeliveryPanel(e)}
        ${renderActivityArtifactPanel(e)}
        <pre class="activity-json"><code>${escapeHtml(details)}</code></pre>
      `;
    }

    window.PanelActivityDetail = {
      activityTitle,
      activitySearchText,
      activityScopeLine,
      activityAsArray,
      activityCollectValues,
      activityUniqueStrings,
      activityAgentProfileIds,
      activityAgentRunIds,
      activityApprovalResumeGateIds,
      activityApprovalResumeGateSha256s,
      activityApprovalResumeGateAudit,
      activitySkillBindings,
      activitySkillNames,
      activityDispatchTags,
      activityDiagnosticItems,
      activityArtifacts,
      isAgentActivityEvent,
      renderActivityRunButtons,
      renderActivityApprovalResumeGatePanel,
      renderActivityAgentPanel,
      renderActivityArtifactPanel,
      renderActivityClusterDeliveryPanel,
      renderActivityDetail,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
