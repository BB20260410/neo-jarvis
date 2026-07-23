// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { extractClaudeEvidenceRead } from './NoeClaudeEvidenceParser.js';

export { extractClaudeEvidenceRead } from './NoeClaudeEvidenceParser.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const REQUIRED_EFFORT = 'max';
const REQUIRED_MODE_LABEL = 'Claude 4.8 Max';
const DEFAULT_STATE_PATH = join(homedir(), '.noe-panel', 'claude-collaborator', 'state.json');
const DEFAULT_REPORT_DIR = join(process.cwd(), 'output', 'noe-claude-collaborator');
const DENY_CONTEXT_RE = /(^|[/\\])(?:\.env(?:\..*)?|room-adapters\.json|.*cookie.*|.*oauth.*|.*token.*|.*secret.*|.*keychain.*)$/i;
const VALID_MODES = new Set([
  'plan',
  'review',
  'handoff',
  'active-executor-brief',
  'independent-plan',
  'cross-review',
  'synthesis-review',
  'agreement-vote',
]);

export const DEFAULT_CLAUDE_COLLABORATOR_STATE_PATH = DEFAULT_STATE_PATH;
export const DEFAULT_CLAUDE_COLLABORATOR_REPORT_DIR = DEFAULT_REPORT_DIR;
export const REQUIRED_CLAUDE_COLLABORATOR_MODE_LABEL = REQUIRED_MODE_LABEL;

function nowIso() {
  return new Date().toISOString();
}

