import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildBaiLongmaFeatureMap,
  buildBaiLongmaFusionReport,
  buildFusionBacklog,
  buildNoeFusionSurface,
  detectNoeFusionCapabilities,
  formatBaiLongmaFusionPlanMarkdown,
  scanBaiLongmaRepository,
} from '../../src/runtime/NoeBaiLongmaFusionPlanner.js';

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'bailongma-fusion-'));
  const write = (path, text) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('package.json', JSON.stringify({ dependencies: { 'wechat-ilink-client': '^0.1.0', ws: '^8.0.0' } }, null, 2));
  write('src/social/wechat-clawbot.js', 'export const bridge = true;\n');
  write('src/social/webhooks.js', 'export const webhooks = true;\n');
  write('src/social/dispatch.js', 'export const dispatch = true;\n');
  write('src/social/targets.js', 'export const targets = true;\n');
  write('src/social/discord.js', 'export const discord = true;\n');
  write('src/identity.js', 'export const id = true;\n');
  write('src/runtime/channel.js', 'export const channel = true;\n');
  write('src/ui/brain-ui/hotspot-earth.js', 'export class HotspotEarth {}\n');
  write('src/ui/brain-ui/hotspot-panel.js', 'export const panel = ``;\n');
  write('src/ui/brain-ui/vendor/three/three.module.js', 'vendor\n'.repeat(20));
  write('src/hotspots.js', 'export const hotspots = true;\n');
  write('src/capabilities/executor.js', 'export async function executeTool() {}\n');
  write('src/capabilities/schemas/filesystem.js', 'export const schema = {};\n');
  write('src/capabilities/tool-policy.js', 'export const policy = {};\n');
  write('src/capabilities/tool-audit.js', 'export const audit = {};\n');
  write('src/runtime/tool-protocol.js', 'export const protocol = {};\n');
  write('node_modules/ignored.js', 'ignored\n');
  write('dist/ignored.js', 'ignored\n');
  return root;
}

