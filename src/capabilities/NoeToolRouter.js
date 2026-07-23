import { buildNoeCommandSurface } from './NoeCommandSurface.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_TOOL_ROUTER_SCHEMA_VERSION = 1;

const ALWAYS_ON_COMMAND_IDS = new Set([
  'noe.find_tool',
  'noe.recall_memory',
  'noe.show_current_task',
  'noe.explain_next_action',
]);

const DOMAIN_KEYWORDS = {
  memory: ['memory', 'recall', '记忆', '回忆', '历史', '昨天', '上周'],
  files: ['file', 'fs', 'search', '文件', '检索', '路径', '目录'],
  knowledge: ['kg', 'graph', 'knowledge', '知识', '图谱', '关系'],
  task: ['task', 'focus', 'status', '任务', '焦点', '进度', '下一步'],
  plan: ['plan', 'dry-run', 'explain', '计划', '方案', 'dry'],
};

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function normalizeTerms(values = []) {
  const input = Array.isArray(values) ? values : [values];
  return input.flatMap((value) => {
    const raw = clean(value, 500).toLowerCase();
    const parts = raw.split(/[\s,，。；;:：/|]+/).filter(Boolean);
    const cnPairs = [];
    for (const part of parts) {
      const chars = [...part];
      if (chars.length >= 2 && /[\u4e00-\u9fff]/.test(part)) {
        for (let i = 0; i < chars.length - 1; i++) cnPairs.push(chars.slice(i, i + 2).join(''));
      }
    }
    return [...parts, ...cnPairs];
  }).filter(Boolean);
}

function commandText(command = {}) {
  return [
    command.id,
    command.title,
    command.description,
    ...(command.capabilityTags || []),
    ...(command.aliases || []),
    command.operation,
  ].join('\n').toLowerCase();
}

function commandMatches(command, terms = []) {
  const text = commandText(command);
  return terms.some((term) => text.includes(term));
}

function commandScore(command = {}, terms = []) {
  const id = clean(command.id, 300).toLowerCase();
  const title = clean(command.title, 300).toLowerCase();
  const description = clean(command.description, 1000).toLowerCase();
  const operation = clean(command.operation, 300).toLowerCase();
  const tags = (command.capabilityTags || []).map((tag) => clean(tag, 100).toLowerCase());
  const aliases = (command.aliases || []).map((alias) => clean(alias, 100).toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (id === term || operation === term) score += 30;
    if (tags.includes(term) || aliases.includes(term)) score += 20;
    if (id.includes(term) || operation.includes(term)) score += 12;
    if (title.includes(term)) score += 8;
    if (description.includes(term)) score += 3;
  }
  return score;
}

function domainTerms(contextTags = []) {
  const tags = normalizeTerms(contextTags);
  const out = [];
  for (const tag of tags) {
    out.push(tag);
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      if (domain === tag || keywords.includes(tag)) out.push(...keywords);
    }
  }
  return [...new Set(out)];
}

function canInject(command, permissionState = {}) {
  if (!command.hiddenReason) return true;
  if (permissionState.allowHighRisk === true || permissionState.consensusApproved === true || permissionState.userApproved === true) return true;
  return false;
}