function sha12(text) {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function cleanText(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').replace(/\r\n/g, '\n')).slice(0, max);
}

function ensureParent(file) {
  mkdirSync(dirname(file), { recursive: true });
}

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function isClaude48Model(value) {
  return /(?:^|[^0-9])4[._-]?8(?:[^0-9]|$)/i.test(String(value || ''));
}

function normalizeClaudeCollaboratorModel(model = '') {
  const value = cleanText(model || DEFAULT_MODEL, 200).trim();
  if (!isClaude48Model(value)) {
    throw new Error(`Claude collaborator requires ${REQUIRED_MODE_LABEL}; refusing model: ${value || '<empty>'}`);
  }
  return value;
}

function normalizeClaudeCollaboratorEffort(effort = REQUIRED_EFFORT) {
  const value = String(effort || REQUIRED_EFFORT).trim().toLowerCase();
  if (value !== REQUIRED_EFFORT) {
    throw new Error(`Claude collaborator requires ${REQUIRED_MODE_LABEL}; refusing effort: ${value || '<empty>'}`);
  }
  return REQUIRED_EFFORT;
}

export function resolveClaudeCollaboratorBin(bin = process.env.CLAUDE_BIN || '') {
  if (bin) return bin;
  try {
    const r = spawnSync('which', ['claude'], { encoding: 'utf8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* ignore */ }
  const fallback = join(homedir(), '.npm-global', 'bin', 'claude');
  return existsSync(fallback) ? fallback : 'claude';
}

export function defaultClaudeCollaboratorState() {
  return {
    version: 1,
    name: 'Noe Claude Development Partner',
    role: 'codex_development_partner_default_non_writer',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    model: DEFAULT_MODEL,
    effort: REQUIRED_EFFORT,
    requiredMode: REQUIRED_MODE_LABEL,
    sessionId: '',
    memory: [],
    runs: [],
  };
}

export function loadClaudeCollaboratorState(statePath = DEFAULT_STATE_PATH) {
  if (!existsSync(statePath)) return defaultClaudeCollaboratorState();
  const parsed = safeJsonParse(readFileSync(statePath, 'utf8'), null);
  if (!parsed || typeof parsed !== 'object') return defaultClaudeCollaboratorState();
  return {
    ...defaultClaudeCollaboratorState(),
    ...parsed,
    model: isClaude48Model(parsed.model) ? parsed.model : DEFAULT_MODEL,
    effort: REQUIRED_EFFORT,
    requiredMode: REQUIRED_MODE_LABEL,
    memory: Array.isArray(parsed.memory) ? parsed.memory : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  };
}

export function saveClaudeCollaboratorState(state, statePath = DEFAULT_STATE_PATH) {
  const next = { ...state, updatedAt: nowIso() };
  ensureParent(statePath);
  const tmp = `${statePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath);
  return next;
}

export function resetClaudeCollaboratorState(statePath = DEFAULT_STATE_PATH) {
  if (existsSync(statePath)) rmSync(statePath, { force: true });
  return defaultClaudeCollaboratorState();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function normalizeMode(mode) {
  const value = String(mode || 'plan').trim() || 'plan';
  if (!VALID_MODES.has(value)) throw new Error(`unsupported claude collaborator mode: ${value}`);
  return value;
}

export function resolveSafeContextFile(file, { rootDir = process.cwd() } = {}) {
  const root = resolve(rootDir);
  const full = resolve(root, file);
  if (full !== root && !isInside(root, full)) throw new Error(`context file outside project root: ${file}`);
  const rel = relative(root, full);
  if (DENY_CONTEXT_RE.test(full) || DENY_CONTEXT_RE.test(rel) || basename(full).startsWith('.env')) {
    throw new Error(`refusing sensitive context file: ${rel || file}`);
  }
  if (!existsSync(full)) throw new Error(`context file not found: ${rel || file}`);
  if (!statSync(full).isFile()) throw new Error(`context path is not a file: ${rel || file}`);
  return { full, rel: rel || basename(full) };
}

export function readClaudeContextFiles(files = [], { rootDir = process.cwd(), maxCharsPerFile = 12_000 } = {}) {
  return files.map((file) => {
    const { full, rel } = resolveSafeContextFile(file, { rootDir });
    const raw = readFileSync(full, 'utf8').slice(0, maxCharsPerFile);
    const redacted = cleanText(raw, maxCharsPerFile);
    return {
      path: rel,
      chars: redacted.length,
      truncated: raw.length >= maxCharsPerFile,
      redacted: redacted !== raw,
      text: redacted,
    };
  });
}

function renderMemory(memory = []) {
  const items = memory.slice(-12);
  if (!items.length) return '- 尚无专属 Claude 协作者记忆。';
  return items.map((m, index) => {
    const summary = cleanText(m.summary || '', 700).replace(/\n+/g, ' ');
    return `${index + 1}. [${m.ts || 'unknown'}] ${m.kind || 'note'}: ${summary}`;
  }).join('\n');
}

function renderContextFiles(contextFiles = []) {
  if (!contextFiles.length) return '无附加文件片段。';
  return contextFiles.map((f) => [
    `### ${f.path}${f.truncated ? ' (truncated)' : ''}${f.redacted ? ' (redacted)' : ''}`,
    '```text',
    f.text,
    '```',
  ].join('\n')).join('\n\n');
}

function renderSharedEvidence(sharedEvidence = []) {
  if (!Array.isArray(sharedEvidence) || !sharedEvidence.length) return '无显式 shared evidence 列表；如有上下文文件，请在 evidence_read 标注 direct-read。';
  return sharedEvidence.map((item) => {
    const object = item && typeof item === 'object' ? item : { ref: item };
    const ref = cleanText(object.ref || object.path || object.id || '', 600).replace(/\n+/g, ' ');
    const kind = cleanText(object.kind || 'file', 80);
    const notes = cleanText(object.notes || object.note || '', 600).replace(/\n+/g, ' ');
    return `- ${ref} (${kind})${notes ? ` - ${notes}` : ''}`;
  }).filter((line) => line !== '-  (file)').join('\n') || '无有效 shared evidence。';
}

export function buildClaudeCollaboratorPrompt({
  task,
  state,
  contextFiles = [],
  sharedEvidence = [],
  model = DEFAULT_MODEL,
  effort = REQUIRED_EFFORT,
  rootDir = process.cwd(),
  mode = 'plan',
} = {}) {
  const cleanTask = cleanText(task, 8000).trim();
  if (!cleanTask) throw new Error('task required');
  const normalizedMode = normalizeMode(mode);
  return `你是 Neo / Noe Jarvis 项目里专门配合 Codex 共同开发的 Claude 协作者。

你的身份:
- 名称: Noe Claude Development Partner。
- 默认角色: plan/review/research/handoff partner，和 Codex 协同开发 Neo，但默认不是 writer，不直接改文件。
- 强制运行要求: ${REQUIRED_MODE_LABEL}；本轮请求 model=${model}，effort=${effort}。
- Codex 是默认 integrator/writer。只有 owner 明确写 activeExecutor: "claude" 时，你才可被视为唯一 writer；否则你负责提出方案、指出风险、审查 diff、维护交接记忆。
- 你有持久上下文: Claude CLI session_id + 下方显式 memory。请利用它保持连续性，但不要把隐藏上下文当作不可审计事实。

硬边界:
- 不要要求读取、打印、复制或总结 .env、API key、token、cookie、OAuth、owner token 或 room-adapters secret。
- 不要触碰 51735，不要触碰 games/cartoon-apocalypse/**。
- 不要要求 commit/push/reset/clean。
- 不要给模型/agent/multi-model 调用设置人为硬超时。
- 不要伪造执行、搜索、投票或验证。
- 不要把自己当成已完成真实执行；你的输出是给 Codex 复核和落地的研究材料。

项目根:
${rootDir}

协作模式:
${normalizedMode}

shared evidence refs:
${renderSharedEvidence(sharedEvidence)}

模式要求:
- independent-plan: 先不迎合 Codex，给出 Claude 独立方案。
- independent-plan: 必须列出你直接读取的 shared evidence refs；如果只看到 Codex 摘要，要明确标为 summary-only，不可当作已验证事实。
- cross-review: 审查 Codex 方案，指出可采纳点、风险、缺失验证和需要说服的分歧；对关键事实给出 confirmed/refuted/unresolved。
- synthesis-review: 审查综合方案是否吸收双方优点，是否可以进入执行；若仍有 unresolved 事实，不得同意执行。
- agreement-vote: 明确给出 agree/revise/reject；只有真正可执行、可验证、可回滚，且共享证据已读、争议已处理，才 agree。
- active-executor-brief: 只生成切换 Claude 为唯一 activeExecutor 前的交接材料，不等于授权写文件。

你的持久记忆:
${renderMemory(state?.memory || [])}

本轮任务:
${cleanTask}

附加上下文文件片段:
${renderContextFiles(contextFiles)}

请输出中文，结构固定:
1. 结论
2. evidence_read: 逐条列 ref / mode(direct-read|truncated|summary-only) / note
3. 风险/硬边界
4. 给 Codex 的可执行开发/审查建议
5. challenge_log: 如有争议事实，逐条写 claim / decision(confirmed|refuted|unresolved) / evidence_ref
6. memory_update: 用一句话记录你下轮应继续记住的事实`;
}

function buildArgs({ state, model, effort = REQUIRED_EFFORT, resume = true } = {}) {
  const args = [
    '--print',
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--tools', '',
  ];
  if (model) args.push('--model', model);
  args.push('--effort', normalizeClaudeCollaboratorEffort(effort));
  if (resume && state?.sessionId) args.push('--resume', state.sessionId);
  return args;
}

function defaultRunner({ bin, args, prompt, cwd, env }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => reject(new Error(`Claude collaborator spawn failed: ${e.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr, code });
      else reject(new Error(`Claude collaborator exit code=${code} stderr=${stderr.slice(0, 600)}`));
    });
    child.stdin.write(prompt, (err) => {
      if (err) reject(new Error(`Claude collaborator stdin failed: ${err.message}`));
      try { child.stdin.end(); } catch { /* ignore */ }
    });
  });
}

function extractMemoryUpdate(resultText) {
  const match = String(resultText || '').match(/memory_update\s*[:：]\s*([\s\S]{1,800})/i);
  const text = match ? match[1] : resultText;
  return cleanText(text, 700).replace(/\n+/g, ' ').trim();
}

function writeReport({ reportDir, task, resultText, parsed, evidenceRead = [], requestedModel = DEFAULT_MODEL, requestedEffort = REQUIRED_EFFORT }) {
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(reportDir, `${stamp}-${sha12(task)}.md`);
  const body = [
    '# Noe Claude Collaborator Report',
    '',
    `- generatedAt: ${nowIso()}`,
    `- sessionId: ${parsed?.session_id || ''}`,
    `- requiredMode: ${REQUIRED_MODE_LABEL}`,
    `- requestedModel: ${requestedModel}`,
    `- requestedEffort: ${requestedEffort}`,
    `- model: ${Object.keys(parsed?.modelUsage || {})[0] || ''}`,
    `- costUSD: ${parsed?.total_cost_usd ?? ''}`,
    '',
    '## Task',
    '',
    cleanText(task, 3000),
    '',
    '## Result',
    '',
    cleanText(resultText, 40_000),
    '',
    '## Parsed Evidence Read',
    '',
    ...(evidenceRead.length ? evidenceRead.map((item) => `- ${item.ref} (${item.mode})`) : ['none']),
    '',
  ].join('\n');
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

export async function askClaudeCollaborator({
  task,
  context = [],
  extraContextBlocks = [],
  sharedEvidence = [],
  statePath = DEFAULT_STATE_PATH,
  reportDir = DEFAULT_REPORT_DIR,
  rootDir = process.cwd(),
  model = '',
  effort = REQUIRED_EFFORT,
  bin = '',
  dryRun = false,
  runner = defaultRunner,
  resume = true,
  env = {},
  mode = 'plan',
} = {}) {
  const state = loadClaudeCollaboratorState(statePath);
  const effectiveModel = normalizeClaudeCollaboratorModel(model || state.model || DEFAULT_MODEL);
  const effectiveEffort = normalizeClaudeCollaboratorEffort(effort || state.effort || REQUIRED_EFFORT);
  const normalizedMode = normalizeMode(mode);
  const contextFiles = [
    ...readClaudeContextFiles(context, { rootDir }),
    ...extraContextBlocks.map((block) => ({
      path: block.path || block.name || 'inline-context',
      chars: cleanText(block.text || '', 60_000).length,
      truncated: Boolean(block.truncated),
      redacted: Boolean(block.redacted),
      text: cleanText(block.text || '', 60_000),
    })),
  ];
  const prompt = buildClaudeCollaboratorPrompt({ task, state, contextFiles, sharedEvidence, model: effectiveModel, effort: effectiveEffort, rootDir, mode: normalizedMode });
  const args = buildArgs({ state, model: effectiveModel, effort: effectiveEffort, resume });
  const runMeta = {
    ts: nowIso(),
    id: `claude-collab-${randomUUID()}`,
    taskHash: sha12(task),
    context: contextFiles.map((f) => ({ path: f.path, chars: f.chars, truncated: f.truncated, redacted: f.redacted })),
    sharedEvidence: Array.isArray(sharedEvidence) ? sharedEvidence.map((item) => cleanText(item?.ref || item?.path || item, 600)).filter(Boolean) : [],
    model: effectiveModel,
    effort: effectiveEffort,
    requiredMode: REQUIRED_MODE_LABEL,
    mode: normalizedMode,
    resumed: Boolean(resume && state.sessionId),
  };
  if (dryRun) return { ok: true, dryRun: true, args, prompt, state, run: runMeta };

  const raw = await runner({
    bin: resolveClaudeCollaboratorBin(bin),
    args,
    prompt,
    cwd: rootDir,
    env,
    state,
  });
  const parsed = typeof raw === 'string' ? safeJsonParse(raw, {}) : safeJsonParse(raw.stdout || '', {});
  const resultText = cleanText(parsed?.result || raw.stdout || '', 40_000);
  const sessionId = parsed?.session_id || state.sessionId || '';
  const evidenceRead = extractClaudeEvidenceRead(resultText);
  const reportPath = writeReport({ reportDir, task, resultText, parsed, evidenceRead, requestedModel: effectiveModel, requestedEffort: effectiveEffort });
  const memoryUpdate = extractMemoryUpdate(resultText) || `Claude reviewed task ${runMeta.taskHash}.`;
  const nextState = {
    ...state,
    model: effectiveModel,
    effort: effectiveEffort,
    requiredMode: REQUIRED_MODE_LABEL,
    sessionId,
    memory: [
      ...state.memory,
      { ts: nowIso(), kind: 'claude_report', summary: memoryUpdate, reportPath: relative(rootDir, reportPath) },
    ].slice(-40),
    runs: [
      { ...runMeta, sessionId, reportPath: relative(rootDir, reportPath), evidenceRead, costUSD: parsed?.total_cost_usd ?? null },
      ...state.runs,
    ].slice(0, 30),
  };
  saveClaudeCollaboratorState(nextState, statePath);
  return {
    ok: true,
    result: resultText,
    sessionId,
    reportPath,
    statePath,
    model: effectiveModel,
    effort: effectiveEffort,
    requiredMode: REQUIRED_MODE_LABEL,
    costUSD: parsed?.total_cost_usd ?? null,
    evidenceRead,
    args,
  };
}

export function claudeCollaboratorStatus({ statePath = DEFAULT_STATE_PATH } = {}) {
  const state = loadClaudeCollaboratorState(statePath);
  return {
    ok: true,
    statePath,
    name: state.name,
    role: state.role,
    model: state.model,
    effort: state.effort || REQUIRED_EFFORT,
    requiredMode: state.requiredMode || REQUIRED_MODE_LABEL,
    hasSession: Boolean(state.sessionId),
    sessionId: state.sessionId || '',
    memoryCount: state.memory.length,
    runCount: state.runs.length,
    updatedAt: state.updatedAt,
    lastRun: state.runs[0] || null,
  };
}
