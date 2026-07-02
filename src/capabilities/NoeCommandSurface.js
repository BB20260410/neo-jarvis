import { BUILTIN_READONLY_TOOLS } from './builtinReadonlyTools.js';
import { freedomToolsAsCommandManifests } from './NoeFreedomManifest.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_COMMAND_SURFACE_SCHEMA_VERSION = 1;

const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9_-]{20,}|tp-[a-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,})/i;

const BASE_COMMANDS = [
  {
    id: 'noe.find_tool',
    title: '查找可用工具',
    description: '按目标、关键词或能力标签查找 Noe 当前可用工具；只返回说明、schema、风险和 dry-run 信息，不执行工具。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查找的工具、任务或能力关键词' },
        limit: { type: 'number', description: '最多返回多少个候选工具' },
      },
    },
    dryRunSupported: true,
    riskLevel: 'low',
    permissionRequired: false,
    capabilityTags: ['discoverability', 'help', 'tools', '工具', '帮助'],
    aliases: ['find_tool', '工具', '帮助', '能做什么'],
    source: 'core',
  },
  {
    id: 'noe.recall_memory',
    title: '检索记忆',
    description: '检索 Noe 已授权可见的记忆摘要；只读，不写入长期记忆。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的记忆关键词' },
        projectId: { type: 'string', description: '项目标识' },
      },
    },
    dryRunSupported: true,
    riskLevel: 'low',
    permissionRequired: false,
    capabilityTags: ['memory', 'recall', 'readonly', '记忆', '检索'],
    aliases: ['recall_memory', '记忆', '回忆'],
    source: 'core',
  },
  {
    id: 'noe.show_current_task',
    title: '查看当前任务',
    description: '展示当前任务、焦点、阻断原因和下一步建议；只读。',
    inputSchema: { type: 'object', properties: {} },
    dryRunSupported: true,
    riskLevel: 'low',
    permissionRequired: false,
    capabilityTags: ['task', 'focus', 'status', '任务', '状态'],
    aliases: ['当前任务', '进度', 'status'],
    source: 'core',
  },
  {
    id: 'noe.explain_next_action',
    title: '解释下一步动作',
    description: '解释 Noe 下一步计划、需要的上下文、权限和验证方式；不执行动作。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '用户目标或当前任务' },
      },
    },
    dryRunSupported: true,
    riskLevel: 'low',
    permissionRequired: false,
    capabilityTags: ['plan', 'dry-run', 'explain', '计划', '下一步'],
    aliases: ['下一步', '计划', 'dry-run'],
    source: 'core',
  },
];

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function normalizeRisk(value = 'low') {
  const risk = clean(value, 80).toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(risk)) return risk;
  if (/delete|remove|upload|publish|external|restart|kill|exec|shell|write|move/i.test(risk)) return 'high';
  return 'low';
}

function riskNeedsPermission(risk) {
  return risk === 'high' || risk === 'critical';
}

function normalizeTags(tags = []) {
  const input = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
  return [...new Set(input.map((tag) => clean(tag, 80).toLowerCase()).filter(Boolean))];
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  try {
    return JSON.parse(JSON.stringify(schema));
  } catch {
    return { type: 'object', properties: {} };
  }
}

function manifestToCommand(manifest = {}) {
  const id = clean(manifest.id || manifest.operation || manifest.name, 160);
  if (!id) return null;
  const riskLevel = normalizeRisk(manifest.riskLevel || manifest.risk_level || 'low');
  const tags = normalizeTags([
    manifest.category,
    manifest.operation,
    ...(Array.isArray(manifest.capabilityTags) ? manifest.capabilityTags : []),
    ...(Array.isArray(manifest.tags) ? manifest.tags : []),
  ]);
  return {
    id,
    title: clean(manifest.title || manifest.name || id, 160),
    description: clean(manifest.description || '', 1000),
    inputSchema: normalizeSchema(manifest.inputSchema || manifest.input_schema),
    dryRunSupported: manifest.dryRunSupported !== false,
    riskLevel,
    permissionRequired: manifest.permissionRequired === true || riskNeedsPermission(riskLevel),
    capabilityTags: tags,
    aliases: normalizeTags(manifest.aliases || []),
    source: clean(manifest.source || 'registry', 80),
    operation: clean(manifest.operation || id, 160),
  };
}

export function normalizeNoeCommandDescriptor(input = {}) {
  const rawVisible = JSON.stringify(input || {});
  const fromManifest = manifestToCommand(input);
  const command = fromManifest || {
    id: clean(input.id, 160),
    title: clean(input.title || input.id, 160),
    description: clean(input.description || '', 1000),
    inputSchema: normalizeSchema(input.inputSchema),
    dryRunSupported: input.dryRunSupported !== false,
    riskLevel: normalizeRisk(input.riskLevel),
    permissionRequired: input.permissionRequired === true,
    capabilityTags: normalizeTags(input.capabilityTags),
    aliases: normalizeTags(input.aliases),
    source: clean(input.source || 'custom', 80),
  };
  if (!command.id) return null;
  const visible = JSON.stringify(command);
  if (SECRET_VALUE_PATTERN.test(rawVisible) || SECRET_VALUE_PATTERN.test(visible)) {
    return {
      ...command,
      description: redactSensitiveText(command.description),
      hiddenReason: 'command_descriptor_contains_secret_like_value',
      permissionRequired: true,
      riskLevel: 'critical',
    };
  }
  return command;
}

