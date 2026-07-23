// MiniMaxSpawnAdapter — CE12 P0 patch-only local CLI adapter.
// It is intentionally not a general execution adapter. MiniMax M3 can provide
// Chinese-side review and patch plans, but shell/file/apply_patch capability is
// fail-closed here.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RoomAdapter, normalizeNativeCapabilities } from './RoomAdapter.js';
import { M3_SUGGESTION_ACTIONS, validateM3SuggestionPlan } from './MiniMaxSuggestionRouter.js';

const SAFE_ACTIONS = new Set(['session_new', 'messages', 'diff', ...M3_SUGGESTION_ACTIONS]);
const BLOCKED_ACTIONS = new Set(['shell', 'shell.exec', 'bash', 'zsh', 'read', 'file.read', 'write', 'file.write', 'delete', 'file.delete', 'move', 'file.move', 'apply_patch', 'patch.apply', 'tool_calls']);

function str(value, max = 1000) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = str(value, 2000);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function resolveMiniMaxCli({ env = process.env, homeDir = homedir() } = {}) {
  const which = (() => {
    try {
      const result = spawnSync('which', ['minimax'], { encoding: 'utf8', env, timeout: 3000 });
      return result.status === 0 ? result.stdout.trim() : '';
    } catch {
      return '';
    }
  })();
  const appCli = '/Applications/MiniMax Code.app/Contents/Resources/app/cli.js';
  const candidates = unique([
    env.MINIMAX_BIN,
    which,
    join(homeDir, '.mavis', 'bin', 'minimax'),
    appCli,
  ]);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function extractJson(text) {
  const raw = str(text, 200_000);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch {}
  }
  return null;
}

export function extractSessionId(value) {
  const parsed = value && typeof value === 'object' ? value : extractJson(value);
  const candidates = [
    parsed?.id,
    parsed?.sessionId,
    parsed?.session_id,
    parsed?.session?.id,
    parsed?.session?.sessionId,
    parsed?.data?.id,
    parsed?.data?.sessionId,
    parsed?.data?.session_id,
  ];
  for (const candidate of candidates) {
    const text = str(candidate, 200);
    if (text) return text;
  }
  const raw = str(typeof value === 'string' ? value : JSON.stringify(value || {}), 20_000);
  const mavisMatch = raw.match(/\b(mvs_[A-Za-z0-9_-]{8,})\b/);
  if (mavisMatch) return mavisMatch[1];
  return '';
}

export function normalizeSessionDiffs(value) {
  if (Array.isArray(value)) return value;
  const parsed = value && typeof value === 'object' ? value : extractJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.diffs)) return parsed.diffs;
  if (Array.isArray(parsed?.files)) return parsed.files;
  if (Array.isArray(parsed?.changes)) return parsed.changes;
  const raw = str(typeof value === 'string' ? value : JSON.stringify(value || {}), 20_000);
  if (!raw || raw === '[]' || /^no (file )?(changes|diffs)/i.test(raw)) return [];
  return [{ raw: raw.slice(0, 2000) }];
}

export function proposalFromMessagesOutput(value) {
  const parsed = value && typeof value === 'object' ? value : extractJson(value);
  const rows = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.messages) ? parsed.messages
      : Array.isArray(parsed?.items) ? parsed.items
        : Array.isArray(parsed?.data) ? parsed.data
          : []);
  if (rows.length > 0) {
    for (const message of [...rows].reverse()) {
      const role = str(message?.role || message?.author || message?.sender, 80).toLowerCase();
      const content = typeof message?.content === 'string'
        ? message.content
        : typeof message?.text === 'string'
          ? message.text
          : typeof message?.message === 'string'
            ? message.message
            : '';
      if (content && /assistant|agent|minimax|m3/.test(role)) return str(content, 20_000);
    }
    return '';
  }
  for (const message of [...rows].reverse()) {
    const role = str(message?.role || message?.author || message?.sender, 80).toLowerCase();
    const content = typeof message?.content === 'string'
      ? message.content
      : typeof message?.text === 'string'
        ? message.text
        : typeof message?.message === 'string'
          ? message.message
          : '';
    if (content && (!role || /assistant|agent|minimax|m3/.test(role))) return str(content, 20_000);
  }
  return str(typeof value === 'string' ? value : JSON.stringify(value || {}), 20_000);
}

export function validatePatchOnlyPlan(planInput = {}) {
  const plan = planInput && typeof planInput === 'object' ? planInput : {};
  const actions = Array.isArray(plan.actions) ? plan.actions.map((item) => str(item, 80)).filter(Boolean) : [];
  const diffs = Array.isArray(plan.diffs) ? plan.diffs : [];
  const text = JSON.stringify(plan).toLowerCase();
  const blocked = actions.filter((action) => BLOCKED_ACTIONS.has(action) || !SAFE_ACTIONS.has(action));
  if (blocked.length > 0) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: `MiniMaxSpawnAdapter blocks non patch-only actions: ${blocked.join(', ')}`,
      diffs,
      actions,
    };
  }
  const suggestionValidation = validateM3SuggestionPlan(plan);
  if (!suggestionValidation.ok) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: suggestionValidation.error,
      diffs,
      actions,
    };
  }
  if (hasForbiddenIntent(text)) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: 'MiniMaxSpawnAdapter detected shell/write/delete/move/apply_patch intent',
      diffs,
      actions,
    };
  }
  if (diffs.length !== 0) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: 'MiniMaxSpawnAdapter accepts only diffs=[] in CE12 P0',
      diffs,
      actions,
    };
  }
  return {
    ok: true,
    status: 'proposal_saved',
    actions: actions.length ? actions : ['session_new', 'messages', 'diff'],
    diffs: [],
    proposal: str(plan.proposal || plan.reply || plan.summary || '', 20_000),
    raw: plan,
  };
}

