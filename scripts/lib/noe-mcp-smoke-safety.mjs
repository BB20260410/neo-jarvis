const DEFAULT_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

const LOW_RISK = [
  /^(list|get|read|search|find|query|resolve|take_snapshot|capture_snapshot|list_console|get_console|list_network|get_network|get_supported)/i,
  /screenshot/i,
  /snapshot/i,
];

const WRITE_RISK = [
  /write|create|replace|delete|edit|patch|apply|save|move|rename|upload|download|install|uninstall|disable|enable/i,
  /fill|type|click|drag|press|select/i,
  /memory/i,
];

const EXECUTE_RISK = [
  /execute|exec|shell|run_code|evaluate|eval|script|command/i,
  /performance|trace|heap|profile/i,
];

const NAVIGATION_RISK = [
  /navigate|new_page|close_page|open|browser/i,
];

export function buildMcpSmokeEnv(extra = {}, env = process.env) {
  const out = {
    PATH: env.PATH || DEFAULT_PATH,
    HOME: env.HOME || '',
    TMPDIR: env.TMPDIR || '/tmp',
    TMP: env.TMP || env.TMPDIR || '/tmp',
    TEMP: env.TEMP || env.TMPDIR || '/tmp',
    LANG: env.LANG || 'C.UTF-8',
    LC_ALL: env.LC_ALL || env.LANG || 'C.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
    SEMGREP_SEND_METRICS: 'off',
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    DD_TRACE_ENABLED: 'false',
    DD_PROFILING_ENABLED: 'false',
    DD_RUNTIME_METRICS_ENABLED: 'false',
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    ...extra,
  };
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value && proxyValueLooksNonSecret(value)) out[key] = value;
  }
  return out;
}

function proxyValueLooksNonSecret(value = '') {
  if (/[\r\n]/.test(value)) return false;
  if (/(?:key|token|secret|password)=/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  } catch {
    return !/@/.test(value);
  }
}

export function classifyMcpTool(name = '') {
  const value = String(name || '');
  const tags = [];
  if (WRITE_RISK.some((pattern) => pattern.test(value))) tags.push('write_or_mutation');
  if (EXECUTE_RISK.some((pattern) => pattern.test(value))) tags.push('execute_or_inspect_runtime');
  if (NAVIGATION_RISK.some((pattern) => pattern.test(value))) tags.push('browser_or_navigation');
  if (!tags.length && LOW_RISK.some((pattern) => pattern.test(value))) tags.push('read_or_inspect');
  if (!tags.length) tags.push('unknown');
  const riskLevel = tags.includes('execute_or_inspect_runtime') ? 'high'
    : tags.includes('write_or_mutation') ? 'medium'
      : tags.includes('browser_or_navigation') ? 'medium'
        : tags.includes('unknown') ? 'review'
          : 'low';
  return {
    name: value,
    tags,
    riskLevel,
    boundary: riskLevel === 'low' ? 'allowed_readonly_or_local_inspection' : 'allowed_with_smoke_boundaries',
  };
}

export function summarizeMcpToolSafety(toolNames = []) {
  const tools = toolNames.map(classifyMcpTool);
  const riskyTools = tools.filter((tool) => tool.riskLevel !== 'low');
  return {
    toolCount: tools.length,
    riskyCount: riskyTools.length,
    riskyTools: riskyTools.map((tool) => ({
      name: tool.name,
      riskLevel: tool.riskLevel,
      tags: tool.tags,
      boundary: tool.boundary,
    })),
    riskCounts: tools.reduce((acc, tool) => {
      acc[tool.riskLevel] = (acc[tool.riskLevel] || 0) + 1;
      return acc;
    }, {}),
  };
}
