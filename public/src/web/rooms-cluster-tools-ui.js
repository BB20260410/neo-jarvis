// @ts-check
// rooms-cluster-tools-ui.js — Chat 房 cluster 工具/formatter/操作群（预检/并发预算/诊断/自愈/交付包归档）（从 app.js 外迁；app.js 模块化第8批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml, promptModal, api, renderRoomDebate } = core;

    async function openClusterDeliveryPackage() {
      if (!core.roomState.activeId) return;
      const id = core.roomState.activeId;
      const btn = $('#btnRoomDeliveryPackage');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '打开中…';
      }
      try {
        const pkg = await fetch(`/api/rooms/${encodeURIComponent(id)}/cluster-delivery-package`).then(async (r) => {
          if (!r.ok) throw new Error(await r.text());
          return r.json();
        });
        const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/cluster-delivery-package/report/download`, {
          headers: { Accept: 'text/markdown' },
        });
        if (!response.ok) throw new Error(await response.text());
        const markdown = await response.text();
        const artifactCount = pkg.package?.artifacts?.length || 0;
        await promptModal({
          title: '集群协同交付包',
          message: `状态: ${pkg.package?.status || 'unknown'} / 产物: ${artifactCount} / 指纹: ${pkg.manifestFingerprint || ''}`,
          multiline: true,
          value: markdown,
          confirmLabel: '关闭',
        });
      } catch (e) {
        toast('交付包打开失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '📦 交付包';
        }
      }
    }

    function currentRoomTopicDraft() {
      const input = $('#roomTaskInput') || $('#roomTopicInput') || $('#roomPromptInput') || $('#roomArea textarea');
      return String(input?.value || '').trim();
    }

    function formatClusterPreflightMarkdown(preflight = {}) {
      const rows = (preflight.checks || []).map((check) => (
        `| ${check.label || check.id} | ${check.status || 'unknown'} | ${(check.evidence || []).join('<br>') || '-'} | ${(check.blockers || []).join('<br>') || '-'} |`
      ));
      return [
        '# 集群协同闭环预检',
        '',
        `- 状态: ${preflight.status || 'unknown'}`,
        `- 通过: ${preflight.passedCount || 0}/${preflight.total || 0}`,
        `- 目标: ${preflight.topic || '-'}`,
        '',
        '| 检查项 | 状态 | 证据 | 阻断/警告 |',
        '|---|---|---|---|',
        ...rows,
      ].join('\n');
    }

    function formatClusterLiveCheckMarkdown(liveCheck = {}) {
      const rows = (liveCheck.checks || []).map((check) => (
        `| ${check.displayName || check.adapterId || '-'} | ${check.status || 'unknown'} | ${check.latencyMs || 0}ms | ${(check.evidence || []).join('<br>') || '-'} | ${(check.blockers || []).join('<br>') || '-'} |`
      ));
      return [
        '# 集群协同实时连通性检查',
        '',
        `- 状态: ${liveCheck.status || 'unknown'}`,
        `- 通过: ${liveCheck.passedCount || 0}/${liveCheck.total || 0}`,
        `- 阻断: ${(liveCheck.blockers || []).join('；') || '-'}`,
        '',
        '| 成员 | 状态 | 耗时 | 证据 | 阻断原因 |',
        '|---|---|---:|---|---|',
        ...rows,
      ].join('\n');
    }

    function formatClusterConcurrencyBudgetMarkdown(budget = {}) {
      const adapterIds = Array.from(new Set([
        ...Object.keys(budget.adapterLoad || {}),
        ...Object.keys(budget.projectedAdapterLoad || {}),
        ...(budget.currentAdapters || []),
      ])).sort();
      const rows = adapterIds.map((adapterId) => (
        `| ${escapeHtml(adapterId)} | ${budget.adapterLoad?.[adapterId] || 0} | ${budget.projectedAdapterLoad?.[adapterId] || 0} | ${budget.maxAdapterRunningRooms || '-'} |`
      ));
      return [
        '# 集群协同并发预算',
        '',
        `- 状态: ${budget.status || 'unknown'}`,
        `- 当前运行房间: ${budget.runningRoomCount || 0}`,
        `- 启动中预约: ${budget.startingRoomCount || 0}`,
        `- 启动后运行房间: ${budget.projectedRunningRoomCount || 0}`,
        `- 房间并发上限: ${budget.maxRunningRooms || '-'}`,
        `- 单 adapter 并发上限: ${budget.maxAdapterRunningRooms || '-'}`,
        `- 阻断: ${(budget.blockers || []).join('；') || '-'}`,
        `- 警告: ${(budget.warnings || []).join('；') || '-'}`,
        `- 启动中房间: ${(budget.startingRooms || []).map((room) => `${room.roomId}${room.ageMs !== undefined ? `(${room.ageMs}ms)` : ''}`).join('；') || '-'}`,
        '',
        '| Adapter | 当前占用房间 | 启动后占用 | 上限 |',
        '|---|---:|---:|---:|',
        ...rows,
      ].join('\n');
    }

    function formatClusterDiagnosticsMarkdown(diagnostics = {}, body = {}) {
      const summary = diagnostics.summary || {};
      const invariants = diagnostics.invariants || {};
      const findings = Array.isArray(diagnostics.findings) ? diagnostics.findings : [];
      const recommendations = Array.isArray(diagnostics.recommendations) ? diagnostics.recommendations : [];
      const recoveryPlan = Array.isArray(diagnostics.recoveryPlan) ? diagnostics.recoveryPlan : [];
      const assurance = body.assurance || {};
      const repair = body.repair || {};
      const assuranceSummary = assurance.summary || {};
      const assuranceGates = Array.isArray(assurance.gates) ? assurance.gates : [];
      const assuranceRecoveryPlan = Array.isArray(assurance.recoveryPlan) ? assurance.recoveryPlan : [];
      const readiness = body.readiness || {};
      const runtime = body.runtimeReconciliation || {};
      const configAudit = body.configAudit || {};
      const budget = body.concurrencyBudget || {};
      const capabilityGuard = body.capabilityGuard || {};
      const capabilitySummary = capabilityGuard.summary || {};
      const capabilityChecks = Array.isArray(capabilityGuard.checks) ? capabilityGuard.checks : [];
      const capabilityRooms = Array.isArray(capabilityGuard.rooms) ? capabilityGuard.rooms : [];
      const roomSummary = summary.roomSummary || {};
      const invariantRows = Object.entries(invariants).map(([key, value]) => (
        `| ${escapeHtml(key)} | ${escapeHtml(String(value))} |`
      ));
      const findingRows = findings.length
        ? findings.map((item, index) => (
          `| ${index + 1} | ${escapeHtml(item.severity || item.status || 'info')} | ${escapeHtml(item.id || item.name || '-')} | ${escapeHtml(item.message || item.label || item.reason || '-')} |`
        ))
        : ['| - | - | - | 无 |'];
      const recommendationRows = recommendations.length
        ? recommendations.map((item, index) => {
          const text = typeof item === 'string'
            ? item
            : item.message || item.action || item.reason || item.id || JSON.stringify(item);
          return `| ${index + 1} | ${escapeHtml(text)} |`;
        })
        : ['| - | 暂无 |'];
      const recoveryRows = recoveryPlan.length
        ? recoveryPlan.map((item, index) => (
          `| ${index + 1} | ${escapeHtml(item.severity || 'info')} | ${escapeHtml(item.code || '-')} | ${escapeHtml(item.action || '-')} | ${escapeHtml(item.command || item.endpoint || item.ui || '-')} |`
        ))
        : ['| - | - | - | 暂无 | - |'];
      const assuranceRows = assuranceGates.length
        ? assuranceGates.map((item, index) => (
          `| ${index + 1} | ${escapeHtml(item.status || 'unknown')} | ${escapeHtml(item.id || '-')} | ${escapeHtml(item.label || '-')} | ${escapeHtml(String(item.caseCount ?? item.findingCount ?? '-'))} | ${escapeHtml((item.failedCases || []).join(', ') || item.error || '-')} |`
        ))
        : ['| - | - | - | 暂无 | - | - |'];
      const assuranceRecoveryRows = assuranceRecoveryPlan.length
        ? assuranceRecoveryPlan.map((item, index) => (
          `| ${index + 1} | ${escapeHtml(item.severity || 'info')} | ${escapeHtml(item.gateId || '-')} | ${escapeHtml(item.action || '-')} | ${escapeHtml(item.command || '-')} | ${escapeHtml(item.endpoint || item.ui || '-')} |`
        ))
        : ['| - | - | - | 暂无 | - | - |'];
      const capabilityCheckRows = capabilityChecks.length
        ? capabilityChecks.map((item, index) => (
          `| ${index + 1} | ${escapeHtml(item.status || 'unknown')} | ${escapeHtml(item.label || item.id || '-')} | ${escapeHtml((item.evidence || []).join('；') || '-')} | ${escapeHtml((item.blockers || []).join('；') || '-')} | ${escapeHtml((item.warnings || []).join('；') || '-')} |`
        ))
        : ['| - | - | 暂无 | - | - | - |'];
      const capabilityRoomRows = capabilityRooms.length
        ? capabilityRooms.map((item, index) => {
          const adapterText = (item.adapterIds || []).join(', ') || '-';
          const issueText = [...(item.blockers || []), ...(item.warnings || [])].join('；') || '-';
          return `| ${index + 1} | ${escapeHtml(item.roomId || '-')} | ${escapeHtml(item.status || 'unknown')} | ${escapeHtml(String(item.enabledMemberCount ?? '-'))} | ${escapeHtml(adapterText)} | ${escapeHtml(issueText)} |`;
        })
        : ['| - | - | - | - | - | 暂无 |'];
      return [
        '# 集群协同诊断报告',
        '',
        `- 诊断状态: ${diagnostics.status || 'unknown'}`,
        `- 安全启动: ${invariants.safeToStart === true ? 'true' : 'false'}`,
        `- 健康状态: ${summary.healthStatus || body.health?.status || 'unknown'}`,
        `- 就绪状态: ${summary.readinessStatus || readiness.status || 'unknown'}`,
        `- 运行时状态: ${summary.runtimeStatus || runtime.status || 'unknown'}`,
        `- 配置状态: ${summary.configStatus || configAudit.status || 'unknown'}`,
        `- 并发状态: ${summary.concurrencyStatus || budget.status || 'unknown'}`,
        `- 能力守卫: ${capabilityGuard.status || summary.capabilityGuardStatus || 'unknown'}`,
        `- 能力守卫阻断: ${(capabilityGuard.blockers || []).join('；') || '无'}`,
        `- 能力守卫警告: ${(capabilityGuard.warnings || []).join('；') || '无'}`,
        `- 原生能力边界违规: ${capabilitySummary.nativeBridgeViolationCount ?? '-'}`,
        `- 房间级共享插件桥: ${capabilitySummary.sharedRoomBridgeCount ?? '-'}`,
        `- 当前运行房间: ${budget.runningRoomCount || 0}`,
        `- 启动中预约: ${budget.startingRoomCount || 0}`,
        `- 最大运行房间: ${budget.maxRunningRooms || configAudit.config?.maxRunningRooms || '-'}`,
        `- 单 adapter 并发上限: ${budget.maxAdapterRunningRooms || configAudit.config?.maxAdapterRunningRooms || '-'}`,
        `- 房间总数: ${roomSummary.total ?? '-'}`,
        `- 阻断数: ${summary.blockerCount ?? findings.filter((item) => item.severity === 'blocker').length}`,
        `- 警告数: ${summary.warningCount ?? findings.filter((item) => item.severity === 'warning').length}`,
        `- 保证体系: ${assurance.status || 'unknown'} / gates ${assuranceSummary.passedGateCount ?? '-'}/${assuranceSummary.gateCount ?? '-'}`,
        `- 保证阻断: ${(assuranceSummary.failedGateIds || []).join(', ') || '无'}`,
        `- 自愈修复: ${repair.status || '未执行'} / actions ${(repair.appliedActions || []).length || 0} / blockers ${(repair.blockers || []).length || 0}`,
        '',
        '## 能力漂移守卫',
        '',
        `- 状态: ${capabilityGuard.status || 'unknown'}`,
        `- 可执行成员: ${capabilitySummary.enabledMemberCount ?? '-'}`,
        `- 缺失 adapterId: ${capabilitySummary.missingAdapterMemberCount ?? '-'}`,
        `- 重复 adapter 房间: ${capabilitySummary.duplicateAdapterRoomCount ?? '-'}`,
        `- 房间级共享 Skill/插件桥: ${capabilitySummary.sharedRoomBridgeCount ?? '-'}`,
        `- Claude/Gemini 原生能力违规: ${capabilitySummary.nativeBridgeViolationCount ?? '-'}`,
        '',
        '| # | 状态 | 检查项 | 证据 | 阻断 | 警告 |',
        '|---:|---|---|---|---|---|',
        ...capabilityCheckRows,
        '',
        '### 能力守卫房间明细',
        '',
        '| # | 房间 | 状态 | 启用成员 | Adapter | 阻断/警告 |',
        '|---:|---|---|---:|---|---|',
        ...capabilityRoomRows,
        '',
        '## 启动不变量',
        '',
        '| 项 | 值 |',
        '|---|---|',
        ...invariantRows,
        '',
        '## 发现项',
        '',
        '| # | 级别 | ID | 说明 |',
        '|---:|---|---|---|',
        ...findingRows,
        '',
        '## 修复建议',
        '',
        '| # | 建议 |',
        '|---:|---|',
        ...recommendationRows,
        '',
        '## 恢复计划',
        '',
        '| # | 级别 | 代码 | 操作 | 命令/入口 |',
        '|---:|---|---|---|---|',
        ...recoveryRows,
        '',
        '## 保证体系门禁',
        '',
        '| # | 状态 | 门禁 | 说明 | 用例/发现数 | 失败项 |',
        '|---:|---|---|---|---:|---|',
        ...assuranceRows,
        '',
        '## 保证体系恢复决策',
        '',
        '| # | 级别 | 门禁 | 操作 | 命令 | API/UI |',
        '|---:|---|---|---|---|---|',
        ...assuranceRecoveryRows,
      ].join('\n');
    }

    function clusterStartErrorSummary(body = {}) {
      const candidates = [
        ...(body.concurrencyBudget?.blockers || []),
        ...(body.liveCheck?.blockers || []),
        ...(body.preflight?.blockers || []),
        body.message,
        body.reason,
        body.error,
        body.startError,
      ].filter(Boolean);
      return candidates.length ? candidates.join('；') : 'unknown';
    }

    async function showClusterStartFailure(body = {}) {
      const liveCheck = body.liveCheck || null;
      const preflight = body.preflight || null;
      const concurrencyBudget = body.concurrencyBudget || null;
      const title = body.error === 'room_already_running'
        ? '房间已在运行中'
        : body.error === 'cluster_concurrency_blocked'
          ? '集群协同启动被并发预算拦截'
          : body.error === 'room_start_in_progress'
            ? '集群协同启动中'
            : body.error === 'cluster_live_check_failed'
              ? '集群协同实时检查异常'
              : body.error === 'cluster_live_check_blocked'
                ? '集群协同启动被实时连通性检查拦截'
                : '集群协同启动被预检拦截';
      const value = concurrencyBudget
        ? formatClusterConcurrencyBudgetMarkdown(concurrencyBudget)
        : liveCheck ? formatClusterLiveCheckMarkdown(liveCheck) : formatClusterPreflightMarkdown(preflight || {});
      const blockers = concurrencyBudget?.blockers || liveCheck?.blockers || preflight?.blockers || [];
      await promptModal({
        title,
        message: body.error === 'room_already_running'
          ? '当前房间已经在运行。可以切换到其他房间继续并发启动，或先暂停当前房间。'
          : body.error === 'room_start_in_progress'
            ? '当前房间已有启动流程正在进行，请等待实时检查完成。'
          : body.error === 'cluster_live_check_failed'
            ? `实时连通性检查自身异常：${body.message || 'unknown'}`
          : blockers.length ? blockers.join('；') : (body.error || '启动失败'),
        multiline: true,
        value,
        confirmLabel: '关闭',
      });
    }

    async function runClusterPreflight() {
      if (!core.roomState.activeId) return;
      const btn = $('#btnRoomClusterPreflight');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '预检中…';
      }
      try {
        const topic = currentRoomTopicDraft();
        const response = await fetch(`/api/rooms/${encodeURIComponent(core.roomState.activeId)}/cluster-preflight?topic=${encodeURIComponent(topic)}`);
        const body = await response.json().catch(() => ({}));
        const preflight = body.preflight || {};
        await promptModal({
          title: '集群协同闭环预检',
          message: preflight.status === 'blocked' ? '存在阻断项，建议修复后再启动。' : '预检完成。',
          multiline: true,
          value: formatClusterPreflightMarkdown(preflight),
          confirmLabel: '关闭',
        });
        toast(`闭环预检：${preflight.status || 'unknown'} ${preflight.passedCount || 0}/${preflight.total || 0}`, response.ok ? 'success' : 'warn', 3500);
      } catch (e) {
        toast('闭环预检失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '🧪 闭环预检';
        }
      }
    }

    async function showClusterConcurrencyBudget() {
      if (!core.roomState.activeId) return;
      const btn = $('#btnRoomClusterConcurrency');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '读取中…';
      }
      try {
        const response = await fetch(`/api/cluster/concurrency-budget?roomId=${encodeURIComponent(core.roomState.activeId)}`);
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
        const budget = body.concurrencyBudget || {};
        await promptModal({
          title: '集群协同并发预算',
          message: `状态: ${budget.status || 'unknown'} / 运行中 ${budget.runningRoomCount || 0} / 启动中 ${budget.startingRoomCount || 0}`,
          multiline: true,
          value: formatClusterConcurrencyBudgetMarkdown(budget),
          confirmLabel: '关闭',
        });
        toast(`并发预算：${budget.status || 'unknown'}，运行中 ${budget.runningRoomCount || 0}，启动中 ${budget.startingRoomCount || 0}`, budget.status === 'blocked' ? 'warn' : 'success', 3500);
      } catch (e) {
        toast('并发预算读取失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '📊 并发预算';
        }
      }
    }

    async function showClusterDiagnostics() {
      const btn = $('#btnRoomClusterDiagnostics');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '诊断中…';
      }
      try {
        const response = await fetch('/api/cluster/diagnostics');
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
        const diagnostics = body.diagnostics || {};
        const assurance = body.assurance || {};
        await promptModal({
          title: '集群协同诊断',
          message: `状态: ${diagnostics.status || 'unknown'} / assurance=${assurance.status || 'unknown'} / safeToStart=${diagnostics.invariants?.safeToStart === true}`,
          multiline: true,
          value: formatClusterDiagnosticsMarkdown(diagnostics, body),
          confirmLabel: '关闭',
        });
        toast(`集群诊断：${diagnostics.status || 'unknown'}，保证体系=${assurance.status || 'unknown'}`, diagnostics.status === 'blocked' || assurance.status === 'blocked' ? 'warn' : 'success', 3500);
      } catch (e) {
        toast('集群诊断失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '🩺 集群诊断';
        }
      }
    }

    async function repairClusterRuntime() {
      const btn = $('#btnRoomClusterRepair');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '修复中…';
      }
      try {
        const response = await fetch('/api/cluster/repair', { method: 'POST' });
        const body = await response.json().catch(() => ({}));
        if (!body || (!body.repair && body.ok === false)) throw new Error(body.error || `HTTP ${response.status}`);
        const repair = body.repair || {};
        const diagnostics = body.diagnostics || {};
        const assurance = body.assurance || {};
        await promptModal({
          title: '集群协同自愈修复',
          message: `修复状态: ${repair.status || 'unknown'} / diagnostics=${diagnostics.status || 'unknown'} / assurance=${assurance.status || 'unknown'}`,
          multiline: true,
          value: formatClusterDiagnosticsMarkdown(diagnostics, body),
          confirmLabel: '关闭',
        });
        toast(
          `自愈修复：${repair.status || 'unknown'}，动作 ${(repair.appliedActions || []).length || 0}，阻断 ${(repair.blockers || []).length || 0}`,
          repair.ok === false || response.status >= 500 ? 'warn' : 'success',
          4500,
        );
      } catch (e) {
        toast('自愈修复失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '🛠 自愈修复';
        }
      }
    }

    async function archiveClusterDeliveryPackage() {
      if (!core.roomState.activeId) return;
      const id = core.roomState.activeId;
      const btn = $('#btnRoomArchiveDeliveryPackage');
      const oldText = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '归档中…';
      }
      try {
        const result = await api(`/api/rooms/${encodeURIComponent(id)}/cluster-delivery-package/archive`, {
          method: 'POST',
          body: JSON.stringify({ requestedBy: 'owner' }),
        });
        toast(`交付包已归档：${result.archive?.archiveDir || result.archive?.id || 'done'}`, 'success', 3500);
        if (result.room) {
          const i = core.roomState.rooms.findIndex((room) => room.id === id);
          if (i >= 0) core.roomState.rooms[i] = result.room;
          renderRoomDebate(result.room);
        }
      } catch (e) {
        toast('交付包归档失败：' + (e.message || e), 'error', 5000);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = oldText || '🗄 归档交付';
        }
      }
    }

    window.PanelRoomsClusterTools = {
      openClusterDeliveryPackage,
      currentRoomTopicDraft,
      formatClusterPreflightMarkdown,
      formatClusterLiveCheckMarkdown,
      formatClusterConcurrencyBudgetMarkdown,
      formatClusterDiagnosticsMarkdown,
      clusterStartErrorSummary,
      showClusterStartFailure,
      runClusterPreflight,
      showClusterConcurrencyBudget,
      showClusterDiagnostics,
      repairClusterRuntime,
      archiveClusterDeliveryPackage,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
