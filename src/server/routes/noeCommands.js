import { requireOwnerToken } from '../auth/owner-token.js';
import {
  buildNoeCommandDryRun,
  buildNoeCommandHelp,
  buildNoeCommandSurface,
  findNoeTools,
} from '../../capabilities/NoeCommandSurface.js';
import { routeNoeTools } from '../../capabilities/NoeToolRouter.js';

function parseLimit(value, fallback = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function parseBool(value) {
  return value === true || value === 'true' || value === '1';
}

function listToolManifests(toolRegistry) {
  try {
    const tools = toolRegistry?.list?.() || [];
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function makeSurface(toolRegistry, body = {}) {
  return buildNoeCommandSurface({
    manifests: listToolManifests(toolRegistry),
    extraCommands: Array.isArray(body.extraCommands) ? body.extraCommands : [],
    permissionState: {},
  });
}

export function registerNoeCommandRoutes(app, { toolRegistry, sendError } = {}) {
  app.get('/api/noe/commands/discover', requireOwnerToken, (req, res) => {
    try {
      const surface = makeSurface(toolRegistry);
      const query = req.query.q || req.query.query || '';
      const includeHidden = parseBool(req.query.includeHidden || req.query.include_hidden);
      const search = findNoeTools({
        query,
        commands: surface.commands,
        limit: parseLimit(req.query.limit, 8),
        includeHidden,
      });
      return res.json({
        ok: true,
        schemaVersion: surface.schemaVersion,
        count: surface.visibleCommands.length,
        visibleCommands: surface.visibleCommands,
        hiddenCommands: includeHidden ? surface.hiddenCommands : [],
        search,
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/commands/:id/help', requireOwnerToken, (req, res) => {
    try {
      const includeHidden = parseBool(req.query.includeHidden || req.query.include_hidden);
      const surface = makeSurface(toolRegistry);
      const help = buildNoeCommandHelp({ id: req.params.id, commands: surface.commands, includeHidden });
      return res.status(help.ok ? 200 : 404).json(help);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/commands/:id/dry-run', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const includeHidden = parseBool(body.includeHidden || body.include_hidden);
      const surface = makeSurface(toolRegistry, body);
      const dryRun = buildNoeCommandDryRun({
        id: req.params.id,
        input: body.input || body.args || {},
        commands: surface.commands,
        includeHidden,
      });
      return res.status(dryRun.ok ? 200 : 409).json(dryRun);
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/commands/route', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const surface = makeSurface(toolRegistry, body);
      const routed = routeNoeTools({
        goal: body.goal || body.query || '',
        contextTags: body.contextTags || body.context_tags || [],
        recentActions: body.recentActions || body.recent_actions || [],
        commandSurface: surface,
        permissionState: {},
        maxCommands: body.maxCommands || body.max_commands || 8,
      });
      return res.json({ ok: true, ...routed });
    } catch (e) {
      return sendError(res, e);
    }
  });
}
