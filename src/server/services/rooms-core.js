import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { DEFAULT_AGENT_SKILL_REGISTRY } from '../../agents/AgentSkillRegistry.js';
import { objectiveSummary } from '../../room/RoomLineage.js';
import { summarizeRoleCards } from '../../room/roleCards.js';
import {
  CLUSTER_ENGINEERING_STAGES,
  buildClusterRuntimeState,
  buildClusterDeliveryManifest,
  buildClusterDeliveryPackage,
  buildClusterDeliveryReportMarkdown,
  buildClusterWorkflowAudit,
} from '../../room/CrossVerifyDispatcher.js';

const ROOM_LIST_FULL_VALUES = new Set(['1', 'true', 'yes', 'on']);
const CLUSTER_PREFLIGHT_DEFAULT_MAX_ROUNDS = 3;
const CLUSTER_PREFLIGHT_MAX_MEMBERS = 6;
const CLUSTER_PREFLIGHT_WARN_CALLS = 220;
const CLUSTER_PREFLIGHT_BLOCK_CALLS = 360;
const CLUSTER_PREFLIGHT_WARN_TOKENS = 700_000;
const CLUSTER_PREFLIGHT_BLOCK_TOKENS = 1_200_000;
const CLUSTER_PREFLIGHT_AVG_TOKENS_PER_CALL = 3500;
const CLUSTER_PROJECT_DEFAULT_BASE_DIR = join(homedir(), 'Desktop', 'NoeProjects');
const CLUSTER_PROJECT_FORBIDDEN_HOME_PREFIXES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  'Library/Keychains',
  'Library/Application Support/com.apple.TCC',
  '.password-store',
];
const ROOM_LIST_FULL_MAX_TEXT_CHARS = 250_000;
const ROOM_LIST_FULL_MAX_TURNS = 400;
const ROOM_LIST_FULL_MAX_TASK_ATTEMPTS = 400;
const ROOM_LIST_FULL_MAX_CONVERSATION = 400;

function wantsFullRoomList(query = {}) {
  return ROOM_LIST_FULL_VALUES.has(String(query.full || '').toLowerCase());
}

export function roomWithFreshClusterRuntimeState(room, event = 'api_read_fallback') {
  if (!room || typeof room !== 'object') return room;
  if (room.mode !== 'cross_verify') return room;
  return {
    ...room,
    clusterRuntimeState: buildClusterRuntimeState(room, { event }),
  };
}