function hasForbiddenIntent(text = '') {
  const raw = String(text || '');
  if (!raw) return false;
  if (/(rm\s+-rf|curl\s+-t|network\.upload|writefile|write_file|unlink)/i.test(raw)) return true;
  if (/\b(run|execute|spawn|invoke|call)\s+(a\s+)?(shell|command|cmd|apply_patch|patch)/i.test(raw)) return true;
  if (/\b(write|delete|move)\s+(file|files|workspace|project|repo|directory|directories)/i.test(raw)) return true;

  const negated = /(do not|don't|never|not allowed|forbidden|blocked|block|fail-closed|禁止|不得|不允许|不能|不要|只允许)/i;
  for (const line of raw.split(/\\n|[。；;]/)) {
    if (!/(apply_patch|shell\\.exec|file\\.write|file\\.delete|file\\.move|patch\\.apply|\\bexec\\b|\\bspawn\\b|\\bmv\\s+)/i.test(line)) continue;
    if (negated.test(line)) continue;
    return true;
  }
  return false;
}

function buildPrompt(messages = []) {
  const rows = [
    '你是 MiniMax M3 建议员，不是执行员。',
    '你只能基于调用方提供的文本提出优化意见、风险、缺口和 patch 建议。',
    '禁止读取本地文件、运行 shell、write/delete/move/apply_patch、外发数据或请求 secret。',
    'JSON schema: {"actions":["suggestions"],"diffs":[],"suggestions":[],"risk_notes":[],"product_gaps":[],"evidence_gaps":[],"patch_suggestions":[],"do_not_block_reason":"","final_authority":"Claude/GPT-Codex"}',
    '如果需要真实文件修改，只能把建议写进 patch_suggestions，diffs 必须是空数组。',
    '',
  ];
  for (const message of messages) {
    rows.push(`[${message.role || 'user'}${message.speaker ? `:${message.speaker}` : ''}]`);
    rows.push(str(message.content, 120_000));
    rows.push('');
  }
  return rows.join('\n');
}

export class MiniMaxSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: opts.id || 'minimax-spawn',
      displayName: opts.displayName || '🟡 MiniMax M3 Patch',
      model: opts.model || 'MiniMax-M3',
      timeout: Object.prototype.hasOwnProperty.call(opts, 'timeout') ? opts.timeout : 0,
    });
    this.bin = opts.bin || resolveMiniMaxCli();
    this.agent = opts.agent || process.env.MINIMAX_PATCH_AGENT || 'neo-m3-patch';
    this.runner = typeof opts.runner === 'function' ? opts.runner : null;
  }

  getNativeCapabilities() {
    return normalizeNativeCapabilities({
      providerId: this.id,
      displayName: this.displayName,
      runtime: 'MiniMax suggestion-only adapter',
      nativeRuntime: true,
      accountScoped: true,
      userConfigured: true,
      toolUse: false,
      skills: ['优化建议', '风险提示', 'P0/P1 缺口扫描', '中文产品体验审计', 'patch suggestion'],
      tools: ['API-only prompt by default', 'Mavis/OpenCode local executor disabled'],
      notes: ['M3 is suggestion-only. It cannot execute, read local files, mutate files, or sign off final delivery.'],
    });
  }

  async _doChat(messages, opts = {}) {
    const prompt = buildPrompt(messages);
    if (!this.runner && this.bin) {
      const plan = {
        actions: ['suggestions'],
        diffs: [],
        suggestions: ['Mavis/OpenCode local executor is disabled. Use M3 through API-only selected-context suggestion review.'],
        risk_notes: ['Current Mavis permissionMode can bypass deny rules, so local executor is unsafe without sandbox/tool allowlist/watchdog.'],
        product_gaps: [],
        evidence_gaps: [],
        patch_suggestions: [],
        do_not_block_reason: 'M3 suggestion-only output is advisory and must not block Claude/GPT-Codex main chain.',
        final_authority: 'Claude/GPT-Codex',
      };
      return {
        reply: plan.suggestions[0],
        tokensIn: 0,
        tokensOut: 0,
        raw: { plan },
        ok: true,
        status: 'suggestions_saved',
      };
    }
    const raw = this.runner
      ? await this.runner({ prompt, messages, opts, adapter: this })
      : JSON.stringify({
        actions: ['suggestions'],
        diffs: [],
        proposal: 'MiniMax local executor not found; local executor is disabled, provide selected context through the API-only suggestion pipeline.',
      });
    const plan = extractJson(raw);
    if (!plan) {
      return {
        reply: '',
        tokensIn: 0,
        tokensOut: 0,
        raw: { output: raw },
        ok: false,
        status: 'blocked_safety',
        error: 'MiniMaxSpawnAdapter requires parseable JSON patch-only plan',
      };
    }
    const validation = validatePatchOnlyPlan(plan);
    return {
      reply: validation.ok ? validation.proposal : '',
      tokensIn: 0,
      tokensOut: 0,
      ok: validation.ok,
      status: validation.status,
      error: validation.error || null,
      raw: { output: raw, plan, validation },
    };
  }

}
