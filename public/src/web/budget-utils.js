// budget-utils.js — 预算/格式化纯函数（从 app.js 外迁；零依赖叶子，IIFE 挂 window.BudgetUtils，无时序风险）
(function () {
  'use strict';
  function rangeToFromIso(range) {
    const now = Date.now();
    const ms = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[range] || 7 * 86400000;
    return new Date(now - ms).toISOString();
  }
  function rangeBucket(range) { return range === '24h' ? 'hour' : 'day'; }
  function fmtUSD(n) { return '$' + (n || 0).toFixed(4); }
  function fmtBigInt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n || 0);
  }
  function fmtMs(ms) {
    if (!ms) return '0ms';
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }
  function fmtBudgetMetric(metric, value) {
    const n = Number(value) || 0;
    if (metric === 'usd') return '$' + n.toFixed(4);
    if (metric === 'tokens') return fmtBigInt(n) + ' tokens';
    if (metric === 'calls') return fmtBigInt(n) + ' calls';
    return String(n);
  }
  function fmtBudgetTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '-';
    try {
      return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
      return '-';
    }
  }
  function budgetScopeLabel(scopeType, scopeId) {
    const labels = { project: '项目', room: '房间', session: '会话', adapter: '模型', task: '任务' };
    return `${labels[scopeType] || scopeType}:${scopeId || '-'}`;
  }
  window.BudgetUtils = { rangeToFromIso, rangeBucket, fmtUSD, fmtBigInt, fmtMs, fmtBudgetMetric, fmtBudgetTime, budgetScopeLabel };
})();
