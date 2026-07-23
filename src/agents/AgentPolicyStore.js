import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { activityLog } from '../audit/ActivityLog.js';
import {
  DEFAULT_AGENT_SKILL_REGISTRY,
  mergeAgentGovernanceOverrides,
  normalizeGovernancePolicy,
} from './AgentSkillRegistry.js';

const DEFAULT_POLICY_FILE = join(homedir(), '.noe-panel', 'agent-policies.json');

function nowMs() {
  return Date.now();
}

function normalizeProfileId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(id)) throw new Error('invalid profile id');
  return id;
}

function normalizePolicyRow(row = {}) {
  const profileId = normalizeProfileId(row.profileId ?? row.profile_id ?? row.id);
  const updatedAt = Number(row.updatedAt ?? row.updated_at) || nowMs();
  return {
    profileId,
    governance: normalizeGovernancePolicy(row.governance || row.policy || row),
    updatedAt,
  };
}

function parsePolicyFile(raw) {
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : parsed?.policies;
  if (!Array.isArray(rows)) return new Map();
  const map = new Map();
  for (const row of rows) {
    try {
      const normalized = normalizePolicyRow(row);
      map.set(normalized.profileId, normalized);
    } catch {
      // Ignore malformed rows; one bad profile should not disable the panel.
    }
  }
  return map;
}

export class AgentPolicyStore {
  constructor({ filePath = DEFAULT_POLICY_FILE, audit = activityLog, logger = console } = {}) {
    this.filePath = filePath;
    this.audit = audit;
    this.logger = logger;
    this.policies = new Map();
    this.load();
  }

  load() {
    if (!existsSync(this.filePath)) {
      this.policies = new Map();
      return this.list();
    }
    try {
      this.policies = parsePolicyFile(readFileSync(this.filePath, 'utf8'));
    } catch (e) {
      this.logger?.warn?.('[agent-policies] load failed:', e instanceof Error ? e.message : e);
      this.policies = new Map();
    }
    return this.list();
  }

  save() {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      updatedAt: nowMs(),
      policies: this.list(),
    }, null, 2);
    writeFileSync(tmpPath, `${payload}\n`, { mode: 0o600 });
    renameSync(tmpPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {}
  }

  list() {
    return [...this.policies.values()]
      .map((row) => ({
        profileId: row.profileId,
        governance: normalizeGovernancePolicy(row.governance),
        updatedAt: row.updatedAt,
      }))
      .sort((a, b) => a.profileId.localeCompare(b.profileId));
  }

  get(profileId) {
    const id = normalizeProfileId(profileId);
    const row = this.policies.get(id);
    return row ? {
      profileId: row.profileId,
      governance: normalizeGovernancePolicy(row.governance),
      updatedAt: row.updatedAt,
    } : null;
  }

  overridesByProfileId() {
    return Object.fromEntries(this.list().map((row) => [row.profileId, row.governance]));
  }

  upsert(profileId, governance = {}) {
    const id = normalizeProfileId(profileId);
    const row = {
      profileId: id,
      governance: normalizeGovernancePolicy(governance),
      updatedAt: nowMs(),
    };
    this.policies.set(id, row);
    this.save();
    this.audit?.recordSafe?.({
      action: 'agent_policy.upserted',
      actorType: 'user',
      entityType: 'agent_policy',
      entityId: id,
      status: 'active',
      details: row,
    });
    return this.get(id);
  }

  delete(profileId) {
    const id = normalizeProfileId(profileId);
    const deleted = this.policies.delete(id);
    if (deleted) {
      this.save();
      this.audit?.recordSafe?.({
        action: 'agent_policy.deleted',
        actorType: 'user',
        entityType: 'agent_policy',
        entityId: id,
        status: 'deleted',
        details: { profileId: id },
      });
    }
    return deleted;
  }
}

/**
 * Computes the effective agent registry by merging the default skill registry
 * with governance overrides from the provided policy store.
 *
 * @param {Object} [options]
 * @param {Object} [options.registry] - The base agent skill registry. Defaults to DEFAULT_AGENT_SKILL_REGISTRY.
 * @param {AgentPolicyStore} [options.policyStore] - The policy store instance to read overrides from. Defaults to agentPolicyStore.
 * @returns {Object} The merged registry with applied governance overrides.
 */
export function effectiveAgentRegistry({
  registry = DEFAULT_AGENT_SKILL_REGISTRY,
  policyStore = agentPolicyStore,
} = {}) {
  const overrides = typeof policyStore?.overridesByProfileId === 'function'
    ? policyStore.overridesByProfileId()
    : {};
  return mergeAgentGovernanceOverrides(registry, overrides);
}

export const agentPolicyStore = new AgentPolicyStore();
