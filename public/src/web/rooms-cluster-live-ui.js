// @ts-check
// rooms-cluster-live-ui.js — cluster runtime 实时渲染群（cross_verify 阶段徽章/心跳/自愈/续跑策略/成员输出行/实时运行面板/共识 Markdown）（从 app.js 外迁；app.js 模块化第9批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, statusLabel, isRoomRunningLike } = core;

    function crossVerifyStageBadges(task) {
      const artifact = task?.consensus?.stageArtifact || task?.stageArtifact || null;
      const badges = [];
      if (task?.blocking) badges.push('阻断');
      if (task?.qualityGateRepairs) {
        badges.push(task.status === 'done' ? `已自动修复 ${task.qualityGateRepairs} 次` : `修复尝试 ${task.qualityGateRepairs} 次`);
      }
      const evidenceRequirement = artifact?.evidenceRequirement;
      if (evidenceRequirement?.required) {
        badges.push(evidenceRequirement.status === 'passed' ? '硬证据通过' : '硬证据不足');
      }
      const acceptanceSummary = artifact?.acceptanceReport?.summary;
      if (acceptanceSummary) {
        const bad = (acceptanceSummary.failed || 0) + (acceptanceSummary.insufficient || 0);
        badges.push(bad > 0 ? `验收异常 ${bad}` : '验收通过');
      }
      const retrospectiveSummary = artifact?.retrospectiveReport?.summary;
      if (retrospectiveSummary) {
        badges.push(`改进项 ${retrospectiveSummary.totalBacklog || 0}`);
      }
      return badges.length ? ` [${badges.join(' / ')}]` : '';
    }

    function formatClusterRuntimeTime(value) {
      const ms = Date.parse(value || '');
      if (!Number.isFinite(ms)) return '';
      try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false });
      } catch {
        return String(value || '');
      }
    }

    function formatClusterDurationMs(ms) {
      const n = Number(ms);
      if (!Number.isFinite(n) || n < 0) return '';
      if (n < 1000) return `${Math.round(n)}ms`;
      if (n < 60_000) return `${Math.round(n / 1000)}s`;
      if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
      return `${Math.round(n / 3_600_000)}h`;
    }

    function renderClusterRuntimeHeartbeatLine(room) {
      const heartbeat = room?.clusterRuntimeHeartbeat;
      if (!heartbeat) return '';
      const at = formatClusterRuntimeTime(heartbeat.lastProgressAt);
      const event = heartbeat.lastEvent || 'unknown';
      const task = heartbeat.taskId ? `，任务 ${heartbeat.taskId}` : '';
      const stage = heartbeat.stageId ? `，阶段 ${heartbeat.stageId}` : '';
      const round = heartbeat.round ? `，第 ${heartbeat.round} 轮` : '';
      return `> 运行心跳：最后进展 ${at || heartbeat.lastProgressAt || '未知'}，事件 ${event}${task}${stage}${round}`;
    }

    function renderClusterRuntimeRecoveryLine(room) {
      const recovery = room?.clusterRuntimeStallRecovery || room?.clusterRuntimeRecovery;
      if (!recovery) return '';
      const at = formatClusterRuntimeTime(recovery.at);
      const stalled = recovery.stalledForMs ? `，停滞 ${formatClusterDurationMs(recovery.stalledForMs)}` : '';
      const lastProgress = recovery.lastProgressAt ? `，上次进展 ${formatClusterRuntimeTime(recovery.lastProgressAt) || recovery.lastProgressAt}` : '';
      return `> 自愈恢复：${recovery.reason || 'unknown'}，动作 ${recovery.action || 'unknown'}${at ? `，时间 ${at}` : ''}${lastProgress}${stalled}`;
    }

    function renderClusterRuntimeResumePolicyLine(room) {
      const policy = room?.clusterRuntimeResumePolicy;
      if (!policy) return '';
      const status = policy.autoResumeAllowed === false ? '自动续跑已限流' : '自动续跑可用';
      const count = `${policy.stallRecoveryCount || 0}/${policy.maxStallRecoveries || 0}`;
      const next = policy.nextAction || 'unknown';
      return `> 续跑策略：${status}，停滞恢复 ${count}，下一步 ${next}`;
    }

    function currentClusterTask(room) {
      const tasks = Array.isArray(room?.taskList) ? room.taskList : [];
      return tasks.find((task) => task.status === 'running')
        || tasks.find((task) => task.status === 'pending')
        || tasks[0]
        || null;
    }

    function cleanClusterRuntimeOutputContent(value) {
      return String(value || '')
        .replace(/\u0004/g, '')
        .replace(/^\^D+/, '')
        .replace(/\n\^D+/g, '\n')
        .trim();
    }

    function renderClusterRuntimeOutputRows(outputs = []) {
      const all = Array.isArray(outputs) ? outputs : [];
      const important = all
        .filter((item) => ['reply', 'stderr'].includes(item.stream) || /error|failed|not in workspace|阻断|失败/i.test(String(item.content || '')))
        .slice(-10)
        .reverse();
      const latest = all.slice(-18).reverse();
      const seen = new Set();
      const items = [...important, ...latest].filter((item) => {
        const key = item.id || `${item.at}|${item.adapterId}|${item.stream}|${String(item.content || '').slice(0, 40)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 28);
      if (!items.length) {
        return '<div class="cluster-runtime-output-row muted">等待成员输出；启动后会显示 Claude / Codex / Gemini 的 stdout、最终回复和错误。</div>';
      }
      return items.map((item) => {
        const title = [
          item.displayName || item.adapterId || 'member',
          item.turn || '',
          item.stream || '',
        ].filter(Boolean).join(' · ');
        const when = formatClusterRuntimeTime(item.at) || item.at || '';
        const content = cleanClusterRuntimeOutputContent(item.content) || '[empty output]';
        return `
          <div class="cluster-runtime-output-row ${escapeHtml(item.stream || 'stdout')}">
            <div class="cluster-runtime-output-meta">
              <strong>${escapeHtml(title)}</strong>
              <span>${escapeHtml(when)}</span>
            </div>
            <div class="cluster-runtime-output-body">${escapeHtml(content.slice(-8000))}</div>
          </div>
        `;
      }).join('');
    }

    function renderClusterRuntimeLivePanel(room) {
      if (!room || room.mode !== 'cross_verify') return;
      const body = $('#roomConsensusBody');
      if (!body) return;
      let panel = body.querySelector('[data-cluster-runtime-live]');
      if (!panel) {
        panel = document.createElement('div');
        panel.setAttribute('data-cluster-runtime-live', '1');
        panel.className = 'cluster-runtime-live';
        body.prepend(panel);
      }
      const heartbeat = room.clusterRuntimeHeartbeat || {};
      const task = currentClusterTask(room);
      const last = formatClusterRuntimeTime(heartbeat.lastProgressAt) || heartbeat.lastProgressAt || '尚无';
      const event = heartbeat.lastEvent || '尚无';
      const adapter = heartbeat.adapterId || '等待成员事件';
      panel.innerHTML = `
        <div class="cluster-runtime-live-head">
          <strong>实时运行面板</strong>
          <span>${escapeHtml(statusLabel(room.status || 'unknown'))}</span>
        </div>
        <div class="cluster-runtime-live-grid">
          <div><b>项目目录</b><code>${escapeHtml(room.cwd || '-')}</code></div>
          <div><b>当前阶段</b><code>${escapeHtml(task ? `${task.id || ''} ${task.stageLabel || task.title || task.stageId || ''}`.trim() : '-')}</code></div>
          <div><b>最后心跳</b><code>${escapeHtml(last)} / ${escapeHtml(event)}</code></div>
          <div><b>最近成员</b><code>${escapeHtml(adapter)}</code></div>
        </div>
        <div class="cluster-runtime-processes" data-process-list>
          <div class="cluster-runtime-process-row muted">正在读取后台模型进程...</div>
        </div>
        <div class="cluster-runtime-output-head">
          <strong>成员执行输出</strong>
          <span>最近 ${escapeHtml(String((room.clusterRuntimeOutput || []).length))} 条</span>
        </div>
        <div class="cluster-runtime-output" data-runtime-output>
          ${renderClusterRuntimeOutputRows(room.clusterRuntimeOutput)}
        </div>
      `;
      fetch(`/api/rooms/${encodeURIComponent(room.id)}/runtime-processes`)
        .then((res) => res.json())
        .then((payload) => {
          const list = panel.querySelector('[data-process-list]');
          if (!list) return;
          const processes = Array.isArray(payload.processes) ? payload.processes : [];
          if (!payload.ok) {
            list.innerHTML = `<div class="cluster-runtime-process-row error">进程快照读取失败：${escapeHtml(payload.error || 'unknown')}</div>`;
            return;
          }
          if (!processes.length) {
            list.innerHTML = '<div class="cluster-runtime-process-row muted">暂无模型子进程；如果房间刚启动，等待成员调用开始。</div>';
            return;
          }
          const signalText = (p) => {
            const signals = [];
            if (p.fullAccessSignals?.clusterFullAccess) signals.push('cluster_full_access');
            if (p.fullAccessSignals?.fullAuto) signals.push('full_auto');
            if (p.fullAccessSignals?.observeOnly) signals.push('observe_only');
            if (p.fullAccessSignals?.claudeSkipPermissions) signals.push('claude_skip_permissions');
            if (p.fullAccessSignals?.codexBypassSandbox) signals.push('codex_bypass_sandbox');
            return signals.join(' / ') || 'native_runtime';
          };
          list.innerHTML = processes.map((p) => `
            <div class="cluster-runtime-process-row">
              <span class="cluster-runtime-dot"></span>
              <strong>${escapeHtml(p.adapterId || 'model')}</strong>
              <code>pid ${escapeHtml(String(p.pid || '-'))}</code>
              <code>${escapeHtml(p.elapsed || '-')}</code>
              <span>${escapeHtml(signalText(p))}</span>
            </div>
          `).join('');
        })
        .catch((error) => {
          const list = panel.querySelector('[data-process-list]');
          if (list) list.innerHTML = `<div class="cluster-runtime-process-row error">进程快照读取异常：${escapeHtml(error.message || String(error))}</div>`;
        });
    }

    function renderCrossVerifyConsensusMarkdown(room) {
      const tasks = Array.isArray(room?.taskList) ? room.taskList : [];
      if (!tasks.length) return '';
      const blocks = [];
      const counts = tasks.reduce((acc, task) => {
        const key = task?.status || 'pending';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      const progressLines = tasks.map((task, i) => {
        const status = task?.status || 'pending';
        const rounds = task?.consensus?.totalRounds || task?.rounds?.length || 0;
        const stage = task?.stageLabel || task?.title || task?.id || `阶段 ${i + 1}`;
        const suffix = rounds ? `，${rounds} 轮` : '';
        return `- ${i + 1}. ${stage}: ${statusLabel(status)}${suffix}${crossVerifyStageBadges(task)}`;
      });
      blocks.push([
        '# 集群协同进度',
        '',
        `> 共 ${tasks.length} 个阶段：已完成 ${counts.done || 0}，运行中 ${counts.running || 0}，待执行 ${counts.pending || 0}，需裁定 ${counts.escalated || 0}，已暂停 ${counts.paused || 0}`,
        room?.clusterWorkflowAudit
          ? `> 链路审计：${room.clusterWorkflowAudit.overallStatus || 'unknown'}，阻断 ${room.clusterWorkflowAudit.counts?.blocking || 0}，证据不足 ${room.clusterWorkflowAudit.counts?.evidenceInsufficient || 0}，已修复 ${room.clusterWorkflowAudit.counts?.repaired || 0}`
          : '',
        room?.clusterWorkflowAudit?.remediationSummary?.total
          ? `> 自动返工审计：${room.clusterWorkflowAudit.remediationSummary.total || 0} 次，自动 ${room.clusterWorkflowAudit.remediationSummary.automatic || 0} 次，失效下游阶段 ${room.clusterWorkflowAudit.remediationSummary.invalidatedStages || 0} 个`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest
          ? `> 交付清单：${room.clusterDeliveryManifest.overallStatus || 'unknown'}，阶段 ${room.clusterDeliveryManifest.doneStageCount || 0}/${room.clusterDeliveryManifest.stageCount || tasks.length}，返工 ${room.clusterDeliveryManifest.remediation?.count || 0} 次`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.deliveryGate
          ? `> 交付门禁：${room.clusterDeliveryManifest.readyForDelivery ? '通过' : `阻断 ${room.clusterDeliveryManifest.deliveryGate.blockers?.length || 0} 项`}`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.memberSignoffMatrix
          ? `> 成员签字矩阵：${room.clusterDeliveryManifest.memberSignoffMatrix.filter(row => row.complete).length}/${room.clusterDeliveryManifest.memberSignoffMatrix.length} 阶段完成全员签字`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.evidenceCoverage
          ? `> 证据覆盖：命令 ${room.clusterDeliveryManifest.evidenceCoverage.commandEvidenceCount || 0}，文件 ${room.clusterDeliveryManifest.evidenceCoverage.fileEvidenceCount || 0}，运行/UI ${room.clusterDeliveryManifest.evidenceCoverage.runtimeEvidenceCount || 0}，代码驱动 ${room.clusterDeliveryManifest.evidenceCoverage.codeDrivenCoveredStageCount || 0}/${room.clusterDeliveryManifest.evidenceCoverage.codeDrivenStageCount || 0}`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.evidenceIntegrity
          ? `> 证据完整性：${room.clusterDeliveryManifest.evidenceIntegrity.status || 'unknown'}，声明式 ${room.clusterDeliveryManifest.evidenceIntegrity.declaredHardEvidenceStageCount || 0}，Agent Run 验证 ${room.clusterDeliveryManifest.evidenceIntegrity.verifiedRunEvidenceStageCount || 0}`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.fingerprint
          ? `> 交付指纹：${String(room.clusterDeliveryManifest.fingerprint).slice(0, 12)}`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryManifest?.objectiveCompletionAudit
          ? `> 目标完成度：${room.clusterDeliveryManifest.objectiveCompletionAudit.status || 'unknown'}，${room.clusterDeliveryManifest.objectiveCompletionAudit.passedCount || 0}/${room.clusterDeliveryManifest.objectiveCompletionAudit.total || 0}`
          : '',
        room?.goalMode?.enabled
          ? `> 目标模式：开启，交付未通过会自动返工；交付返工 ${room.goalMode.deliveryReworks || 0} 次，阶段返工 ${room.goalMode.stageReworks || 0} 次`
          : '',
        !isRoomRunningLike(room?.status) && room?.clusterDeliveryPackage
          ? `> 交付包：${room.clusterDeliveryPackage.status || 'unknown'}，产物 ${room.clusterDeliveryPackage.artifacts?.length || 0} 个，归档 ${room.clusterDeliveryPackage.readyForArchive ? 'ready' : 'blocked'}`
          : '',
        room?.clusterRuntimeTelemetry
          ? `> 运行遥测：调用 ${room.clusterRuntimeTelemetry.calls || 0}，成功 ${room.clusterRuntimeTelemetry.succeededCalls || 0}，失败 ${room.clusterRuntimeTelemetry.failedCalls || 0}，Token ${room.clusterRuntimeTelemetry.totalTokens || 0}，平均时延 ${room.clusterRuntimeTelemetry.avgLatencyMs || 0}ms`
          : '',
        renderClusterRuntimeHeartbeatLine(room),
        renderClusterRuntimeRecoveryLine(room),
        renderClusterRuntimeResumePolicyLine(room),
        '',
        ...progressLines,
      ].join('\n'));

      if (!isRoomRunningLike(room?.status) && room?.clusterDeliveryReportMarkdown) {
        blocks.push(String(room.clusterDeliveryReportMarkdown));
      }

      for (const task of tasks) {
        const finalPlan = task?.consensus?.finalPlan;
        if (!finalPlan) continue;
        const rounds = task.consensus.totalRounds || task.rounds?.length || 0;
        const byA = task.consensus.byA || task.rounds?.[0]?.byA || 'A';
        const byB = task.consensus.byB || task.rounds?.[0]?.byB || 'B';
        const artifact = task.consensus.stageArtifact || task.stageArtifact || null;
        const ledgerLine = artifact
          ? `> 阶段账本：交付物 ${artifact.deliverables?.length || 0}，证据 ${artifact.evidence?.length || 0}，签字 ${artifact.signoffs?.length || 0}，风险 ${artifact.risks?.length || 0}`
          : '';
        const evidenceRequirementLine = artifact?.evidenceRequirement?.required
          ? `> 代码驱动证据门槛：${artifact.evidenceRequirement.status === 'passed' ? '通过' : '证据不足'}（需要 ${artifact.evidenceRequirement.requiredSignals?.join(' / ') || '硬证据'}）`
          : '';
        const acceptanceSummary = artifact?.acceptanceReport?.summary;
        const acceptanceLine = acceptanceSummary
          ? `> 自动验收：共 ${acceptanceSummary.total || 0} 项，通过 ${acceptanceSummary.passed || 0}，带风险通过 ${acceptanceSummary.passed_with_risks || 0}，证据不足 ${acceptanceSummary.insufficient || 0}，失败 ${acceptanceSummary.failed || 0}`
          : '';
        const retrospectiveSummary = artifact?.retrospectiveReport?.summary;
        const retrospectiveLine = retrospectiveSummary
          ? `> 自动复盘：改进项 ${retrospectiveSummary.totalBacklog || 0}，P0 ${retrospectiveSummary.byPriority?.P0 || 0}，P1 ${retrospectiveSummary.byPriority?.P1 || 0}，P2 ${retrospectiveSummary.byPriority?.P2 || 0}`
          : '';
        blocks.push([
          `## ${task.title || task.id || '集群任务'}`,
          '',
          `> 集群已互签一致：${task.consensus.byMembers?.join(' + ') || `${byA} + ${byB}`}${rounds ? `，共 ${rounds} 轮` : ''}`,
          ledgerLine,
          evidenceRequirementLine,
          acceptanceLine,
          retrospectiveLine,
          '',
          finalPlan,
        ].join('\n'));
      }
      return blocks.join('\n\n---\n\n');
    }

    window.PanelRoomsClusterLive = {
      crossVerifyStageBadges,
      formatClusterRuntimeTime,
      formatClusterDurationMs,
      renderClusterRuntimeHeartbeatLine,
      renderClusterRuntimeRecoveryLine,
      renderClusterRuntimeResumePolicyLine,
      currentClusterTask,
      cleanClusterRuntimeOutputContent,
      renderClusterRuntimeOutputRows,
      renderClusterRuntimeLivePanel,
      renderCrossVerifyConsensusMarkdown,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