export function routeNoeTools({
  goal = '',
  contextTags = [],
  recentActions = [],
  commandSurface = null,
  manifests = undefined,
  extraCommands = [],
  permissionState = {},
  maxCommands = 8,
} = {}) {
  const surface = commandSurface || buildNoeCommandSurface({ manifests, extraCommands, permissionState });
  const commands = Array.isArray(surface.commands) ? surface.commands : [];
  const goalTerms = normalizeTerms(goal);
  const tags = domainTerms(contextTags);
  const recentTerms = normalizeTerms((Array.isArray(recentActions) ? recentActions : []).map((item) => item?.action || item?.toolName || item?.id || item));
  const terms = [...new Set([...goalTerms, ...tags, ...recentTerms])];
  const alwaysOn = commands.filter((command) => ALWAYS_ON_COMMAND_IDS.has(command.id));
  const candidates = commands
    .filter((command) => !ALWAYS_ON_COMMAND_IDS.has(command.id))
    .filter((command) => commandMatches(command, terms) || (terms.length === 0 && command.riskLevel === 'low'));
  const ranked = candidates
    .map((command, index) => ({ command, index, score: commandScore(command, terms) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((item) => item.command);
  const hidden = ranked.filter((command) => !canInject(command, permissionState));
  const selected = ranked.filter((command) => canInject(command, permissionState));
  // L6 保活：最近「真用过」的工具强制保留，防长任务因本轮关键词未命中而丢工具 →
  //   Noe 下一轮看不到上轮用过的工具，误判「我没有执行命令的能力」（人为假限制）。
  const recentActionKeys = new Set(
    (Array.isArray(recentActions) ? recentActions : [])
      .map((item) => clean(item?.action || item?.toolName || item?.id || item, 200).toLowerCase())
      .filter(Boolean),
  );
  const keepAlive = commands.filter((command) => !ALWAYS_ON_COMMAND_IDS.has(command.id)
    && canInject(command, permissionState)
    && (recentActionKeys.has(String(command.id).toLowerCase())
      || (command.capability && recentActionKeys.has(String(command.capability).toLowerCase()))
      || (command.action && recentActionKeys.has(String(command.action).toLowerCase()))));
  const prioritized = [...alwaysOn, ...keepAlive];
  const max = Math.max(prioritized.length, Number(maxCommands) || 8); // 保活+常驻不被预算挤掉
  const injected = [...prioritized, ...selected]
    .filter((command, index, arr) => arr.findIndex((item) => item.id === command.id) === index)
    .slice(0, max);
  return {
    schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
    goal: clean(goal, 1000),
    contextTags: tags,
    injected,
    alwaysOn,
    keepAlive,
    selected,
    hidden,
    warnings: hidden.length ? ['high_risk_or_permissioned_tools_hidden'] : [],
    injectionBudget: {
      maxCommands: max,
      injectedCount: injected.length,
      hiddenCount: hidden.length,
    },
  };
}

export function resolveNoeTool(toolName, {
  commandSurface = null,
  manifests = undefined,
  extraCommands = [],
  permissionState = {},
} = {}) {
  const cleanedName = clean(toolName, 300);
  if (!cleanedName) {
    return {
      ok: false,
      schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
      error: {
        code: 'NOE_TOOL_INVALID_NAME',
        message: 'Tool name must be a non-empty string.',
      },
    };
  }

  let surface;
  try {
    surface = commandSurface || buildNoeCommandSurface({ manifests, extraCommands, permissionState });
  } catch (err) {
    return {
      ok: false,
      schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
      error: {
        code: 'NOE_TOOL_SURFACE_BUILD_FAILED',
        message: 'Failed to build command surface.',
        detail: err && err.message ? String(err.message) : String(err),
      },
    };
  }

  const commands = Array.isArray(surface?.commands) ? surface.commands : [];

  if (commands.length === 0) {
    return {
      ok: false,
      schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
      error: {
        code: 'NOE_TOOL_REGISTRY_EMPTY',
        message: 'Tool registry is empty; no tools are available to resolve.',
        toolName: cleanedName,
      },
    };
  }

  const lookup = cleanedName.toLowerCase();
  const found = commands.find((command) => {
    if (!command || !command.id) return false;
    if (String(command.id).toLowerCase() === lookup) return true;
    if (command.operation && String(command.operation).toLowerCase() === lookup) return true;
    if (Array.isArray(command.aliases)) {
      for (const alias of command.aliases) {
        if (clean(alias, 100).toLowerCase() === lookup) return true;
      }
    }
    return false;
  });

  if (!found) {
    return {
      ok: false,
      schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
      error: {
        code: 'NOE_TOOL_NOT_FOUND',
        message: `Tool "${cleanedName}" is not registered.`,
        toolName: cleanedName,
        availableIds: commands
          .map((command) => (command && command.id ? String(command.id) : ''))
          .filter(Boolean)
          .slice(0, 50),
      },
    };
  }

  return {
    ok: true,
    schemaVersion: NOE_TOOL_ROUTER_SCHEMA_VERSION,
    tool: found,
  };
}
