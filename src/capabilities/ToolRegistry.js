import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import * as sqliteStore from '../storage/SqliteStore.js';
import { permissionGovernance as defaultPermissionGovernance } from '../permissions/PermissionGovernance.js';
import { activityLog as defaultActivityLog } from '../audit/ActivityLog.js';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

function nowMs() {
  return Date.now();
}

function safeString(value, max = 1000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function parseManifest(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function rowToTool(row = {}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    version: row.version || '0.0.0',
    category: row.category || 'local',
    riskLevel: row.risk_level || 'medium',
    enabled: row.enabled === 1,
    manifest: parseManifest(row.manifest),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TOOL_MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    version: { type: 'string', maxLength: 80 },
    category: { type: 'string', maxLength: 120 },
    risk_level: { enum: [...RISK_LEVELS] },
    riskLevel: { enum: [...RISK_LEVELS] },
    operation: { type: 'string', maxLength: 160 },
  },
};

export class ToolRegistry {
  constructor({
    storage = sqliteStore,
    permission = defaultPermissionGovernance,
    audit = defaultActivityLog,
    handlers = {},
  } = {}) {
    this.storage = storage;
    this.permission = permission;
    this.audit = audit;
    this.handlers = handlers;
    this.ajv = new Ajv({ allErrors: true });
    this.validateManifest = this.ajv.compile(TOOL_MANIFEST_SCHEMA);
  }

  db() {
    return this.storage.getDb();
  }

  register(manifest = {}) {
    if (!this.validateManifest(manifest)) {
      const msg = this.validateManifest.errors?.map((e) => `${e.dataPath || e.instancePath || '/'} ${e.message}`).join('; ') || 'invalid manifest';
      throw new Error(`invalid tool manifest: ${msg}`);
    }
    const now = nowMs();
    const id = safeString(manifest.id, 160) || `tool-${randomUUID()}`;
    const name = safeString(manifest.name, 200) || id;
    const description = safeString(manifest.description, 2000);
    const version = safeString(manifest.version || '0.0.0', 80) || '0.0.0';
    const category = safeString(manifest.category || 'local', 120) || 'local';
    const riskLevel = safeString(manifest.risk_level || manifest.riskLevel || 'medium', 40);
    if (!RISK_LEVELS.has(riskLevel)) throw new Error(`invalid risk level: ${riskLevel}`);
    this.db().prepare(`
      INSERT INTO noe_tools(id, name, description, version, category, risk_level, enabled, manifest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        category = excluded.category,
        risk_level = excluded.risk_level,
        manifest = excluded.manifest,
        updated_at = excluded.updated_at
    `).run(id, name, description, version, category, riskLevel, JSON.stringify(manifest), now, now);
    return this.get(id);
  }

  get(id) {
    const toolId = safeString(id, 160);
    if (!toolId) return null;
    const row = this.db().prepare('SELECT * FROM noe_tools WHERE id = ?').get(toolId);
    return row ? rowToTool(row) : null;
  }

  list({ enabled } = {}) {
    const where = [];
    const args = [];
    if (enabled === true || enabled === false) { where.push('enabled = ?'); args.push(enabled ? 1 : 0); }
    const suffix = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db().prepare(`
      SELECT * FROM noe_tools
      ${suffix}
      ORDER BY enabled DESC, risk_level DESC, name ASC
    `).all(...args).map(rowToTool);
  }

  setEnabled(id, enabled) {
    const now = nowMs();
    const result = this.db().prepare('UPDATE noe_tools SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, safeString(id, 160));
    return result.changes > 0 ? this.get(id) : null;
  }

  async invoke(id, input = {}) {
    const tool = this.get(id);
    if (!tool) return { ok: false, status: 404, error: 'tool not found' };
    if (!tool.enabled) {
      this.#audit('noe.tool.blocked', tool, { reason: 'disabled' });
      return { ok: false, status: 403, error: 'tool disabled', tool };
    }

    const command = safeString(input.command ?? input.args?.command ?? tool.manifest.command, 4000);
    if (command) {
      const shellDecision = this.permission?.evaluatePermission?.({
        action: 'shell.exec',
        target: {
          toolId: tool.id,
          toolName: tool.name,
          command,
          guardLevel: input.guardLevel || tool.manifest.guardLevel || 'standard',
        },
        risk: tool.riskLevel,
        actorType: input.actorType || 'user',
        actorId: input.actorId || 'owner',
        cwd: input.cwd,
        approvalId: input.approvalId,
        approvalIds: input.approvalIds,
        details: { source: 'noe.tool.invoke' },
      });
      if (shellDecision?.decision === 'deny') {
        this.#audit('noe.tool.blocked', tool, { reason: shellDecision.reason, shellGuard: true });
        return { ok: false, status: 403, error: 'permission_denied', permissionDecision: shellDecision };
      }
      if (shellDecision?.decision === 'ask') {
        this.#audit('noe.tool.approval_required', tool, {
          reason: shellDecision.reason,
          approvalId: shellDecision.approval?.id || null,
          shellGuard: true,
        });
        return {
          ok: false,
          status: 202,
          error: 'approval_required',
          approval: shellDecision.approval,
          approvalId: shellDecision.approval?.id || null,
          permissionDecision: shellDecision,
        };
      }
    }

    const decision = this.permission?.evaluatePermission?.({
      action: 'noe.tool.invoke',
      target: { toolId: tool.id, toolName: tool.name, operation: tool.manifest.operation || tool.id },
      risk: tool.riskLevel,
      actorType: input.actorType || 'user',
      actorId: input.actorId || 'owner',
      cwd: input.cwd,
      approvalId: input.approvalId,
      approvalIds: input.approvalIds,
      details: { args: input.args || {} },
    });
    if (decision?.decision === 'deny') {
      this.#audit('noe.tool.blocked', tool, { reason: decision.reason, decisionId: decision.id });
      return { ok: false, status: 403, error: 'permission_denied', permissionDecision: decision };
    }
    if (decision?.decision === 'ask') {
      this.#audit('noe.tool.approval_required', tool, { reason: decision.reason, approvalId: decision.approval?.id || null });
      return { ok: false, status: 202, error: 'approval_required', approval: decision.approval, approvalId: decision.approval?.id || null, permissionDecision: decision };
    }

    const handler = this.handlers[tool.id] || this.handlers[tool.manifest.operation];
    if (!handler) {
      this.#audit('noe.tool.blocked', tool, { reason: 'no_handler' });
      return { ok: false, status: 501, error: 'tool handler not registered', tool };
    }
    const result = await handler({ tool, args: input.args || {}, context: input });
    this.#audit('noe.tool.invoked', tool, { status: 'succeeded' });
    return { ok: true, status: 200, tool, result };
  }

  #audit(action, tool, details = {}) {
    this.audit?.recordSafe?.({
      action,
      actorType: 'system',
      entityType: 'noe_tool',
      entityId: tool?.id || null,
      status: details.status || 'blocked',
      severity: action.endsWith('invoked') ? 'info' : 'warn',
      details: { toolId: tool?.id, riskLevel: tool?.riskLevel, ...details },
    });
  }
}
