import { inferCodeContextSignals } from './CodeContextSignals.js';
import { normalizeCodeContextEvidence, summarizeCodeContextEvidence } from './CodeContextEvidence.js';
import { normalizeSymbolGraph, summarizeSymbolGraph } from './SymbolGraph.js';

const DEFAULT_AGENT_PROFILES = [
  {
    id: 'xike-chief',
    roles: ['pm'],
    title: 'Xike Chief Planner',
    mission: 'Turn the user objective into a small set of verifiable, dependency-aware tasks.',
    boundaries: [
      'define acceptance criteria before implementation',
      'prefer parallelizable tasks when dependencies are not real',
      'summarize risks and handoffs without doing dev work',
    ],
    skillBindings: ['autoplan', 'plan-eng-review', 'retro'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'standard',
      approvalPolicy: 'plan_changes_only',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-builder',
    roles: ['dev'],
    title: 'Xike Builder',
    mission: 'Implement the assigned task, run the narrowest meaningful verification, and explain the changed surface.',
    boundaries: [
      'stay inside the assigned task boundary',
      'prefer existing project patterns over new abstractions',
      'include concrete verification evidence',
    ],
    skillBindings: ['codex', 'careful'],
    governance: {
      budgetTier: 'high',
      commandGuard: 'standard',
      approvalPolicy: 'dangerous_commands',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-verifier',
    roles: ['qa'],
    title: 'Xike Verifier',
    mission: 'Verify claims against files, commands, rendered UI, and tests before accepting a result.',
    boundaries: [
      'reject vague claims without evidence',
      'name the exact failing file, command, selector, or requirement',
      'separate blocker, bug, risk, and suggestion',
    ],
    skillBindings: ['qa', 'qa-only', 'browse'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'strict',
      approvalPolicy: 'dangerous_commands',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-architect',
    roles: ['architect'],
    title: 'Xike Architect',
    mission: 'Find the simplest durable architecture that can support future agents, skills, models, and governance.',
    boundaries: [
      'optimize for clear contracts and replacement points',
      'write migration steps when changing a shared interface',
      'avoid framework churn unless the current boundary is exhausted',
    ],
    skillBindings: ['plan-eng-review', 'investigate', 'benchmark'],
    governance: {
      budgetTier: 'high',
      commandGuard: 'strict',
      approvalPolicy: 'architecture_changes',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-judge',
    roles: ['judge'],
    title: 'Xike Judge',
    mission: 'Compare candidate outputs, check factual support, and decide the best next action.',
    boundaries: [
      'judge the evidence, not the model identity',
      'call out uncertainty instead of smoothing it over',
      'produce one decision with rollback or follow-up criteria',
    ],
    skillBindings: ['review', 'qa', 'office-hours'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'strict',
      approvalPolicy: 'final_decision',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-shipper',
    roles: ['shipper'],
    title: 'Xike Shipper',
    mission: 'Prepare the verified change for release, deployment, rollback, and operator handoff.',
    boundaries: [
      'never skip rollback notes for risky changes',
      'surface data, protocol, storage, and compatibility impact',
      'keep release artifacts reproducible',
    ],
    skillBindings: ['ship', 'setup-deploy', 'land-and-deploy', 'canary'],
    governance: {
      budgetTier: 'restricted',
      commandGuard: 'strict',
      approvalPolicy: 'release_and_destructive_actions',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-designer',
    roles: ['designer'],
    title: 'Xike Designer',
    mission: 'Translate product intent into clear, usable, domain-specific interaction flows.',
    boundaries: [
      'prioritize the primary workflow over decorative UI',
      'make state, progress, and risk legible',
      'verify text and controls fit across viewport sizes',
    ],
    skillBindings: ['design-consultation', 'design-review', 'document-release'],
    governance: {
      budgetTier: 'standard',
      commandGuard: 'standard',
      approvalPolicy: 'asset_export_changes',
      auditLevel: 'standard',
      budgetScope: 'agent_profile',
    },
  },
  {
    id: 'xike-observer',
    roles: ['observer'],
    title: 'Xike Observer',
    mission: 'Track context drift, recurring risks, and useful memory without mutating work.',
    boundaries: [
      'record evidence and open questions',
      'avoid changing task state',
      'escalate when context contradicts the plan',
    ],
    skillBindings: ['investigate', 'retro'],
    governance: {
      budgetTier: 'low',
      commandGuard: 'strict',
      approvalPolicy: 'read_only',
      auditLevel: 'full',
      budgetScope: 'agent_profile',
    },
  },
];

const DEFAULT_DISPATCH_RULES = [
  {
    tag: 'planning',
    agentId: 'xike-chief',
    keywords: ['plan', 'roadmap', 'split', 'breakdown', 'acceptance', 'priority', '规划', '计划', '拆解', '验收', '优先级'],
    skillHints: ['autoplan', 'plan-eng-review'],
  },
  {
    tag: 'implementation',
    agentId: 'xike-builder',
    keywords: ['implement', 'build', 'code', 'refactor', 'fix', 'patch', '实现', '开发', '编码', '重构', '修复'],
    skillHints: ['codex', 'careful'],
  },
  {
    tag: 'verification',
    agentId: 'xike-verifier',
    keywords: ['test', 'verify', 'qa', 'browser', 'screenshot', 'regression', '测试', '验证', '回归', '截图', '浏览器'],
    skillHints: ['qa', 'qa-only', 'browse'],
  },
  {
    tag: 'architecture',
    agentId: 'xike-architect',
    keywords: ['architecture', 'system', 'contract', 'migration', 'scalability', '架构', '系统', '接口', '迁移', '扩展'],
    skillHints: ['plan-eng-review', 'investigate'],
  },
  {
    tag: 'debugging',
    agentId: 'xike-architect',
    keywords: ['debug', 'root cause', 'perf', 'benchmark', 'trace', '排查', '根因', '性能', '基准', '链路'],
    skillHints: ['investigate', 'benchmark'],
  },
  {
    tag: 'release',
    agentId: 'xike-shipper',
    keywords: ['release', 'deploy', 'ship', 'canary', 'rollback', '上线', '部署', '发布', '回滚', '灰度'],
    skillHints: ['ship', 'setup-deploy', 'canary'],
  },
  {
    tag: 'design',
    agentId: 'xike-designer',
    keywords: ['ui', 'ux', 'design', 'layout', 'interaction', 'copy', '界面', '交互', '设计', '文案', '布局'],
    skillHints: ['design-consultation', 'design-review'],
  },
  {
    tag: 'governance',
    agentId: 'xike-judge',
    keywords: ['approval', 'budget', 'audit', 'policy', 'guard', 'governance', '审批', '预算', '审计', '治理', '权限'],
    skillHints: ['review', 'qa'],
  },
];

const ROLE_FALLBACK = {
  pm: 'xike-chief',
  dev: 'xike-builder',
  qa: 'xike-verifier',
  architect: 'xike-architect',
  judge: 'xike-judge',
  shipper: 'xike-shipper',
  designer: 'xike-designer',
  observer: 'xike-observer',
};

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function normalizeId(value) {
  const s = safeString(value, 80).toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(s)) return '';
  return s;
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function uniqueText(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = safeString(value, 80).toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function uniqueLimited(values, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = safeString(value, 240);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function resolveCodeContextSignals(input = {}) {
  const candidate = input?.codeContext || input;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.tags)) return candidate;
  return inferCodeContextSignals(candidate || {});
}

function resolveCodeContextEvidence(input = {}) {
  const candidate = input?.codeContext || input;
  return normalizeCodeContextEvidence(candidate || {});
}

function resolveCodeContextGraph(input = {}) {
  const candidate = input?.codeContext || input;
  return normalizeSymbolGraph(candidate || {});
}

/**
 * Normalizes a codebase question/answer object into a structured result with citations and coverage.
 * @param {Object} input - The input object containing codebaseQuestionAnswer, questionAnswer, or raw data.
 * @param {Array<Object>} [input.citations] - Array of citation objects.
 * @param {string} [input.question] - The question text.
 * @param {string} [input.answer] - The answer text.
 * @param {Object} [input.coverage] - Coverage statistics.
 * @returns {Object|null} Normalized object with ok, mode, question, answer, citations, coverage, etc., or null if invalid.
 */
function safeNonNegativeInt(value) {
  return Math.max(0, Number(value) || 0);
}

function resolveCitationId(rawId, index) {
  return safeString(rawId, 20) || `C${index + 1}`;
}

function resolveCitationLabel(rawLabel, path, line, id) {
  return safeString(rawLabel, 340) || (path ? `${path}:${line}` : id);
}

function safeOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCitationReasons(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons.map((reason) => safeString(reason, 120)).filter(Boolean).slice(0, 4);
}

function normalizeCitation(item, index) {
  const id = resolveCitationId(item.id, index);
  const path = safeString(item.path, 300);
  const line = Math.max(1, Number(item.line) || 1);
  const label = resolveCitationLabel(item.label, path, line, id);
  return {
    id,
    path,
    line,
    label,
    kind: safeString(item.kind, 100) || 'file',
    anchor: safeString(item.anchor, 180),
    parser: safeString(item.parser, 80) || 'unknown',
    score: Number(item.score || 0),
    semanticScore: safeOptionalNumber(item.semanticScore),
    reasons: normalizeCitationReasons(item.reasons),
    snippet: safeString(item.snippet, 260),
    evidenceCount: safeNonNegativeInt(item.evidenceCount),
    graphReferenceCount: safeNonNegativeInt(item.graphReferenceCount),
    routeUsageCount: safeNonNegativeInt(item.routeUsageCount),
  };
}

function normalizeCitations(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 6).map(normalizeCitation).filter((item) => item.path || item.label);
}

function normalizeAnswerLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => safeString(line, 360)).filter(Boolean).slice(0, 6);
}

function normalizeCoverage(coverage, citations) {
  const source = coverage && typeof coverage === 'object' ? coverage : {};
  return {
    resultCount: Math.max(0, Number(source.resultCount) || 0),
    citedResultCount: Math.max(0, Number(source.citedResultCount) || citations.length),
    uniqueFileCount: Math.max(0, Number(source.uniqueFileCount) || new Set(citations.map((item) => item.path).filter(Boolean)).size),
    evidenceItemCount: Math.max(0, Number(source.evidenceItemCount) || 0),
    graphReferenceCount: Math.max(0, Number(source.graphReferenceCount) || 0),
    routeUsageCount: Math.max(0, Number(source.routeUsageCount) || 0),
  };
}

function normalizeStringList(items, maxLength, limit) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => safeString(item, maxLength)).filter(Boolean).slice(0, limit);
}

/**
 * Normalizes a codebase question/answer payload into a stable shape.
 * @param {Object} [input] - Raw payload or a wrapper containing `codebaseQuestionAnswer` / `questionAnswer`.
 * @returns {Object|null} Normalized answer object, or null when no meaningful content is present.
 */
export function normalizeCodebaseQuestionAnswer(input = {}) {
  const candidate = input?.codebaseQuestionAnswer || input?.questionAnswer || input;
  if (!candidate || typeof candidate !== 'object') return null;
  const citations = normalizeCitations(candidate.citations);
  const question = safeString(candidate.question, 500);
  const answer = safeString(candidate.answer, 1200);
  if (!question && !answer && citations.length === 0) return null;
  return {
    ok: candidate.ok !== false,
    mode: safeString(candidate.mode, 80) || 'local-codebase-question',
    generatedBy: safeString(candidate.generatedBy, 120) || 'CodebaseIndexStore',
    question,
    confidence: safeString(candidate.confidence, 40) || 'unknown',
    answer,
    answerLines: normalizeAnswerLines(candidate.answerLines),
    citations,
    coverage: normalizeCoverage(candidate.coverage, citations),
    nextActions: normalizeStringList(candidate.nextActions, 180, 6),
    limitations: normalizeStringList(candidate.limitations, 180, 6),
  };
}

/**
 * Normalizes a governance policy object, ensuring all fields have valid IDs or defaults.
 * @param {Object} input - The policy object.
 * @param {string} [input.budgetTier] - Budget tier ID.
 * @param {string} [input.commandGuard] - Command guard ID.
 * @param {string} [input.approvalPolicy] - Approval policy ID.
 * @param {string} [input.auditLevel] - Audit level ID.
 * @param {string} [input.budgetScope] - Budget scope ID.
 * @returns {Object} Normalized policy object.
 */
export function normalizeGovernancePolicy(input = {}) {
  const policy = input && typeof input === 'object' ? input : {};
  const budgetTier = normalizeId(policy.budgetTier) || 'standard';
  const commandGuard = normalizeId(policy.commandGuard) || 'standard';
  const approvalPolicy = normalizeId(policy.approvalPolicy) || 'dangerous_commands';
  const auditLevel = normalizeId(policy.auditLevel) || 'standard';
  const budgetScope = normalizeId(policy.budgetScope) || 'agent_profile';
  return {
    budgetTier,
    commandGuard,
    approvalPolicy,
    auditLevel,
    budgetScope,
  };
}

function normalizeProfile(input = {}) {
  const id = normalizeId(input.id);
  if (!id) return null;
  return {
    id,
    roles: unique(input.roles || []),
    title: safeString(input.title, 120) || id,
    mission: safeString(input.mission, 800),
    boundaries: Array.isArray(input.boundaries)
      ? input.boundaries.map((item) => safeString(item, 240)).filter(Boolean).slice(0, 12)
      : [],
    skillBindings: unique(input.skillBindings || []),
    governance: normalizeGovernancePolicy(input.governance),
  };
}

function normalizeRule(input = {}) {
  const tag = normalizeId(input.tag);
  const agentId = normalizeId(input.agentId);
  if (!tag || !agentId) return null;
  return {
    tag,
    agentId,
    keywords: Array.isArray(input.keywords)
      ? input.keywords.map((item) => safeString(item, 80).toLowerCase()).filter(Boolean).slice(0, 40)
      : [],
    skillHints: unique(input.skillHints || []),
  };
}

/**
 * Builds an agent skill registry from default profiles/rules and optional overrides.
 * @param {Object} [overrides] - Optional overrides for profiles and dispatch rules.
 * @param {Array<Object>} [overrides.profiles] - Additional profile objects.
 * @param {Array<Object>} [overrides.dispatchRules] - Additional dispatch rule objects.
 * @returns {Object} The constructed registry object with profiles, rules, profileById map, and roleFallback.
 */
export function buildAgentSkillRegistry(overrides = {}) {
  const profiles = [
    ...DEFAULT_AGENT_PROFILES,
    ...(Array.isArray(overrides.profiles) ? overrides.profiles : []),
  ].map(normalizeProfile).filter(Boolean);
  const rules = [
    ...DEFAULT_DISPATCH_RULES,
    ...(Array.isArray(overrides.dispatchRules) ? overrides.dispatchRules : []),
  ].map(normalizeRule).filter(Boolean);
  return {
    profiles,
    rules,
    profileById: new Map(profiles.map((profile) => [profile.id, profile])),
    roleFallback: {
      ...ROLE_FALLBACK,
      ...(overrides.roleFallback && typeof overrides.roleFallback === 'object' ? overrides.roleFallback : {}),
    },
  };
}

export const DEFAULT_AGENT_SKILL_REGISTRY = buildAgentSkillRegistry();

/**
 * Merges governance overrides into a registry's profiles.
 * @param {Object} [registry] - The base registry to modify.
 * @param {Object} [overridesByProfileId] - Map of profile IDs to governance override objects.
 * @returns {Object} New registry object with merged governance policies.
 */
export function mergeAgentGovernanceOverrides(registry = DEFAULT_AGENT_SKILL_REGISTRY, overridesByProfileId = {}) {
  const overrides = overridesByProfileId && typeof overridesByProfileId === 'object' ? overridesByProfileId : {};
  const profiles = (registry.profiles || []).map((profile) => {
    const override = overrides[profile.id];
    if (!override) return profile;
    return {
      ...profile,
      governance: normalizeGovernancePolicy({
        ...(profile.governance || {}),
        ...override,
      }),
      governanceOverridden: true,
    };
  });
  return {
    profiles,
    rules: registry.rules || [],
    profileById: new Map(profiles.map((profile) => [profile.id, profile])),
    roleFallback: registry.roleFallback || {},
  };
}

/**
 * Classifies a task text against registry rules to find matching dispatch tags.
 * @param {string} text - The task text to classify.
 * @param {Object} [registry] - The agent skill registry.
 * @param {Object} [options] - Classification options.
 * @param {Object} [options.codeContext] - Code context signals for bonus scoring.
 * @param {number} [options.maxTags] - Maximum number of tags to return.
 * @returns {Array<Object>} Array of match objects with tag, agentId, score, etc.
 */
export function classifyTask(text, registry = DEFAULT_AGENT_SKILL_REGISTRY, options = {}) {
  const haystack = safeString(text, 12000).toLowerCase();
  const codeContextSignals = resolveCodeContextSignals(options);
  if (!haystack && (!codeContextSignals.tags || codeContextSignals.tags.length === 0)) return [];
  const matches = [];
  if (haystack) {
    for (const rule of registry.rules || []) {
      const matched = [];
      let score = 0;
      for (const keyword of rule.keywords || []) {
        if (!keyword) continue;
        let pos = haystack.indexOf(keyword);
        while (pos >= 0) {
          matched.push(keyword);
          score += keyword.length > 2 ? 2 : 1;
          pos = haystack.indexOf(keyword, pos + keyword.length);
        }
      }
      if (score > 0) {
        matches.push({
          tag: rule.tag,
          agentId: rule.agentId,
          score,
          textScore: score,
          matched: uniqueText(matched),
          skillHints: [...rule.skillHints],
        });
      }
    }
  }

  const byTag = new Map(matches.map((match) => [match.tag, match]));
  for (const signal of codeContextSignals.tags || []) {
    const tag = normalizeId(signal.tag);
    if (!tag) continue;
    const rule = (registry.rules || []).find((item) => item.tag === tag);
    if (!rule) continue;
    const bonus = Math.max(1, Math.min(16, Number(signal.score) || 1));
    let match = byTag.get(tag);
    if (!match) {
      match = {
        tag,
        agentId: rule.agentId,
        score: 0,
        textScore: 0,
        matched: [],
        skillHints: [...rule.skillHints],
      };
      byTag.set(tag, match);
      matches.push(match);
    }
    match.score += bonus;
    match.codeScore = (match.codeScore || 0) + bonus;
    match.contextReasons = uniqueLimited([...(match.contextReasons || []), ...(signal.reasons || [])], 8);
    match.contextPaths = uniqueLimited([...(match.contextPaths || []), ...(signal.paths || [])], 10);
  }

  matches.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  return matches.slice(0, Math.max(1, Number(options.maxTags) || 6));
}

/**
 * Resolves the agent profile for a given member and room context.
 * @param {Object} member - The member object.
 * @param {Object} room - The room object.
 * @param {Object} [registry] - The agent skill registry.
 * @returns {Object|null} The resolved profile object or null.
 */
function resolveProfileByCandidateIds(registry, ids) {
  if (!registry?.profileById) return null;
  for (const id of ids) {
    if (id && registry.profileById.has(id)) return registry.profileById.get(id);
  }
  return null;
}

/**
 * Resolves the agent profile for the given member within a room context.
 *
 * Lookup order:
 *   1. The member's own agent id (`agentId`, `profileId`, or `agentProfileId`).
 *   2. The room's `agentBindings`, keyed by the member's normalized id or role.
 *   3. The registry's `roleFallback` entry for the member's role.
 *   4. The first profile whose `roles` array includes the member's role.
 *   5. The hard-coded `xike-builder` profile, then the first registered profile.
 *
 * @param {Object} [member] - The member whose profile should be resolved.
 * @param {string} [member.id] - The member identifier (used to look up room bindings).
 * @param {string} [member.adapterId] - Adapter-provided id; preferred over `member.id`.
 * @param {string} [member.role] - The member's role, used as a fallback key.
 * @param {string} [member.agentId] - Explicit agent profile id on the member.
 * @param {string} [member.profileId] - Alias of `agentId`.
 * @param {string} [member.agentProfileId] - Alias of `agentId`.
 * @param {Object} [room] - The room context providing `agentBindings`.
 * @param {Object} [registry] - The agent skill registry to resolve against. Defaults to `DEFAULT_AGENT_SKILL_REGISTRY`.
 * @returns {Object|null} The resolved profile object, or `null` when no profile matches.
 */
export function resolveAgentProfile(member = {}, room = {}, registry = DEFAULT_AGENT_SKILL_REGISTRY) {
  const roomBindings = room?.agentBindings && typeof room.agentBindings === 'object' ? room.agentBindings : {};
  const memberId = normalizeId(member.adapterId || member.id);
  const role = normalizeId(member.role);

  const matched = resolveProfileByCandidateIds(registry, [
    normalizeId(member.agentId || member.profileId || member.agentProfileId),
    normalizeId(roomBindings[memberId] || roomBindings[member.role]),
    normalizeId(registry.roleFallback?.[role]),
  ]);
  if (matched) return matched;

  const byRole = registry.profiles.find((profile) => profile.roles.includes(role));
  if (byRole) return byRole;

  return registry.profileById.get('xike-builder') || registry.profiles[0] || null;
}

function addSkillBindingSource(bindings, name, source) {
  const id = normalizeId(name);
  if (!id) return;
  if (!bindings.has(id)) bindings.set(id, { name: id, sources: [] });
  const binding = bindings.get(id);
  if (source && !binding.sources.includes(source)) binding.sources.push(source);
}

function parseSkillNameList(value) {
  if (Array.isArray(value)) return unique(value);
  if (typeof value !== 'string') return [];
  return unique(value.split(/[,\s]+/).filter(Boolean));
}

function skillGovernanceMetadata(skill = {}) {
  const extra = skill?.extra && typeof skill.extra === 'object' ? skill.extra : {};
  return {
    exclusiveGroup: normalizeId(extra.exclusiveGroup || extra.exclusive_group),
    conflictsWith: parseSkillNameList(extra.conflictsWith || extra.conflicts_with),
  };
}

/**
 * Resolves skill bindings for an agent based on profile, dispatch matches, and room context.
 * @param {Object} options - The resolution options.
 * @param {Object} options.profile - The agent profile.
 * @param {Array<Object>} [options.dispatchMatches] - Dispatch match results.
 * @param {Object} [options.room] - The room context.
 * @param {Object} [options.skillStore] - Optional skill store for enrichment.
 * @returns {Array<Object>} Array of skill binding objects with metadata.
 */
function collectSkillBindingSources(profile, dispatchMatches, room) {
  const bindings = new Map();
  for (const name of profile?.skillBindings || []) {
    addSkillBindingSource(bindings, name, 'profile');
  }
  for (const match of dispatchMatches || []) {
    const source = match?.tag ? `dispatch:${normalizeId(match.tag) || match.tag}` : 'dispatch';
    for (const name of match?.skillHints || []) addSkillBindingSource(bindings, name, source);
  }
  const roomSkills = Array.isArray(room?.skills) ? room.skills : [];
  for (const name of roomSkills) addSkillBindingSource(bindings, name, 'room');
  return bindings;
}

function enrichSkillBinding(binding, skillStore) {
  const skill = skillStore.get(binding.name);
  const governance = skillGovernanceMetadata(skill);
  return {
    ...binding,
    displayName: skill?.displayName || binding.name,
    installed: !!skill,
    enabled: skill ? skill.enabled !== false : false,
    bodyLen: skill?.body ? skill.body.length : 0,
    ...(governance.exclusiveGroup ? { exclusiveGroup: governance.exclusiveGroup } : {}),
    ...(governance.conflictsWith.length ? { conflictsWith: governance.conflictsWith } : {}),
  };
}

function isSkillEnabledByStore(skillStore, name) {
  const skill = skillStore.get(name);
  return !!skill && skill.enabled !== false;
}

/**
 * Resolves the active skill bindings for an agent by merging profile defaults, dispatch matches, and room context.
 * When a skill store is supplied, each binding is enriched with skill metadata and filtered to enabled skills only.
 * @param {Object} options - The resolution options.
 * @param {Object} options.profile - The agent profile whose default skill bindings are used.
 * @param {Array<Object>} [options.dispatchMatches=[]] - Dispatch match results to merge in.
 * @param {Object} [options.room={}] - The room context for room-level skill bindings.
 * @param {Object} [options.skillStore=null] - Optional skill store used to enrich and filter bindings.
 * @returns {Array<Object>} Array of skill bindings; enriched and limited to enabled skills when a skill store is provided.
 */
export function resolveAgentSkillBindings({ profile, dispatchMatches = [], room = {}, skillStore = null } = {}) {
  const bindings = collectSkillBindingSources(profile, dispatchMatches, room);
  let out = [...bindings.values()];
  if (!skillStore || typeof skillStore.get !== 'function') return out;
  out = out.map((binding) => enrichSkillBinding(binding, skillStore));
  return out.filter((binding) => isSkillEnabledByStore(skillStore, binding.name));
}

/**
 * Diagnoses potential issues with skill bindings, such as conflicts or size limits.
 * @param {Array<Object>} skillBindings - The list of skill bindings to diagnose.
 * @param {Object} [options] - Diagnostic options.
 * @param {number} [options.maxSkills] - Maximum allowed skills.
 * @param {number} [options.maxBodyChars] - Maximum allowed body characters.
 * @returns {Array<Object>} Array of diagnostic objects with code, severity, and message.
 */
function pushTooManySkillsDiagnostic(bindings, maxSkills, diagnostics) {
  if (bindings.length <= maxSkills) return;
  diagnostics.push({
    code: 'too_many_skills',
    severity: 'warn',
    message: `This turn has ${bindings.length} installed skills; consider narrowing room-level bindings.`,
    count: bindings.length,
    limit: maxSkills,
  });
}

function pushPayloadSizeDiagnostic(totalBodyChars, maxBodyChars, diagnostics) {
  if (totalBodyChars <= maxBodyChars) return;
  diagnostics.push({
    code: 'skill_prompt_too_large',
    severity: 'warn',
    message: `Skill prompt payload is ${totalBodyChars} chars; trim bindings or split work.`,
    totalBodyChars,
    limit: maxBodyChars,
  });
}

function collectExclusiveGroupMembers(bindings) {
  const byExclusiveGroup = new Map();
  for (const binding of bindings) {
    if (!binding?.exclusiveGroup) continue;
    const group = binding.exclusiveGroup;
    if (!byExclusiveGroup.has(group)) byExclusiveGroup.set(group, []);
    byExclusiveGroup.get(group).push(binding.name);
  }
  return byExclusiveGroup;
}

function pushExclusiveGroupDiagnostics(byExclusiveGroup, diagnostics) {
  for (const [group, groupNames] of byExclusiveGroup.entries()) {
    if (groupNames.length <= 1) continue;
    diagnostics.push({
      code: 'exclusive_skill_group_conflict',
      severity: 'warn',
      message: `Skills in exclusive group "${group}" are both active: ${groupNames.join(', ')}.`,
      group,
      skills: groupNames,
    });
  }
}

function pushConflictPairDiagnostics(bindings, names, diagnostics) {
  const emittedPairs = new Set();
  for (const binding of bindings) {
    for (const other of binding.conflictsWith || []) {
      if (!names.has(other)) continue;
      const pair = [binding.name, other].sort().join('::');
      if (emittedPairs.has(pair)) continue;
      emittedPairs.add(pair);
      diagnostics.push({
        code: 'skill_conflict',
        severity: 'warn',
        message: `Skill "${binding.name}" declares a conflict with "${other}".`,
        skills: [binding.name, other],
      });
    }
  }
}

/**
 * Diagnoses potential issues across a set of skill bindings, including skill count limits,
 * payload size limits, exclusive group conflicts, and declared skill conflicts.
 * @param {Array<Object>} [skillBindings=[]] - The list of skill bindings to diagnose.
 * @param {Object} [options={}] - Diagnostic options.
 * @param {number} [options.maxSkills=8] - Maximum allowed skills before warning.
 * @param {number} [options.maxBodyChars=120000] - Maximum allowed total body characters before warning.
 * @returns {Array<Object>} Array of diagnostic objects with code, severity, and message.
 */
export function diagnoseAgentSkillBindings(skillBindings = [], options = {}) {
  const bindings = Array.isArray(skillBindings) ? skillBindings : [];
  const maxSkills = Math.max(1, Number(options.maxSkills) || 8);
  const maxBodyChars = Math.max(1000, Number(options.maxBodyChars) || 120_000);
  const diagnostics = [];
  const names = new Set(bindings.map((binding) => binding.name).filter(Boolean));
  const totalBodyChars = bindings.reduce((sum, binding) => sum + Math.max(0, Number(binding.bodyLen) || 0), 0);

  pushTooManySkillsDiagnostic(bindings, maxSkills, diagnostics);
  pushPayloadSizeDiagnostic(totalBodyChars, maxBodyChars, diagnostics);
  pushExclusiveGroupDiagnostics(collectExclusiveGroupMembers(bindings), diagnostics);
  pushConflictPairDiagnostics(bindings, names, diagnostics);

  return diagnostics;
}

/**
 * Resolves the list of enabled skill names for an agent.
 * @param {Object} options - The resolution options.
 * @param {Object} options.profile - The agent profile.
 * @param {Array<Object>} [options.dispatchMatches] - Dispatch match results.
 * @param {Object} [options.room] - The room context.
 * @param {Object} [options.skillStore] - Optional skill store for filtering.
 * @returns {Array<string>} Array of enabled skill names.
 */
export function resolveAgentSkillNames({ profile, dispatchMatches = [], room = {}, skillStore = null } = {}) {
  const names = resolveAgentSkillBindings({ profile, dispatchMatches, room, skillStore }).map((binding) => binding.name);
  if (!skillStore || typeof skillStore.get !== 'function') return names;
  return names.filter((name) => {
    const skill = skillStore.get(name);
    return skill && skill.enabled !== false;
  });
}

/**
 * Builds the full runtime context for an agent, including profile, dispatch, skills, and code context.
 * @param {Object} options - The context building options.
 * @param {Object} [options.room] - The room context.
 * @param {Object} [options.member] - The member context.
 * @param {string} [options.objective] - The task objective.
 * @param {Object} [options.codeContext] - Code context data.
 * @param {Object} [options.skillStore] - Optional skill store.
 * @param {Object} [options.registry] - Optional registry override.
 * @returns {Object} The complete runtime context object.
 */
function resolveCodeContextSource(codeContext, room) {
  return codeContext || room?.codeContext || null;
}

function resolveCodeContextAffectedFiles(codeContext, room) {
  return codeContext?.affectedFiles || room?.affectedFiles || room?.changedFiles || [];
}

function resolveCodeContextSignalsFromContext({ codeContext, room }) {
  return resolveCodeContextSignals({
    codeContext: resolveCodeContextSource(codeContext, room) || { affectedFiles: resolveCodeContextAffectedFiles(codeContext, room) },
  });
}

function resolveCodeContextEvidenceFromContext({ codeContext, room }) {
  return resolveCodeContextEvidence({
    codeContext: resolveCodeContextSource(codeContext, room) || room?.codeContextEvidence || [],
  });
}

function resolveCodeContextGraphFromContext({ codeContext, room }) {
  return resolveCodeContextGraph({
    codeContext: resolveCodeContextSource(codeContext, room) || room?.codeContextGraph || {},
  });
}

function resolveCodebaseQuestionAnswerFromContext(codeContext, room) {
  return normalizeCodebaseQuestionAnswer(
    codeContext?.codebaseQuestionAnswer
      || codeContext?.questionAnswer
      || room?.codeContext?.codebaseQuestionAnswer
      || room?.codeContext?.questionAnswer
      || room?.codebaseQuestionAnswer,
  );
}

function buildDispatchTargetText({ objective, room, member }) {
  return [
    objective,
    room?.topic,
    room?.name,
    member?.role,
    member?.displayName,
  ].map((part) => safeString(part, 4000)).filter(Boolean).join('\n');
}

/**
 * Builds the runtime context used to dispatch an agent, resolving the agent profile,
 * dispatch matches, skill bindings/diagnostics, and code-context signals from the
 * room, member, and provided inputs.
 * @param {Object} [options] - Runtime context inputs.
 * @param {Object} [options.room={}] - The room where the agent is operating.
 * @param {Object} [options.member={}] - The room member invoking the agent.
 * @param {string} [options.objective=''] - The dispatch objective text.
 * @param {Object|null} [options.codeContext=null] - Pre-computed code context (signals, evidence, graph, Q&A).
 * @param {Object|null} [options.skillStore=null] - Skill store used to resolve skill bindings.
 * @param {Object} [options.registry=DEFAULT_AGENT_SKILL_REGISTRY] - The agent/skill registry used for classification and skill lookup.
 * @returns {Object} The assembled agent runtime context, including profile, dispatch matches,
 *   skill names/bindings/diagnostics, code context signals/evidence/graph, codebase Q&A,
 *   governance policy, and a rendered prompt string.
 */
export function buildAgentRuntimeContext({ room = {}, member = {}, objective = '', codeContext = null, skillStore = null, registry = DEFAULT_AGENT_SKILL_REGISTRY } = {}) {
  const profile = resolveAgentProfile(member, room, registry);
  const codeContextSignals = resolveCodeContextSignalsFromContext({ codeContext, room });
  const codeContextEvidence = resolveCodeContextEvidenceFromContext({ codeContext, room });
  const codeContextGraph = resolveCodeContextGraphFromContext({ codeContext, room });
  const codebaseQuestionAnswer = resolveCodebaseQuestionAnswerFromContext(codeContext, room);
  const targetText = buildDispatchTargetText({ objective, room, member });
  const dispatchMatches = classifyTask(targetText, registry, { codeContext: codeContextSignals });
  const skillBindings = resolveAgentSkillBindings({ profile, dispatchMatches, room, skillStore });
  const skillNames = skillBindings.map((binding) => binding.name);
  const skillDiagnostics = diagnoseAgentSkillBindings(skillBindings);
  const governance = profile?.governance || normalizeGovernancePolicy();
  return {
    profile,
    dispatchMatches,
    skillNames,
    skillBindings,
    skillDiagnostics,
    codeContextSignals,
    codeContextEvidence,
    codeContextGraph,
    codebaseQuestionAnswer,
    governance,
    prompt: formatAgentRuntimeContext({ profile, dispatchMatches, skillNames, skillBindings, skillDiagnostics, codeContextSignals, codeContextEvidence, codeContextGraph, codebaseQuestionAnswer, member, governance }),
  };
}

/**
 * Summarizes an agent runtime context into a structured format suitable for logging or transmission.
 * @param {Object} [agentContext] - The agent runtime context.
 * @returns {Object} Summarized context object.
 */
function summarizeDispatchMatch(match) {
  return {
    tag: match.tag,
    agentId: match.agentId,
    score: match.score,
    textScore: match.textScore || 0,
    codeScore: match.codeScore || 0,
    matched: match.matched || [],
    contextReasons: match.contextReasons || [],
    contextPaths: match.contextPaths || [],
  };
}

function summarizeDispatchTags(dispatchMatches) {
  return (dispatchMatches || []).map((match) => match.tag).filter(Boolean);
}

function ensureRuntimeContextArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Summarizes the agent runtime context into a serializable object suitable for
 * prompt construction and downstream consumers.
 * @param {Object} [agentContext={}] - The raw agent runtime context.
 * @param {Object} [agentContext.profile] - The agent profile object.
 * @param {Array<Object>} [agentContext.dispatchMatches=[]] - Dispatch match records.
 * @param {Object} [agentContext.codeContextSignals] - Aggregated code context signal tags.
 * @param {Array<Object>} [agentContext.codeContextEvidence=[]] - Raw code context evidence entries.
 * @param {Object} [agentContext.codeContextGraph={}] - Symbol graph describing definitions and references.
 * @param {Object} [agentContext.codebaseQuestionAnswer] - Optional codebase Q&A payload.
 * @param {Array<string>} [agentContext.skillNames=[]] - Names of skills installed for this turn.
 * @param {Array<Object>} [agentContext.skillBindings=[]] - Skill binding descriptors.
 * @param {Array<Object>} [agentContext.skillDiagnostics=[]] - Skill diagnostic entries.
 * @param {Object} [agentContext.governance] - Explicit governance policy override.
 * @returns {Object} Normalized runtime context summary with prefixed agent* keys.
 */
export function summarizeAgentRuntimeContext(agentContext = {}) {
  const profile = agentContext.profile || null;
  const dispatchMatches = agentContext.dispatchMatches || [];
  return {
    agentProfileId: profile?.id || null,
    agentProfileTitle: profile?.title || null,
    agentDispatchTags: summarizeDispatchTags(dispatchMatches),
    agentDispatchMatches: dispatchMatches.map(summarizeDispatchMatch),
    agentCodeContextSignals: agentContext.codeContextSignals || null,
    agentCodeContextEvidence: normalizeCodeContextEvidence(agentContext.codeContextEvidence || []),
    agentCodeContextGraph: normalizeSymbolGraph(agentContext.codeContextGraph || {}),
    agentCodebaseQuestionAnswer: normalizeCodebaseQuestionAnswer(agentContext.codebaseQuestionAnswer),
    agentSkillNames: ensureRuntimeContextArray(agentContext.skillNames),
    agentSkillBindings: ensureRuntimeContextArray(agentContext.skillBindings),
    agentSkillDiagnostics: ensureRuntimeContextArray(agentContext.skillDiagnostics),
    agentGovernance: agentContext.governance || profile?.governance || normalizeGovernancePolicy(),
  };
}

function formatCodeContextLine(codeContextSignals = null) {
  const tags = Array.isArray(codeContextSignals?.tags) ? codeContextSignals.tags.slice(0, 4) : [];
  if (tags.length === 0) return null;
  const parts = tags.map((tag) => {
    const reasons = (tag.reasons || []).slice(0, 3).join('/');
    const paths = (tag.paths || []).slice(0, 2).join(', ');
    return `${tag.tag}:${tag.score}${reasons ? ` (${reasons})` : ''}${paths ? ` @ ${paths}` : ''}`;
  });
  return `- Code context signals: ${parts.join('; ')}`;
}

function formatCodeEvidenceLine(codeContextEvidence = []) {
  const summary = summarizeCodeContextEvidence(codeContextEvidence);
  if (summary.fileCount === 0 || (summary.symbolCount === 0 && summary.anchorCount === 0)) return null;
  const symbols = summary.topSymbols.slice(0, 5).map((item) => `${item.name}@${item.path}:${item.line}`);
  const anchors = summary.topAnchors.slice(0, 4).map((item) => `${item.kind}:${item.name}@${item.path}:${item.line}`);
  const details = [
    symbols.length ? `symbols ${symbols.join(', ')}` : '',
    anchors.length ? `anchors ${anchors.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const parserCounts = summary.parserCounts && typeof summary.parserCounts === 'object'
    ? Object.entries(summary.parserCounts).map(([parser, count]) => `${parser}:${count}`).join(', ')
    : '';
  return `- Code evidence: ${summary.fileCount} files, ${summary.symbolCount} symbols, ${summary.anchorCount} anchors, ${summary.referenceCount || 0} references${parserCounts ? `, parsers ${parserCounts}` : ''}${details ? `; ${details}` : ''}`;
}

function formatCodeGraphLine(codeContextGraph = {}) {
  const summary = summarizeSymbolGraph(codeContextGraph);
  if (summary.definitionCount === 0 && summary.routeCount === 0) return null;
  const defs = summary.topDefinitions.slice(0, 4).map((item) => `${item.name}@${item.path}:${item.line} refs=${item.referenceCount}`);
  const routes = summary.topRoutes.slice(0, 3).map((item) => `${item.route}@${item.path}:${item.line} uses=${item.usageCount}`);
  const details = [
    defs.length ? `defs ${defs.join(', ')}` : '',
    routes.length ? `routes ${routes.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  return `- Symbol graph: ${summary.definitionCount} definitions, ${summary.referenceCount} references, ${summary.callCount} calls, ${summary.typeImplementationCount || 0} type implementations, ${summary.routeUsageCount} route uses${details ? `; ${details}` : ''}`;
}

function formatCodebaseQuestionAnswerLine(codebaseQuestionAnswer = null) {
  const answer = normalizeCodebaseQuestionAnswer(codebaseQuestionAnswer);
  if (!answer) return null;
  const coverage = answer.coverage || {};
  const citations = (answer.citations || []).slice(0, 4).map((item) => `${item.id}:${item.label}`);
  const parts = [
    answer.question ? `question "${answer.question}"` : '',
    `${answer.confidence} confidence`,
    `${coverage.uniqueFileCount || 0} files`,
    citations.length ? `citations ${citations.join(', ')}` : '',
    answer.answer ? `answer ${safeString(answer.answer, 320)}` : '',
  ].filter(Boolean);
  return `- Code question answer: ${parts.join('; ')}`;
}

/**
 * Builds the dispatch tag line (e.g. "tag:agent, tag:agent") or "none".
 * @param {Array<Object>} dispatchMatches - Dispatch matches.
 * @returns {string} Comma-separated tag line.
 */
function formatDispatchTagsLine(dispatchMatches) {
  if (!Array.isArray(dispatchMatches) || dispatchMatches.length === 0) {
    return 'none';
  }
  return dispatchMatches.map((match) => `${match.tag}:${match.agentId}`).join(', ');
}

/**
 * Builds the operating boundaries block (bullet list or default text).
 * @param {Array<string>} boundaries - Profile boundary lines.
 * @returns {string} Newline-joined boundary lines.
 */
function formatBoundaryLines(boundaries) {
  if (Array.isArray(boundaries) && boundaries.length > 0) {
    return boundaries.map((item) => `- ${item}`).join('\n');
  }
  return '- Follow the room role card and current task boundary.';
}

/**
 * Resolves the effective skill binding list, falling back to bare names.
 * @param {Array<Object>} skillBindings - Skill bindings.
 * @param {Array<string>} skillNames - Skill names.
 * @returns {Array<Object>} Normalized binding list.
 */
function resolveBindingList(skillBindings, skillNames) {
  if (Array.isArray(skillBindings) && skillBindings.length > 0) {
    return skillBindings;
  }
  return (skillNames || []).map((name) => ({ name, sources: [] }));
}

/**
 * Builds the "Installed bound skills" line.
 * @param {Array<Object>} bindingList - Normalized binding list.
 * @returns {string} Comma-separated binding list, or fallback text.
 */
function formatBoundSkillsLine(bindingList) {
  if (!Array.isArray(bindingList) || bindingList.length === 0) {
    return 'none installed for this turn';
  }
  return bindingList.map((binding) => {
    const sourceLine = Array.isArray(binding.sources) && binding.sources.length > 0
      ? ` [${binding.sources.join('+')}]`
      : '';
    return `${binding.name}${sourceLine}`;
  }).join(', ');
}

/**
 * Resolves the effective governance policy, honoring the precedence order.
 * @param {Object|null} governance - Explicit governance override.
 * @param {Object} profile - Agent profile.
 * @returns {Object} Effective governance policy.
 */
function resolveGovernancePolicy(governance, profile) {
  return governance || (profile && profile.governance) || normalizeGovernancePolicy();
}

/**
 * Builds the "Skill diagnostics" line, or null when there is nothing to report.
 * @param {Array<Object>} skillDiagnostics - Skill diagnostics.
 * @returns {string|null} Diagnostics line or null.
 */
function formatDiagnosticsLine(skillDiagnostics) {
  if (!Array.isArray(skillDiagnostics) || skillDiagnostics.length === 0) {
    return null;
  }
  return `- Skill diagnostics: ${skillDiagnostics.map((item) => `${item.severity}:${item.code}`).join(', ')}`;
}

/**
 * Builds the "Governance" line for the runtime context.
 * @param {Object} policy - Effective governance policy.
 * @param {Object} profile - Agent profile (used for id).
 * @returns {string} Governance line.
 */
function formatGovernanceLine(policy, profile) {
  return `- Governance: budget=${policy.budgetScope}:${profile.id}/${policy.budgetTier}; guard=${policy.commandGuard}; approval=${policy.approvalPolicy}; audit=${policy.auditLevel}`;
}

/**
 * Formats the agent runtime context into a human-readable string prompt.
 * @param {Object} options - The context formatting options.
 * @param {Object} options.profile - The agent profile.
 * @param {Array<Object>} [options.dispatchMatches] - Dispatch matches.
 * @param {Array<string>} [options.skillNames] - Skill names.
 * @param {Array<Object>} [options.skillBindings] - Skill bindings.
 * @param {Array<Object>} [options.skillDiagnostics] - Skill diagnostics.
 * @param {Object} [options.codeContextSignals] - Code context signals.
 * @param {Array<Object>} [options.codeContextEvidence] - Code context evidence.
 * @param {Object} [options.codeContextGraph] - Code context graph.
 * @param {Object} [options.codebaseQuestionAnswer] - Codebase Q&A data.
 * @param {Object} [options.member] - Member data.
 * @param {Object} [options.governance] - Governance policy.
 * @returns {string} Formatted prompt string.
 */
export function formatAgentRuntimeContext({
  profile,
  dispatchMatches = [],
  skillNames = [],
  skillBindings = [],
  skillDiagnostics = [],
  codeContextSignals = null,
  codeContextEvidence = [],
  codeContextGraph = {},
  codebaseQuestionAnswer = null,
  member = {},
  governance = null,
} = {}) {
  if (!profile) return '';
  const tagLine = formatDispatchTagsLine(dispatchMatches);
  const boundaryLines = formatBoundaryLines(profile.boundaries);
  const bindingList = resolveBindingList(skillBindings, skillNames);
  const skillsLine = formatBoundSkillsLine(bindingList);
  const policy = resolveGovernancePolicy(governance, profile);
  const diagnosticsLine = formatDiagnosticsLine(skillDiagnostics);
  const codeContextLine = formatCodeContextLine(codeContextSignals);
  const codeEvidenceLine = formatCodeEvidenceLine(codeContextEvidence);
  const codeGraphLine = formatCodeGraphLine(codeContextGraph);
  const codeQuestionLine = formatCodebaseQuestionAnswerLine(codebaseQuestionAnswer);
  const lines = [
    '# Xike Agent Runtime Context',
    '',
    `- Agent profile: ${profile.title} (${profile.id})`,
    `- Room member: ${safeString(member.displayName || member.adapterId || 'unknown', 160)}`,
    `- Mission: ${profile.mission || 'Complete the assigned work with evidence.'}`,
    `- Matched dispatch tags: ${tagLine}`,
    codeContextLine,
    codeQuestionLine,
    codeEvidenceLine,
    codeGraphLine,
    `- Installed bound skills for this turn: ${skillsLine}`,
    diagnosticsLine,
    formatGovernanceLine(policy, profile),
    '',
    '## Operating boundaries',
    boundaryLines,
  ];
  return lines.filter((line) => line !== null).join('\n');
}
