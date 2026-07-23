// CrossVerifyDispatcher — 集群协同模式(旧 mode id: cross_verify,为兼容历史数据保留)
//
// 与 squad(单向 PM→Dev→QA 层级)的根本区别:
//   - squad: 角色不对等,Dev 写 QA 审,QA 单方面判 pass/reject
//   - cross_verify: 多个成员**完全对等**,每个 task 各自写一版 → 集体互审 → **所有成员都明说"我同意"** 才算一致
//
// 用户选 A 方案:显式签字(both.agree=true)才进入下一 task,防止单方面强推。
// 防死循环:最多 N 轮,超过自动 escalated 等用户裁定。
//
// 模式名仍为 'cross_verify',默认成员可为 2+ 个,无角色字段(role 可空)。

import { PROMPT_VERSIONS } from './squad-limits.js';
import { injectSkillsToMessages, buildRoomAgentContext } from './skillInjector.js';
import { summarizeAgentRuntimeContext } from '../agents/AgentSkillRegistry.js';
import { isIncompleteChatResult, truncationFinishReason, markTruncatedReply } from './chatTruncation.js';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, relative } from 'node:path';

const AUTO_VERIFIABLE_CLUSTER_STAGE_IDS = new Set([
  'implementation',
  'unit_test',
  'integration_test',
  'functional_validation'
]);

const AUTO_VERIFICATION_MAX_COMMANDS_PER_STAGE = 2;
const AUTO_VERIFICATION_TIMEOUT_MS = 15_000;

function isInsideWorkspacePath(cwd, target) {
  if (!cwd || !target) return false;
  try {
    const rel = relative(resolve(cwd), resolve(target));
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function stripPathToken(value) {
  return String(value || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[，。；;,、)\]}]+$/g, '')
    .trim();
}

function pathLeaf(value) {
  const parts = normalize(String(value || '')).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function findWorkspaceMirrorPath(cwd, externalPath) {
  if (!cwd || !externalPath) return null;
  const parts = normalize(String(externalPath || '')).split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidateRoot = resolve(cwd, parts[i]);
    try {
      if (existsSync(candidateRoot) && statSync(candidateRoot).isDirectory()) {
        return resolve(candidateRoot, ...parts.slice(i + 1));
      }
    } catch {}
  }
  const leaf = pathLeaf(externalPath);
  if (!leaf) return null;
  const fallback = resolve(cwd, leaf);
  return existsSync(fallback) ? fallback : null;
}