describe('NoeBaiLongmaFusionPlanner', () => {
  it('scans upstream files and excludes build/dependency directories', () => {
    const root = fixtureRepo();
    try {
      const inventory = scanBaiLongmaRepository(root);
      expect(inventory.ok).toBe(true);
      expect(inventory.files.some((file) => file.path === 'node_modules/ignored.js')).toBe(false);
      expect(inventory.files.some((file) => file.path === 'dist/ignored.js')).toBe(false);
      expect(inventory.totals.files).toBeGreaterThan(5);
      expect(inventory.totals.lines).toBeGreaterThan(5);
      expect(inventory.totals.byCategory.vendor).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects BaiLongma social and globe patterns but does not invent QQ support', () => {
    const root = fixtureRepo();
    try {
      const inventory = scanBaiLongmaRepository(root);
      const packageJson = JSON.parse(readFixture(root, 'package.json'));
      const features = buildBaiLongmaFeatureMap({ inventory, packageJson });
      const byId = Object.fromEntries(features.map((item) => [item.id, item]));
      expect(byId.wechat_clawbot_personal_bridge.detected).toBe(true);
      expect(byId.official_and_webhook_social_hub.detected).toBe(true);
      expect(byId.discord_gateway_bridge.detected).toBe(true);
      expect(byId.globe_hotspot_world_ui.detected).toBe(true);
      expect(byId.capability_tool_protocol.detected).toBe(true);
      expect(byId.capability_tool_protocol.noeFusion).toContain('ToolRegistry');
      expect(byId.qq_bridge.detected).toBe(false);
      expect(byId.qq_bridge.noeFusion).toContain('no QQ connector');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds a no-secret Noe fusion report and marks current increment done', () => {
    const root = fixtureRepo();
    try {
      const report = buildBaiLongmaFusionReport({
        bailongmaRoot: root,
        upstreamCommit: 'abc123',
        noePackageJson: { dependencies: { ws: '^8.0.0' } },
        noeCapabilities: {
          socialWebhookInbound: true,
          wechatPersonalBridgeContract: true,
          qqBridgeResearchGate: true,
          worldSurfacePanel: true,
          worldEarthPanel: true,
          capabilityToolSurface: true,
          noe100ToolHealthVisible: true,
          baiLongmaFusionAudit: true,
        },
        env: {
          DISCORD_BOT_TOKEN: 'secret-discord-token-value',
          WECHAT_OFFICIAL_APP_ID: 'appid',
          WECHAT_OFFICIAL_APP_SECRET: 'super-secret',
          WECHAT_OFFICIAL_TOKEN: 'verify-token',
        },
        generatedAt: '2026-06-13T00:00:00.000Z',
      });
      const serialized = JSON.stringify(report);
      expect(report.ok).toBe(true);
      expect(report.executionPolicy).toMatchObject({ noSecretsRead: true, noConnectorsStarted: true, qqNotClaimed: true });
      expect(report.noeSurface.envReadiness.discordBotToken).toBe(true);
      expect(report.noeSurface.envReadiness.wechatOfficial).toBe(true);
      expect(serialized).not.toContain('secret-discord-token-value');
      expect(serialized).not.toContain('super-secret');
      expect(report.backlog.find((item) => item.id === 'BML-0')).toMatchObject({ status: 'done_by_this_report' });
      expect(report.backlog.find((item) => item.id === 'BML-1')).toMatchObject({ status: 'contract_done_transport_pending', blockers: ['live_transport_not_selected_or_started'] });
      expect(report.backlog.find((item) => item.id === 'BML-2')).toMatchObject({ status: 'done_by_noe_webhook_routes' });
      expect(report.backlog.find((item) => item.id === 'BML-3')).toMatchObject({
        status: 'research_gate_done_official_webhook_selected',
        blockers: ['not_present_in_bailongma_upstream', 'qq_live_credentials_and_public_callback_not_configured'],
      });
      expect(report.backlog.find((item) => item.id === 'BML-4')).toMatchObject({ status: 'done_by_noe_three_earth_world_surface', blockers: [] });
      expect(report.backlog.find((item) => item.id === 'BML-5')).toMatchObject({
        status: 'foundation_done_protocol_unification_pending',
        blockers: ['freedom_manifest_toolregistry_protocol_not_unified'],
      });
      expect(report.backlog.find((item) => item.id === 'BML-5').blockers).not.toContain('tool_health_not_in_noe100_readiness');
      expect(report.executionPolicy).toMatchObject({
        worldSurfaceRendered: true,
        threeJsEarthPanel: true,
        threeJsAssetGateRequired: false,
        arbitraryToolExecutionNotEnabled: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects the Noe world-surface panel from real front-end files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-world-surface-'));
    try {
      const write = (path, text) => {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      };
      write('public/mind.html', '<section id="worldSurface"><canvas id="worldEarthCanvas"></canvas><svg id="worldSurfaceSvg"></svg></section>');
      write('public/mind.js', [
        'function renderWorldSurface() {}',
        "import('./src/web/noe-world-earth.js')",
        "const a = '/api/noe/readiness';",
        "const b = '/api/noe/social-inbound/status';",
        "const c = '/api/noe/missions?limit=10';",
      ].join('\n'));
      write('public/src/web/noe-world-earth.js', 'export class NoeWorldEarth {}\n');
      write('public/vendor/three/three.module.js', 'export const Scene = true;\n');
      write('public/vendor/earth/earth_atmos_2048.jpg', 'earth\n');
      write('public/vendor/earth/earth_clouds_2048.png', 'clouds\n');
      write('scripts/noe-100-readiness.mjs', [
        'async function summarizeToolSurface() {}',
        "check('tool_surface_health_visible', toolSurface.ok)",
        'executionEnabledCount === 0',
      ].join('\n'));
      write('tests/unit/noe-100-readiness.test.js', "it('exposes tool surface health without enabling marketplace execution', () => {});\n");
      write('src/runtime/NoeWeChatPersonalBridge.js', 'export const bridge = true;\n');
      write('src/runtime/NoeQqBridgeResearchGate.js', 'export const qq = true;\n');
      write('src/runtime/NoeSocialWebhookInbound.js', 'export const webhook = true;\n');
      write('src/runtime/NoeToolMarketplaceRegistry.js', 'export const market = true;\n');
      write('src/capabilities/ToolRegistry.js', 'export const registry = true;\n');
      write('src/capabilities/builtinReadonlyTools.js', 'export const readonly = true;\n');
      write('src/capabilities/NoeFreedomManifest.js', 'export const manifest = true;\n');
      write('src/capabilities/NoeToolRouter.js', 'export const router = true;\n');
      write('src/server/routes/noeSocialInbound.js', [
        "app.get('/api/noe/social-inbound/wechat-personal/status')",
        "app.post('/api/noe/social-inbound/wechat-personal/outbound-dry-run')",
        "app.get('/api/noe/social-inbound/qq/research-gate')",
        "app.post('/api/noe/social-inbound/qq/dry-run')",
      ].join('\n'));
      const caps = detectNoeFusionCapabilities(root);
      expect(caps.worldSurfacePanel).toBe(true);
      expect(caps.worldEarthPanel).toBe(true);
      expect(caps.noe100ToolHealthVisible).toBe(true);
      expect(caps.wechatPersonalBridgeContract).toBe(true);
      expect(caps.qqBridgeResearchGate).toBe(true);
      expect(caps.socialWebhookInbound).toBe(true);
      expect(caps.capabilityToolSurface).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('formats a durable markdown plan from the machine report', () => {
    const surface = buildNoeFusionSurface({ noePackageJson: { dependencies: { ws: '^8.0.0' } }, env: {} });
    const backlog = buildFusionBacklog({ features: [], noeSurface: surface });
    const md = formatBaiLongmaFusionPlanMarkdown({
      ok: true,
      source: { upstreamUrl: 'https://example.test/BaiLongma.git', upstreamCommit: 'abc123' },
      inventory: { totals: { files: 3, lines: 12 } },
      features: [{ id: 'qq_bridge', detected: false, noeFusion: 'BaiLongma current upstream has no QQ connector.' }],
      backlog,
    });
    expect(md).toContain('BaiLongma Fusion Plan');
    expect(md).toContain('BML-0 [done_by_this_report]');
    expect(md).toContain('do not pretend BaiLongma already has QQ');
    expect(md).toContain('do not enable arbitrary runtime execution');
  });
});

function readFixture(root, path) {
  return String(readFileSync(join(root, path), 'utf8'));
}
