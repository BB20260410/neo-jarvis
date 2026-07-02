const MB = 1024 * 1024;

const DEFAULT_WARN_RSS_MB = 1536;
const DEFAULT_MAX_RSS_MB = 2048;
const DEFAULT_WARN_HEAP_USED_RATIO = 0.90;
const DEFAULT_MAX_HEAP_USED_RATIO = 0.95;
const DEFAULT_WARN_HEAP_USED_MB_FOR_RATIO = 256;
const DEFAULT_MAX_HEAP_USED_MB_FOR_RATIO = 512;
const DEFAULT_WARN_ACTIVE_HANDLES = 512;
const DEFAULT_MAX_ACTIVE_HANDLES = 1024;
const DEFAULT_WARN_ACTIVE_REQUESTS = 128;
const DEFAULT_MAX_ACTIVE_REQUESTS = 256;
const DEFAULT_WARN_EVENT_LOOP_LAG_MS = 250;
const DEFAULT_MAX_EVENT_LOOP_LAG_MS = 1000;

function numberFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function activeCount(fnName) {
  const fn = process[fnName];
  if (typeof fn !== 'function') return null;
  try {
    const items = fn.call(process);
    return Array.isArray(items) ? items.length : null;
  } catch {
    return null;
  }
}

function statusFromIssues(blockers, warnings) {
  if (blockers.length > 0) return 'blocked';
  if (warnings.length > 0) return 'warn';
  return 'passed';
}

function makeCheck(id, label, value, warnAt, blockAt, unit = '') {
  const blockers = [];
  const warnings = [];
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return {
      id,
      label,
      status: 'unknown',
      value: null,
      warnAt,
      blockAt,
      unit,
      blockers,
      warnings: [`${id}_unavailable`],
    };
  }
  if (Number.isFinite(blockAt) && value >= blockAt) blockers.push(`${id}_gte_${blockAt}${unit}`);
  else if (Number.isFinite(warnAt) && value >= warnAt) warnings.push(`${id}_gte_${warnAt}${unit}`);
  return {
    id,
    label,
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warn' : 'passed',
    value,
    warnAt,
    blockAt,
    unit,
    blockers,
    warnings,
  };
}

function makeHeapUsedRatioCheck(snapshot, config) {
  const value = snapshot.heapUsedRatio;
  const blockers = [];
  const warnings = [];
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return {
      id: 'heap_used_ratio',
      label: '堆内存使用比例',
      status: 'unknown',
      value: null,
      warnAt: config.warnHeapUsedRatio,
      blockAt: config.maxHeapUsedRatio,
      unit: '',
      blockers,
      warnings: ['heap_used_ratio_unavailable'],
    };
  }
  const heapUsedMb = Number(snapshot.heapUsedMb);
  const hasHeapUsedMb = Number.isFinite(heapUsedMb);
  const warnHeapUsedMb = positiveNumber(config.warnHeapUsedMbForRatio);
  const maxHeapUsedMb = positiveNumber(config.maxHeapUsedMbForRatio);
  const ratio = Number(value);
  if (Number.isFinite(config.maxHeapUsedRatio) && ratio >= config.maxHeapUsedRatio) {
    if (!hasHeapUsedMb || heapUsedMb >= maxHeapUsedMb) blockers.push(`heap_used_ratio_gte_${config.maxHeapUsedRatio}`);
  } else if (Number.isFinite(config.warnHeapUsedRatio) && ratio >= config.warnHeapUsedRatio) {
    if (!hasHeapUsedMb || heapUsedMb >= warnHeapUsedMb) warnings.push(`heap_used_ratio_gte_${config.warnHeapUsedRatio}`);
  }
  return {
    id: 'heap_used_ratio',
    label: '堆内存使用比例',
    status: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warn' : 'passed',
    value: ratio,
    warnAt: config.warnHeapUsedRatio,
    blockAt: config.maxHeapUsedRatio,
    unit: '',
    heapUsedMb: hasHeapUsedMb ? heapUsedMb : null,
    warnHeapUsedMb,
    maxHeapUsedMb,
    blockers,
    warnings,
  };
}