function extractWorkspacePathCandidates(text) {
  const source = String(text || '');
  const candidates = [];
  const rawMatches = source.match(/\/(?:Users|Volumes|private|var|tmp)\/[^\n`"'<>|]+/g) || [];
  for (const raw of rawMatches) {
    const cleaned = stripPathToken(raw);
    if (cleaned && isAbsolute(cleaned)) candidates.push(cleaned);
  }
  let currentCd = '';
  for (const line of source.split(/\r?\n/)) {
    const cdMatch = /^\s*cd\s+(.+?)\s*$/.exec(line);
    if (cdMatch) {
      const nextCd = stripPathToken(cdMatch[1]);
      if (nextCd && isAbsolute(nextCd)) currentCd = nextCd;
      continue;
    }
    const cloneMatch = /\bgit\s+clone\s+\S+(?:\s+([^\s`"']+))?/i.exec(line);
    if (cloneMatch && currentCd) {
      const dest = stripPathToken(cloneMatch[1] || '');
      if (dest && !isAbsolute(dest)) candidates.push(resolve(currentCd, dest));
    }
  }
  return [...new Set(candidates)];
}

function buildWorkspacePathContract(room, userPrompt) {
  const cwd = room?.cwd ? resolve(room.cwd) : '';
  if (!cwd) return { prompt: String(userPrompt || ''), text: '', aliases: [] };
  const source = `${room?.topic || ''}\n${userPrompt || ''}`;
  const externalPaths = extractWorkspacePathCandidates(source)
    .map((item) => resolve(item))
    .filter((item) => !isInsideWorkspacePath(cwd, item));
  const aliases = [];
  for (const externalPath of externalPaths) {
    const workspaceMirror = findWorkspaceMirrorPath(cwd, externalPath);
    if (!workspaceMirror) continue;
    if (!isInsideWorkspacePath(cwd, workspaceMirror)) continue;
    if (existsSync(workspaceMirror)) aliases.push({ from: externalPath, to: workspaceMirror });
  }
  const uniqueAliases = [];
  const aliasKeys = new Set();
  for (const alias of aliases) {
    const key = `${alias.from}\n${alias.to}`;
    if (aliasKeys.has(key)) continue;
    aliasKeys.add(key);
    uniqueAliases.push(alias);
  }
  let prompt = String(userPrompt || '');
  for (const alias of uniqueAliases) {
    prompt = prompt.split(alias.from).join(alias.to);
  }
  const externalWithoutMirror = externalPaths
    .filter((externalPath) => !uniqueAliases.some((alias) => alias.from === externalPath))
    .slice(0, 12);
  const lines = [
    '# 集群工作区路径契约',
    `- 房间唯一可执行工作区: ${cwd}`,
    '- 对 Gemini CLI 等带 workspace guard 的成员,文件读取/写入/审计必须使用工作区内路径。',
    '- 这不是权限收紧;这是跨模型可执行路径归一化,避免某个成员因 cwd 外路径被工具层拒绝。',
  ];
  if (uniqueAliases.length) {
    lines.push('- 已识别到 cwd 外路径的工作区镜像,本轮必须使用右侧 canonical path:');
    uniqueAliases.forEach((alias) => lines.push(`  - ${alias.from} -> ${alias.to}`));
    lines.push('- 如果旧任务文字要求在 cwd 外 clone/read 同名目录,视为历史路径;直接使用上面的 canonical path。');
  }
  if (externalWithoutMirror.length) {
    lines.push('- 以下 cwd 外路径仅作为边界/参考;不要作为工具读写目标,除非先在工作区内建立副本或镜像:');
    externalWithoutMirror.forEach((item) => lines.push(`  - ${item}`));
  }
  return { prompt, text: lines.join('\n'), aliases: uniqueAliases };
}

function parseSafeNodeCheckCommand(command) {
  const trimmed = String(command || '').trim();
  const match = /^node\s+--check\s+(.+)$/i.exec(trimmed);
  if (!match) return null;
  let target = match[1].trim();
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  if (!target || target.startsWith('-')) return null;
  if (isAbsolute(target)) return null;
  if (/[;&|`$<>*?[\]{}()]/.test(target)) return null;
  const normalized = normalize(target);
  if (normalized === '.' || normalized.startsWith('..')) return null;
  return { command: `node --check ${normalized}`, relativePath: normalized };
}

function collectSafeStageVerificationCommands(stageArtifact) {
  const seen = new Set();
  const commands = [];
  const evidenceItems = Array.isArray(stageArtifact?.evidence) ? stageArtifact.evidence : [];
  for (const evidence of evidenceItems) {
    const rawCommands = Array.isArray(evidence?.commands) ? evidence.commands : [];
    for (const rawCommand of rawCommands) {
      const parsed = parseSafeNodeCheckCommand(rawCommand);
      if (!parsed || seen.has(parsed.command)) continue;
      seen.add(parsed.command);
      commands.push(parsed);
      if (commands.length >= AUTO_VERIFICATION_MAX_COMMANDS_PER_STAGE) return commands;
    }
  }
  return commands;
}

function runNodeSyntaxCheck({ cwd, relativePath }) {
  return new Promise((resolveCheck) => {
    const absolutePath = resolve(cwd, relativePath);
    const relativeToCwd = relative(cwd, absolutePath);
    if (!relativeToCwd || relativeToCwd.startsWith('..') || isAbsolute(relativeToCwd)) {
      resolveCheck({
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: 'path escapes room cwd'
      });
      return;
    }
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      resolveCheck({
        status: 'failed',
        exitCode: null,
        stdout: '',
        stderr: 'file does not exist'
      });
      return;
    }

    const child = spawn(process.execPath, ['--check', absolutePath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolveCheck({
        status: 'failed',
        exitCode: null,
        stdout,
        stderr: `${stderr}\nnode --check timed out`.trim()
      });
    }, AUTO_VERIFICATION_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCheck({
        status: 'failed',
        exitCode: null,
        stdout,
        stderr: error?.message || 'failed to start node --check'
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCheck({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}

const MAX_ROUNDS = 3;
const MAX_QUALITY_GATE_REPAIRS = 1;
const MAX_ACCEPTANCE_AUTO_REMEDIATIONS = 5;
const CLUSTER_RUNTIME_WARN_CALLS = 220;
const CLUSTER_RUNTIME_BLOCK_CALLS = 360;
const CLUSTER_RUNTIME_WARN_TOKENS = 700_000;
const CLUSTER_RUNTIME_BLOCK_TOKENS = 1_200_000;
const CLUSTER_RUNTIME_WARN_AVG_LATENCY_MS = 45_000;
const CLUSTER_RUNTIME_BLOCK_AVG_LATENCY_MS = 90_000;

export function clusterMemberCallTimeoutMs(overrideMs = null) {
  const override = Number(overrideMs);
  if (Number.isFinite(override) && Number.isInteger(override) && override >= 1) return override;
  const n = Number(process.env.PANEL_CLUSTER_MEMBER_CALL_TIMEOUT_MS);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 0;
  return n;
}

function makeClusterAbortError() {
  const error = new Error('aborted');
  error.code = 'cluster_member_call_aborted';
  return error;
}

function makeClusterMemberCallTimeoutError(member, timeoutMs) {
  const error = new Error(`cluster_member_call_timeout:${member?.adapterId || 'unknown'}:${timeoutMs}ms`);
  error.code = 'cluster_member_call_timeout';
  error.timeoutMs = timeoutMs;
  return error;
}

const CODE_DRIVEN_STAGE_EVIDENCE = {
  implementation: ['filesystem_evidence', 'command_evidence'],
  unit_test: ['command_evidence'],
  integration_test: ['command_evidence', 'runtime_or_ui_evidence'],
  functional_validation: ['command_evidence', 'runtime_or_ui_evidence'],
};
const GOAL_MODE_CODE_REWORK_STAGE_IDS = Object.keys(CODE_DRIVEN_STAGE_EVIDENCE);

function emptyClusterRuntimeTelemetry() {
  return {
    telemetryVersion: 'cluster-runtime-telemetry-v1',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    calls: 0,
    succeededCalls: 0,
    failedCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    avgLatencyMs: 0,
    byAdapter: {},
    latest: null,
  };
}

function addClusterRuntimeMetric(prev = {}, metric = {}) {
  const next = {
    ...emptyClusterRuntimeTelemetry(),
    ...prev,
    byAdapter: { ...(prev.byAdapter || {}) },
  };
  const adapterId = String(metric.adapterId || 'unknown');
  const tokensIn = Math.max(0, Number(metric.tokensIn) || 0);
  const tokensOut = Math.max(0, Number(metric.tokensOut) || 0);
  const latencyMs = Math.max(0, Number(metric.latencyMs) || 0);
  const succeeded = metric.status !== 'failed';
  next.updatedAt = new Date().toISOString();
  next.calls = Math.max(0, Number(next.calls) || 0) + 1;
  next.succeededCalls = Math.max(0, Number(next.succeededCalls) || 0) + (succeeded ? 1 : 0);
  next.failedCalls = Math.max(0, Number(next.failedCalls) || 0) + (succeeded ? 0 : 1);
  next.tokensIn = Math.max(0, Number(next.tokensIn) || 0) + tokensIn;
  next.tokensOut = Math.max(0, Number(next.tokensOut) || 0) + tokensOut;
  next.totalTokens = next.tokensIn + next.tokensOut;
  next.totalLatencyMs = Math.max(0, Number(next.totalLatencyMs) || 0) + latencyMs;
  next.maxLatencyMs = Math.max(Math.max(0, Number(next.maxLatencyMs) || 0), latencyMs);
  next.avgLatencyMs = next.calls ? Math.round(next.totalLatencyMs / next.calls) : 0;
  const adapter = {
    calls: 0,
    succeededCalls: 0,
    failedCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    avgLatencyMs: 0,
    ...(next.byAdapter[adapterId] || {}),
  };
  adapter.calls += 1;
  adapter.succeededCalls += succeeded ? 1 : 0;
  adapter.failedCalls += succeeded ? 0 : 1;
  adapter.tokensIn += tokensIn;
  adapter.tokensOut += tokensOut;
  adapter.totalTokens = adapter.tokensIn + adapter.tokensOut;
  adapter.totalLatencyMs += latencyMs;
  adapter.maxLatencyMs = Math.max(adapter.maxLatencyMs, latencyMs);
  adapter.avgLatencyMs = adapter.calls ? Math.round(adapter.totalLatencyMs / adapter.calls) : 0;
  next.byAdapter[adapterId] = adapter;
  next.latest = {
    at: next.updatedAt,
    adapterId,
    model: metric.model || '',
    taskId: metric.taskId || '',
    turn: metric.turn || '',
    status: metric.status || 'succeeded',
    latencyMs,
    tokensIn,
    tokensOut,
    totalTokens: tokensIn + tokensOut,
    agentRunId: metric.agentRunId || null,
    error: metric.error || null,
  };
  return next;
}

function buildClusterRuntimeBudgetStatus(telemetry = {}, limits = {}) {
  const warnCalls = Math.max(1, Number(limits.warnCalls) || CLUSTER_RUNTIME_WARN_CALLS);
  const blockCalls = Math.max(warnCalls + 1, Number(limits.blockCalls) || CLUSTER_RUNTIME_BLOCK_CALLS);
  const warnTokens = Math.max(1, Number(limits.warnTokens) || CLUSTER_RUNTIME_WARN_TOKENS);
  const blockTokens = Math.max(warnTokens + 1, Number(limits.blockTokens) || CLUSTER_RUNTIME_BLOCK_TOKENS);
  const warnAvgLatencyMs = Math.max(1, Number(limits.warnAvgLatencyMs) || CLUSTER_RUNTIME_WARN_AVG_LATENCY_MS);
  const blockAvgLatencyMs = Math.max(warnAvgLatencyMs + 1, Number(limits.blockAvgLatencyMs) || CLUSTER_RUNTIME_BLOCK_AVG_LATENCY_MS);
  const calls = Math.max(0, Number(telemetry.calls) || 0);
  const totalTokens = Math.max(0, Number(telemetry.totalTokens) || 0);
  const avgLatencyMs = Math.max(0, Number(telemetry.avgLatencyMs) || 0);
  const blockers = [
    calls > blockCalls ? `calls_gt_${blockCalls}` : '',
    totalTokens > blockTokens ? `tokens_gt_${blockTokens}` : '',
    avgLatencyMs > blockAvgLatencyMs ? `avg_latency_gt_${blockAvgLatencyMs}` : '',
  ].filter(Boolean);
  const warnings = [
    calls > warnCalls ? `calls_gt_${warnCalls}` : '',
    totalTokens > warnTokens ? `tokens_gt_${warnTokens}` : '',
    avgLatencyMs > warnAvgLatencyMs ? `avg_latency_gt_${warnAvgLatencyMs}` : '',
  ].filter(Boolean);
  return {
    statusVersion: 'cluster-runtime-budget-status-v1',
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    calls,
    totalTokens,
    avgLatencyMs,
    thresholds: {
      warnCalls,
      blockCalls,
      warnTokens,
      blockTokens,
      warnAvgLatencyMs,
      blockAvgLatencyMs,
    },
    warnings,
    blockers,
    updatedAt: new Date().toISOString(),
  };
}

function isVerifiableAgentToolResult(item = {}) {
  const status = String(item?.status || '').trim().toLowerCase();
  if (!status) return true;
  return !/(failed|error|blocked|denied|approval_required|cancelled|canceled|timeout)/i.test(status);
}

function clusterEvidenceLinkEvidenceCount(link = {}) {
  const explicit = Number(link?.evidenceCount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(0, Number(link?.toolResultCount) || 0)
    + Math.max(0, Number(link?.archiveCount) || 0)
    + Math.max(0, Number(link?.artifactCount) || 0);
}

function isVerifiableClusterEvidenceLink(link = {}) {
  if (link?.verified !== true || !link?.stageId) return false;
  const runStatus = String(link?.runStatus || '').trim().toLowerCase();
  if (runStatus && runStatus !== 'succeeded') return false;
  return clusterEvidenceLinkEvidenceCount(link) > 0;
}

export const CLUSTER_ENGINEERING_STAGES = [
  {
    id: 'idea',
    label: '用户想法',
    goal: '把用户原始想法转成明确项目目标、边界、约束和不可做事项。',
    deliverable: '目标说明、范围边界、成功标准、风险假设。',
    gate: '任何成员都能复述同一个目标,且没有明显范围漂移。',
  },
  {
    id: 'requirements',
    label: '需求分析与拆解',
    goal: '拆出用户需求、功能需求、非功能需求、验收条件和优先级。',
    deliverable: '需求清单、验收标准、依赖关系、缺口问题。',
    gate: '每条需求都有可验证验收口径。',
  },
  {
    id: 'technical_design',
    label: '技术方案设计',
    goal: '给出架构、模块边界、数据流、接口、状态机和失败处理策略。',
    deliverable: '技术方案、关键设计决策、兼容性与回滚策略。',
    gate: '方案能指导代码落地,并说明主要风险如何收敛。',
  },
  {
    id: 'task_planning',
    label: '任务分配与排期',
    goal: '把技术方案转成可执行任务队列,明确角色分工、顺序、阻塞点和验证门。',
    deliverable: '任务列表、执行顺序、负责人/模型分工、排期与检查点。',
    gate: '任务粒度足够小,可以逐项执行和验收。',
  },
  {
    id: 'implementation',
    label: '代码开发',
    goal: '按任务计划完成代码和配置落地,保留关键实现依据。',
    deliverable: '代码改动、文件路径、关键命令、实现说明。',
    gate: '实现和磁盘文件一致,无明显未完成占位。',
  },
  {
    id: 'unit_test',
    label: '单元测试',
    goal: '为核心逻辑、边界条件、失败分支和回归点补单测或说明现有覆盖。',
    deliverable: '单测清单、测试文件、执行命令、结果摘要。',
    gate: '核心逻辑有可重复的自动化验证。',
  },
  {
    id: 'integration_test',
    label: '集成测试',
    goal: '验证模块之间、前后端、存储、适配器或外部进程协作是否贯通。',
    deliverable: '集成测试路径、命令、日志、失败处理。',
    gate: '关键链路不是只靠单元假设,而是有端到端证据。',
  },
  {
    id: 'functional_validation',
    label: '功能验证',
    goal: '站在用户场景验证功能是否能真实完成目标。',
    deliverable: '功能验证步骤、输入输出、截图/日志/接口结果。',
    gate: '用户主路径可复现通过。',
  },
  {
    id: 'documentation',
    label: '文档编写',
    goal: '沉淀使用说明、维护说明、已知限制和交接信息。',
    deliverable: 'README/交接/变更说明/操作手册更新。',
    gate: '下一位执行者无需重新猜测上下文即可继续。',
  },
  {
    id: 'acceptance',
    label: '交付验收',
    goal: '对照需求和验收标准逐项确认是否完成。',
    deliverable: '验收表、通过/未通过项、剩余风险、回滚方式。',
    gate: '每个显式需求都有当前证据支撑。',
  },
  {
    id: 'retrospective',
    label: '复盘优化',
    goal: '总结过程问题、可复用经验、下一轮优化方向。',
    deliverable: '复盘结论、改进项、后续优先级。',
    gate: '形成能减少下次返工的具体行动项。',
  },
];

function formatClusterEngineeringStages() {
  return CLUSTER_ENGINEERING_STAGES.map((stage, i) => `${i + 1}. ${stage.label}`).join('\n');
}

function hasCompleteClusterEngineeringLifecycle(taskList = []) {
  const presentStageIds = new Set((Array.isArray(taskList) ? taskList : []).map((task) => task?.stageId).filter(Boolean));
  return CLUSTER_ENGINEERING_STAGES.every((stage) => presentStageIds.has(stage.id));
}

function formatStageContract(stage) {
  if (!stage) return '';
  return `当前阶段: ${stage.label}
- 目标: ${stage.goal}
- 交付物: ${stage.deliverable}
- 完成门槛: ${stage.gate}`;
}

export function buildClusterEngineeringTaskList(topic) {
  const safeTopic = String(topic || '').trim() || '未命名项目';
  return CLUSTER_ENGINEERING_STAGES.map((stage, index) => ({
    id: `CE${String(index + 1).padStart(2, '0')}`,
    title: `${index + 1}. ${stage.label}`,
    desc: `围绕单一项目目标「${safeTopic}」完成工程闭环阶段: ${stage.label}\n${formatStageContract(stage)}`,
    stageId: stage.id,
    stageLabel: stage.label,
    stageIndex: index + 1,
    rounds: [],
    status: 'pending',
  }));
}

function summarizeStageConsensus(task) {
  const finalPlan = task?.consensus?.finalPlan;
  if (!finalPlan) return '';
  const title = task.stageLabel || task.title || task.id || '未命名阶段';
  const rounds = task.consensus.totalRounds || task.rounds?.length || 0;
  const artifact = task.consensus.stageArtifact || task.stageArtifact || null;
  const artifactBlock = artifact ? `\n### 结构化交付物账本\n\`\`\`json\n${JSON.stringify(artifact, null, 2).slice(0, 6000)}\n\`\`\`\n` : '';
  return `## ${title}
- status: ${task.status || 'unknown'}
- rounds: ${rounds}
- gate: ${task.stageId ? CLUSTER_ENGINEERING_STAGES.find((stage) => stage.id === task.stageId)?.gate || '' : ''}

### 阶段共识
${String(finalPlan).slice(0, 6000)}${artifactBlock}`;
}

export function buildPriorStageContext(taskList, currentTask) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const currentIndex = tasks.findIndex((task) => task === currentTask || task?.id === currentTask?.id);
  const priorTasks = currentIndex >= 0 ? tasks.slice(0, currentIndex) : [];
  const blocks = priorTasks
    .filter((task) => task?.status === 'done' && task?.consensus?.finalPlan)
    .map(summarizeStageConsensus)
    .filter(Boolean);
  if (!blocks.length) return '';
  return `# 已完成阶段共识链
后续阶段必须继承这些结论,不得无理由推翻。若发现前序阶段有硬伤,必须明确指出冲突点并给出修正建议。

${blocks.join('\n\n---\n\n')}`;
}

function collectArtifact(task) {
  return task?.consensus?.stageArtifact || task?.stageArtifact || null;
}

function artifactVerdict(task, artifact) {
  if (task?.status !== 'done') return 'failed';
  if (!artifact) return 'insufficient';
  const gates = Array.isArray(artifact.gates) ? artifact.gates : [];
  const signoffs = Array.isArray(artifact.signoffs) ? artifact.signoffs : [];
  const evidence = Array.isArray(artifact.evidence) ? artifact.evidence : [];
  const gatesPassed = gates.length > 0 && gates.every((gate) => gate?.status === 'passed');
  const allSigned = signoffs.length > 0 && signoffs.every((entry) => entry?.agree === true);
  if (!gatesPassed || !allSigned) return 'failed';
  if (evidence.length === 0) return 'insufficient';
  if (artifact.evidenceRequirement?.required && artifact.evidenceRequirement?.status !== 'passed') return 'insufficient';
  return Array.isArray(artifact.risks) && artifact.risks.length > 0 ? 'passed_with_risks' : 'passed';
}

export function buildClusterAcceptanceReport(taskList, currentTask) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const currentIndex = tasks.findIndex((task) => task === currentTask || task?.id === currentTask?.id);
  const scopedTasks = (currentIndex >= 0 ? tasks.slice(0, currentIndex) : tasks)
    .filter((task) => task?.stageId !== 'retrospective');
  const items = scopedTasks.map((task) => {
    const artifact = collectArtifact(task);
    const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
    const signals = uniqueStrings(evidence.flatMap((entry) => entry?.signals || []), 12);
    const verdict = artifactVerdict(task, artifact);
    return {
      stageId: task?.stageId || '',
      stageLabel: task?.stageLabel || task?.title || '',
      status: task?.status || 'unknown',
      verdict,
      deliverables: artifact?.deliverables || [],
      gates: artifact?.gates || [],
      evidenceCount: evidence.length,
      evidenceSignals: signals,
      signoffCount: Array.isArray(artifact?.signoffs) ? artifact.signoffs.length : 0,
      riskCount: Array.isArray(artifact?.risks) ? artifact.risks.length : 0,
      risks: artifact?.risks || [],
    };
  });
  const summary = items.reduce((acc, item) => {
    acc.total += 1;
    acc[item.verdict] = (acc[item.verdict] || 0) + 1;
    return acc;
  }, { total: 0, passed: 0, passed_with_risks: 0, insufficient: 0, failed: 0 });
  return {
    generatedAt: new Date().toISOString(),
    currentStageId: currentTask?.stageId || '',
    scopeStageCount: items.length,
    summary,
    items,
  };
}

function backlogItem(kind, stage, title, evidence, priority = 'P2') {
  return {
    id: `${kind}:${stage?.stageId || stage?.id || 'unknown'}:${String(title || '').slice(0, 40)}`,
    kind,
    priority,
    stageId: stage?.stageId || stage?.id || '',
    stageLabel: stage?.stageLabel || stage?.label || '',
    title,
    evidence,
  };
}

export function buildClusterRetrospectiveReport(taskList, currentTask) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const currentIndex = tasks.findIndex((task) => task === currentTask || task?.id === currentTask?.id);
  const scopedTasks = (currentIndex >= 0 ? tasks.slice(0, currentIndex) : tasks)
    .filter((task) => task?.stageId !== 'retrospective');
  const backlog = [];

  for (const task of scopedTasks) {
    const artifact = collectArtifact(task);
    const stage = {
      stageId: task?.stageId || '',
      stageLabel: task?.stageLabel || task?.title || '',
    };
    const reportItem = task?.acceptanceReport?.items?.find((item) => item.stageId === task.stageId);
    const verdict = reportItem?.verdict || artifactVerdict(task, artifact);
    if (verdict === 'failed') {
      backlog.push(backlogItem('fix_failed_gate', stage, `${stage.stageLabel} 未通过验收门槛`, `verdict=${verdict}`, 'P0'));
    } else if (verdict === 'insufficient') {
      backlog.push(backlogItem('add_missing_evidence', stage, `${stage.stageLabel} 证据不足`, `verdict=${verdict}`, 'P1'));
    } else if (verdict === 'passed_with_risks') {
      backlog.push(backlogItem('reduce_known_risk', stage, `${stage.stageLabel} 带风险通过`, `verdict=${verdict}`, 'P1'));
    }

    for (const risk of (artifact?.risks || [])) {
      backlog.push(backlogItem('resolve_risk', stage, String(risk).slice(0, 120), String(risk), 'P1'));
    }

    for (const evidence of (artifact?.evidence || [])) {
      const signals = Array.isArray(evidence?.signals) ? evidence.signals : [];
      if (signals.includes('natural_language_only')) {
        backlog.push(backlogItem(
          'replace_weak_evidence',
          stage,
          `${stage.stageLabel} 需要从自然语言证据升级为命令/文件/UI证据`,
          `member=${evidence.memberId || ''}; signals=${signals.join(',')}`,
          'P2',
        ));
      }
    }
  }

  const acceptanceTask = scopedTasks.find((task) => task?.stageId === 'acceptance');
  const remediationHistory = Array.isArray(acceptanceTask?.remediationHistory) ? acceptanceTask.remediationHistory : [];
  if (remediationHistory.length > 0) {
    backlog.push(backlogItem(
      'stabilize_acceptance_rework_loop',
      { stageId: 'acceptance', stageLabel: '交付验收' },
      `交付验收触发 ${remediationHistory.length} 次返工,需要收敛前置质量门`,
      `remediations=${remediationHistory.length}`,
      remediationHistory.length >= 3 ? 'P0' : 'P1',
    ));
  }
  for (const record of remediationHistory) {
    const invalidated = Array.isArray(record?.invalidated) ? record.invalidated : [];
    if (invalidated.length > 0) {
      backlog.push(backlogItem(
        'reduce_downstream_rework_churn',
        { stageId: record.targetStageId || '', stageLabel: record.targetStageLabel || '' },
        `${record.targetStageLabel || record.targetStageId || '上游阶段'} 返工导致 ${invalidated.length} 个下游阶段失效`,
        `target=${record.targetStageId || ''}; invalidated=${invalidated.map((item) => item.stageId || item.stageLabel || '').filter(Boolean).join(',')}`,
        invalidated.length >= 4 ? 'P1' : 'P2',
      ));
    }
  }

  const uniqueBacklog = [];
  const seen = new Set();
  for (const item of backlog) {
    const key = `${item.kind}|${item.stageId}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueBacklog.push(item);
  }

  const byPriority = uniqueBacklog.reduce((acc, item) => {
    acc[item.priority] = (acc[item.priority] || 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    currentStageId: currentTask?.stageId || '',
    scopeStageCount: scopedTasks.length,
    summary: {
      totalBacklog: uniqueBacklog.length,
      byPriority,
    },
    backlog: uniqueBacklog,
  };
}

export function buildClusterWorkflowAudit(taskList) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const stages = tasks.map((task) => {
    const artifact = collectArtifact(task);
    return {
      id: task?.id || '',
      stageId: task?.stageId || '',
      stageLabel: task?.stageLabel || task?.title || '',
      status: task?.status || 'unknown',
      blocking: task?.blocking === true,
      repairs: task?.qualityGateRepairs || 0,
      verdict: artifactVerdict(task, artifact),
      evidenceRequirementStatus: artifact?.evidenceRequirement?.status || 'not_required',
      evidenceRequirementRequired: artifact?.evidenceRequirement?.required === true,
      signoffCount: Array.isArray(artifact?.signoffs) ? artifact.signoffs.length : 0,
      riskCount: Array.isArray(artifact?.risks) ? artifact.risks.length : 0,
    };
  });
  const counts = stages.reduce((acc, stage) => {
    acc.status[stage.status] = (acc.status[stage.status] || 0) + 1;
    acc.verdict[stage.verdict] = (acc.verdict[stage.verdict] || 0) + 1;
    if (stage.blocking) acc.blocking += 1;
    if (stage.repairs > 0) acc.repaired += 1;
    if (stage.evidenceRequirementRequired && stage.evidenceRequirementStatus !== 'passed') acc.evidenceInsufficient += 1;
    return acc;
  }, {
    total: stages.length,
    blocking: 0,
    repaired: 0,
    evidenceInsufficient: 0,
    status: {},
    verdict: {},
  });
  const acceptanceTask = tasks.find((task) => task?.stageId === 'acceptance');
  const retrospectiveTask = tasks.find((task) => task?.stageId === 'retrospective');
  const remediationHistory = Array.isArray(acceptanceTask?.remediationHistory) ? acceptanceTask.remediationHistory : [];
  const blockers = stages.filter((stage) => stage.blocking || stage.status === 'escalated');
  const allDone = stages.length > 0 && stages.every((stage) => stage.status === 'done');
  return {
    generatedAt: new Date().toISOString(),
    overallStatus: blockers.length > 0 ? 'blocked' : allDone ? 'complete' : 'incomplete',
    counts,
    stages,
    blockers,
    acceptanceSummary: acceptanceTask?.acceptanceReport?.summary || acceptanceTask?.consensus?.stageArtifact?.acceptanceReport?.summary || null,
    retrospectiveSummary: retrospectiveTask?.retrospectiveReport?.summary || retrospectiveTask?.consensus?.stageArtifact?.retrospectiveReport?.summary || null,
    remediationSummary: {
      total: remediationHistory.length,
      automatic: remediationHistory.filter((item) => item?.automatic === true).length,
      invalidatedStages: remediationHistory.reduce((acc, item) => acc + (Array.isArray(item?.invalidated) ? item.invalidated.length : 0), 0),
      latest: remediationHistory.at(-1) || null,
    },
  };
}

function objectiveAuditItem(id, label, passed, evidence = [], blockers = []) {
  return {
    id,
    label,
    status: passed ? 'passed' : 'blocked',
    passed: passed === true,
    evidence: uniqueStrings(evidence, 12),
    blockers: uniqueStrings(blockers, 12),
  };
}

export function buildClusterObjectiveCompletionAudit({
  topic = '',
  stages = [],
  requiredStageIds = [],
  presentStageIds = new Set(),
  readyForDelivery = false,
  deliveryBlockers = [],
  evidenceCoverage = {},
  evidenceIntegrity = {},
  memberSignoffMatrix = [],
  acceptanceSummary = null,
  acceptanceRequirementStatus = null,
  remediationSummary = null,
} = {}) {
  const doneStageCount = stages.filter((stage) => stage.status === 'done').length;
  const allStagesPresent = requiredStageIds.length > 0 && requiredStageIds.every((stageId) => presentStageIds.has(stageId));
  const allStagesDone = stages.length > 0 && doneStageCount === stages.length;
  const signoffComplete = memberSignoffMatrix.length > 0 && memberSignoffMatrix.every((row) => row.complete);
  const expectedMemberCount = Math.max(...memberSignoffMatrix.map((row) => row.expectedMemberCount || 0), 0);
  const signoffFailoverAdjusted = memberSignoffMatrix.some((row) => row.failoverAdjusted === true);
  const memberSignoffSatisfied = signoffComplete && (expectedMemberCount >= 2 || signoffFailoverAdjusted);
  const codeDrivenCovered = (evidenceCoverage.codeDrivenStageCount || 0) >= Object.keys(CODE_DRIVEN_STAGE_EVIDENCE).length
    && evidenceCoverage.codeDrivenCoveredStageCount === evidenceCoverage.codeDrivenStageCount;
  const agentRunEvidenceVerified = (evidenceCoverage.codeDrivenStageCount || 0) > 0
    && (evidenceIntegrity.verifiedRunEvidenceStageCount || 0) >= (evidenceCoverage.codeDrivenStageCount || 0);
  const hardEvidenceCount = (evidenceCoverage.commandEvidenceCount || 0)
    + (evidenceCoverage.fileEvidenceCount || 0)
    + (evidenceCoverage.runtimeEvidenceCount || 0);
  const acceptancePassed = acceptanceSummary
    && (acceptanceSummary.failed || 0) === 0
    && (acceptanceSummary.insufficient || 0) === 0
    && (!acceptanceRequirementStatus || acceptanceRequirementStatus === 'passed');
  const items = [
    objectiveAuditItem(
      'single_project_goal',
      '围绕单一项目目标推进',
      Boolean(String(topic || '').trim()) && stages.length > 0,
      [`topic=${String(topic || '').slice(0, 120)}`, `stageCount=${stages.length}`],
      [String(topic || '').trim() ? '' : 'topic_missing', stages.length ? '' : 'stage_list_missing'],
    ),
    objectiveAuditItem(
      'full_lifecycle_11_stages',
      '覆盖想法到复盘的 11 阶段工程闭环',
      allStagesPresent && allStagesDone,
      [`required=${requiredStageIds.length}`, `present=${stages.length}`, `done=${doneStageCount}`],
      [
        allStagesPresent ? '' : 'required_stages_missing',
        allStagesDone ? '' : `incomplete=${stages.filter((stage) => stage.status !== 'done').map((stage) => stage.stageId).join(',')}`,
      ],
    ),
    objectiveAuditItem(
      'multi_ai_peer_signoff',
      '多 AI 对等互审并全员签字',
      memberSignoffSatisfied,
      [
        `expectedMembers=${expectedMemberCount}`,
        `completeStages=${memberSignoffMatrix.filter((row) => row.complete).length}/${memberSignoffMatrix.length}`,
        `failoverAdjusted=${signoffFailoverAdjusted ? 'yes' : 'no'}`,
      ],
      [
        (expectedMemberCount >= 2 || signoffFailoverAdjusted) ? '' : 'member_count_lt_2',
        signoffComplete ? '' : `signoff_incomplete=${memberSignoffMatrix.filter((row) => !row.complete).map((row) => row.stageId).join(',')}`,
      ],
    ),
    objectiveAuditItem(
      'code_driven_evidence',
      '代码驱动阶段具备命令/文件/运行证据并绑定 Agent Run',
      codeDrivenCovered && hardEvidenceCount > 0 && agentRunEvidenceVerified,
      [
        `codeDriven=${evidenceCoverage.codeDrivenCoveredStageCount || 0}/${evidenceCoverage.codeDrivenStageCount || 0}`,
        `agentRunVerified=${evidenceIntegrity.verifiedRunEvidenceStageCount || 0}/${evidenceCoverage.codeDrivenStageCount || 0}`,
        `commands=${evidenceCoverage.commandEvidenceCount || 0}`,
        `files=${evidenceCoverage.fileEvidenceCount || 0}`,
        `runtime=${evidenceCoverage.runtimeEvidenceCount || 0}`,
      ],
      [
        codeDrivenCovered ? '' : 'code_driven_stage_evidence_incomplete',
        agentRunEvidenceVerified ? '' : 'agent_run_evidence_incomplete',
        hardEvidenceCount > 0 ? '' : 'hard_evidence_missing',
      ],
    ),
    objectiveAuditItem(
      'acceptance_closed_loop',
      '交付验收按证据闭环通过',
      acceptancePassed === true && readyForDelivery,
      [
        `acceptanceTotal=${acceptanceSummary?.total || 0}`,
        `failed=${acceptanceSummary?.failed || 0}`,
        `insufficient=${acceptanceSummary?.insufficient || 0}`,
        `deliveryGate=${readyForDelivery ? 'passed' : 'blocked'}`,
      ],
      [
        acceptancePassed ? '' : 'acceptance_not_passed',
        readyForDelivery ? '' : deliveryBlockers.join(';'),
      ],
    ),
    objectiveAuditItem(
      'automatic_rework_traceability',
      '验收返工和复盘优化可追踪',
      remediationSummary !== null,
      [
        `remediations=${remediationSummary?.total || 0}`,
        `automatic=${remediationSummary?.automatic || 0}`,
        `invalidatedStages=${remediationSummary?.invalidatedStages || 0}`,
      ],
      [remediationSummary !== null ? '' : 'remediation_summary_missing'],
    ),
  ];
  const passedCount = items.filter((item) => item.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    auditVersion: 'cluster-objective-completion-v1',
    status: passedCount === items.length ? 'passed' : 'blocked',
    passedCount,
    total: items.length,
    items,
  };
}

export function buildClusterDeliveryManifest({ room = {}, taskList = [], audit = null, topic = '' } = {}) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const acceptanceTask = tasks.find((task) => task?.stageId === 'acceptance');
  const retrospectiveTask = tasks.find((task) => task?.stageId === 'retrospective');
  const stages = tasks.map((task) => {
    const artifact = collectArtifact(task);
    const evidence = Array.isArray(artifact?.evidence) ? artifact.evidence : [];
    const signoffs = Array.isArray(artifact?.signoffs) ? artifact.signoffs : [];
    const commandEvidence = uniqueStrings(evidence.flatMap((entry) => entry?.commands || []), 20);
    const fileEvidence = uniqueStrings(evidence.flatMap((entry) => entry?.fileChecks || []), 20);
    const runtimeEvidence = uniqueStrings(evidence.flatMap((entry) => entry?.runtimeChecks || []), 20);
    return {
      id: task?.id || '',
      stageId: task?.stageId || '',
      stageLabel: task?.stageLabel || task?.title || '',
      status: task?.status || 'unknown',
      verdict: artifactVerdict(task, artifact),
      rounds: task?.consensus?.totalRounds || task?.rounds?.length || 0,
      evidenceSignals: uniqueStrings(evidence.flatMap((entry) => entry?.signals || []), 20),
      commandEvidence,
      fileEvidence,
      runtimeEvidence,
      commandEvidenceCount: commandEvidence.length,
      fileEvidenceCount: fileEvidence.length,
      runtimeEvidenceCount: runtimeEvidence.length,
      deliverableCount: Array.isArray(artifact?.deliverables) ? artifact.deliverables.length : 0,
      riskCount: Array.isArray(artifact?.risks) ? artifact.risks.length : 0,
      signoffCount: signoffs.length,
      signoffs: signoffs.map((entry) => ({
        memberId: entry?.memberId || '',
        displayName: entry?.displayName || entry?.memberId || '',
        agree: entry?.agree === true,
      })),
      evidenceRequirementStatus: artifact?.evidenceRequirement?.status || 'not_required',
      acceptanceRequirementStatus: artifact?.acceptanceRequirement?.status || 'not_required',
    };
  });
  const enabledMemberCount = Array.isArray(room?.members) ? room.members.filter((member) => member?.enabled !== false).length : 0;
  const hasMemberFailover = Array.isArray(room?.clusterDroppedMembers)
    && room.clusterDroppedMembers.some((member) => member && member.recoverable !== true);
  const memberSignoffMatrix = stages.map((stage) => ({
    stageId: stage.stageId,
    stageLabel: stage.stageLabel,
    expectedMemberCount: hasMemberFailover
      ? Math.max(1, stage.signoffCount || 0)
      : Math.max(enabledMemberCount, stage.signoffCount || 0, 2),
    failoverAdjusted: hasMemberFailover,
    signoffCount: stage.signoffCount,
    agreedCount: stage.signoffs.filter((entry) => entry.agree === true).length,
    complete: stage.signoffCount >= (
      hasMemberFailover ? Math.max(1, stage.signoffCount || 0) : Math.max(enabledMemberCount, stage.signoffCount || 0, 2)
    ) && stage.signoffs.every((entry) => entry.agree === true),
    signoffs: stage.signoffs,
  }));
  const signoffIncompleteStages = memberSignoffMatrix
    .filter((row) => !row.complete)
    .map((row) => ({
      stageId: row.stageId,
      stageLabel: row.stageLabel,
      signoffCount: row.signoffCount,
      expectedMemberCount: row.expectedMemberCount,
      agreedCount: row.agreedCount,
    }));
  const requiredStageIds = CLUSTER_ENGINEERING_STAGES.map((stage) => stage.id);
  const presentStageIds = new Set(stages.map((stage) => stage.stageId).filter(Boolean));
  const missingStages = CLUSTER_ENGINEERING_STAGES
    .filter((stage) => !presentStageIds.has(stage.id))
    .map((stage) => ({ stageId: stage.id, stageLabel: stage.label }));
  const incompleteStages = stages
    .filter((stage) => stage.status !== 'done')
    .map((stage) => ({ stageId: stage.stageId, stageLabel: stage.stageLabel, status: stage.status }));
  const failedStages = stages
    .filter((stage) => stage.verdict === 'failed' || stage.verdict === 'insufficient')
    .map((stage) => ({ stageId: stage.stageId, stageLabel: stage.stageLabel, verdict: stage.verdict }));
  const evidenceInsufficientStages = stages
    .filter((stage) => stage.evidenceRequirementStatus && !['not_required', 'passed'].includes(stage.evidenceRequirementStatus))
    .map((stage) => ({ stageId: stage.stageId, stageLabel: stage.stageLabel, evidenceRequirementStatus: stage.evidenceRequirementStatus }));
  const evidenceCoverage = stages.reduce((acc, stage) => {
    acc.commandEvidenceCount += stage.commandEvidenceCount || 0;
    acc.fileEvidenceCount += stage.fileEvidenceCount || 0;
    acc.runtimeEvidenceCount += stage.runtimeEvidenceCount || 0;
    if (CODE_DRIVEN_STAGE_EVIDENCE[stage.stageId]) {
      acc.codeDrivenStageCount += 1;
      if (stage.evidenceRequirementStatus === 'passed') acc.codeDrivenCoveredStageCount += 1;
    }
    if ((stage.commandEvidenceCount || 0) > 0 || (stage.fileEvidenceCount || 0) > 0 || (stage.runtimeEvidenceCount || 0) > 0) {
      acc.stagesWithHardEvidence += 1;
    }
    return acc;
  }, {
    commandEvidenceCount: 0,
    fileEvidenceCount: 0,
    runtimeEvidenceCount: 0,
    stagesWithHardEvidence: 0,
    codeDrivenStageCount: 0,
    codeDrivenCoveredStageCount: 0,
  });
  evidenceCoverage.codeDrivenCoverageRatio = evidenceCoverage.codeDrivenStageCount
    ? evidenceCoverage.codeDrivenCoveredStageCount / evidenceCoverage.codeDrivenStageCount
    : 1;
  const allVerifiedEvidenceLinks = (Array.isArray(room?.clusterEvidenceLinks) ? room.clusterEvidenceLinks : [])
    .filter(isVerifiableClusterEvidenceLink);
  const verifiedEvidenceLinks = allVerifiedEvidenceLinks
    .filter((link) => CODE_DRIVEN_STAGE_EVIDENCE[link.stageId]);
  const nonCodeVerifiedEvidenceStageIds = [...new Set(
    allVerifiedEvidenceLinks
      .filter((link) => !CODE_DRIVEN_STAGE_EVIDENCE[link.stageId])
      .map((link) => link.stageId),
  )];
  const verifiedEvidenceStageIds = [...new Set(verifiedEvidenceLinks.map((link) => link.stageId))];
  const evidenceIntegrity = {
    integrityVersion: 'cluster-evidence-integrity-v1',
    status: verifiedEvidenceStageIds.length >= evidenceCoverage.codeDrivenStageCount && evidenceCoverage.codeDrivenStageCount > 0
      ? 'agent_run_verified'
      : verifiedEvidenceStageIds.length > 0
        ? 'mixed'
        : evidenceCoverage.stagesWithHardEvidence > 0 ? 'declared_hard_evidence' : 'missing_hard_evidence',
    declaredHardEvidenceStageCount: evidenceCoverage.stagesWithHardEvidence,
    verifiedRunEvidenceStageCount: verifiedEvidenceStageIds.length,
    nonCodeVerifiedRunEvidenceStageCount: nonCodeVerifiedEvidenceStageIds.length,
    declaredHardEvidenceStages: stages
      .filter((stage) => (stage.commandEvidenceCount || 0) > 0 || (stage.fileEvidenceCount || 0) > 0 || (stage.runtimeEvidenceCount || 0) > 0)
      .map((stage) => stage.stageId),
    verifiedRunEvidenceStages: verifiedEvidenceStageIds,
    nonCodeVerifiedRunEvidenceStages: nonCodeVerifiedEvidenceStageIds,
    verifiedRunEvidenceLinks: verifiedEvidenceLinks.map((link) => ({
      stageId: link.stageId,
      stageLabel: link.stageLabel || link.stageId,
      agentRunId: link.agentRunId,
      evidenceCount: link.evidenceCount || 0,
      toolResultCount: link.toolResultCount || 0,
      archiveCount: link.archiveCount || 0,
      artifactCount: link.artifactCount || 0,
    })),
    limitation: 'hard evidence is extracted from member output unless linked to Agent Run verified records',
    nextHardening: 'bind code-driven stages to Agent Run command/file/runtime records',
  };
  const acceptanceSummary = acceptanceTask?.acceptanceReport?.summary || acceptanceTask?.consensus?.stageArtifact?.acceptanceReport?.summary || null;
  const acceptanceRequirementStatus = acceptanceTask?.consensus?.stageArtifact?.acceptanceRequirement?.status || null;
  const requiredAgentRunEvidenceStageCount = evidenceCoverage.codeDrivenStageCount || 0;
  const verifiedAgentRunEvidenceStageCount = evidenceIntegrity.verifiedRunEvidenceStageCount || 0;
  const agentRunEvidenceBlockers = requiredAgentRunEvidenceStageCount > 0 && verifiedAgentRunEvidenceStageCount < requiredAgentRunEvidenceStageCount
    ? [`agent_run_evidence_incomplete=${verifiedAgentRunEvidenceStageCount}/${requiredAgentRunEvidenceStageCount}`]
    : [];
  const deliveryBlockers = [
    ...(audit?.overallStatus === 'complete' ? [] : [`workflow_status=${audit?.overallStatus || 'unknown'}`]),
    ...(missingStages.length ? [`missing_stages=${missingStages.map((stage) => stage.stageId).join(',')}`] : []),
    ...(incompleteStages.length ? [`incomplete_stages=${incompleteStages.map((stage) => `${stage.stageId}:${stage.status}`).join(',')}`] : []),
    ...(failedStages.length ? [`failed_or_insufficient_stages=${failedStages.map((stage) => `${stage.stageId}:${stage.verdict}`).join(',')}`] : []),
    ...(evidenceInsufficientStages.length ? [`evidence_insufficient=${evidenceInsufficientStages.map((stage) => `${stage.stageId}:${stage.evidenceRequirementStatus}`).join(',')}`] : []),
    ...agentRunEvidenceBlockers,
    ...(signoffIncompleteStages.length ? [`signoff_incomplete=${signoffIncompleteStages.map((stage) => `${stage.stageId}:${stage.signoffCount}/${stage.expectedMemberCount}`).join(',')}`] : []),
    ...((acceptanceSummary?.failed || 0) > 0 || (acceptanceSummary?.insufficient || 0) > 0
      ? [`acceptance_not_passed=failed:${acceptanceSummary?.failed || 0},insufficient:${acceptanceSummary?.insufficient || 0}`]
      : []),
    ...(acceptanceRequirementStatus && acceptanceRequirementStatus !== 'passed' ? [`acceptance_requirement=${acceptanceRequirementStatus}`] : []),
  ];
  const readyForDelivery = deliveryBlockers.length === 0
    && requiredStageIds.every((stageId) => presentStageIds.has(stageId));
  const objectiveCompletionAudit = buildClusterObjectiveCompletionAudit({
    topic: String(topic || room?.topic || '').slice(0, 1000),
    stages,
    requiredStageIds,
    presentStageIds,
    readyForDelivery,
    deliveryBlockers,
    evidenceCoverage,
    evidenceIntegrity,
    memberSignoffMatrix,
    acceptanceSummary,
    acceptanceRequirementStatus,
    remediationSummary: audit?.remediationSummary || null,
  });
  const manifest = {
    generatedAt: new Date().toISOString(),
    manifestVersion: 'cluster-delivery-v1',
    mode: 'cluster_collaboration',
    roomId: room?.id || '',
    roomName: room?.name || '',
    topic: String(topic || room?.topic || '').slice(0, 1000),
    overallStatus: audit?.overallStatus || 'unknown',
    stageCount: stages.length,
    doneStageCount: stages.filter((stage) => stage.status === 'done').length,
    blockedStageCount: stages.filter((stage) => stage.status === 'escalated' || stage.status === 'blocked').length,
    readyForDelivery,
    deliveryGate: {
      status: readyForDelivery ? 'passed' : 'blocked',
      blockers: deliveryBlockers,
      missingStages,
      incompleteStages,
      failedStages,
      evidenceInsufficientStages,
      signoffIncompleteStages,
    },
    stages,
    memberSignoffMatrix,
    evidenceCoverage,
    evidenceIntegrity,
    objectiveCompletionAudit,
    acceptance: {
      summary: acceptanceSummary,
      requirementStatus: acceptanceRequirementStatus,
    },
    retrospective: {
      summary: retrospectiveTask?.retrospectiveReport?.summary || retrospectiveTask?.consensus?.stageArtifact?.retrospectiveReport?.summary || null,
      backlog: retrospectiveTask?.retrospectiveReport?.backlog || retrospectiveTask?.consensus?.stageArtifact?.retrospectiveReport?.backlog || [],
    },
    remediation: {
      count: Array.isArray(room?.acceptanceRemediationHistory) ? room.acceptanceRemediationHistory.length : 0,
      history: Array.isArray(room?.acceptanceRemediationHistory) ? room.acceptanceRemediationHistory.slice(-20) : [],
      summary: audit?.remediationSummary || null,
    },
    evidenceMatrix: stages.map((stage) => ({
      stageId: stage.stageId,
      stageLabel: stage.stageLabel,
      status: stage.status,
      verdict: stage.verdict,
      evidenceSignals: stage.evidenceSignals,
      commandEvidence: stage.commandEvidence,
      fileEvidence: stage.fileEvidence,
      runtimeEvidence: stage.runtimeEvidence,
      commandEvidenceCount: stage.commandEvidenceCount,
      fileEvidenceCount: stage.fileEvidenceCount,
      runtimeEvidenceCount: stage.runtimeEvidenceCount,
      evidenceRequirementStatus: stage.evidenceRequirementStatus,
      acceptanceRequirementStatus: stage.acceptanceRequirementStatus,
    })),
  };
  manifest.fingerprint = createHash('sha256')
    .update(stableStringify({ ...manifest, generatedAt: '' }))
    .digest('hex');
  return manifest;
}

export function buildClusterDeliveryReportMarkdown(manifest = {}) {
  const gate = manifest.deliveryGate || {};
  const coverage = manifest.evidenceCoverage || {};
  const integrity = manifest.evidenceIntegrity || {};
  const acceptance = manifest.acceptance?.summary || {};
  const retro = manifest.retrospective?.summary || {};
  const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
  const objectiveAudit = manifest.objectiveCompletionAudit || {};
  const objectiveAuditItems = Array.isArray(objectiveAudit.items) ? objectiveAudit.items : [];
  const blockers = Array.isArray(gate.blockers) ? gate.blockers : [];
  const stageRows = stages.map((stage, i) => (
    `| ${i + 1} | ${stage.stageLabel || stage.stageId || ''} | ${stage.status || ''} | ${stage.verdict || ''} | ${stage.signoffCount || 0} | ${stage.commandEvidenceCount || 0}/${stage.fileEvidenceCount || 0}/${stage.runtimeEvidenceCount || 0} |`
  ));
  return [
    '# 集群协同交付报告',
    '',
    `- 项目目标: ${manifest.topic || '(未命名目标)'}`,
    `- 交付状态: ${manifest.overallStatus || 'unknown'}`,
    `- 交付门禁: ${manifest.readyForDelivery ? '通过' : '阻断'}`,
    `- 交付指纹: ${manifest.fingerprint || ''}`,
    `- 阶段完成: ${manifest.doneStageCount || 0}/${manifest.stageCount || 0}`,
    `- 目标完成度: ${objectiveAudit.status || 'unknown'} (${objectiveAudit.passedCount || 0}/${objectiveAudit.total || 0})`,
    `- 自动返工: ${manifest.remediation?.count || 0} 次`,
    '',
    '## 目标完成度审计',
    '',
    '| 要求 | 状态 | 证据 | 阻断 |',
    '|---|---|---|---|',
    ...objectiveAuditItems.map((item) => `| ${item.label || item.id || ''} | ${item.status || ''} | ${(item.evidence || []).join('<br>')} | ${(item.blockers || []).join('<br>') || '-'} |`),
    '',
    '## 证据覆盖',
    '',
    `- 命令证据: ${coverage.commandEvidenceCount || 0}`,
    `- 文件验证: ${coverage.fileEvidenceCount || 0}`,
    `- 运行/UI证据: ${coverage.runtimeEvidenceCount || 0}`,
    `- 代码驱动阶段覆盖: ${coverage.codeDrivenCoveredStageCount || 0}/${coverage.codeDrivenStageCount || 0}`,
    `- 证据完整性: ${integrity.status || 'unknown'}，声明式硬证据阶段 ${integrity.declaredHardEvidenceStageCount || 0}，Agent Run 已验证阶段 ${integrity.verifiedRunEvidenceStageCount || 0}`,
    integrity.limitation ? `- 限制: ${integrity.limitation}` : '',
    '',
    '## 验收摘要',
    '',
    `- 总项: ${acceptance.total || 0}`,
    `- 通过: ${acceptance.passed || 0}`,
    `- 带风险通过: ${acceptance.passed_with_risks || 0}`,
    `- 证据不足: ${acceptance.insufficient || 0}`,
    `- 失败: ${acceptance.failed || 0}`,
    '',
    '## 复盘摘要',
    '',
    `- 改进项: ${retro.totalBacklog || 0}`,
    `- P0: ${retro.byPriority?.P0 || 0}`,
    `- P1: ${retro.byPriority?.P1 || 0}`,
    `- P2: ${retro.byPriority?.P2 || 0}`,
    '',
    blockers.length ? '## 阻断原因' : '',
    blockers.length ? blockers.map((item) => `- ${item}`).join('\n') : '',
    blockers.length ? '' : '',
    '## 阶段交付矩阵',
    '',
    '| # | 阶段 | 状态 | 判定 | 签字 | 命令/文件/UI证据 |',
    '|---|---|---|---|---:|---:|',
    ...stageRows,
  ].filter((line) => line !== '').join('\n');
}

function deliveryPackageSlug(value) {
  return String(value || 'cluster')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'cluster';
}

export function buildClusterDeliveryPackage(manifest = {}, reportMarkdown = '') {
  const roomSlug = deliveryPackageSlug(manifest.roomId || manifest.roomName || 'cluster');
  const manifestFingerprint = String(manifest.fingerprint || '').slice(0, 64);
  const shortFingerprint = manifestFingerprint.slice(0, 12) || 'draft';
  const reportFingerprint = createHash('sha256')
    .update(String(reportMarkdown || ''))
    .digest('hex');
  const artifacts = [
    {
      kind: 'delivery_manifest_json',
      label: '集群协同交付清单(JSON)',
      filename: `${roomSlug}-cluster-delivery-${shortFingerprint}.json`,
      mime: 'application/json',
      sha256: manifestFingerprint,
      required: true,
    },
    {
      kind: 'delivery_report_markdown',
      label: '集群协同交付报告(Markdown)',
      filename: `${roomSlug}-cluster-report-${shortFingerprint}.md`,
      mime: 'text/markdown; charset=utf-8',
      sha256: reportFingerprint,
      required: true,
    },
  ];
  return {
    generatedAt: new Date().toISOString(),
    packageVersion: 'cluster-delivery-package-v1',
    mode: manifest.mode || 'cluster_collaboration',
    roomId: manifest.roomId || '',
    topic: manifest.topic || '',
    status: manifest.readyForDelivery ? 'ready' : 'blocked',
    readyForArchive: manifest.readyForDelivery === true,
    manifestFingerprint,
    reportFingerprint,
    deliveryGateStatus: manifest.deliveryGate?.status || 'unknown',
    blockers: Array.isArray(manifest.deliveryGate?.blockers) ? manifest.deliveryGate.blockers : [],
    objectiveCompletionAudit: manifest.objectiveCompletionAudit ? {
      status: manifest.objectiveCompletionAudit.status || 'unknown',
      passedCount: manifest.objectiveCompletionAudit.passedCount || 0,
      total: manifest.objectiveCompletionAudit.total || 0,
      failedItems: (manifest.objectiveCompletionAudit.items || [])
        .filter((item) => item.passed !== true)
        .map((item) => ({ id: item.id, label: item.label, blockers: item.blockers || [] })),
    } : null,
    evidenceIntegrity: manifest.evidenceIntegrity ? {
      status: manifest.evidenceIntegrity.status || 'unknown',
      declaredHardEvidenceStageCount: manifest.evidenceIntegrity.declaredHardEvidenceStageCount || 0,
      verifiedRunEvidenceStageCount: manifest.evidenceIntegrity.verifiedRunEvidenceStageCount || 0,
      requiresAgentRunBinding: (manifest.evidenceIntegrity.verifiedRunEvidenceStageCount || 0) < (manifest.evidenceCoverage?.codeDrivenStageCount || 0),
    } : null,
    artifacts,
    archivePlan: {
      recommendedPath: `deliveries/${roomSlug}/${shortFingerprint}/`,
      requiredArtifacts: artifacts.filter((item) => item.required).map((item) => item.kind),
      evidenceMatrixIncluded: Array.isArray(manifest.evidenceMatrix),
      signoffMatrixIncluded: Array.isArray(manifest.memberSignoffMatrix),
      remediationHistoryIncluded: Array.isArray(manifest.remediation?.history),
      objectiveCompletionAuditIncluded: Boolean(manifest.objectiveCompletionAudit),
    },
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function evidenceDetails(plan) {
  const lines = String(plan || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const commands = uniqueStrings(lines.filter((line) => /(npm\s+test|vitest|pytest|node\s+--check|curl\s+)/i.test(line)), 12);
  const fileChecks = uniqueStrings(lines.filter((line) => /(cat\s+|wc\s+-l|sed\s+-n|rg\s+-n)/i.test(line)), 12);
  const runtimeChecks = uniqueStrings(lines.filter((line) => /(截图|screenshot|浏览器|页面|UI)/i.test(line)), 12);
  return { commands, fileChecks, runtimeChecks };
}

function evidenceSignals(plan) {
  const text = String(plan || '');
  const signals = [];
  if (/本步未写文件/.test(text)) signals.push('declared_no_file_write');
  if (/文件落地验证|cat\s+|wc\s+-l|sed\s+-n|rg\s+-n/.test(text)) signals.push('filesystem_evidence');
  if (/npm\s+test|vitest|pytest|node\s+--check|curl\s+/.test(text)) signals.push('command_evidence');
  if (/截图|screenshot|浏览器|页面|UI/.test(text)) signals.push('runtime_or_ui_evidence');
  return signals.length ? signals : ['natural_language_only'];
}

function buildEvidenceRequirement(stageId, proposalEvidence) {
  const requiredSignals = CODE_DRIVEN_STAGE_EVIDENCE[stageId];
  if (!requiredSignals) {
    return {
      required: false,
      status: 'not_required',
      requiredSignals: [],
      matchedSignals: [],
      reason: '该阶段允许自然语言共识作为主要交付物。',
    };
  }
  const matchedSignals = uniqueStrings(
    (proposalEvidence || []).flatMap((entry) => entry?.signals || []).filter((signal) => requiredSignals.includes(signal)),
    12,
  );
  return {
    required: true,
    status: matchedSignals.length > 0 ? 'passed' : 'insufficient',
    requiredSignals,
    matchedSignals,
    reason: matchedSignals.length > 0
      ? '代码驱动阶段已有命令/文件/UI等硬证据。'
      : '代码驱动阶段缺少命令/文件/UI等硬证据,不能仅靠自然语言共识通过验收。',
  };
}

function buildAcceptanceRequirement(task) {
  if (task?.stageId !== 'acceptance') {
    return {
      required: false,
      status: 'not_required',
      reason: '非交付验收阶段。',
    };
  }
  const summary = task?.acceptanceReport?.summary || null;
  if (!summary) {
    return {
      required: true,
      status: 'insufficient',
      failed: 0,
      insufficient: 1,
      reason: '交付验收阶段缺少系统自动验收表。',
    };
  }
  const failed = Number(summary.failed || 0);
  const insufficient = Number(summary.insufficient || 0);
  return {
    required: true,
    status: failed > 0 || insufficient > 0 ? 'failed' : 'passed',
    failed,
    insufficient,
    passed: Number(summary.passed || 0),
    passedWithRisks: Number(summary.passed_with_risks || 0),
    total: Number(summary.total || 0),
    reason: failed > 0 || insufficient > 0
      ? `自动验收未通过: failed=${failed}, insufficient=${insufficient}; 必须回到对应阶段修复或补齐证据后才能交付。`
      : '自动验收未发现失败或证据不足项。',
  };
}

function stageQualityGateFailure(task, stageArtifact) {
  if (stageArtifact?.evidenceRequirement?.required && stageArtifact.evidenceRequirement.status !== 'passed') {
    return {
      kind: 'evidence',
      reason: `关键阶段「${task.stageLabel || task.title || task.id}」代码驱动证据不足: ${stageArtifact.evidenceRequirement.reason}`,
      evidenceRequirement: stageArtifact.evidenceRequirement,
      canAutoRepair: true,
    };
  }
  if (stageArtifact?.acceptanceRequirement?.required && stageArtifact.acceptanceRequirement.status !== 'passed') {
    return {
      kind: 'acceptance',
      reason: `交付验收阶段「${task.stageLabel || task.title || task.id}」未通过: ${stageArtifact.acceptanceRequirement.reason}`,
      acceptanceRequirement: stageArtifact.acceptanceRequirement,
      canAutoRepair: false,
    };
  }
  return null;
}

function prepareAcceptanceRemediation(taskList, broadcast, roomId, { automatic = false } = {}) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const acceptanceTask = tasks.find((task) => task?.stageId === 'acceptance' && task.blocking === true);
  const failedItem = acceptanceTask?.acceptanceReport?.items?.find((item) => item.verdict === 'failed' || item.verdict === 'insufficient');
  if (!acceptanceTask || !failedItem) return null;
  const targetIndex = tasks.findIndex((task) => task?.stageId === failedItem.stageId);
  const targetTask = tasks[targetIndex];
  if (!targetTask || targetTask === acceptanceTask) return null;
  const feedback = `自动验收未通过,需重跑「${failedItem.stageLabel || failedItem.stageId}」并补齐交付证据。verdict=${failedItem.verdict}`;
  targetTask.status = 'pending';
  targetTask.blocking = false;
  targetTask.qualityGateFeedback = feedback;
  targetTask.qualityGateRepairs = 0;
  const invalidated = [];
  const acceptanceIndex = tasks.indexOf(acceptanceTask);
  for (let i = targetIndex + 1; i < acceptanceIndex; i += 1) {
    const downstreamTask = tasks[i];
    if (!downstreamTask || downstreamTask.stageId === 'acceptance' || downstreamTask.stageId === 'retrospective') continue;
    if (downstreamTask.status === 'done' || downstreamTask.consensus) {
      downstreamTask.status = 'pending';
      downstreamTask.blocking = false;
      downstreamTask.qualityGateFeedback = `上游阶段「${failedItem.stageLabel || failedItem.stageId}」因验收失败已返工,本阶段必须基于最新上游共识重新生成。`;
      downstreamTask.qualityGateRepairs = 0;
      invalidated.push({
        taskId: downstreamTask.id || '',
        stageId: downstreamTask.stageId || '',
        stageLabel: downstreamTask.stageLabel || downstreamTask.title || '',
      });
    }
  }
  acceptanceTask.status = 'pending';
  acceptanceTask.blocking = false;
  acceptanceTask.qualityGateFeedback = `等待前序阶段「${failedItem.stageLabel || failedItem.stageId}」修复后重新验收。`;
  const remediationRecord = {
    generatedAt: new Date().toISOString(),
    automatic,
    targetTaskId: targetTask.id || '',
    targetStageId: targetTask.stageId || '',
    targetStageLabel: targetTask.stageLabel || targetTask.title || '',
    acceptanceTaskId: acceptanceTask.id || '',
    verdict: failedItem.verdict,
    reason: feedback,
    invalidated,
  };
  acceptanceTask.remediationHistory = [
    ...(Array.isArray(acceptanceTask.remediationHistory) ? acceptanceTask.remediationHistory : []),
    remediationRecord,
  ].slice(-20);
  broadcast(roomId, {
    type: 'cv_acceptance_remediation',
    taskId: targetTask.id,
    stageId: targetTask.stageId || '',
    acceptanceTaskId: acceptanceTask.id,
    verdict: failedItem.verdict,
    reason: feedback,
    automatic,
    invalidated,
  });
  return { targetTask, targetIndex, acceptanceTask, failedItem, invalidated, remediationRecord };
}

function normalizeGoalModeState(room = {}, topic = '', options = {}) {
  const prev = room && typeof room.goalMode === 'object' && room.goalMode ? room.goalMode : {};
  const hasExplicit = Object.prototype.hasOwnProperty.call(options || {}, 'goalMode');
  const enabled = hasExplicit ? options.goalMode === true : prev.enabled === true;
  const now = new Date().toISOString();
  return {
    modeVersion: 'cluster-goal-mode-v1',
    ...prev,
    enabled,
    target: String(prev.target || topic || room.topic || room.name || '').slice(0, 4000),
    startedAt: prev.startedAt || now,
    updatedAt: now,
    deliveryReworks: Math.max(0, Number(prev.deliveryReworks) || 0),
    stageReworks: Math.max(0, Number(prev.stageReworks) || 0),
    lastBlockers: Array.isArray(prev.lastBlockers) ? prev.lastBlockers : [],
    lastTargetStageIds: Array.isArray(prev.lastTargetStageIds) ? prev.lastTargetStageIds : [],
  };
}

function deliveryGateBlockers(manifest = {}) {
  return Array.isArray(manifest?.deliveryGate?.blockers) ? manifest.deliveryGate.blockers.filter(Boolean) : [];
}

function goalModeTargetStageIds(manifest = {}) {
  const gate = manifest.deliveryGate || {};
  const blockers = deliveryGateBlockers(manifest);
  const ids = new Set();
  const pushStageList = (list = []) => {
    for (const item of Array.isArray(list) ? list : []) {
      const stageId = String(item?.stageId || '').trim();
      if (stageId) ids.add(stageId);
    }
  };
  pushStageList(gate.failedStages);
  pushStageList(gate.evidenceInsufficientStages);
  pushStageList(gate.incompleteStages);
  pushStageList(gate.signoffIncompleteStages);
  if (blockers.some((item) => /agent_run_evidence_incomplete|code_driven|hard_evidence|evidence/i.test(String(item)))) {
    for (const stageId of GOAL_MODE_CODE_REWORK_STAGE_IDS) ids.add(stageId);
  }
  if (blockers.some((item) => /acceptance|验收/i.test(String(item)))) {
    ids.add('acceptance');
  }
  if (ids.size === 0 && blockers.length > 0) {
    for (const stageId of GOAL_MODE_CODE_REWORK_STAGE_IDS) ids.add(stageId);
    ids.add('acceptance');
  }
  if (ids.size > 0) {
    ids.add('acceptance');
    ids.add('retrospective');
  }
  return [...ids];
}

function goalModeReworkDigest(kind, blockers = [], targetStageIds = []) {
  return createHash('sha1')
    .update(JSON.stringify({
      kind,
      blockers: [...blockers].map(String).sort(),
      targetStageIds: [...targetStageIds].map(String).sort(),
    }))
    .digest('hex')
    .slice(0, 16);
}

function resetTaskForGoalModeRework(task, feedback, record) {
  task.status = 'pending';
  task.blocking = false;
  task.rounds = [];
  task.qualityGateFeedback = feedback;
  task.qualityGateRepairs = 0;
  task.goalModeReworkHistory = [
    ...(Array.isArray(task.goalModeReworkHistory) ? task.goalModeReworkHistory : []),
    record,
  ].slice(-20);
  delete task.consensus;
  delete task.stageArtifact;
  delete task.acceptanceReport;
  delete task.retrospectiveReport;
  delete task.escalateReason;
}

export function prepareGoalModeDeliveryRework({ taskList = [], manifest = {}, topic = '', goalMode = {} } = {}) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const blockers = deliveryGateBlockers(manifest);
  const targetStageIds = goalModeTargetStageIds(manifest);
  if (!tasks.length || !targetStageIds.length) return null;
  const targetSet = new Set(targetStageIds);
  const targetTasks = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => targetSet.has(String(task?.stageId || '').trim()));
  if (!targetTasks.length) return null;
  const now = new Date().toISOString();
  const nextCount = Math.max(0, Number(goalMode.deliveryReworks) || 0) + 1;
  const digest = goalModeReworkDigest('delivery_gate', blockers, targetStageIds);
  const repeatedBlockerCount = goalMode.lastReworkDigest === digest
    ? Math.max(1, Number(goalMode.repeatedBlockerCount) || 1) + 1
    : 1;
  const repeatGuidance = repeatedBlockerCount > 1
    ? `这是同一组阻断第 ${repeatedBlockerCount} 次出现;本轮必须改变策略,缩小验证面,真实运行命令或生成缺失文件,不能重复上一轮文字方案。`
    : '本轮必须直接处理阻断原因。';
  const reason = `目标模式第 ${nextCount} 次自动返工: 交付门禁未通过(${blockers.join('; ') || 'unknown'}). ${repeatGuidance} 必须继续真实完成目标「${String(topic || goalMode.target || '').slice(0, 180)}」,补齐缺失实现、测试、验收和证据;不要只写解释。`;
  const record = { at: now, kind: 'delivery_gate', iteration: nextCount, blockers, targetStageIds, digest, repeatedBlockerCount };
  for (const { task } of targetTasks) resetTaskForGoalModeRework(task, reason, record);
  return {
    reason,
    blockers,
    targetStageIds,
    targetTasks: targetTasks.map(({ task }) => ({
      taskId: task.id || '',
      stageId: task.stageId || '',
      stageLabel: task.stageLabel || task.title || '',
    })),
    restartIndex: Math.min(...targetTasks.map(({ index }) => index)),
    goalMode: {
      modeVersion: 'cluster-goal-mode-v1',
      ...goalMode,
      enabled: true,
      target: String(goalMode.target || topic || '').slice(0, 4000),
      deliveryReworks: nextCount,
      lastReworkDigest: digest,
      repeatedBlockerCount,
      lastBlockers: blockers,
      lastTargetStageIds: targetStageIds,
      updatedAt: now,
    },
  };
}

export function prepareGoalModeStageRework({ taskList = [], blockedTask = null, topic = '', goalMode = {} } = {}) {
  const tasks = Array.isArray(taskList) ? taskList : [];
  const blockedIndex = tasks.findIndex((task) => task === blockedTask || task?.id === blockedTask?.id);
  if (!blockedTask || blockedIndex < 0) return null;
  const now = new Date().toISOString();
  const nextCount = Math.max(0, Number(goalMode.stageReworks) || 0) + 1;
  const targetTasks = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ index }) => index >= blockedIndex);
  const blockers = [blockedTask.escalateReason || 'stage blocked'];
  const targetStageIds = targetTasks.map(({ task }) => task.stageId).filter(Boolean);
  const digest = goalModeReworkDigest('stage_blocked', blockers, targetStageIds);
  const repeatedBlockerCount = goalMode.lastReworkDigest === digest
    ? Math.max(1, Number(goalMode.repeatedBlockerCount) || 1) + 1
    : 1;
  const repeatGuidance = repeatedBlockerCount > 1
    ? `同一阶段阻断已连续出现 ${repeatedBlockerCount} 次;本轮必须换策略,优先产出可运行文件/命令证据/最小可验收切片。`
    : '本轮必须针对阻断原因继续修复。';
  const reason = `目标模式第 ${nextCount} 次阶段返工: 「${blockedTask.stageLabel || blockedTask.title || blockedTask.id}」未完成(${blockedTask.escalateReason || 'stage blocked'}). ${repeatGuidance} 不允许因轮数/输出上限停止;必须继续修复直到目标「${String(topic || goalMode.target || '').slice(0, 180)}」可验收。`;
  const record = {
    at: now,
    kind: 'stage_blocked',
    iteration: nextCount,
    blockers,
    targetStageIds,
    digest,
    repeatedBlockerCount,
  };
  for (const { task } of targetTasks) resetTaskForGoalModeRework(task, reason, record);
  return {
    reason,
    blockers: record.blockers,
    targetStageIds: record.targetStageIds,
    targetTasks: targetTasks.map(({ task }) => ({
      taskId: task.id || '',
      stageId: task.stageId || '',
      stageLabel: task.stageLabel || task.title || '',
    })),
    restartIndex: blockedIndex,
    goalMode: {
      modeVersion: 'cluster-goal-mode-v1',
      ...goalMode,
      enabled: true,
      target: String(goalMode.target || topic || '').slice(0, 4000),
      stageReworks: nextCount,
      lastReworkDigest: digest,
      repeatedBlockerCount,
      lastBlockers: record.blockers,
      lastTargetStageIds: record.targetStageIds,
      updatedAt: now,
    },
  };
}

function uniqueStrings(items, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.slice(0, 500));
    if (out.length >= limit) break;
  }
  return out;
}

export function buildClusterStageArtifact(task, proposalEntries, reviewEntries) {
  const stage = CLUSTER_ENGINEERING_STAGES.find((item) => item.id === task?.stageId) || null;
  const signoffs = reviewEntries.map((entry) => ({
    memberId: entry.memberId,
    adapterId: entry.adapterId || '',
    displayName: entry.displayName || entry.memberId,
    agree: entry.ack?.agree === true,
    reasoning: String(entry.ack?.reasoning || '').slice(0, 1000),
  }));
  const reviewRisks = reviewEntries.flatMap((entry) => [
    ...(entry.ack?.critical_issues || []),
    ...(entry.ack?.suggestions || []),
  ]);
  const proposalEvidence = proposalEntries.map((entry) => ({
    memberId: entry.memberId,
    adapterId: entry.adapterId || '',
    displayName: entry.displayName || entry.memberId,
    planChars: String(entry.plan || '').length,
    signals: evidenceSignals(entry.plan),
    ...evidenceDetails(entry.plan),
  }));
  const evidenceRequirement = buildEvidenceRequirement(task?.stageId || '', proposalEvidence);
  const acceptanceRequirement = buildAcceptanceRequirement(task);
  const artifact = {
    stageId: task?.stageId || '',
    stageLabel: task?.stageLabel || task?.title || '',
    stageIndex: task?.stageIndex || null,
    deliverables: uniqueStrings([stage?.deliverable || task?.title || '阶段交付物']),
    gates: [{
      label: stage?.gate || '所有成员显式同意',
      status: signoffs.every((entry) => entry.agree) ? 'passed' : 'pending',
    }],
    evidenceRequirement,
    acceptanceRequirement,
    evidence: proposalEvidence,
    signoffs,
    risks: uniqueStrings(reviewRisks),
  };
  if (task?.acceptanceReport) artifact.acceptanceReport = task.acceptanceReport;
  if (task?.retrospectiveReport) artifact.retrospectiveReport = task.retrospectiveReport;
  return artifact;
}

function makeMemberRef(member, index) {
  const adapterId = String(member.adapterId || `member-${index + 1}`);
  return {
    member,
    index,
    key: `${adapterId}#${index + 1}`,
    adapterId,
    displayName: member.displayName || adapterId,
    model: member.model || '',
  };
}