export function buildNoeCommandSurface({
  manifests = [...BUILTIN_READONLY_TOOLS, ...freedomToolsAsCommandManifests()],
  extraCommands = [],
  includeHighRisk = false,
  permissionState = {},
} = {}) {
  const commands = [];
  const add = (item) => {
    const command = normalizeNoeCommandDescriptor(item);
    if (!command) return;
    if (commands.some((existing) => existing.id === command.id)) return;
    const highRisk = riskNeedsPermission(command.riskLevel) || command.permissionRequired === true;
    const allowedHighRisk = includeHighRisk === true || permissionState.allowHighRisk === true || permissionState.consensusApproved === true || permissionState.userApproved === true;
    commands.push({
      schemaVersion: NOE_COMMAND_SURFACE_SCHEMA_VERSION,
      ...command,
      hiddenReason: highRisk && !allowedHighRisk
        ? (command.hiddenReason || 'permission_required_before_injection')
        : (command.hiddenReason || ''),
    });
  };
  BASE_COMMANDS.forEach(add);
  (Array.isArray(manifests) ? manifests : []).forEach((manifest) => add({ ...manifest, source: manifest.source || 'builtin-readonly' }));
  (Array.isArray(extraCommands) ? extraCommands : []).forEach(add);
  return {
    schemaVersion: NOE_COMMAND_SURFACE_SCHEMA_VERSION,
    commands,
    visibleCommands: commands.filter((command) => !command.hiddenReason),
    hiddenCommands: commands.filter((command) => command.hiddenReason),
  };
}

function scoreCommand(command, query = '') {
  const q = clean(query, 400).toLowerCase();
  if (!q) return 0;
  const haystack = [
    command.id,
    command.title,
    command.description,
    ...(command.aliases || []),
    ...(command.capabilityTags || []),
  ].join('\n').toLowerCase();
  if (haystack.includes(q)) return 100;
  const parts = q.split(/[\s,，。；;:：/|]+/).filter(Boolean);
  const terms = [...parts];
  for (const part of parts) {
    const chars = [...part];
    if (chars.length >= 2 && /[\u4e00-\u9fff]/.test(part)) {
      for (let i = 0; i < chars.length - 1; i += 1) terms.push(chars.slice(i, i + 2).join(''));
    }
  }
  return [...new Set(terms)].reduce((score, part) => score + (haystack.includes(part) ? 10 : 0), 0);
}

function commandMatchesId(command = {}, id = '') {
  const target = clean(id, 200).toLowerCase();
  if (!target) return false;
  return [
    command.id,
    command.operation,
    command.title,
    ...(command.aliases || []),
  ].map((item) => clean(item, 200).toLowerCase()).some((item) => item === target);
}

function redactJsonValue(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return clean(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return clean(value, 200);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    const k = clean(key, 120);
    out[k] = /secret|token|key|password|authorization/i.test(k) ? '[redacted]' : redactJsonValue(item, depth + 1);
  }
  return out;
}

export function buildNoeCommandHelp({ id = '', commands = null, includeHidden = false } = {}) {
  const surface = commands ? { commands } : buildNoeCommandSurface();
  const command = (surface.commands || []).find((item) => commandMatchesId(item, id));
  if (!command) return { ok: false, error: 'command_not_found', commandId: clean(id, 200) };
  if (command.hiddenReason && !includeHidden) {
    return {
      ok: false,
      error: 'command_hidden',
      commandId: command.id,
      hiddenReason: command.hiddenReason,
      riskLevel: command.riskLevel,
      permissionRequired: command.permissionRequired,
    };
  }
  return {
    ok: true,
    commandId: command.id,
    title: command.title,
    description: command.description,
    inputSchema: command.inputSchema,
    dryRunSupported: command.dryRunSupported,
    riskLevel: command.riskLevel,
    permissionRequired: command.permissionRequired,
    capabilityTags: command.capabilityTags || [],
    aliases: command.aliases || [],
    source: command.source,
    hiddenReason: command.hiddenReason || '',
  };
}

export function buildNoeCommandDryRun({ id = '', input = {}, commands = null, includeHidden = false } = {}) {
  const help = buildNoeCommandHelp({ id, commands, includeHidden });
  if (!help.ok) return { ...help, dryRun: true, wouldExecute: false };
  if (help.hiddenReason) {
    return {
      ok: false,
      dryRun: true,
      wouldExecute: false,
      commandId: help.commandId,
      error: 'permission_required_before_dry_run',
      hiddenReason: help.hiddenReason,
      riskLevel: help.riskLevel,
      permissionRequired: true,
    };
  }
  if (help.dryRunSupported === false) {
    return {
      ok: false,
      dryRun: true,
      wouldExecute: false,
      commandId: help.commandId,
      error: 'dry_run_not_supported',
    };
  }
  return {
    ok: true,
    dryRun: true,
    wouldExecute: false,
    commandId: help.commandId,
    title: help.title,
    riskLevel: help.riskLevel,
    permissionRequired: help.permissionRequired,
    inputPreview: redactJsonValue(input),
    inputSchema: help.inputSchema,
    nextStep: help.permissionRequired
      ? 'request permission or validated consensus before execution'
      : 'safe to inspect; execution still requires explicit invoke path',
  };
}

export function findNoeTools({ query = '', commands = null, limit = 8, includeHidden = false } = {}) {
  const surface = commands ? { commands } : buildNoeCommandSurface();
  const list = (surface.commands || []).filter((command) => includeHidden || !command.hiddenReason);
  const scored = list
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((item) => item.score > 0 || !query)
    .sort((a, b) => b.score - a.score || a.command.id.localeCompare(b.command.id));
  return {
    query: clean(query, 400),
    count: Math.min(scored.length, Math.max(0, Number(limit) || 8)),
    results: scored.slice(0, Math.max(0, Number(limit) || 8)).map((item) => item.command),
  };
}