export function buildClusterResourceGuardConfig() {
  return {
    warnRssMb: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_RSS_MB', DEFAULT_WARN_RSS_MB),
    maxRssMb: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_RSS_MB', DEFAULT_MAX_RSS_MB),
    warnHeapUsedRatio: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_RATIO', DEFAULT_WARN_HEAP_USED_RATIO),
    maxHeapUsedRatio: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_RATIO', DEFAULT_MAX_HEAP_USED_RATIO),
    warnHeapUsedMbForRatio: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_HEAP_USED_MB_FOR_RATIO', DEFAULT_WARN_HEAP_USED_MB_FOR_RATIO),
    maxHeapUsedMbForRatio: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_HEAP_USED_MB_FOR_RATIO', DEFAULT_MAX_HEAP_USED_MB_FOR_RATIO),
    warnActiveHandles: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_HANDLES', DEFAULT_WARN_ACTIVE_HANDLES),
    maxActiveHandles: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_HANDLES', DEFAULT_MAX_ACTIVE_HANDLES),
    warnActiveRequests: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_ACTIVE_REQUESTS', DEFAULT_WARN_ACTIVE_REQUESTS),
    maxActiveRequests: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_ACTIVE_REQUESTS', DEFAULT_MAX_ACTIVE_REQUESTS),
    warnEventLoopLagMs: numberFromEnv('PANEL_CLUSTER_RESOURCE_WARN_EVENT_LOOP_LAG_MS', DEFAULT_WARN_EVENT_LOOP_LAG_MS),
    maxEventLoopLagMs: numberFromEnv('PANEL_CLUSTER_RESOURCE_MAX_EVENT_LOOP_LAG_MS', DEFAULT_MAX_EVENT_LOOP_LAG_MS),
  };
}

export function buildClusterResourceSnapshot(overrides = {}) {
  const memory = overrides.memory || process.memoryUsage();
  const resourceUsage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : {};
  return {
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    nodeVersion: process.version,
    rssMb: Math.round((positiveNumber(memory.rss) / MB) * 10) / 10,
    heapUsedMb: Math.round((positiveNumber(memory.heapUsed) / MB) * 10) / 10,
    heapTotalMb: Math.round((positiveNumber(memory.heapTotal) / MB) * 10) / 10,
    heapUsedRatio: positiveNumber(memory.heapTotal) > 0
      ? Math.round((positiveNumber(memory.heapUsed) / positiveNumber(memory.heapTotal)) * 1000) / 1000
      : 0,
    externalMb: Math.round((positiveNumber(memory.external) / MB) * 10) / 10,
    arrayBuffersMb: Math.round((positiveNumber(memory.arrayBuffers) / MB) * 10) / 10,
    activeHandles: overrides.activeHandles ?? activeCount('_getActiveHandles'),
    activeRequests: overrides.activeRequests ?? activeCount('_getActiveRequests'),
    eventLoopLagMs: overrides.eventLoopLagMs ?? null,
    fsRead: resourceUsage.fsRead,
    fsWrite: resourceUsage.fsWrite,
    involuntaryContextSwitches: resourceUsage.involuntaryContextSwitches,
  };
}

export function buildClusterResourceGuardReport({
  snapshot = buildClusterResourceSnapshot(),
  config = buildClusterResourceGuardConfig(),
  now = new Date(),
} = {}) {
  const checks = [
    makeCheck('rss_mb', '进程 RSS 内存', snapshot.rssMb, config.warnRssMb, config.maxRssMb, 'mb'),
    makeHeapUsedRatioCheck(snapshot, config),
    makeCheck('active_handles', 'Node 活跃句柄数', snapshot.activeHandles, config.warnActiveHandles, config.maxActiveHandles),
    makeCheck('active_requests', 'Node 活跃请求数', snapshot.activeRequests, config.warnActiveRequests, config.maxActiveRequests),
    makeCheck('event_loop_lag_ms', '事件循环延迟', snapshot.eventLoopLagMs, config.warnEventLoopLagMs, config.maxEventLoopLagMs, 'ms'),
  ];
  const blockers = checks.flatMap((check) => check.blockers);
  const warnings = checks
    .filter((check) => check.id !== 'event_loop_lag_ms' || check.value !== null)
    .flatMap((check) => check.warnings);
  const status = statusFromIssues(blockers, warnings);
  return {
    guardVersion: 'cluster-resource-guard-v1',
    generatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    status,
    ok: status !== 'blocked',
    config,
    snapshot,
    checks,
    blockers,
    warnings,
    recommendations: blockers.length > 0
      ? [
        '暂停启动新的集群协同房间,等待运行中任务释放资源。',
        '运行 npm run repair:panel && npm run check:panel;若仍阻断,重启面板服务。',
      ]
      : warnings.length > 0
        ? ['继续允许运行,但建议观察资源趋势并避免继续放大并发。']
        : [],
  };
}