function memberFailoverReason(error) {
  const text = String(error?.message || error || 'unknown_error').slice(0, 500);
  if (/quota|rate.?limit|resource_exhausted|insufficient_quota|429|额度|配额|限流/i.test(text)) return `额度/限流: ${text}`;
  if (/timeout|timed out|超时/i.test(text)) return `超时: ${text}`;
  if (/abort|中断|cancel/i.test(text)) return `中断: ${text}`;
  if (/unavailable|not registered|spawn|enoent|econn|fetch failed|network|offline|不可用|掉线/i.test(text)) return `连接/运行时不可用: ${text}`;
  return text;
}

function removesSharedPanelMcp(value) {
  return !/面板启用|面板已叠加\s*MCP|面板临时\s*profile|panel[-_ ]?mcp|shared\s*mcp/i.test(String(value || ''));
}

export function isolateClusterNativeCapabilities(capabilityInput = null) {
  if (!capabilityInput || typeof capabilityInput !== 'object') return capabilityInput;
  const isolated = {
    ...capabilityInput,
    mcp: Array.isArray(capabilityInput.mcp)
      ? capabilityInput.mcp.filter(removesSharedPanelMcp)
      : capabilityInput.mcp,
    bridges: Array.isArray(capabilityInput.bridges)
      ? capabilityInput.bridges.filter(removesSharedPanelMcp)
      : capabilityInput.bridges,
    notes: [
      ...(Array.isArray(capabilityInput.notes) ? capabilityInput.notes : []),
      '集群协同本轮禁用面板共享 MCP 注入;成员只使用各自 CLI/账号/本机配置原本可见的原生工具、插件、Skill 或 MCP。',
    ],
  };
  if (String(capabilityInput.providerId || '').toLowerCase() === 'codex') {
    isolated.bridges = [
      ...(Array.isArray(isolated.bridges) ? isolated.bridges : []),
      'Codex App 插件桥接: 集群协同本轮不叠加面板共享 MCP;仅保留 Codex CLI base config 与 Codex 运行时原生暴露能力。',
    ];
  }
  return isolated;
}