export function downloadFilename(value) {
  return String(value || 'download.txt').replace(/[\r\n"]/g, '_').slice(0, 180);
}

export function clusterDeliveryArtifact(room = {}, artifactKind = '') {
  const pkg = room.clusterDeliveryPackage;
  if (!pkg || !Array.isArray(pkg.artifacts)) return null;
  const requested = String(artifactKind || '').trim();
  const normalized = requested === 'manifest'
    ? 'delivery_manifest_json'
    : requested === 'report'
      ? 'delivery_report_markdown'
      : requested;
  const artifact = pkg.artifacts.find((item) => item?.kind === normalized);
  if (!artifact) return null;
  if (normalized === 'delivery_manifest_json') {
    return {
      artifact,
      body: JSON.stringify(room.clusterDeliveryManifest || {}, null, 2),
      contentType: 'application/json; charset=utf-8',
    };
  }
  if (normalized === 'delivery_report_markdown') {
    return {
      artifact,
      body: String(room.clusterDeliveryReportMarkdown || ''),
      contentType: 'text/markdown; charset=utf-8',
    };
  }
  return null;
}

function safeArchiveSlug(value, fallback = 'cluster') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function makeClusterProjectSlug(value = '') {
  return String(value || 'cluster-project')
    .trim()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+$/, 'cluster-project')
    .slice(0, 80) || 'cluster-project';
}

function ensureDirectory(pathValue, { recursive = true } = {}) {
  mkdirSync(pathValue, { recursive, mode: 0o700 });
  const st = statSync(pathValue);
  if (!st.isDirectory()) throw new Error('项目路径不是目录');
}

function writeFileIfMissing(pathValue, content) {
  if (existsSync(pathValue)) return false;
  writeFileSync(pathValue, content, { mode: 0o600 });
  return true;
}

function expandHomePath(pathValue) {
  return String(pathValue || '').startsWith('~')
    ? String(pathValue || '').replace(/^~/, homedir())
    : String(pathValue || '');
}

function isSafeMissingClusterPathSegment(segment = '') {
  return Boolean(segment)
    && segment !== '.'
    && segment !== '..'
    && !segment.includes(sep)
    && !segment.includes('\0')
    && !segment.startsWith('.');
}

function isForbiddenHomeProjectPath(pathValue = '') {
  let homeRoot = homedir();
  try { homeRoot = realpathSync(homedir()); } catch {}
  const rel = relative(homeRoot, resolve(pathValue)).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../')) return false;
  return CLUSTER_PROJECT_FORBIDDEN_HOME_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function resolveWritableClusterBaseDir(rawBaseDir, safeResolveFsPath) {
  const expandedBaseDir = expandHomePath(rawBaseDir);
  if (!expandedBaseDir || expandedBaseDir.includes('\0')) return null;

  const existing = safeResolveFsPath(expandedBaseDir);
  if (existing) return existing;

  const missingSegments = [];
  let cursor = expandedBaseDir;
  while (cursor && cursor !== dirname(cursor)) {
    const segment = basename(cursor);
    if (!isSafeMissingClusterPathSegment(segment)) return null;
    missingSegments.push(segment);
    cursor = dirname(cursor);
    const safeAncestor = safeResolveFsPath(cursor);
    if (!safeAncestor) continue;
    const candidate = join(safeAncestor, ...missingSegments.reverse());
    if (isForbiddenHomeProjectPath(candidate)) return null;
    return candidate;
  }
  return null;
}

export function createClusterProjectScaffold({
  scaffold = {},
  roomName = '',
  safeResolveFsPath,
} = {}) {
  const config = scaffold && typeof scaffold === 'object' ? scaffold : {};
  const rawBaseDir = String(config.baseDir || '').trim() || CLUSTER_PROJECT_DEFAULT_BASE_DIR;
  if (rawBaseDir.length > 1024) {
    const err = new Error('项目根目录过长');
    err.statusCode = 400;
    throw err;
  }
  const baseDir = resolveWritableClusterBaseDir(rawBaseDir, safeResolveFsPath);
  if (!baseDir) {
    const err = new Error('项目根目录越权或敏感');
    err.statusCode = 403;
    throw err;
  }
  ensureDirectory(baseDir, { recursive: true });

  const projectName = String(config.projectName || roomName || 'cluster-project').trim() || 'cluster-project';
  const slug = makeClusterProjectSlug(projectName);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let projectDir = join(baseDir, slug);
  if (existsSync(projectDir)) projectDir = join(baseDir, `${slug}-${stamp}`);
  for (let i = 2; existsSync(projectDir); i += 1) projectDir = join(baseDir, `${slug}-${stamp}-${i}`);
  ensureDirectory(projectDir, { recursive: false });
  ensureDirectory(join(projectDir, 'artifacts'), { recursive: true });
  ensureDirectory(join(projectDir, 'attachments'), { recursive: true });
  ensureDirectory(join(projectDir, 'logs'), { recursive: true });

  const generatedAt = new Date().toISOString();
  const files = [
    {
      path: 'project.md',
      content: [
        `# ${projectName}`,
        '',
        `- Created: ${generatedAt}`,
        '- Mode: cluster collaboration',
        '- Boundary: this room is bound to this directory.',
        '',
        '## Working boundary',
        '',
        '- Keep requirements, plans, code, assets, logs, and handoff files under this directory.',
        '- Do not read or write outside this directory unless the user explicitly asks for it.',
        '- If an external file is required, record the reason and path in `handoff.md` first.',
        '',
      ].join('\n'),
    },
    {
      path: 'requirements.md',
      content: [
        '# Requirements',
        '',
        'Paste the user-facing requirements here before starting the cluster run.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] The project can be opened and understood from this directory alone.',
        '- [ ] Deliverables and validation evidence are saved under this directory.',
        '- [ ] Cross-room or external-file dependencies are explicitly documented.',
        '',
      ].join('\n'),
    },
    {
      path: 'tasks.md',
      content: [
        '# Tasks',
        '',
        '- [ ] Clarify scope',
        '- [ ] Split work across Claude / GPT / Gemini',
        '- [ ] Implement',
        '- [ ] Verify',
        '- [ ] Archive final handoff and artifacts',
        '',
      ].join('\n'),
    },
    {
      path: 'handoff.md',
      content: [
        '# Handoff',
        '',
        `Generated: ${generatedAt}`,
        '',
        '## Current state',
        '',
        '- Room created with an isolated project directory.',
        '- Add requirements before starting execution.',
        '',
        '## External dependencies',
        '',
        '- None recorded.',
        '',
      ].join('\n'),
    },
    { path: 'artifacts/.gitkeep', content: '' },
    { path: 'attachments/.gitkeep', content: '' },
    { path: 'logs/.gitkeep', content: '' },
  ];
  const writtenFiles = [];
  for (const file of files) {
    if (writeFileIfMissing(join(projectDir, file.path), file.content)) writtenFiles.push(file.path);
  }
  return {
    version: 'cluster-project-scaffold-v1',
    generatedAt,
    baseDir,
    projectDir,
    projectName,
    files: writtenFiles,
    isolation: 'room_cwd_bound_to_generated_project_directory',
  };
}

function sha256Text(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeClusterArchiveArtifactKind(value = '') {
  const requested = String(value || '').trim();
  if (requested === 'package' || requested === 'index') return 'delivery_package_index_json';
  if (requested === 'manifest') return 'delivery_manifest_json';
  if (requested === 'report') return 'delivery_report_markdown';
  return requested;
}

function findClusterDeliveryArchive(room = {}, archiveId = '') {
  const requested = String(archiveId || '').trim();
  const archives = [
    ...(Array.isArray(room.clusterDeliveryArchives) ? room.clusterDeliveryArchives : []),
    ...(room.clusterDeliveryArchive ? [room.clusterDeliveryArchive] : []),
  ].filter(Boolean);
  return archives.find((archive) => archive?.id === requested) || null;
}

export function readClusterDeliveryArchiveArtifact(room = {}, { archiveId = '', artifactKind = '' } = {}) {
  const archive = findClusterDeliveryArchive(room, archiveId);
  if (!archive) throw new Error('cluster delivery archive not found');
  const kind = normalizeClusterArchiveArtifactKind(artifactKind);
  const artifact = (Array.isArray(archive.artifacts) ? archive.artifacts : []).find((item) => item?.kind === kind);
  if (!artifact) throw new Error('cluster delivery archive artifact not found');
  const relPath = String(artifact.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relPath || relPath.includes('\0') || relPath.split('/').some((part) => part === '..')) {
    throw new Error('cluster delivery archive artifact path is invalid');
  }
  if (!relPath.startsWith('output/noe/cluster-delivery/')) {
    throw new Error('cluster delivery archive artifact path is not allowed');
  }
  const cwd = typeof room.cwd === 'string' && room.cwd.trim() ? room.cwd : homedir();
  const archiveRoot = realpathSync(join(cwd, 'output/noe/cluster-delivery'));
  const targetPath = realpathSync(join(cwd, relPath));
  if (!targetPath.startsWith(`${archiveRoot}/`) && targetPath !== archiveRoot) {
    throw new Error('cluster delivery archive artifact path escapes archive root');
  }
  const stat = statSync(targetPath);
  if (!stat.isFile()) throw new Error('cluster delivery archive artifact is not a file');
  const content = readFileSync(targetPath, 'utf8');
  const sha256 = sha256Text(content);
  if (artifact.sha256 && artifact.sha256 !== sha256) {
    throw new Error('cluster delivery archive artifact digest mismatch');
  }
  return {
    archive,
    artifact: { ...artifact, sha256 },
    content,
    contentType: String(artifact.filename || artifact.path || '').endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'text/markdown; charset=utf-8',
  };
}

export function buildClusterDeliveryArchive(room = {}, { requestedBy = 'owner' } = {}) {
  if (!room.clusterDeliveryPackage) throw new Error('cluster delivery package not found');
  const cwd = typeof room.cwd === 'string' && room.cwd.trim() ? room.cwd : homedir();
  const shortFingerprint = String(
    room.clusterDeliveryManifest?.fingerprint ||
    room.clusterDeliveryPackage.manifestFingerprint ||
    'draft',
  ).slice(0, 12) || 'draft';
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const roomSlug = safeArchiveSlug(room.id || room.name || 'room');
  const archiveId = `cluster-delivery-${createHash('sha1').update(`${roomSlug}|${stamp}|${shortFingerprint}`).digest('hex').slice(0, 12)}`;
  const relDir = `output/noe/cluster-delivery/${roomSlug}/${stamp}-${shortFingerprint}`;
  const absDir = join(cwd, relDir);
  mkdirSync(absDir, { recursive: true, mode: 0o700 });

  const packageBody = JSON.stringify(room.clusterDeliveryPackage, null, 2);
  const packageFile = `${roomSlug}-cluster-package-${shortFingerprint}.json`;
  const files = [{
    kind: 'delivery_package_index_json',
    label: '集群协同交付包索引(JSON)',
    filename: packageFile,
    path: `${relDir}/${packageFile}`,
    body: packageBody,
  }];
  for (const kind of ['manifest', 'report']) {
    const artifact = clusterDeliveryArtifact(room, kind);
    if (!artifact) continue;
    files.push({
      kind: artifact.artifact.kind,
      label: artifact.artifact.label || artifact.artifact.kind,
      filename: artifact.artifact.filename,
      path: `${relDir}/${artifact.artifact.filename}`,
      body: artifact.body,
    });
  }
  const artifacts = files.map((file) => {
    writeFileSync(join(absDir, file.filename), file.body, { mode: 0o600 });
    return {
      kind: file.kind,
      label: file.label,
      filename: file.filename,
      path: file.path,
      size: Buffer.byteLength(file.body),
      sha256: sha256Text(file.body),
      exists: true,
    };
  });
  return {
    id: archiveId,
    generatedAt,
    requestedBy: String(requestedBy || 'owner').slice(0, 80),
    roomId: room.id || '',
    topic: room.topic || '',
    status: room.clusterDeliveryPackage.status || 'unknown',
    readyForArchive: room.clusterDeliveryPackage.readyForArchive === true,
    manifestFingerprint: room.clusterDeliveryPackage.manifestFingerprint || room.clusterDeliveryManifest?.fingerprint || '',
    archiveDir: relDir,
    artifacts,
  };
}

function preflightCheck(id, label, passed, evidence = [], blockers = [], severity = 'error') {
  return {
    id,
    label,
    status: passed ? 'passed' : (severity === 'warn' ? 'warn' : 'blocked'),
    passed: passed === true,
    severity,
    evidence: Array.isArray(evidence) ? evidence.filter(Boolean).slice(0, 12) : [],
    blockers: Array.isArray(blockers) ? blockers.filter(Boolean).slice(0, 12) : [],
  };
}

export function buildClusterExecutionBudgetEstimate(room = {}, { maxRounds = CLUSTER_PREFLIGHT_DEFAULT_MAX_ROUNDS } = {}) {
  const enabledMembers = Array.isArray(room.members) ? room.members.filter((member) => member?.enabled !== false) : [];
  const memberCount = enabledMembers.length;
  const stageCount = CLUSTER_ENGINEERING_STAGES.length;
  const normalizedMaxRounds = Math.min(Math.max(Number(maxRounds) || CLUSTER_PREFLIGHT_DEFAULT_MAX_ROUNDS, 1), 10);
  const callsPerStageWorstCase = memberCount * 2 * normalizedMaxRounds;
  const livePingCalls = memberCount;
  const estimatedCallsWorstCase = stageCount * callsPerStageWorstCase + livePingCalls;
  const estimatedTokensWorstCase = estimatedCallsWorstCase * CLUSTER_PREFLIGHT_AVG_TOKENS_PER_CALL;
  const blockers = [
    memberCount > CLUSTER_PREFLIGHT_MAX_MEMBERS ? `member_count_gt_${CLUSTER_PREFLIGHT_MAX_MEMBERS}` : '',
    estimatedCallsWorstCase > CLUSTER_PREFLIGHT_BLOCK_CALLS ? `estimated_calls_gt_${CLUSTER_PREFLIGHT_BLOCK_CALLS}` : '',
    estimatedTokensWorstCase > CLUSTER_PREFLIGHT_BLOCK_TOKENS ? `estimated_tokens_gt_${CLUSTER_PREFLIGHT_BLOCK_TOKENS}` : '',
  ].filter(Boolean);
  const warnings = [
    estimatedCallsWorstCase > CLUSTER_PREFLIGHT_WARN_CALLS ? `estimated_calls_gt_${CLUSTER_PREFLIGHT_WARN_CALLS}` : '',
    estimatedTokensWorstCase > CLUSTER_PREFLIGHT_WARN_TOKENS ? `estimated_tokens_gt_${CLUSTER_PREFLIGHT_WARN_TOKENS}` : '',
  ].filter(Boolean);
  return {
    estimateVersion: 'cluster-execution-budget-estimate-v1',
    memberCount,
    stageCount,
    maxRounds: normalizedMaxRounds,
    callsPerStageWorstCase,
    livePingCalls,
    estimatedCallsWorstCase,
    estimatedTokensWorstCase,
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    blockers,
    warnings,
  };
}

function isClusterSoloTakeoverEligible(room = {}, enabledMembers = []) {
  const members = Array.isArray(room.members) ? room.members : [];
  if (enabledMembers.length !== 1 || members.length < 2) return false;
  const hasDroppedHistory = Array.isArray(room.clusterDroppedMembers) && room.clusterDroppedMembers.length > 0;
  const hasStartupDegradedHistory = Array.isArray(room.clusterStartupDegradedMembers) && room.clusterStartupDegradedMembers.length > 0;
  const hasFailoverDisabledMember = members.some((member) => member?.enabled === false && (
    member.failoverDisabled === true ||
    Boolean(member.failoverReason) ||
    Boolean(member.failoverDisabledAt)
  ));
  return hasDroppedHistory || hasStartupDegradedHistory || hasFailoverDisabledMember;
}

export function buildClusterPreflight(room = {}, { topic = '', roomAdapterPool = null } = {}) {
  const enabledMembers = Array.isArray(room.members) ? room.members.filter((member) => member?.enabled !== false) : [];
  const soloTakeoverEligible = isClusterSoloTakeoverEligible(room, enabledMembers);
  const projectGoal = String(topic || room.topic || room.objective?.title || room.name || '').trim();
  const cwd = typeof room.cwd === 'string' && room.cwd.trim() ? room.cwd : homedir();
  let cwdOk = false;
  let cwdReason = '';
  try {
    cwdOk = statSync(cwd).isDirectory();
    if (!cwdOk) cwdReason = 'cwd_not_directory';
  } catch (e) {
    cwdReason = e?.code || 'cwd_not_found';
  }
  const adapterReadiness = enabledMembers.map((member) => {
    const adapterId = member?.adapterId || '';
    const registered = Boolean(adapterId)
      && (!roomAdapterPool || typeof roomAdapterPool.has !== 'function' || roomAdapterPool.has(adapterId));
    const adapter = registered && roomAdapterPool && typeof roomAdapterPool.get === 'function'
      ? roomAdapterPool.get(adapterId)
      : null;
    const nativeCapabilities = adapter?.getNativeCapabilities?.() || null;
    const chatReady = !roomAdapterPool || typeof roomAdapterPool.get !== 'function'
      ? registered
      : Boolean(adapter && typeof adapter.chat === 'function');
    const status = !adapterId
      ? 'missing_adapter_id'
      : !registered
        ? 'not_registered'
        : chatReady
          ? 'chat_ready'
          : 'chat_unavailable';
    return {
      member,
      adapterId,
      displayName: member?.displayName || adapterId || 'unknown',
      registered,
      chatReady,
      nativeRuntime: nativeCapabilities?.nativeRuntime === true,
      nativeCapabilities,
      status,
    };
  });
  const adapterProblems = adapterReadiness
    .filter((item) => !item.registered || !item.chatReady)
    .map((item) => `${item.adapterId || item.displayName}:${item.status}`);
  const chatReadyCount = adapterReadiness.filter((item) => item.chatReady).length;
  const adapterCheckSeverity = adapterProblems.length > 0 && chatReadyCount > 0 ? 'warn' : 'error';
  const budgetEstimate = buildClusterExecutionBudgetEstimate(room);
  const checks = [
    preflightCheck(
      'mode',
      '房间模式为集群协同',
      room.mode === 'cross_verify',
      [`mode=${room.mode || 'unknown'}`],
      [room.mode === 'cross_verify' ? '' : 'mode_not_cross_verify'],
    ),
    preflightCheck(
      'members',
      '至少 2 个启用成员,或已有故障降级证据允许单模型接管',
      enabledMembers.length >= 2 || soloTakeoverEligible,
      [`enabledMembers=${enabledMembers.length}`, `soloTakeoverEligible=${soloTakeoverEligible}`],
      [enabledMembers.length >= 2 || soloTakeoverEligible ? '' : 'enabled_members_lt_2'],
    ),
    ...(soloTakeoverEligible ? [
      preflightCheck(
        'solo_takeover',
        '单模型接管为故障降级运行',
        false,
        [`enabledMembers=${enabledMembers.length}`, 'failoverEvidence=true'],
        ['solo_takeover_active'],
        'warn',
      ),
    ] : []),
    preflightCheck(
      'adapters',
      '启用成员 adapter 已注册且可发起 chat;部分不可用时允许剩余成员降级接管',
      adapterProblems.length === 0,
      adapterReadiness.map((item) => `${item.displayName}:${item.adapterId || 'missing'}:${item.status}`),
      adapterProblems.map((id) => `adapter_unavailable=${id}`),
      adapterCheckSeverity,
    ),
    preflightCheck(
      'project_goal',
      '单一项目目标已填写',
      projectGoal.length > 0,
      [`topicChars=${projectGoal.length}`],
      [projectGoal ? '' : 'project_goal_missing'],
    ),
    preflightCheck(
      'cwd',
      '工作目录可访问',
      cwdOk,
      [`cwd=${cwd}`],
      [cwdOk ? '' : cwdReason],
    ),
    preflightCheck(
      'lifecycle',
      '11 阶段工程闭环模板可用',
      CLUSTER_ENGINEERING_STAGES.length === 11,
      [`stageCount=${CLUSTER_ENGINEERING_STAGES.length}`],
      [CLUSTER_ENGINEERING_STAGES.length === 11 ? '' : `unexpected_stage_count=${CLUSTER_ENGINEERING_STAGES.length}`],
    ),
    preflightCheck(
      'delivery_archive',
      '交付包归档路径已规划',
      cwdOk,
      [`archiveRoot=${cwd}/output/noe/cluster-delivery`],
      [cwdOk ? '' : 'archive_root_unavailable'],
      'warn',
    ),
    preflightCheck(
      'execution_budget',
      '集群协同调用量/Token 预估可控',
      budgetEstimate.status !== 'blocked',
      [
        `members=${budgetEstimate.memberCount}`,
        `stages=${budgetEstimate.stageCount}`,
        `maxRounds=${budgetEstimate.maxRounds}`,
        `estimatedCallsWorstCase=${budgetEstimate.estimatedCallsWorstCase}`,
        `estimatedTokensWorstCase=${budgetEstimate.estimatedTokensWorstCase}`,
      ],
      [...budgetEstimate.blockers, ...budgetEstimate.warnings],
      budgetEstimate.status === 'warn' ? 'warn' : 'error',
    ),
  ];
  const blocked = checks.filter((check) => check.status === 'blocked');
  const warns = checks.filter((check) => check.status === 'warn');
  return {
    generatedAt: new Date().toISOString(),
    preflightVersion: 'cluster-preflight-v1',
    mode: 'cross_verify',
    roomId: room.id || '',
    topic: projectGoal,
    status: blocked.length ? 'blocked' : warns.length ? 'warn' : 'passed',
    passedCount: checks.filter((check) => check.passed).length,
    total: checks.length,
    checks,
    adapterReadiness: adapterReadiness.map((item) => ({
      adapterId: item.adapterId,
      displayName: item.displayName,
      registered: item.registered,
      chatReady: item.chatReady,
      status: item.status,
      nativeRuntime: item.nativeRuntime,
      nativeCapabilities: item.nativeCapabilities,
    })),
    budgetEstimate,
    blockers: blocked.flatMap((check) => check.blockers.map((blocker) => `${check.id}:${blocker}`)),
    warnings: warns.flatMap((check) => check.blockers.map((blocker) => `${check.id}:${blocker}`)),
  };
}

function liveCheckBlockerMessage(error) {
  const message = String(error?.message || error || 'unknown_error').slice(0, 180);
  if (message === 'cluster_adapter_live_ping_timeout') return 'live_ping_timeout';
  return `live_ping_failed=${message}`;
}

function isLiveCheckSoftTimeout(check = {}) {
  const blockers = Array.isArray(check.blockers) ? check.blockers : [];
  return check?.passed !== true && blockers.length > 0 && blockers.every((blocker) => blocker === 'live_ping_timeout');
}

export async function runClusterAdapterLiveChecks(room = {}, {
  topic = '',
  roomAdapterPool = null,
  timeoutMs = 30000,
} = {}) {
  const enabledMembers = Array.isArray(room.members) ? room.members.filter((member) => member?.enabled !== false) : [];
  const projectGoal = String(topic || room.topic || room.objective?.title || room.name || '').trim();
  const boundedTimeoutMs = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 60000);
  const checks = await Promise.all(enabledMembers.map(async (member) => {
    const adapterId = String(member?.adapterId || '').trim();
    const displayName = String(member?.displayName || adapterId || 'unknown').slice(0, 120);
    const adapter = adapterId && roomAdapterPool && typeof roomAdapterPool.get === 'function'
      ? roomAdapterPool.get(adapterId)
      : null;
    if (!adapterId) {
      return { adapterId, displayName, passed: false, status: 'blocked', latencyMs: 0, evidence: [], blockers: ['missing_adapter_id'] };
    }
    if (!adapter || typeof adapter.chat !== 'function') {
      return { adapterId, displayName, passed: false, status: 'blocked', latencyMs: 0, evidence: [], blockers: ['chat_unavailable'] };
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch {}
          reject(new Error('cluster_adapter_live_ping_timeout'));
        }, boundedTimeoutMs);
      });
      const result = await Promise.race([
        adapter.chat([
          { role: 'system', content: '你是 Noe 集群协同启动前的轻量连通性探测。' },
          { role: 'user', content: `只回复 OK。项目目标: ${projectGoal.slice(0, 200) || '未命名项目'}` },
        ], {
          cwd: room.cwd,
          model: member.model,
          abortSignal: controller.signal,
          livePing: true,
          skipBudget: true,
          agentRunLifecycle: false,
          budgetContext: { projectId: room.cwd, roomId: room.id, adapterId, preflight: 'cluster_live_ping' },
        }),
        timeout,
      ]);
      const reply = String(result?.reply || '').trim();
      const passed = reply.length > 0;
      return {
        adapterId,
        displayName,
        passed,
        status: passed ? 'passed' : 'blocked',
        latencyMs: Date.now() - startedAt,
        evidence: [`replyChars=${reply.length}`, `model=${member.model || 'default'}`],
        blockers: passed ? [] : ['empty_reply'],
      };
    } catch (error) {
      return {
        adapterId,
        displayName,
        passed: false,
        status: 'blocked',
        latencyMs: Date.now() - startedAt,
        evidence: [`model=${member.model || 'default'}`],
        blockers: [liveCheckBlockerMessage(error)],
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
  const failed = checks.filter((check) => check.passed !== true);
  const softTimedOut = failed.filter(isLiveCheckSoftTimeout);
  const hardBlocked = failed.filter((check) => !isLiveCheckSoftTimeout(check));
  const status = hardBlocked.length > 0 ? 'blocked' : softTimedOut.length > 0 ? 'warn' : 'passed';
  return {
    generatedAt: new Date().toISOString(),
    liveCheckVersion: 'cluster-adapter-live-check-v1',
    roomId: room.id || '',
    topic: projectGoal,
    timeoutMs: boundedTimeoutMs,
    status,
    passedCount: checks.filter((check) => check.passed).length,
    warningCount: softTimedOut.length,
    blockedCount: hardBlocked.length,
    total: checks.length,
    checks,
    blockers: hardBlocked.flatMap((check) => check.blockers.map((blocker) => `${check.adapterId || check.displayName}:${blocker}`)),
    warnings: softTimedOut.flatMap((check) => check.blockers.map((blocker) => `${check.adapterId || check.displayName}:${blocker}`)),
  };
}

export function buildClusterEvidenceLink(room = {}, input = {}, { agentRunStore = null } = {}) {
  const stageId = String(input.stageId || '').trim();
  const runId = String(input.agentRunId || input.runId || '').trim();
  if (!CLUSTER_ENGINEERING_STAGES.some((stage) => stage.id === stageId)) {
    throw new Error('stageId invalid');
  }
  if (!runId) throw new Error('agentRunId required');
  const timeline = agentRunStore?.getTimeline?.(runId);
  if (!timeline?.run) throw new Error('agent run not found');
  if (timeline.run.roomId && room.id && timeline.run.roomId !== room.id) {
    throw new Error('agent run belongs to a different room');
  }
  const stageTask = Array.isArray(room.taskList)
    ? room.taskList.find((task) => task?.stageId === stageId)
    : null;
  if (timeline.run.taskId && stageTask?.id && timeline.run.taskId !== stageTask.id) {
    throw new Error('agent run belongs to a different task');
  }
  const toolResults = Array.isArray(timeline.toolResults) ? timeline.toolResults : [];
  const toolResultCount = toolResults.filter(isVerifiableAgentToolResult).length;
  const totalToolResultCount = toolResults.length;
  const rejectedToolResultCount = totalToolResultCount - toolResultCount;
  const archiveCount = Array.isArray(timeline.archives) ? timeline.archives.length : 0;
  const artifactCount = Array.isArray(timeline.artifacts) ? timeline.artifacts.length : 0;
  const evidenceCount = toolResultCount + archiveCount + artifactCount;
  if (timeline.run.status !== 'succeeded') throw new Error('agent run is not succeeded');
  if (evidenceCount <= 0) throw new Error('agent run has no verifiable evidence');
  const now = new Date().toISOString();
  const stage = CLUSTER_ENGINEERING_STAGES.find((item) => item.id === stageId);
  return {
    id: `cluster-evidence-${createHash('sha1').update(`${room.id || ''}|${stageId}|${runId}|${now}`).digest('hex').slice(0, 12)}`,
    createdAt: now,
    stageId,
    stageLabel: stage?.label || stageId,
    agentRunId: runId,
    runStatus: timeline.run.status,
    verified: true,
    toolResultCount,
    totalToolResultCount,
    rejectedToolResultCount,
    archiveCount,
    artifactCount,
    evidenceCount,
    summary: String(input.summary || '').slice(0, 500),
  };
}

function isVerifiableAgentToolResult(item = {}) {
  const status = String(item?.status || '').trim().toLowerCase();
  if (!status) return true;
  return !/(failed|error|blocked|denied|approval_required|cancelled|canceled|timeout)/i.test(status);
}

export function rebuildClusterDeliveryAfterEvidenceLink(room = {}) {
  const taskList = Array.isArray(room.taskList) ? room.taskList : [];
  if (!taskList.length) return {};
  const clusterWorkflowAudit = buildClusterWorkflowAudit(taskList);
  const clusterDeliveryManifest = buildClusterDeliveryManifest({
    room,
    taskList,
    audit: clusterWorkflowAudit,
    topic: room.topic || room.name || '',
  });
  const clusterDeliveryReportMarkdown = buildClusterDeliveryReportMarkdown(clusterDeliveryManifest);
  const clusterDeliveryPackage = buildClusterDeliveryPackage(clusterDeliveryManifest, clusterDeliveryReportMarkdown);
  return {
    taskList,
    clusterWorkflowAudit,
    clusterDeliveryManifest,
    clusterDeliveryReportMarkdown,
    clusterDeliveryPackage,
    ...(clusterDeliveryManifest.readyForDelivery === true && clusterDeliveryManifest.deliveryGate?.status === 'passed'
      ? { status: 'done' }
      : {}),
  };
}

function countTurns(rounds) {
  if (!Array.isArray(rounds)) return 0;
  return rounds.reduce((sum, round) => sum + (Array.isArray(round?.turns) ? round.turns.length : 0), 0);
}

function memberSummary(member = {}) {
  const agentProfileId = typeof member.agentProfileId === 'string'
    ? member.agentProfileId
    : (typeof member.profileId === 'string' ? member.profileId : undefined);
  const summary = {
    adapterId: typeof member.adapterId === 'string' ? member.adapterId : '',
    displayName: typeof member.displayName === 'string' ? member.displayName : '',
    model: typeof member.model === 'string' ? member.model : '',
    role: typeof member.role === 'string' ? member.role : undefined,
    enabled: member.enabled !== false,
  };
  if (agentProfileId) summary.agentProfileId = agentProfileId;
  return summary;
}

export function normalizeAgentProfileId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id) return undefined;
  if (!DEFAULT_AGENT_SKILL_REGISTRY.profileById.has(id)) return null;
  return id;
}

export function normalizeRoomSkillNames(values = [], skillStore = null) {
  const out = [];
  const seen = new Set();
  const installed = typeof skillStore?.list === 'function'
    ? new Map(skillStore.list().map((skill) => [skill.name, skill]))
    : null;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) continue;
    if (seen.has(name)) continue;
    if (installed) {
      const skill = installed.get(name);
      if (!skill || skill.enabled === false) return null;
    }
    seen.add(name);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

export function summarizeRoom(room = {}) {
  const runtimeRoom = roomWithFreshClusterRuntimeState(room, 'api_list_summary');
  const rounds = Array.isArray(room.rounds) ? room.rounds : [];
  const taskList = Array.isArray(room.taskList) ? room.taskList : [];
  const conversation = Array.isArray(room.conversation) ? room.conversation : [];
  const userInterventions = Array.isArray(room.userInterventions) ? room.userInterventions : [];
  return {
    id: room.id,
    name: room.name,
    mode: room.mode,
    status: room.status,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    cwd: room.cwd,
    archived: room.archived === true,
    archivedAt: room.archivedAt || null,
    currentRound: room.currentRound,
    currentMacroRound: room.currentMacroRound,
    debateRounds: room.debateRounds,
    qaStrictness: room.qaStrictness,
    clusterRuntimeState: runtimeRoom?.clusterRuntimeState,
    skills: Array.isArray(room.skills) ? room.skills : undefined,
    exportPath: typeof room.exportPath === 'string' ? room.exportPath : undefined,
    members: Array.isArray(room.members) ? room.members.map(memberSummary) : [],
    roundCount: rounds.length,
    turnCount: countTurns(rounds),
    taskCount: taskList.length,
    conversationCount: conversation.length,
    userInterventionCount: userInterventions.length,
    hasFinalConsensus: typeof room.finalConsensus === 'string' && room.finalConsensus.length > 0,
    objective: objectiveSummary(room.objective),
    projectContext: room.projectContextSummary || (room.projectContext ? {
      fileCount: Array.isArray(room.projectContext.files) ? room.projectContext.files.length : 0,
      totalChars: Number(room.projectContext.totalChars) || 0,
      truncated: !!room.projectContext.truncated,
    } : null),
    roleCards: summarizeRoleCards(room.roleCards),
    lineage: room.lineage ? {
      projectId: room.lineage.projectId || '',
      parentRoomId: room.lineage.parentRoomId || null,
      parentTaskId: room.lineage.parentTaskId || null,
      taskId: room.lineage.taskId || null,
      objectiveId: room.lineage.objectiveId || room.objective?.id || null,
      source: room.lineage.source || 'manual',
    } : undefined,
  };
}

function textLength(value) {
  return typeof value === 'string' ? value.length : 0;
}

function estimateRoomListPayloadWeight(room = {}) {
  let textChars = 0;
  let turnCount = 0;
  let taskAttemptCount = 0;
  const rounds = Array.isArray(room.rounds) ? room.rounds : [];
  for (const round of rounds) {
    const turns = Array.isArray(round?.turns) ? round.turns : [];
    turnCount += turns.length;
    for (const turn of turns) {
      textChars += textLength(turn?.content);
      if (textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS) break;
    }
    if (textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS) break;
  }
  const taskList = Array.isArray(room.taskList) ? room.taskList : [];
  for (const task of taskList) {
    textChars += textLength(task?.consensus?.finalPlan);
    textChars += textLength(task?.stageArtifact?.acceptanceReport?.summaryText);
    const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
    taskAttemptCount += attempts.length;
    for (const attempt of attempts) {
      textChars += textLength(attempt?.content);
      if (textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS) break;
    }
    if (textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS) break;
  }
  const conversation = Array.isArray(room.conversation) ? room.conversation : [];
  for (const item of conversation) {
    textChars += textLength(item?.content);
    if (textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS) break;
  }
  textChars += textLength(room.finalConsensus);
  textChars += textLength(room.clusterDeliveryReportMarkdown);
  return {
    textChars,
    turnCount,
    taskAttemptCount,
    conversationCount: conversation.length,
  };
}

function isTooHeavyForFullRoomList(room = {}) {
  const weight = estimateRoomListPayloadWeight(room);
  return {
    tooHeavy: weight.textChars > ROOM_LIST_FULL_MAX_TEXT_CHARS
      || weight.turnCount > ROOM_LIST_FULL_MAX_TURNS
      || weight.taskAttemptCount > ROOM_LIST_FULL_MAX_TASK_ATTEMPTS
      || weight.conversationCount > ROOM_LIST_FULL_MAX_CONVERSATION,
    weight,
  };
}

export function fullListRoomPayload(room = {}) {
  const freshRoom = roomWithFreshClusterRuntimeState(room, 'api_list_full');
  const { tooHeavy, weight } = isTooHeavyForFullRoomList(room);
  if (!tooHeavy) return freshRoom;
  return {
    ...summarizeRoom(room),
    compact: true,
    fullPayloadOmitted: true,
    fullPayloadReason: 'room_too_large_for_list',
    fullPayloadWeight: weight,
    detailEndpoint: `/api/rooms/${encodeURIComponent(String(room.id || ''))}`,
    clusterRuntimeState: freshRoom.clusterRuntimeState,
  };
}

export function roomListResponse(rooms, query = {}) {
  if (wantsFullRoomList(query)) {
    const payloadRooms = rooms.map((room) => fullListRoomPayload(room));
    return {
      ok: true,
      rooms: payloadRooms,
      compact: false,
      fullPayloadPolicy: {
        maxTextChars: ROOM_LIST_FULL_MAX_TEXT_CHARS,
        omittedCount: payloadRooms.filter((room) => room?.fullPayloadOmitted === true).length,
      },
    };
  }
  return { ok: true, rooms: rooms.map(summarizeRoom), compact: true };
}

export function searchRooms({ roomStore, query }) {
  const q = query.q;
  if (!q || typeof q !== 'string' || !q.trim()) return { status: 400, body: { error: 'q required' } };
  if (q.length > 200) return { status: 400, body: { error: 'q 过长（>200）' } };
  const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 30));
  const includeArchived = query.includeArchived === '1';
  const needle = q.toLowerCase();
  const perRoomCap = Math.max(3, Math.ceil(limit / 4));
  const hardCap = limit * 5;
  const hits = [];

  function pushHit(room, where, snippet, extra = {}) {
    const lc = String(snippet || '').toLowerCase();
    const idx = lc.indexOf(needle);
    if (idx < 0) return false;
    const s = String(snippet);
    const start = Math.max(0, idx - 60);
    const end = Math.min(s.length, idx + needle.length + 60);
    hits.push({
      roomId: room.id,
      roomName: room.name,
      mode: room.mode,
      where,
      snippet: (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : ''),
      updatedAt: room.updatedAt || room.createdAt,
      ...extra,
    });
    return true;
  }

  const allRooms = includeArchived
    ? [...roomStore.list(), ...roomStore.listArchived()]
    : roomStore.list();

  outer: for (const room of allRooms) {
    let perRoomHits = 0;
    for (const field of ['name', 'topic', 'finalConsensus']) {
      if (pushHit(room, field, room[field])) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits < perRoomCap && hits.length < hardCap && room.objective) {
      if (pushHit(room, 'objective:title', room.objective.title)) perRoomHits++;
      if (pushHit(room, 'objective:description', room.objective.description)) perRoomHits++;
      for (const [i, criterion] of (room.objective.acceptanceCriteria || []).entries()) {
        if (pushHit(room, `objective:acceptance:${i + 1}`, criterion)) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const r of (room.rounds || [])) {
      for (const t of (r.turns || [])) {
        if (pushHit(room, `turn:${r.kind}`, t.content, { speaker: t.speaker })) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const c of (room.conversation || [])) {
      if (pushHit(room, `chat:${c.from}`, c.content)) perRoomHits++;
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (perRoomHits >= perRoomCap || hits.length >= hardCap) {
      if (hits.length >= hardCap) break outer;
      continue;
    }
    for (const task of (room.taskList || [])) {
      if (pushHit(room, `task:${task.id}.title`, task.title)) perRoomHits++;
      if (pushHit(room, `task:${task.id}.desc`, task.desc)) perRoomHits++;
      for (const at of (task.attempts || [])) {
        if (pushHit(room, `task:${task.id}.attempt`, at.content)) perRoomHits++;
        if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
      }
      if (perRoomHits >= perRoomCap || hits.length >= hardCap) break;
    }
    if (hits.length >= hardCap) break outer;
  }

  hits.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const finalHits = hits.slice(0, limit);
  return { status: 200, body: { ok: true, query: q, count: finalHits.length, total: hits.length, hits: finalHits } };
}
