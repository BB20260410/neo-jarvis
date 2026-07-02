// @ts-check
// Read-only preflight for companion agent tools that Noe can learn from or call.
// It intentionally reads only public install metadata (package/pyproject) and
// state-directory presence; it does not read tool configs, tokens, or secrets.
import { delimiter, dirname, join, resolve } from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';

const VERSION = 'noe-companion-tool-preflight-v2';

function cleanPath(value = '') {
  return String(value || '').replace(/\\/g, '/');
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const s = cleanPath(value);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function safeExists(file) {
  try { return existsSync(file); } catch { return false; }
}

function safeRealpath(file) {
  try { return cleanPath(realpathSync(file)); } catch { return cleanPath(file); }
}

function isExecutable(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

function findExecutableInPath(name, pathValue = '') {
  for (const dir of String(pathValue || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return cleanPath(candidate);
  }
  return '';
}

function findUpFile(start, filename, maxDepth = 8) {
  let current = resolve(start || '.');
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, filename);
    if (safeExists(candidate)) return cleanPath(candidate);
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return '';
}

function parsePyprojectVersion(text = '') {
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  const version = text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1] || '';
  return { name, version };
}

function versionParts(value = '') {
  return String(value || '')
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

export function compareCompanionVersions(a = '', b = '') {
  const aa = versionParts(a);
  const bb = versionParts(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

function newestVersion(candidates = []) {
  const withVersion = candidates.filter((item) => item.version);
  if (!withVersion.length) return null;
  return withVersion.reduce((best, item) => (
    compareCompanionVersions(item.version, best.version) > 0 ? item : best
  ), withVersion[0]);
}

function repairAction({
  id,
  tool,
  warning,
  title,
  reason,
  targetPath = '',
  currentPath = '',
  currentVersion = '',
  targetVersion = '',
  verification = [],
  automatic = false,
  blocked = false,
} = {}) {
  return {
    id,
    tool,
    warning,
    title,
    reason,
    currentPath,
    currentVersion,
    targetPath,
    targetVersion,
    verification,
    safeAutomatic: automatic === true,
    repairable: automatic === true,
    requiresOwnerApproval: automatic !== true,
    blocked: blocked === true,
  };
}

function openClawCandidate(file = '') {
  const path = cleanPath(file);
  const exists = safeExists(path);
  const target = exists ? safeRealpath(path) : '';
  const packagePath = target ? findUpFile(dirname(target), 'package.json', 4) : '';
  const pkg = packagePath ? readJson(packagePath) : null;
  const isOpenClaw = pkg?.name === 'openclaw';
  return {
    path,
    exists,
    target,
    packagePath: isOpenClaw ? packagePath : '',
    version: isOpenClaw ? String(pkg.version || '') : '',
  };
}

function hermesCandidate(file = '') {
  const path = cleanPath(file);
  const exists = safeExists(path);
  const target = exists ? safeRealpath(path) : '';
  const pyprojectPath = target ? findUpFile(dirname(target), 'pyproject.toml', 8) : '';
  const pyproject = pyprojectPath ? parsePyprojectVersion(readText(pyprojectPath)) : { name: '', version: '' };
  const isHermes = pyproject.name === 'hermes-agent';
  return {
    path,
    exists,
    target,
    projectPath: isHermes ? cleanPath(dirname(pyprojectPath)) : '',
    pyprojectPath: isHermes ? pyprojectPath : '',
    version: isHermes ? pyproject.version : '',
  };
}

function analyzeOpenClaw({ activePath = '', candidates = [] } = {}) {
  const installs = unique([activePath, ...candidates]).map(openClawCandidate);
  const existing = installs.filter((item) => item.exists);
  const active = installs.find((item) => item.path === cleanPath(activePath)) || null;
  const newest = newestVersion(existing);
  const versions = unique(existing.map((item) => item.version).filter(Boolean));
  const warnings = [];
  if (!activePath) warnings.push('openclaw_not_on_path');
  if (versions.length > 1) warnings.push('multiple_openclaw_versions_detected');
  if (active?.version && newest?.version && compareCompanionVersions(active.version, newest.version) < 0) {
    warnings.push('active_openclaw_older_than_available_candidate');
  }
  return {
    status: warnings.length ? 'warn' : existing.length ? 'ok' : 'missing',
    activePath: cleanPath(activePath),
    activeVersion: active?.version || '',
    newestCandidatePath: newest?.path || '',
    newestCandidateVersion: newest?.version || '',
    candidates: installs,
    warnings,
    recommendedAction: warnings.includes('active_openclaw_older_than_available_candidate')
      ? '将 PATH 指向较新的 OpenClaw 安装，或用目标安装重新执行 openclaw update status；不要在 Noe 自检里自动改 PATH。'
      : warnings.includes('openclaw_not_on_path')
        ? '安装或暴露 openclaw CLI 后再运行伴随工具自检。'
        : '',
  };
}

function analyzeHermes({ activePath = '', candidates = [] } = {}) {
  const installs = unique([activePath, ...candidates]).map(hermesCandidate);
  const existing = installs.filter((item) => item.exists);
  const active = installs.find((item) => item.path === cleanPath(activePath)) || null;
  const warnings = [];
  if (!activePath) warnings.push('hermes_not_on_path');
  if (existing.length > 1) warnings.push('multiple_hermes_launchers_detected');
  return {
    status: warnings.length ? 'warn' : existing.length ? 'ok' : 'missing',
    activePath: cleanPath(activePath),
    activeVersion: active?.version || '',
    activeProjectPath: active?.projectPath || '',
    candidates: installs,
    warnings,
    recommendedAction: warnings.includes('hermes_not_on_path')
      ? '安装或暴露 hermes CLI 后再运行伴随工具自检。'
      : '',
  };
}

function analyzeClawPanel(paths = []) {
  const directories = unique(paths).map((path) => ({ path, exists: safeExists(path) }));
  const existing = directories.filter((item) => item.exists);
  return {
    status: existing.length ? 'ok' : 'missing',
    directories,
    warnings: existing.length ? [] : ['claw_panel_state_dirs_not_found'],
    recommendedAction: existing.length ? '' : '如果需要继续对标 Claw Panel，请确认本机 clawpanel 状态目录或归档源码路径。'
  };
}

function buildOpenClawRepairActions(openclaw = {}) {
  const warnings = Array.isArray(openclaw.warnings) ? openclaw.warnings : [];
  const actions = [];
  if (warnings.includes('active_openclaw_older_than_available_candidate')) {
    actions.push(repairAction({
      id: 'prefer_newer_openclaw_candidate',
      tool: 'openclaw',
      warning: 'active_openclaw_older_than_available_candidate',
      title: '切换到较新的开爪候选版本',
      reason: '当前 PATH 命中的开爪版本低于本机已发现候选版本；开机自检只给出计划，不自动改 shell 配置。',
      currentPath: openclaw.activePath || '',
      currentVersion: openclaw.activeVersion || '',
      targetPath: openclaw.newestCandidatePath || '',
      targetVersion: openclaw.newestCandidateVersion || '',
      verification: ['openclaw --version', 'openclaw doctor --fix 或 openclaw update --yes 需主人确认后执行'],
    }));
  }
  if (warnings.includes('multiple_openclaw_versions_detected')) {
    actions.push(repairAction({
      id: 'dedupe_openclaw_path_candidates',
      tool: 'openclaw',
      warning: 'multiple_openclaw_versions_detected',
      title: '确认开爪 PATH 优先级',
      reason: '本机存在多个开爪安装入口；需要人工确认保留哪个作为 Noe 调用入口，避免自检和真实执行不一致。',
      currentPath: openclaw.activePath || '',
      currentVersion: openclaw.activeVersion || '',
      targetPath: openclaw.newestCandidatePath || '',
      targetVersion: openclaw.newestCandidateVersion || '',
      verification: ['which openclaw', 'openclaw --version'],
    }));
  }
  if (warnings.includes('openclaw_not_on_path')) {
    const hasCandidate = Boolean(openclaw.newestCandidatePath);
    actions.push(repairAction({
      id: hasCandidate ? 'expose_openclaw_candidate_on_path' : 'install_openclaw_cli',
      tool: 'openclaw',
      warning: 'openclaw_not_on_path',
      title: hasCandidate ? '把已发现的开爪候选加入 PATH' : '安装或恢复开爪命令行入口',
      reason: hasCandidate
        ? '已在本机发现开爪候选，但当前 PATH 未命中；需要主人确认 shell 配置或启动环境。'
        : '当前 PATH 和默认候选位置均未发现开爪；Noe 不能自动安装未知来源工具。',
      targetPath: openclaw.newestCandidatePath || '',
      targetVersion: openclaw.newestCandidateVersion || '',
      verification: ['which openclaw', 'openclaw --version'],
      blocked: !hasCandidate,
    }));
  }
  return actions;
}

function buildHermesRepairActions(hermes = {}) {
  const warnings = Array.isArray(hermes.warnings) ? hermes.warnings : [];
  const actions = [];
  const existingCandidates = (hermes.candidates || []).filter((item) => item.exists);
  const firstCandidate = existingCandidates[0] || null;
  if (warnings.includes('hermes_not_on_path')) {
    actions.push(repairAction({
      id: firstCandidate ? 'expose_hermes_candidate_on_path' : 'install_hermes_cli',
      tool: 'hermes',
      warning: 'hermes_not_on_path',
      title: firstCandidate ? '把赫尔墨斯启动器加入 PATH' : '安装或恢复赫尔墨斯启动器',
      reason: firstCandidate
        ? '本机存在赫尔墨斯启动器候选，但当前 PATH 未命中；需要主人确认启动环境。'
        : '当前 PATH 和默认候选位置均未发现赫尔墨斯；Noe 不自动安装未知来源工具。',
      targetPath: firstCandidate?.path || '',
      targetVersion: firstCandidate?.version || '',
      verification: ['which hermes', 'hermes --version'],
      blocked: !firstCandidate,
    }));
  }
  if (warnings.includes('multiple_hermes_launchers_detected')) {
    actions.push(repairAction({
      id: 'dedupe_hermes_launchers',
      tool: 'hermes',
      warning: 'multiple_hermes_launchers_detected',
      title: '确认赫尔墨斯唯一启动入口',
      reason: '本机存在多个赫尔墨斯启动器；需要确认 Noe 使用哪个入口，避免版本和工作目录漂移。',
      currentPath: hermes.activePath || '',
      currentVersion: hermes.activeVersion || '',
      targetPath: firstCandidate?.path || '',
      targetVersion: firstCandidate?.version || '',
      verification: ['which hermes', 'hermes --version'],
    }));
  }
  return actions;
}

function buildClawPanelRepairActions(clawPanel = {}) {
  const warnings = Array.isArray(clawPanel.warnings) ? clawPanel.warnings : [];
  if (!warnings.includes('claw_panel_state_dirs_not_found')) return [];
  return [repairAction({
    id: 'locate_claw_panel_state_or_source',
    tool: 'clawPanel',
    warning: 'claw_panel_state_dirs_not_found',
    title: '定位 Claw Panel 状态目录或源码归档',
    reason: '默认状态目录不存在；Noe 不创建空目录来伪造 Claw Panel 存在性，需要主人确认真实安装或源码位置。',
    verification: ['确认 Claw Panel 安装路径', '确认状态目录后重新运行开机自检'],
    blocked: true,
  })];
}

function buildRepairPlan(tools = {}) {
  const actions = [
    ...buildOpenClawRepairActions(tools.openclaw || {}),
    ...buildHermesRepairActions(tools.hermes || {}),
    ...buildClawPanelRepairActions(tools.clawPanel || {}),
  ];
  const safeAutomatic = actions.filter((item) => item.safeAutomatic === true);
  const manual = actions.filter((item) => item.safeAutomatic !== true && item.blocked !== true);
  const blocked = actions.filter((item) => item.blocked === true);
  return {
    status: actions.length ? 'attention_required' : 'clean',
    summary: {
      total: actions.length,
      safeAutomatic: safeAutomatic.length,
      manual: manual.length,
      blocked: blocked.length,
      requiresOwnerApproval: actions.filter((item) => item.requiresOwnerApproval === true).length,
    },
    safeAutomatic,
    manual,
    blocked,
    actions,
    policy: {
      noPathMutation: true,
      noPackageInstall: true,
      noConfigRead: true,
      noSecretRead: true,
      actionsPerformed: false,
    },
  };
}

function defaultHome(env = process.env) {
  return String(env.HOME || env.USERPROFILE || '');
}

export function collectNoeCompanionToolPreflight({
  env = process.env,
  pathValue = env.PATH || '',
  homeDir = defaultHome(env),
  openClawCandidates = null,
  hermesCandidates = null,
  clawPanelPaths = null,
} = {}) {
  const home = cleanPath(homeDir);
  const openClawActive = findExecutableInPath('openclaw', pathValue);
  const hermesActive = findExecutableInPath('hermes', pathValue);
  const openclaw = analyzeOpenClaw({
    activePath: openClawActive,
    candidates: openClawCandidates || [
      '/usr/local/bin/openclaw',
      home ? `${home}/.npm-global/bin/openclaw` : '',
    ],
  });
  const hermes = analyzeHermes({
    activePath: hermesActive,
    candidates: hermesCandidates || [
      home ? `${home}/.local/bin/hermes` : '',
    ],
  });
  const clawPanel = analyzeClawPanel(clawPanelPaths || [
    home ? `${home}/Library/Application Support/clawpanel` : '',
    home ? `${home}/.openclaw/clawpanel` : '',
    home ? `${home}/.openclaw/logs/stability` : '',
  ]);
  const tools = { openclaw, hermes, clawPanel };
  const warnings = [
    ...openclaw.warnings.map((item) => `openclaw:${item}`),
    ...hermes.warnings.map((item) => `hermes:${item}`),
    ...clawPanel.warnings.map((item) => `clawpanel:${item}`),
  ];
  const repairPlan = buildRepairPlan(tools);
  return {
    ok: true,
    version: VERSION,
    status: warnings.length ? 'warn' : 'ok',
    tools,
    warnings,
    blockers: [],
    repairPlan,
    policy: {
      readOnly: true,
      configFilesRead: false,
      secretValuesReturned: false,
      actionsPerformed: false,
    },
  };
}