function activeMemberRefsForRoom(room, members) {
  const dropped = new Set((Array.isArray(room?.clusterDroppedMembers) ? room.clusterDroppedMembers : [])
    .filter((item) => item && item.recoverable !== true)
    .map((item) => item.memberKey || `${item.adapterId || ''}#${item.memberIndex || ''}`));
  return members
    .map(makeMemberRef)
    .filter((ref) => !dropped.has(ref.key));
}

export function recoverDroppedMembersForResume(room = {}, options = {}) {
  if (options?.resume !== true) return { changed: false, patch: {} };
  const members = Array.isArray(room.members) ? room.members.filter((member) => member?.enabled !== false) : [];
  if (members.length === 0) return { changed: false, patch: {} };
  const droppedMembers = Array.isArray(room.clusterDroppedMembers) ? room.clusterDroppedMembers : [];
  if (droppedMembers.length === 0) return { changed: false, patch: {} };
  if (activeMemberRefsForRoom(room, members).length > 0) return { changed: false, patch: {} };

  const now = new Date().toISOString();
  const source = isAutomaticClusterResume(options) ? 'auto_resume' : 'manual_resume';
  const reason = `${source}_all_members_previously_dropped`;
  const recoveredAdapterIds = [];
  const clusterDroppedMembers = droppedMembers.map((item) => {
    if (!item || item.recoverable === true) return item;
    recoveredAdapterIds.push(String(item.adapterId || '').trim());
    return {
      ...item,
      recoverable: true,
      recoveredAt: now,
      recoveryReason: reason,
    };
  });
  const recoveryEvent = {
    eventVersion: 'cluster-dropped-member-recovery-v1',
    at: now,
    source,
    reason,
    recoveredAdapterIds: [...new Set(recoveredAdapterIds.filter(Boolean))],
    previousDroppedCount: droppedMembers.length,
  };
  return {
    changed: true,
    recoveredAdapterIds: recoveryEvent.recoveredAdapterIds,
    patch: {
      clusterDroppedMembers,
      clusterMemberRecoveryEvents: [
        ...(Array.isArray(room.clusterMemberRecoveryEvents) ? room.clusterMemberRecoveryEvents : []),
        recoveryEvent,
      ].slice(-50),
      clusterDroppedMemberRecovery: recoveryEvent,
    },
  };
}

function buildRuntimePersistPending(error) {
  return {
    reason: 'cross_verify_runtime_persist_failed',
    flushError: String(error?.message || error || 'unknown'),
    at: new Date().toISOString(),
  };
}

export function recoverStartupTimeoutMembers(room = {}) {
  const timeoutIds = new Set((room?.clusterStartupLiveCheck?.checks || [])
    .filter((check) => check?.passed !== true
      && Array.isArray(check.blockers)
      && check.blockers.length > 0
      && check.blockers.every((blocker) => blocker === 'live_ping_timeout'))
    .map((check) => String(check.adapterId || '').trim())
    .filter(Boolean));
  if (timeoutIds.size === 0) return { changed: false, patch: {} };

  let changed = false;
  const members = Array.isArray(room.members)
    ? room.members.map((member) => {
        const adapterId = String(member?.adapterId || '').trim();
        if (!timeoutIds.has(adapterId) || member?.failoverReason !== 'startup_live_check_failed') return member;
        changed = true;
        const { failoverDisabled, failoverReason, ...rest } = member;
        void failoverDisabled;
        void failoverReason;
        return { ...rest, enabled: true };
      })
    : room.members;
  const clusterDroppedMembers = Array.isArray(room.clusterDroppedMembers)
    ? room.clusterDroppedMembers.filter((item) => {
        const recover = timeoutIds.has(String(item?.adapterId || '').trim())
          && item?.reason === 'startup_live_check_failed';
        if (recover) changed = true;
        return !recover;
      })
    : room.clusterDroppedMembers;
  const clusterStartupDegradedMembers = Array.isArray(room.clusterStartupDegradedMembers)
    ? room.clusterStartupDegradedMembers.filter((item) => {
        const recover = timeoutIds.has(String(item?.adapterId || '').trim())
          && item?.reason === 'startup_live_check_failed';
        if (recover) changed = true;
        return !recover;
      })
    : room.clusterStartupDegradedMembers;

  if (!changed) return { changed: false, patch: {} };
  return {
    changed: true,
    recoveredAdapterIds: [...timeoutIds],
    patch: {
      members,
      clusterDroppedMembers,
      clusterStartupDegradedMembers,
      clusterStartupTimeoutRecoveredAt: new Date().toISOString(),
    },
  };
}

function failoverContextLine(task = {}) {
  const records = Array.isArray(task.memberFailovers) ? task.memberFailovers.slice(-5) : [];
  if (!records.length) return '';
  return records
    .map((item) => `- ${item.displayName || item.adapterId || item.memberKey} 在 ${item.phase || 'unknown'} 掉线/不可用: ${item.reason || 'unknown'}; 剩余成员: ${(item.remainingMembers || []).join(', ') || '无'}`)
    .join('\n');
}

function userInjectionContextLine(task = {}) {
  const records = Array.isArray(task.userInjections) ? task.userInjections.slice(-8) : [];
  if (!records.length) return '';
  return records
    .map((item) => `- ${item.at ? `[${String(item.at).slice(0, 19)}] ` : ''}${String(item.content || '').slice(0, 4000)}`)
    .join('\n');
}

// 一致提案 prompt:第 1 轮独立写,2+ 轮基于对方反馈修订
function PROPOSE_PROMPT(task, topic, myPrevPlan, otherPrevPlan, otherAck, round) {
  const isRedo = round > 1;
  const failoverContext = failoverContextLine(task);
  const userInjectionContext = userInjectionContextLine(task);
  return `# 你的角色:集群协同开发者(与其他成员对等,不是 boss 也不是 worker)

## 🎯 任务
${task.title || topic}

## 📝 描述
${task.desc || topic}

${userInjectionContext ? `## 🆕 中途追加需求 / 用户最新指示\n${userInjectionContext}\n\n要求:上述新增需求优先级高于旧计划;如与旧方案冲突,必须说明取舍并把后续实现、验证和验收同步调整。\n` : ''}

${task.stageId ? `## 🧩 当前闭环阶段契约\n${formatStageContract(CLUSTER_ENGINEERING_STAGES.find((stage) => stage.id === task.stageId))}\n` : ''}

${task.priorStageContext ? `## 🔗 前序阶段共识链\n${task.priorStageContext}\n` : ''}

${task.acceptanceReport ? `## ✅ 系统自动验收表\n\`\`\`json\n${JSON.stringify(task.acceptanceReport, null, 2).slice(0, 12000)}\n\`\`\`\n` : ''}

${task.retrospectiveReport ? `## 🔁 系统自动复盘改进 backlog\n\`\`\`json\n${JSON.stringify(task.retrospectiveReport, null, 2).slice(0, 12000)}\n\`\`\`\n` : ''}

${task.qualityGateFeedback ? `## 🧯 质量门自动修复要求\n${task.qualityGateFeedback}\n\n这一轮必须直接修复上述问题,补齐缺失的命令/文件/UI硬证据。不能只解释原因。\n` : ''}

${failoverContext ? `## 🧯 成员故障转移 / 自动接手\n${failoverContext}\n\n要求:剩余成员必须自动讨论并接手掉线成员职责;如果只剩你一个成员,不要停,直接以单模型接管模式继续把当前阶段做完,但要明确记录接手范围和风险。\n` : ''}

## 🧭 必须覆盖的工程闭环
完整项目会按下面链路串行推进。你当前只需要把本阶段做深、做实,并说明与前后阶段的衔接:
${formatClusterEngineeringStages()}

${isRedo ? `## 🔁 这是第 ${round} 轮(上一轮双方未达成一致)

### 你上一轮的方案
\`\`\`
${(myPrevPlan || '').slice(0, 8000)}
\`\`\`

### 对方对你方案的评价
- agree: ${otherAck?.agree ? '✅ 同意' : '❌ 不同意'}
- reasoning: ${otherAck?.reasoning || '(无)'}
- suggestions: ${(otherAck?.suggestions || []).map((s, i) => `\n  ${i + 1}. ${s}`).join('') || '(无)'}
- critical_issues: ${(otherAck?.critical_issues || []).map((s, i) => `\n  ${i + 1}. ${s}`).join('') || '(无)'}

### 对方上一轮的方案(供你参考其思路)
\`\`\`
${(otherPrevPlan || '').slice(0, 8000)}
\`\`\`

⚠️ 请基于上述对方反馈**修订**你的方案。如果你坚持原方案某点,在新方案里**明确说明为何不采纳对方建议**(理由要硬,不要为反对而反对)。
` : `请**独立**给出你的方案,不要看其他成员答案(他们也在同时独立写各自方案)。`}

## 📤 输出格式
中文 markdown,必须含 2 节:

### 实现 / 方案
(具体代码 / 命令 / 设计;写文件给出路径 + 完整内容;跑命令给出实测输出;并明确上述工程闭环每一阶段如何落地)

### 📋 文件落地验证(**必填**,防止"报告 ≠ 实际"幻觉)
如果你这一步**修改/创建了文件**,必须用 \`cat <文件>\` 或 \`wc -l\` 真读出磁盘内容贴出来。
未写文件时写一句"本步未写文件"。
对方会比对你"实现/方案"段的代码 vs 这一段的真实文件内容,**严重不符 = 不同意**。

## ⛔ 边界
- 你有文件系统 + shell 权限,**真去做**(写文件 / 跑命令验证)
- 输出**只**markdown,不嵌 JSON 不嵌额外说明`;
}

// 互审 prompt:看对方方案,显式 agree/disagree + 理由
function REVIEW_PROMPT(task, topic, otherPlan, round) {
  const failoverContext = failoverContextLine(task);
  const userInjectionContext = userInjectionContextLine(task);
  return `# 你的角色:协作开发者(评审对等成员的方案)

## 🎯 任务
${task.title || topic}

## 📝 描述
${task.desc || topic}

${userInjectionContext ? `## 🆕 中途追加需求 / 用户最新指示\n${userInjectionContext}\n\n评审时必须检查对方方案是否吸收这些新增需求;没有吸收且无合理解释时应 disagree。\n` : ''}

## 🔍 对方第 ${round} 轮的方案
\`\`\`
${(otherPlan || '').slice(0, 12000)}
\`\`\`

${failoverContext ? `## 🧯 成员故障转移 / 自动接手\n${failoverContext}\n\n评审时必须判断剩余成员是否已经覆盖掉线成员职责;如果只剩一个成员,以能否继续完成任务作为判定标准。\n` : ''}

## 📤 评审输出
**严格 JSON**(不要 markdown 围栏不要前后说明文字):
{
  "agree": true | false,
  "reasoning": "1-3 句中文,客观说明为何同意/不同意。一致 = 任务能完成、方案正确、无严重 bug。",
  "suggestions": ["具体改进建议 1", "..."],
  "critical_issues": ["关键问题(若 agree=false 至少列 1 条)", "..."]
}

## 🎚 判定标准(A 方案:互相显式签字)
- agree=true 仅在你**真心认可**对方方案能完成任务,无关键 bug、无幻觉(代码 = 实际文件)
- agree=false 时,critical_issues 必填(让对方有方向修订)
- **不要委曲求全说"基本可以"**——你的 agree 是产品质量门,严就要真严
- 但也不要为反对而反对——对方方案若客观正确,明确同意`;
}

function CLUSTER_REVIEW_PROMPT(task, topic, proposals, selfId, round) {
  const failoverContext = failoverContextLine(task);
  const userInjectionContext = userInjectionContextLine(task);
  const proposalText = proposals
    .filter((p) => p.memberId !== selfId)
    .map((p, i) => `## 方案 ${i + 1}: ${p.displayName || p.memberId}\n\`\`\`\n${String(p.plan || '').slice(0, 12000)}\n\`\`\``)
    .join('\n\n');
  return `# 你的角色:集群协同评审者(与其他成员对等)

## 🎯 任务
${task.title || topic}

## 📝 描述
${task.desc || topic}

${userInjectionContext ? `## 🆕 中途追加需求 / 用户最新指示\n${userInjectionContext}\n\n评审时必须检查其他成员是否吸收这些新增需求;没有吸收且无合理解释时应 disagree。\n` : ''}

## 🔍 其他成员第 ${round} 轮方案
${proposalText || '(无其他方案)'}

${failoverContext ? `## 🧯 成员故障转移 / 自动接手\n${failoverContext}\n\n评审时必须判断剩余成员是否已经覆盖掉线成员职责,并给出是否可以继续推进的明确结论。\n` : ''}

## 📤 评审输出
**严格 JSON**(不要 markdown 围栏不要前后说明文字):
{
  "agree": true | false,
  "reasoning": "1-3 句中文,客观说明你是否认可当前集群方案集合。agree=true 表示这些方案合并后能完成任务,无关键 bug。",
  "suggestions": ["具体改进建议 1", "..."],
  "critical_issues": ["关键问题(若 agree=false 至少列 1 条)", "..."]
}

## 🎚 判定标准
- agree=true 仅在你认可当前方案集合能完成任务,且没有关键 bug/幻觉/落地缺口
- agree=false 时 critical_issues 必填,给出下一轮修订方向
- 不要为反对而反对;也不要为了尽快结束而放水`;
}

function isAutomaticClusterResume(options = {}) {
  const source = String(options.resumeSource || options.source || '').toLowerCase();
  return options.autoResume === true || source === 'auto' || source === 'autopilot' || source === 'watchdog';
}

function assertClusterRuntimeResumeAllowed(room = {}, options = {}) {
  if (!isAutomaticClusterResume(options)) return;
  const policy = room.clusterRuntimeResumePolicy || {};
  if (policy.autoResumeAllowed !== false) return;
  const count = Number(policy.stallRecoveryCount) || 0;
  const max = Number(policy.maxStallRecoveries) || 0;
  const err = new Error(`cluster_auto_resume_blocked:stalled_recovery_limit ${count}/${max}`);
  err.code = 'cluster_auto_resume_blocked';
  err.resumePolicy = policy;
  throw err;
}

export function isClusterRoomStatusRunning(status) {
  return ['running', 'debating', 'active', 'processing'].includes(String(status || '').trim().toLowerCase());
}

export function buildClusterRuntimeState(room = {}, options = {}) {
  const tasks = Array.isArray(room.taskList) ? room.taskList : [];
  const taskCounts = {};
  for (const task of tasks) {
    const status = String(task?.status || 'pending').trim() || 'pending';
    taskCounts[status] = (taskCounts[status] || 0) + 1;
  }
  const roomStatus = String(room.status || 'idle').trim() || 'idle';
  const isRunning = isClusterRoomStatusRunning(roomStatus);
  const blockingTask = tasks.find((task) => task?.blocking === true || task?.status === 'escalated' || task?.status === 'blocked') || null;
  const activeTask = tasks.find((task) => task?.status === 'running') || blockingTask || tasks.find((task) => task?.status === 'paused') || null;
  const deliveryStatus = room.clusterDeliveryPackage?.status
    || room.clusterDeliveryManifest?.overallStatus
    || room.clusterDeliveryManifest?.deliveryGate?.status
    || '';
  const hasDeliverySnapshot = Boolean(room.clusterDeliveryPackage || room.clusterDeliveryManifest || room.clusterDeliveryReportMarkdown);
  const phase = isRunning
    ? 'running'
    : roomStatus === 'done'
      ? 'done'
      : roomStatus === 'error'
        ? 'error'
        : roomStatus === 'paused' || roomStatus === 'auto_paused'
          ? (blockingTask ? 'blocked' : 'paused')
          : 'idle';
  return {
    statusVersion: 'cluster-runtime-state-v1',
    generatedAt: new Date().toISOString(),
    event: options.event || room.clusterRuntimeHeartbeat?.lastEvent || '',
    roomStatus,
    phase,
    isRunning,
    canStart: !isRunning,
    canResume: ['paused', 'blocked', 'error'].includes(phase),
    taskSummary: {
      total: tasks.length,
      counts: taskCounts,
      activeTaskId: activeTask?.id || '',
      activeStageId: activeTask?.stageId || '',
      activeStageLabel: activeTask?.stageLabel || activeTask?.title || '',
      blockingTaskId: blockingTask?.id || '',
      blockingStageId: blockingTask?.stageId || '',
      blockingReason: blockingTask?.escalateReason || '',
    },
    heartbeat: room.clusterRuntimeHeartbeat ? {
      lastProgressAt: room.clusterRuntimeHeartbeat.lastProgressAt || '',
      lastEvent: room.clusterRuntimeHeartbeat.lastEvent || '',
      taskId: room.clusterRuntimeHeartbeat.taskId || '',
      stageId: room.clusterRuntimeHeartbeat.stageId || '',
      round: room.clusterRuntimeHeartbeat.round || 0,
      adapterId: room.clusterRuntimeHeartbeat.adapterId || '',
      turn: room.clusterRuntimeHeartbeat.turn || '',
      status: room.clusterRuntimeHeartbeat.status || '',
    } : null,
    telemetry: room.clusterRuntimeTelemetry ? {
      calls: room.clusterRuntimeTelemetry.calls || 0,
      succeededCalls: room.clusterRuntimeTelemetry.succeededCalls || 0,
      failedCalls: room.clusterRuntimeTelemetry.failedCalls || 0,
      totalTokens: room.clusterRuntimeTelemetry.totalTokens || 0,
      avgLatencyMs: room.clusterRuntimeTelemetry.avgLatencyMs || 0,
    } : null,
    delivery: {
      status: deliveryStatus,
      present: hasDeliverySnapshot,
      stale: isRunning && hasDeliverySnapshot,
      readyForArchive: Boolean(room.clusterDeliveryPackage?.readyForArchive),
    },
    droppedMemberCount: Array.isArray(room.clusterDroppedMembers) ? room.clusterDroppedMembers.length : 0,
  };
}

export class CrossVerifyDispatcher {
  constructor({
    store,
    adapters,
    broadcast,
    metrics,
    maxRounds = MAX_ROUNDS,
    runtimeBudgetLimits = {},
    agentRunStore = null,
    memberCallTimeoutMs = null,
  }) {
    this.store = store;
    this.adapters = adapters;
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics;
    this.maxRounds = maxRounds;
    this.runtimeBudgetLimits = runtimeBudgetLimits || {};
    this.agentRunStore = agentRunStore;
    this.memberCallTimeoutMs = memberCallTimeoutMs;
    this.activeAborts = new Map(); // roomId → AbortController
    this.activeRunIds = new Map(); // roomId → Symbol, prevents stale run cleanup from touching a newer run
  }

  _isActiveRun(roomId, aborter, runId) {
    return this.activeAborts.get(roomId) === aborter && this.activeRunIds.get(roomId) === runId;
  }

  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.store.setStatus(roomId, 'paused');
      this._markRuntimeProgress(roomId, 'user_abort');
      this._persist(roomId);
      this.broadcast(roomId, { type: 'cross_verify_paused', reason: 'user_abort' });
      return true;
    }
    return false;
  }

  _markRuntimeProgress(roomId, event, details = {}) {
    const room = this.store.get(roomId);
    if (!room) return;
    const now = new Date().toISOString();
    const prev = room.clusterRuntimeHeartbeat || {};
    const heartbeat = {
      ...prev,
      ...details,
      statusVersion: 'cluster-runtime-heartbeat-v1',
      startedAt: prev.startedAt || now,
      lastProgressAt: now,
      lastEvent: event,
    };
    try {
      this.store.update(roomId, {
        clusterRuntimeHeartbeat: heartbeat,
        clusterRuntimeState: buildClusterRuntimeState({ ...room, clusterRuntimeHeartbeat: heartbeat }, { event }),
      });
    } catch (e) {
      try {
        this.broadcast(roomId, {
          type: 'cross_verify_heartbeat_update_failed',
          error: e?.message || String(e),
          event,
        });
      } catch {}
    }
  }

  _syncRuntimeState(roomId, event = 'state_sync') {
    const room = this.store.get(roomId);
    if (!room) return null;
    const clusterRuntimeState = buildClusterRuntimeState(room, { event });
    this.store.update(roomId, { clusterRuntimeState });
    return clusterRuntimeState;
  }

  async retryTask(roomId, taskId, options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (!taskId || typeof taskId !== 'string') throw new Error('taskId required');
    if (!room.topic) throw new Error('该房尚未启动过,无法重试 task');
    const taskList = Array.isArray(room.taskList) ? room.taskList : [];
    const targetIndex = taskList.findIndex((task) => task?.id === taskId);
    if (targetIndex < 0) throw new Error('task not found: ' + taskId);

    if (room.status === 'running' || this.activeAborts.has(roomId)) {
      this.abort(roomId);
    }

    const resetAt = new Date().toISOString();
    const nextTaskList = taskList.map((task, index) => {
      if (index < targetIndex) return task;
      const next = {
        ...task,
        status: 'pending',
        judgement: null,
        decision: null,
        verdict: null,
        blocking: null,
        blockingReasons: [],
        blockingReason: '',
        evidence: [],
        evidenceSummary: null,
        memberOutputs: [],
        memberReviews: [],
        memberSignoffs: [],
        signoffs: [],
        rounds: [],
        attempts: [],
        result: '',
        output: '',
        summary: '',
        artifacts: [],
        agentRuns: [],
        updatedAt: resetAt,
      };
      delete next.error;
      delete next.errorMessage;
      delete next.escalateReason;
      delete next.qualityGateFeedback;
      delete next.stageArtifact;
      delete next.acceptanceReport;
      delete next.retrospectiveReport;
      delete next.deliveryReport;
      delete next.completedAt;
      delete next.startedAt;
      return next;
    });

    this.store.update(roomId, {
      status: 'paused',
      taskList: nextTaskList,
      clusterWorkflowAudit: null,
      clusterDeliveryManifest: null,
      clusterDeliveryReportMarkdown: '',
      clusterDeliveryPackage: null,
      clusterRuntimeOutput: [],
      clusterRuntimeTelemetry: emptyClusterRuntimeTelemetry(),
      clusterRuntimeBudgetStatus: null,
      clusterRuntimeHeartbeat: {
        statusVersion: 'cluster-runtime-heartbeat-v1',
        startedAt: resetAt,
        lastProgressAt: resetAt,
        lastEvent: 'manual_retry_reset',
        taskId,
      },
      clusterRuntimeState: null,
      clusterDroppedMembers: [],
      clusterMemberFailovers: [],
    });
    this.broadcast(roomId, { type: 'cross_verify_retry_reset', taskId, resetFromIndex: targetIndex });
    return this.resume(roomId, {
      ...options,
      resumeSource: options.resumeSource || 'retry_task',
      retryTaskId: taskId,
    });
  }

  async resume(roomId, options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room already running');
    if (!room.topic) throw new Error('该房尚未启动过,无法续跑');
    assertClusterRuntimeResumeAllowed(room, options);
    return this.start(roomId, room.topic, { resume: true, ...options });
  }

  async start(roomId, topic, _options = {}) {
    let room = this.store.get(roomId);
    if (!room) throw new Error('room not found: ' + roomId);
    if (room.status === 'running') throw new Error('room already running');
    const existingAborter = this.activeAborts.get(roomId);
    if (existingAborter) {
      if (existingAborter.signal?.aborted) {
        this.activeAborts.delete(roomId);
        this.activeRunIds.delete(roomId);
      }
      else throw new Error('room already running');
    }

    const timeoutRecovery = recoverStartupTimeoutMembers(room);
    if (timeoutRecovery.changed) {
      this.store.update(roomId, timeoutRecovery.patch);
      room = { ...room, ...timeoutRecovery.patch };
      this.broadcast(roomId, {
        type: 'cv_startup_timeout_members_recovered',
        adapterIds: timeoutRecovery.recoveredAdapterIds,
      });
    }

    const droppedRecovery = recoverDroppedMembersForResume(room, _options);
    if (droppedRecovery.changed) {
      this.store.update(roomId, droppedRecovery.patch);
      room = { ...room, ...droppedRecovery.patch };
      this.broadcast(roomId, {
        type: 'cv_dropped_members_recovered',
        adapterIds: droppedRecovery.recoveredAdapterIds,
        reason: room.clusterDroppedMemberRecovery?.reason || 'resume_all_members_previously_dropped',
      });
    }

    const enabledMembers = (room.members || []).filter((m) => m.enabled !== false);
    if (enabledMembers.length < 1) {
      this.store.setStatus(roomId, 'error');
      this._persist(roomId);
      this.broadcast(roomId, { type: 'cross_verify_error', error: '集群协同至少需要 1 个可用成员' });
      throw new Error('集群协同至少需要 1 个可用成员');
    }

    let goalModeState = normalizeGoalModeState(room, topic, _options);
    const aborter = new AbortController();
    const runId = Symbol(`cross_verify:${roomId}`);
    const isCurrentRun = () => this._isActiveRun(roomId, aborter, runId);
    const startedAt = new Date().toISOString();
    this.activeAborts.set(roomId, aborter);
    this.activeRunIds.set(roomId, runId);
    this.store.update(roomId, {
      topic,
      status: 'running',
      goalMode: goalModeState,
      taskList: room.taskList || [],
      clusterWorkflowAudit: null,
      clusterDeliveryManifest: null,
      clusterDeliveryReportMarkdown: '',
      clusterDeliveryPackage: null,
      clusterRuntimeTelemetry: _options?.resume === true
        ? (room.clusterRuntimeTelemetry || emptyClusterRuntimeTelemetry())
        : emptyClusterRuntimeTelemetry(),
      clusterRuntimeHeartbeat: {
        statusVersion: 'cluster-runtime-heartbeat-v1',
        startedAt,
        lastProgressAt: startedAt,
        lastEvent: _options?.resume === true ? 'resume_start' : 'start',
        topic,
      },
    });
    this._persist(roomId);
    this.broadcast(roomId, { type: 'cross_verify_start', topic });

    try {
      const isResume = _options?.resume === true;
      const taskList = room.taskList?.length ? room.taskList : buildClusterEngineeringTaskList(topic);
      let acceptanceRemediationHistory = Array.isArray(room.acceptanceRemediationHistory) ? [...room.acceptanceRemediationHistory] : [];
      const recordAcceptanceRemediation = (remediation) => {
        if (!remediation?.remediationRecord) return;
        acceptanceRemediationHistory = [...acceptanceRemediationHistory, remediation.remediationRecord].slice(-20);
        this.store.update(roomId, { acceptanceRemediationHistory });
      };
      if (isResume) recordAcceptanceRemediation(prepareAcceptanceRemediation(taskList, this.broadcast, roomId));
      let acceptanceAutoRemediations = Number(room.acceptanceAutoRemediations || 0);
      if (isResume) {
        for (const task of taskList) {
          if (task?.status !== 'running') continue;
          task.status = 'pending';
          task.blocking = false;
          task.qualityGateFeedback = task.qualityGateFeedback || '上次运行在服务重启/中断时停留在 running 状态;目标模式/续跑将从本阶段重新执行,直到完成或遇到硬阻断。';
        }
      }
      // bug 修复:必须先把 taskList 写回 room,否则 _runTaskCrossVerify 中 _persist 调
      // store.get(roomId).taskList 拿不到(undefined),中间 abort/escalated 状态丢失.
      this.store.update(roomId, { taskList, acceptanceAutoRemediations, acceptanceRemediationHistory, goalMode: goalModeState });

      while (!aborter.signal.aborted) {
        for (let taskIndex = 0; taskIndex < taskList.length; taskIndex += 1) {
          const task = taskList[taskIndex];
          if (aborter.signal.aborted) break;
          if (task.status === 'done') continue;
          if (isResume && task.blocking === true && task.status === 'escalated') {
            task.qualityGateFeedback = task.qualityGateFeedback || task.escalateReason || '上次质量门失败,请补齐硬证据后继续。';
            task.qualityGateRepairs = 0;
            task.blocking = false;
            task.status = 'pending';
            this.broadcast(roomId, {
              type: 'cv_quality_gate_resume',
              taskId: task.id,
              stageId: task.stageId || '',
              reason: task.qualityGateFeedback,
            });
          }
          task.priorStageContext = buildPriorStageContext(taskList, task);
          if (task.stageId === 'acceptance') {
            task.acceptanceReport = buildClusterAcceptanceReport(taskList, task);
          }
          if (task.stageId === 'retrospective') {
            task.retrospectiveReport = buildClusterRetrospectiveReport(taskList, task);
          }
          await this._runTaskCrossVerify(roomId, task, topic, enabledMembers, aborter.signal);
          if (aborter.signal.aborted || task.status === 'paused') break;
          if (task.blocking === true) {
            if (task.stageId === 'acceptance' && (goalModeState.enabled || acceptanceAutoRemediations < MAX_ACCEPTANCE_AUTO_REMEDIATIONS)) {
              const remediation = prepareAcceptanceRemediation(taskList, this.broadcast, roomId, { automatic: true });
              if (remediation) {
                recordAcceptanceRemediation(remediation);
                acceptanceAutoRemediations += 1;
                this.store.update(roomId, { taskList, acceptanceAutoRemediations, acceptanceRemediationHistory, goalMode: goalModeState });
                this._persist(roomId);
                this.broadcast(roomId, {
                  type: 'cv_acceptance_auto_rework',
                  taskId: remediation.targetTask.id,
                  stageId: remediation.targetTask.stageId || '',
                  acceptanceTaskId: remediation.acceptanceTask.id,
                  pass: acceptanceAutoRemediations,
                  maxPasses: goalModeState.enabled ? null : MAX_ACCEPTANCE_AUTO_REMEDIATIONS,
                  verdict: remediation.failedItem.verdict,
                  reason: remediation.targetTask.qualityGateFeedback,
                  invalidated: remediation.invalidated,
                });
                taskIndex = Math.max(-1, remediation.targetIndex - 1);
                continue;
              }
            }
            break;
          }
        }

        const clusterWorkflowAudit = buildClusterWorkflowAudit(taskList);
        const clusterDeliveryManifest = buildClusterDeliveryManifest({
          room: this.store.get(roomId),
          taskList,
          audit: clusterWorkflowAudit,
          topic,
        });
        const clusterDeliveryReportMarkdown = buildClusterDeliveryReportMarkdown(clusterDeliveryManifest);
        const clusterDeliveryPackage = buildClusterDeliveryPackage(clusterDeliveryManifest, clusterDeliveryReportMarkdown);
        this.store.update(roomId, { taskList, clusterWorkflowAudit, clusterDeliveryManifest, clusterDeliveryReportMarkdown, clusterDeliveryPackage, goalMode: goalModeState });
        this._syncRuntimeState(roomId, 'delivery_snapshot_updated');
        const blockedTask = taskList.find((task) => task.blocking === true && task.status === 'escalated');
        const pausedTask = taskList.find((task) => task.status === 'paused');
        if (!isCurrentRun()) break;
        if (aborter.signal.aborted || pausedTask) {
          this.store.setStatus(roomId, 'paused');
          this._markRuntimeProgress(roomId, 'paused');
          this._persist(roomId);
          break;
        } else if (blockedTask) {
          if (goalModeState.enabled) {
            const rework = prepareGoalModeStageRework({ taskList, blockedTask, topic, goalMode: goalModeState });
            if (rework) {
              goalModeState = rework.goalMode;
              this.store.update(roomId, { taskList, goalMode: goalModeState });
              this.broadcast(roomId, {
                type: 'cv_goal_mode_rework',
                reason: 'stage_blocked',
                message: rework.reason,
                blockers: rework.blockers,
                targetStageIds: rework.targetStageIds,
                targetTasks: rework.targetTasks,
              });
              continue;
            }
          }
          this.store.setStatus(roomId, 'paused');
          this._markRuntimeProgress(roomId, 'quality_gate_paused', { taskId: blockedTask.id, stageId: blockedTask.stageId || '' });
          this._persist(roomId);
          this.broadcast(roomId, {
            type: 'cross_verify_paused',
            reason: 'quality_gate_failed',
            taskId: blockedTask.id,
            error: blockedTask.escalateReason || '关键阶段质量门未通过',
          });
          break;
        } else if (hasCompleteClusterEngineeringLifecycle(taskList) && clusterDeliveryManifest.deliveryGate?.status !== 'passed') {
          if (goalModeState.enabled) {
            const rework = prepareGoalModeDeliveryRework({ taskList, manifest: clusterDeliveryManifest, topic, goalMode: goalModeState });
            if (rework) {
              goalModeState = rework.goalMode;
              this.store.update(roomId, { taskList, goalMode: goalModeState });
              this.broadcast(roomId, {
                type: 'cv_goal_mode_rework',
                reason: 'delivery_gate_blocked',
                message: rework.reason,
                blockers: rework.blockers,
                targetStageIds: rework.targetStageIds,
                targetTasks: rework.targetTasks,
              });
              continue;
            }
          }
          this.store.setStatus(roomId, 'paused');
          this._markRuntimeProgress(roomId, 'delivery_gate_paused');
          this._persist(roomId);
          this.broadcast(roomId, {
            type: 'cross_verify_paused',
            reason: 'delivery_gate_blocked',
            blockers: clusterDeliveryManifest.deliveryGate?.blockers || [],
            error: `交付门禁未通过: ${(clusterDeliveryManifest.deliveryGate?.blockers || []).join(', ') || 'unknown'}`,
          });
          break;
        } else {
          this.store.setStatus(roomId, 'done');
          this._markRuntimeProgress(roomId, 'done');
          this._persist(roomId);
          this.broadcast(roomId, { type: 'cross_verify_done' });
          break;
        }
      }
    } catch (e) {
      const aborted = aborter.signal.aborted;
      if (isCurrentRun()) {
        this.store.setStatus(roomId, aborted ? 'paused' : 'error');
        this._markRuntimeProgress(roomId, aborted ? 'aborted_error_path' : 'error');
        this._persist(roomId);
        this.broadcast(roomId, { type: aborted ? 'cross_verify_paused' : 'cross_verify_error', error: e.message });
      }
      throw e;
    } finally {
      if (isCurrentRun()) {
        this.activeAborts.delete(roomId);
        this.activeRunIds.delete(roomId);
      }
    }
  }

  async _runTaskCrossVerify(roomId, task, topic, members, abortSignal) {
    task.status = 'running';
    task.rounds = task.rounds || [];
    this._markRuntimeProgress(roomId, 'task_start', { taskId: task.id, stageId: task.stageId || '' });

    try {
      await this._runTaskCrossVerifyInner(roomId, task, topic, members, abortSignal);
    } catch (e) {
      // bug 修复:abort 在 propose/review 中发生时,task.status 卡在 'running',resume 误判已运行。
      // 显式根据 abort 状态分类设置 task.status,让 outer + resume 流程拿到正确语义。
      if (abortSignal.aborted) {
        task.status = 'paused';
        this._persist(roomId);
      } else {
        task.status = 'escalated';
        task.escalateReason = 'cv 内部错: ' + e.message;
        this._persist(roomId);
      }
      throw e; // 重新抛,让 outer setStatus(room) 走对应路径
    }
  }

  async _runTaskCrossVerifyInner(roomId, task, topic, members, abortSignal) {
    let activeMemberRefs = activeMemberRefsForRoom(this.store.get(roomId), members);
    if (activeMemberRefs.length === 0) {
      task.status = 'escalated';
      task.blocking = true;
      task.escalateReason = '集群协同所有成员都不可用,无法继续自动接手。';
      this._persist(roomId);
      this.broadcast(roomId, { type: 'cv_failover_blocked', taskId: task.id, reason: task.escalateReason });
      return;
    }

    for (let round = 1; round <= this.maxRounds; round++) {
      if (abortSignal.aborted) { task.status = 'paused'; return; }
      this._markRuntimeProgress(roomId, 'round_start', { taskId: task.id, stageId: task.stageId || '', round });
      this.broadcast(roomId, { type: 'cv_round_start', taskId: task.id, round, memberCount: activeMemberRefs.length });

      // 拿上轮数据
      const prev = task.rounds[task.rounds.length - 1] || null;
      const prevProposals = prev?.proposals || {};
      const prevReviews = prev?.reviews || {};

      // 步骤 1:集群成员并行写各自方案
      this._markRuntimeProgress(roomId, 'propose_start', { taskId: task.id, stageId: task.stageId || '', round });
      this.broadcast(roomId, { type: 'cv_propose_start', taskId: task.id, round, memberCount: activeMemberRefs.length });
      const proposalResults = await Promise.allSettled(activeMemberRefs.map(async (ref) => {
        const otherPlans = Object.entries(prevProposals)
          .filter(([id]) => id !== ref.key)
          .map(([id, plan]) => `## ${id}\n${String(plan || '').slice(0, 4000)}`)
          .join('\n\n');
        const otherAck = prevReviews[ref.key] || null;
        const plan = await this._call(
          ref.member,
          PROPOSE_PROMPT(task, topic, prevProposals[ref.key], otherPlans, otherAck, round),
          abortSignal,
          { room: this.store.get(roomId), taskId: task.id, stageId: task.stageId, stageLabel: task.stageLabel, turn: `propose-${ref.index + 1}-r${round}` },
        );
        return { memberId: ref.key, adapterId: ref.adapterId, displayName: ref.displayName, model: ref.model, plan };
      }));
      const proposalEntries = [];
      const proposalFailures = [];
      proposalResults.forEach((result, index) => {
        if (result.status === 'fulfilled') proposalEntries.push(result.value);
        else proposalFailures.push({ ref: activeMemberRefs[index], error: result.reason });
      });
      if (abortSignal.aborted || proposalFailures.some((item) => /aborted|abort|cancelled|canceled|中断/i.test(String(item.error?.message || item.error || '')))) {
        task.status = 'paused';
        this._persist(roomId);
        return;
      }
      if (proposalFailures.length) {
        activeMemberRefs = this._applyMemberFailovers(roomId, task, activeMemberRefs, proposalFailures, 'propose');
        if (activeMemberRefs.length === 0 || proposalEntries.length === 0) {
          task.status = 'escalated';
          task.blocking = true;
          task.escalateReason = '集群协同成员在提案阶段全部不可用,无法继续自动接手。';
          this._persist(roomId);
          this.broadcast(roomId, { type: 'cv_failover_blocked', taskId: task.id, reason: task.escalateReason });
          return;
        }
      }
      const activeKeys = new Set(activeMemberRefs.map((ref) => ref.key));
      const activeProposalEntries = proposalEntries.filter((entry) => activeKeys.has(entry.memberId));
      const proposals = Object.fromEntries(proposalEntries.map((p) => [p.memberId, p.plan]));
      const planLens = Object.fromEntries(proposalEntries.map((p) => [p.memberId, p.plan.length]));
      this.broadcast(roomId, {
        type: 'cv_propose_done',
        taskId: task.id,
        round,
        memberCount: activeMemberRefs.length,
        planLens,
        planALen: proposalEntries[0]?.plan.length || 0,
        planBLen: proposalEntries[1]?.plan.length || 0,
      });

      // 步骤 2:集群成员并行审查其他成员方案集合
      this._markRuntimeProgress(roomId, 'review_start', { taskId: task.id, stageId: task.stageId || '', round });
      this.broadcast(roomId, { type: 'cv_review_start', taskId: task.id, round, memberCount: activeMemberRefs.length });
      let reviewEntries = [];
      if (activeMemberRefs.length === 1) {
        const solo = activeMemberRefs[0];
        reviewEntries = [{
          memberId: solo.key,
          adapterId: solo.adapterId,
          displayName: solo.displayName,
          ack: {
            agree: true,
            reasoning: '单模型接管模式:其他成员不可用,剩余成员继续完成当前阶段。',
            suggestions: [],
            critical_issues: [],
          },
        }];
      } else {
        const reviewResults = await Promise.allSettled(activeMemberRefs.map(async (ref) => {
          const raw = activeMemberRefs.length === 2
          ? await this._call(
              ref.member,
              REVIEW_PROMPT(task, topic, activeProposalEntries.find((p) => p.memberId !== ref.key)?.plan || '', round),
              abortSignal,
              { room: this.store.get(roomId), taskId: task.id, stageId: task.stageId, stageLabel: task.stageLabel, turn: `review-${ref.index + 1}-r${round}` },
            )
          : await this._call(
              ref.member,
              CLUSTER_REVIEW_PROMPT(task, topic, activeProposalEntries, ref.key, round),
              abortSignal,
              { room: this.store.get(roomId), taskId: task.id, stageId: task.stageId, stageLabel: task.stageLabel, turn: `review-${ref.index + 1}-r${round}` },
            );
          return { memberId: ref.key, adapterId: ref.adapterId, displayName: ref.displayName, ack: this._parseAck(raw) };
        }));
        const reviewFailures = [];
        reviewResults.forEach((result, index) => {
          if (result.status === 'fulfilled') reviewEntries.push(result.value);
          else reviewFailures.push({ ref: activeMemberRefs[index], error: result.reason });
        });
        if (abortSignal.aborted || reviewFailures.some((item) => /aborted|abort|cancelled|canceled|中断/i.test(String(item.error?.message || item.error || '')))) {
          task.status = 'paused';
          this._persist(roomId);
          return;
        }
        if (reviewFailures.length) {
          activeMemberRefs = this._applyMemberFailovers(roomId, task, activeMemberRefs, reviewFailures, 'review');
          if (activeMemberRefs.length === 0) {
            task.status = 'escalated';
            task.blocking = true;
            task.escalateReason = '集群协同成员在评审阶段全部不可用,无法继续自动接手。';
            this._persist(roomId);
            this.broadcast(roomId, { type: 'cv_failover_blocked', taskId: task.id, reason: task.escalateReason });
            return;
          }
          const remainingKeys = new Set(activeMemberRefs.map((ref) => ref.key));
          reviewEntries = reviewEntries.filter((entry) => remainingKeys.has(entry.memberId));
          if (activeMemberRefs.length === 1 && reviewEntries.length === 0) {
            const solo = activeMemberRefs[0];
            reviewEntries = [{
              memberId: solo.key,
              adapterId: solo.adapterId,
              displayName: solo.displayName,
              ack: {
                agree: true,
                reasoning: '评审阶段故障转移后进入单模型接管模式,继续完成当前阶段。',
                suggestions: [],
                critical_issues: [],
              },
            }];
          }
        }
      }
      const reviews = Object.fromEntries(reviewEntries.map((r) => [r.memberId, r.ack]));
      const agreeCount = reviewEntries.filter((r) => r.ack.agree).length;
      const ackA = reviewEntries[0]?.ack || { agree: false };
      const ackB = reviewEntries[1]?.ack || { agree: false };
      task.rounds.push({
        round,
        proposals,
        reviews,
        members: activeMemberRefs.map((ref) => ({
          memberId: ref.key,
          adapterId: ref.adapterId,
          displayName: ref.displayName,
          model: ref.model,
        })),
        // legacy fields for old UI/data readers
        planA: proposalEntries[0]?.plan || '',
        planB: proposalEntries[1]?.plan || '',
        ackA,
        ackB,
        byA: activeMemberRefs[0]?.adapterId || '',
        byB: activeMemberRefs[1]?.adapterId || '',
      });
      this._persist(roomId);
      this.broadcast(roomId, {
        type: 'cv_review_done',
        taskId: task.id,
        round,
        agreeA: ackA.agree,
        agreeB: ackB.agree,
        agreeCount,
        totalMembers: activeMemberRefs.length,
      });

      // 步骤 3:判定一致(集群全员显式签字)
      if (agreeCount === activeMemberRefs.length) {
        const finalKeys = new Set(activeMemberRefs.map((ref) => ref.key));
        const finalProposalEntries = activeProposalEntries.filter((entry) => finalKeys.has(entry.memberId));
        const stageArtifact = buildClusterStageArtifact(task, finalProposalEntries, reviewEntries);
        const autoVerification = await this._runStageAutoVerification(roomId, task, stageArtifact);
        task.stageArtifact = stageArtifact;
        task.consensus = {
          finalPlan: this._buildClusterFinalPlan(finalProposalEntries, reviewEntries),
          agreedAt: new Date().toISOString(),
          totalRounds: round,
          workflowStages: CLUSTER_ENGINEERING_STAGES,
          stageArtifact,
          byMembers: activeMemberRefs.map((ref) => ref.key),
          byA: activeMemberRefs[0]?.adapterId || '',
          byB: activeMemberRefs[1]?.adapterId || '',
        };
        const qualityFailure = autoVerification?.status === 'failed'
          ? {
              reason: autoVerification.reason || '代码阶段自动验证失败,需要修复后重跑。',
              canAutoRepair: true,
              evidenceRequirement: {
                ...(stageArtifact.evidenceRequirement || {}),
                status: 'failed',
                autoVerification,
              },
            }
          : stageQualityGateFailure(task, stageArtifact);
        if (qualityFailure) {
          const feedback = qualityFailure.reason;
          const repairCount = task.qualityGateRepairs || 0;
          if (qualityFailure.canAutoRepair && round < this.maxRounds && repairCount < MAX_QUALITY_GATE_REPAIRS) {
            task.qualityGateRepairs = repairCount + 1;
            task.qualityGateFeedback = feedback;
            task.status = 'running';
            this._persist(roomId);
            this.broadcast(roomId, {
              type: 'cv_quality_gate_repair',
              taskId: task.id,
              stageId: task.stageId || '',
              round,
              nextRound: round + 1,
              reason: feedback,
              evidenceRequirement: qualityFailure.evidenceRequirement,
            });
            continue;
          }
          task.status = 'escalated';
          task.blocking = true;
          task.escalateReason = feedback;
          this._persist(roomId);
          this.broadcast(roomId, {
            type: 'cv_quality_gate_failed',
            taskId: task.id,
            stageId: task.stageId || '',
            reason: task.escalateReason,
            evidenceRequirement: qualityFailure.evidenceRequirement,
            acceptanceRequirement: qualityFailure.acceptanceRequirement,
          });
          return;
        }
        task.status = 'done';
        task.blocking = false;
        task.qualityGateFeedback = null;
        this._persist(roomId);
        this.broadcast(roomId, { type: 'cv_consensus', taskId: task.id, round, totalRounds: round, memberCount: activeMemberRefs.length });
        return;
      }

      // 不一致 → 下一轮(propose 时会拿这轮的 ack 修订)
      this.broadcast(roomId, { type: 'cv_disagree', taskId: task.id, round, ackA, ackB, agreeCount, totalMembers: activeMemberRefs.length });
    }

    // MAX_ROUNDS 用完仍不一致
    task.status = 'escalated';
    task.blocking = true;
    task.escalateReason = `${this.maxRounds} 轮集群未达成一致,需用户裁定`;
    this._persist(roomId);
    this.broadcast(roomId, { type: 'cv_escalated', taskId: task.id, maxRounds: this.maxRounds });
  }

  _applyMemberFailovers(roomId, task, activeMemberRefs, failures, phase) {
    const failedKeys = new Set(failures.map((item) => item.ref?.key).filter(Boolean));
    const remainingRefs = activeMemberRefs.filter((ref) => !failedKeys.has(ref.key));
    const remainingMembers = remainingRefs.map((ref) => ref.displayName || ref.adapterId || ref.key);
    const now = new Date().toISOString();
    const records = failures.map(({ ref, error }) => ({
      id: `cluster-member-failover-${createHash('sha1').update(`${roomId}|${task?.id || ''}|${ref?.key || ''}|${phase}|${now}`).digest('hex').slice(0, 12)}`,
      createdAt: now,
      roomId,
      taskId: task?.id || '',
      stageId: task?.stageId || '',
      phase,
      memberKey: ref?.key || '',
      adapterId: ref?.adapterId || '',
      displayName: ref?.displayName || ref?.adapterId || ref?.key || '',
      memberIndex: Number(ref?.index || 0) + 1,
      model: ref?.model || '',
      reason: memberFailoverReason(error),
      remainingMembers,
      soloTakeover: remainingRefs.length === 1,
      recoverable: false,
    }));
    task.memberFailovers = [
      ...(Array.isArray(task.memberFailovers) ? task.memberFailovers : []),
      ...records,
    ].slice(-30);
    const room = this.store.get(roomId);
    const previousDropped = Array.isArray(room?.clusterDroppedMembers) ? room.clusterDroppedMembers : [];
    const byKey = new Map(previousDropped.map((item) => [item.memberKey, item]));
    for (const record of records) byKey.set(record.memberKey, record);
    const clusterDroppedMembers = [...byKey.values()].slice(-50);
    const clusterMemberFailovers = [
      ...(Array.isArray(room?.clusterMemberFailovers) ? room.clusterMemberFailovers : []),
      ...records,
    ].slice(-100);
    this.store.update(roomId, { clusterDroppedMembers, clusterMemberFailovers });
    for (const record of records) {
      this.broadcast(roomId, {
        type: 'cv_member_failover',
        taskId: record.taskId,
        stageId: record.stageId,
        phase: record.phase,
        memberKey: record.memberKey,
        adapterId: record.adapterId,
        displayName: record.displayName,
        reason: record.reason,
        remainingMembers: record.remainingMembers,
        soloTakeover: record.soloTakeover,
      });
    }
    this.broadcast(roomId, {
      type: remainingRefs.length === 1 ? 'cv_solo_takeover' : 'cv_failover_takeover',
      taskId: task?.id || '',
      stageId: task?.stageId || '',
      phase,
      droppedCount: records.length,
      remainingMembers,
    });
    this._persist(roomId);
    return remainingRefs;
  }

  _buildClusterFinalPlan(proposalEntries, reviewEntries) {
    const proposals = proposalEntries.map((p) => `## ${p.displayName || p.memberId} 方案\n\n${p.plan}`).join('\n\n---\n\n');
    const reviews = reviewEntries.map((r) => {
      const ack = r.ack || {};
      return `- ${r.displayName || r.memberId} (${r.memberId}): ${ack.agree ? '同意' : '不同意'}。${ack.reasoning || ''}`;
    }).join('\n');
    return `# 集群协同共识\n\n> 所有成员已完成互审并显式同意。以下保留各成员最终方案,供落地执行时交叉参考。\n\n## 闭环交付流程\n${formatClusterEngineeringStages()}\n\n## 成员签字\n${reviews}\n\n---\n\n${proposals}`;
  }

  async _runStageAutoVerification(roomId, task, stageArtifact) {
    if (!roomId || !this.agentRunStore || !AUTO_VERIFIABLE_CLUSTER_STAGE_IDS.has(task?.stageId)) {
      return { status: 'skipped', reason: 'auto verification unavailable' };
    }
    const room = this.store.get(roomId);
    const cwd = room?.cwd;
    if (!cwd) return { status: 'skipped', reason: 'room cwd missing' };
    const commands = collectSafeStageVerificationCommands(stageArtifact);
    if (!commands.length) return { status: 'skipped', reason: 'no safe auto verification command' };

    const run = await Promise.resolve(this.agentRunStore.create?.({
      sourceType: 'cluster_stage_auto_verification',
      roomId,
      taskId: task?.id || '',
      adapterId: 'cluster-auto-verifier',
      cwd,
      objective: room?.topic || '',
      input: {
        stageId: task?.stageId || '',
        stageLabel: task?.stageLabel || task?.title || '',
        commands: commands.map((item) => item.command),
      },
    }));
    const agentRunId = run?.id || run?.runId;
    if (!agentRunId) return { status: 'skipped', reason: 'agent run not created' };

    const results = [];
    let settled = false;
    try {
      for (const command of commands) {
        const startedAt = new Date().toISOString();
        const check = await runNodeSyntaxCheck({ cwd, relativePath: command.relativePath });
        const finishedAt = new Date().toISOString();
        const toolResult = {
          toolName: 'node --check',
          command: command.command,
          status: check.status,
          exitCode: check.exitCode,
          stdout: String(check.stdout || '').slice(0, 8000),
          stderr: String(check.stderr || '').slice(0, 8000),
          cwd,
          startedAt,
          finishedAt,
          stageId: task?.stageId || '',
          stageLabel: task?.stageLabel || task?.title || '',
        };
        await Promise.resolve(this.agentRunStore.appendToolResult?.(agentRunId, toolResult));
        results.push(toolResult);
      }

      const failed = results.filter((item) => item.status !== 'passed');
      const runStatus = failed.length ? 'failed' : 'succeeded';
      await Promise.resolve(this.agentRunStore.transition?.(agentRunId, runStatus, {
        stageId: task?.stageId || '',
        stageLabel: task?.stageLabel || task?.title || '',
        commandCount: results.length,
        failedCount: failed.length,
      }));
      settled = true;
      if (runStatus === 'succeeded') {
        const link = this._autoLinkAgentRunEvidence(roomId, {
          stageId: task?.stageId,
          stageLabel: task?.stageLabel || task?.title,
          taskId: task?.id,
          turn: 'stage-auto-verification',
          adapterId: 'cluster-auto-verifier',
          agentRunId,
        });
        return {
          status: link ? 'passed' : 'failed',
          agentRunId,
          commandCount: results.length,
          reason: link ? '' : '自动验证已成功运行,但 Agent Run 证据未能绑定。',
        };
      }
      return {
        status: 'failed',
        agentRunId,
        commandCount: results.length,
        failedCount: failed.length,
        reason: `自动验证失败: ${failed.map((item) => `${item.command}${item.stderr ? ` (${item.stderr.split(/\r?\n/)[0]})` : ''}`).join('; ')}`,
      };
    } catch (error) {
      try {
        await Promise.resolve(this.agentRunStore.transition?.(agentRunId, 'failed', {
          error: error?.message || String(error || 'auto_verification_error'),
          stageId: task?.stageId || '',
        }));
        settled = true;
      } catch { /* ignore settle failure */ }
      throw error;
    } finally {
      // Anti-zombie: never leave cluster auto-verification runs stuck in non-terminal status.
      if (!settled) {
        try {
          const cur = this.agentRunStore.get?.(agentRunId);
          const st = String(cur?.status || '');
          if (st === 'running' || st === 'queued' || !st) {
            await Promise.resolve(this.agentRunStore.transition?.(agentRunId, 'failed', {
              error: 'unterminated_cluster_auto_verification',
              stageId: task?.stageId || '',
            }));
          }
        } catch { /* ignore */ }
      }
    }
  }

  async _call(member, userPrompt, abortSignal, ctx) {
    const adapter = this.adapters.get(member.adapterId);
    if (!adapter) throw new Error('adapter not registered: ' + member.adapterId);
    const room = ctx?.room;
    const workspacePathContract = buildWorkspacePathContract(room, userPrompt);
    const messages = [
      { role: 'system', content: '你是集群协同模式的对等成员之一。' },
      ...(workspacePathContract.text ? [{ role: 'system', content: workspacePathContract.text }] : []),
      { role: 'user', content: workspacePathContract.prompt },
    ];
    const agentContext = room ? buildRoomAgentContext(room, {
      member,
      objective: room.topic || '',
      disableSharedRoomSkills: true,
    }) : null;
    const agentMetrics = summarizeAgentRuntimeContext(agentContext);
    const nativeCapabilities = isolateClusterNativeCapabilities(adapter.getNativeCapabilities?.());
    const finalMessages = room ? injectSkillsToMessages(messages, room, {
      agentContext,
      member,
      adapter,
      nativeCapabilities,
      disableSharedRoomSkills: true,
    }) : messages;
    const startedAt = Date.now();
    const timeoutMs = clusterMemberCallTimeoutMs(this.memberCallTimeoutMs);
    const callAborter = new AbortController();
    let timeoutId = null;
    let abortReject = null;
    const outputBase = {
      adapterId: member.adapterId,
      displayName: member.displayName || member.name || member.adapterId,
      model: member.model || '',
      taskId: ctx?.taskId || '',
      stageId: ctx?.stageId || '',
      stageLabel: ctx?.stageLabel || '',
      turn: ctx?.turn || '',
    };
    const abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    const abortCall = () => {
      try { callAborter.abort(); } catch {}
      abortReject?.(makeClusterAbortError());
    };
    if (abortSignal?.aborted) abortCall();
    else abortSignal?.addEventListener?.('abort', abortCall, { once: true });
    const timeoutPromise = timeoutMs > 0 ? new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        try { callAborter.abort(); } catch {}
        reject(makeClusterMemberCallTimeoutError(member, timeoutMs));
      }, timeoutMs);
    }) : null;
    try {
      this._appendRuntimeOutput(room?.id, {
        ...outputBase,
        stream: 'lifecycle',
        content: `[start] ${outputBase.displayName} ${outputBase.turn}`.trim(),
      });
      const pending = [
        adapter.chat(finalMessages, {
          cwd: room?.cwd,
          abortSignal: callAborter.signal,
          model: member.model,
          nativeCapabilities,
          disableMcp: true,
          capabilityIsolation: {
            mode: 'cluster_native_only',
            sharedMcpDisabled: true,
          },
          budgetContext: {
            projectId: room?.cwd,
            roomId: room?.id,
            taskId: ctx?.taskId,
            adapterId: member.adapterId,
            agentProfileId: agentMetrics.agentProfileId,
          },
          onProgress: (chunk) => this._appendRuntimeOutput(room?.id, {
            ...outputBase,
            stream: 'stdout',
            content: chunk,
          }),
        }),
        abortPromise,
      ];
      if (timeoutPromise) pending.push(timeoutPromise);
      const result = await Promise.race(pending);
      const incomplete = isIncompleteChatResult(result);
      this._recordRuntimeMetric(room?.id, {
        adapterId: member.adapterId,
        model: member.model,
        taskId: ctx?.taskId,
        stageId: ctx?.stageId,
        turn: ctx?.turn,
        status: 'succeeded',
        incomplete,
        latencyMs: Date.now() - startedAt,
        tokensIn: result?.tokensIn,
        tokensOut: result?.tokensOut,
        agentRunId: result?.agentRunId,
      });
      this._autoLinkAgentRunEvidence(room?.id, {
        stageId: ctx?.stageId,
        stageLabel: ctx?.stageLabel,
        taskId: ctx?.taskId,
        turn: ctx?.turn,
        adapterId: member.adapterId,
        agentRunId: result?.agentRunId,
      });
      // 截断感知:成员输出被 length/max_tokens 截断时,半截提案/互评 verdict/签字 JSON 不能当完整消费。
      // 标注 reply（让下游 _parseAck 的 JSON 解析失败 → 降级为不同意,不蒙混过签）+ 记日志 + 广播。
      const reply = incomplete
        ? markTruncatedReply(result?.reply || '', result)
        : (result?.reply || '');
      if (incomplete) {
        const finishReason = truncationFinishReason(result);
        this._appendRuntimeOutput(room?.id, {
          ...outputBase,
          stream: 'stderr',
          content: `[truncated] ${outputBase.displayName} ${outputBase.turn} 输出被截断（finish_reason=${finishReason}），已标注为不完整，不当完整结论消费。`.trim(),
        });
        this.broadcast(room?.id, {
          type: 'cluster_member_truncated',
          adapterId: member.adapterId,
          model: member.model,
          taskId: ctx?.taskId || '',
          stageId: ctx?.stageId || '',
          turn: ctx?.turn || '',
          finishReason,
        });
      }
      this._appendRuntimeOutput(room?.id, {
        ...outputBase,
        stream: 'reply',
        content: reply || '[done] completed with empty reply',
      });
      return reply;
    } catch (e) {
      if (e?.code === 'cluster_member_call_timeout') {
        this.broadcast(room?.id, {
          type: 'cluster_member_call_timeout',
          adapterId: member.adapterId,
          model: member.model,
          taskId: ctx?.taskId,
          stageId: ctx?.stageId,
          turn: ctx?.turn,
          timeoutMs,
        });
      }
      this._recordRuntimeMetric(room?.id, {
        adapterId: member.adapterId,
        model: member.model,
        taskId: ctx?.taskId,
        turn: ctx?.turn,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        error: e?.message || String(e),
      });
      this._appendRuntimeOutput(room?.id, {
        ...outputBase,
        stream: 'stderr',
        content: `[error] ${e?.message || String(e)}`,
      });
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      abortSignal?.removeEventListener?.('abort', abortCall);
    }
  }

  _appendRuntimeOutput(roomId, entry = {}) {
    if (!roomId) return null;
    const room = this.store.get(roomId);
    if (!room) return null;
    const raw = String(entry.content || '');
    const clean = raw
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\r/g, '\n')
      .replace(/^\^D+/, '')
      .replace(/\n\^D+/g, '\n')
      .trim();
    if (!clean) return null;
    if (/^\^D+$/.test(clean)) return null;
    const now = new Date().toISOString();
    const output = {
      id: createHash('sha1').update(`${roomId}|${now}|${entry.adapterId || ''}|${entry.turn || ''}|${clean.slice(0, 256)}`).digest('hex').slice(0, 16),
      at: now,
      adapterId: entry.adapterId || '',
      displayName: entry.displayName || entry.adapterId || '',
      model: entry.model || '',
      taskId: entry.taskId || '',
      stageId: entry.stageId || '',
      stageLabel: entry.stageLabel || '',
      turn: entry.turn || '',
      stream: entry.stream || 'stdout',
      content: clean.slice(-12000),
    };
    const clusterRuntimeOutput = [
      ...(Array.isArray(room.clusterRuntimeOutput) ? room.clusterRuntimeOutput : []),
      output,
    ].slice(-160);
    this.store.update(roomId, { clusterRuntimeOutput });
    this.broadcast(roomId, { type: 'cluster_runtime_output', output });
    return output;
  }

  _recordRuntimeMetric(roomId, metric) {
    if (!roomId) return null;
    const room = this.store.get(roomId);
    if (!room) return null;
    const prevStatus = room.clusterRuntimeBudgetStatus?.status || 'passed';
    const telemetry = addClusterRuntimeMetric(room.clusterRuntimeTelemetry || emptyClusterRuntimeTelemetry(), metric);
    const budgetStatus = buildClusterRuntimeBudgetStatus(telemetry, this.runtimeBudgetLimits);
    this.store.update(roomId, { clusterRuntimeTelemetry: telemetry, clusterRuntimeBudgetStatus: budgetStatus });
    this._markRuntimeProgress(roomId, 'runtime_metric', {
      adapterId: metric.adapterId || '',
      taskId: metric.taskId || '',
      turn: metric.turn || '',
      status: metric.status || '',
    });
    this.broadcast(roomId, {
      type: 'cluster_runtime_metric',
      telemetry: {
        calls: telemetry.calls,
        succeededCalls: telemetry.succeededCalls,
        failedCalls: telemetry.failedCalls,
        totalTokens: telemetry.totalTokens,
        avgLatencyMs: telemetry.avgLatencyMs,
        latest: telemetry.latest,
      },
    });
    if (budgetStatus.status !== 'passed' && prevStatus !== budgetStatus.status) {
      this.broadcast(roomId, {
        type: 'cluster_runtime_budget',
        status: budgetStatus.status,
        warnings: budgetStatus.warnings,
        blockers: budgetStatus.blockers,
        telemetry: {
          calls: telemetry.calls,
          totalTokens: telemetry.totalTokens,
          avgLatencyMs: telemetry.avgLatencyMs,
        },
      });
    }
    if (budgetStatus.status === 'blocked' && prevStatus !== 'blocked') {
      const aborter = this.activeAborts.get(roomId);
      if (aborter && !aborter.signal?.aborted) {
        try { aborter.abort(); } catch {}
      }
      this.store.setStatus(roomId, 'paused');
      this._persist(roomId);
      this.broadcast(roomId, {
        type: 'cross_verify_paused',
        reason: 'runtime_budget_blocked',
        error: `运行中预算阻断: ${budgetStatus.blockers.join(', ')}`,
      });
    }
    return telemetry;
  }

  _autoLinkAgentRunEvidence(roomId, input = {}) {
    if (!roomId || !this.agentRunStore || !input.agentRunId || !CODE_DRIVEN_STAGE_EVIDENCE[input.stageId]) return null;
    const room = this.store.get(roomId);
    if (!room) return null;
    const timeline = this.agentRunStore.getTimeline?.(input.agentRunId);
    if (!timeline?.run || timeline.run.status !== 'succeeded') return null;
    if (timeline.run.roomId && timeline.run.roomId !== roomId) return null;
    if (timeline.run.taskId && input.taskId && timeline.run.taskId !== input.taskId) return null;
    const toolResults = Array.isArray(timeline.toolResults) ? timeline.toolResults : [];
    const toolResultCount = toolResults.filter(isVerifiableAgentToolResult).length;
    const totalToolResultCount = toolResults.length;
    const rejectedToolResultCount = totalToolResultCount - toolResultCount;
    const archiveCount = Array.isArray(timeline.archives) ? timeline.archives.length : 0;
    const artifactCount = Array.isArray(timeline.artifacts) ? timeline.artifacts.length : 0;
    const evidenceCount = toolResultCount + archiveCount + artifactCount;
    if (evidenceCount <= 0) return null;
    const currentLinks = Array.isArray(room.clusterEvidenceLinks) ? room.clusterEvidenceLinks : [];
    if (currentLinks.some((link) => link?.stageId === input.stageId && link?.agentRunId === input.agentRunId && link?.verified === true)) {
      return null;
    }
    const now = new Date().toISOString();
    const link = {
      id: `cluster-evidence-auto-${createHash('sha1').update(`${roomId}|${input.stageId}|${input.agentRunId}`).digest('hex').slice(0, 12)}`,
      createdAt: now,
      source: 'cross_verify_dispatcher_auto_link',
      stageId: input.stageId,
      stageLabel: input.stageLabel || input.stageId,
      taskId: input.taskId || '',
      turn: input.turn || '',
      adapterId: input.adapterId || '',
      agentRunId: input.agentRunId,
      runStatus: timeline.run.status,
      verified: true,
      toolResultCount,
      totalToolResultCount,
      rejectedToolResultCount,
      archiveCount,
      artifactCount,
      evidenceCount,
      summary: `自动绑定 ${input.stageLabel || input.stageId} 阶段 Agent Run 证据`,
    };
    const links = [...currentLinks, link].slice(-100);
    this.store.update(roomId, { clusterEvidenceLinks: links });
    this.broadcast(roomId, {
      type: 'cluster_evidence_auto_linked',
      stageId: link.stageId,
      stageLabel: link.stageLabel,
      agentRunId: link.agentRunId,
      evidenceCount: link.evidenceCount,
    });
    return link;
  }

  _parseAck(raw) {
    // 容错解析:LLM 可能加 ```json 围栏 / 加前后空白
    let s = String(raw || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try {
      const obj = JSON.parse(s);
      return {
        agree: obj.agree === true,
        reasoning: String(obj.reasoning || '').slice(0, 2000),
        suggestions: Array.isArray(obj.suggestions) ? obj.suggestions.slice(0, 10).map((x) => String(x).slice(0, 500)) : [],
        critical_issues: Array.isArray(obj.critical_issues) ? obj.critical_issues.slice(0, 10).map((x) => String(x).slice(0, 500)) : [],
      };
    } catch {
      // 解析失败 = 视为不同意 + 把原文当 reasoning(让下轮看到出了什么问题)
      return {
        agree: false,
        reasoning: '[ack 解析失败] ' + s.slice(0, 1000),
        suggestions: [],
        critical_issues: ['ack JSON 解析失败,原始输出: ' + s.slice(0, 200)],
      };
    }
  }

  _persist(roomId) {
    try {
      const room = this.store.get(roomId);
      if (!room) return;
      this.store.update(roomId, {
        taskList: room.taskList,
        clusterRuntimeState: buildClusterRuntimeState(room, { event: 'persist' }),
        clusterRuntimeRecoveryPersistPending: undefined,
      });
      if (typeof this.store.flush === 'function') this.store.flush();
    } catch (e) {
      const pending = buildRuntimePersistPending(e);
      try {
        if (typeof this.store.update === 'function') {
          this.store.update(roomId, { clusterRuntimeRecoveryPersistPending: pending });
        } else {
          const room = this.store.get?.(roomId);
          if (room) room.clusterRuntimeRecoveryPersistPending = pending;
        }
      } catch {
        const room = this.store.get?.(roomId);
        if (room) room.clusterRuntimeRecoveryPersistPending = pending;
      }
      try {
        this.broadcast(roomId, {
          type: 'cross_verify_persist_pending',
          reason: pending.reason,
          flushError: pending.flushError,
          at: pending.at,
        });
      } catch {}
      console.warn('[cross-verify-persist] failed:', e.message);
    }
  }
}

export const CROSS_VERIFY_PROMPT_VERSION = PROMPT_VERSIONS?.cross_verify || 'cv-v1';
