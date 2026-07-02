// @ts-check
// NoeBaiLongmaFusionPlanner — read-only upstream audit + actionable fusion plan.
// It counts upstream files/lines and maps BaiLongma social/globe patterns into
// Noe's existing inbound-gateway, freedom, and cognitive UI architecture.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const BAILONGMA_FUSION_SCHEMA_VERSION = 1;

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'out-noe']);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.ps1', '.py', '.txt', '.ts', '.tsx', '.xml', '.yml', '.yaml',
]);
const VENDOR_RE = /(^|\/)(vendor|__pycache__)(\/|$)|three\.module\.js$|babel\.min\.js$|react(?:-dom)?\.development\.js$|\.pyc$/i;
const TEST_RE = /(^|\/)(test-|.*\.test\.|fixtures\/)/i;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function rel(root, file) {
  return clean(relative(root, file).replace(/\\/g, '/'), 2000);
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function safeReadJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function safeReadText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function categorizeFile(path) {
  const ext = extname(path).toLowerCase();
  if (VENDOR_RE.test(path)) return 'vendor';
  if (TEST_RE.test(path)) return 'test';
  if (/^images\/|^music\/|\.png$|\.jpe?g$|\.gif$|\.mp[34]$|\.wav$|\.npz$|\.tiktoken$/i.test(path)) return 'asset';
  if (/^docs\/|\.md$|\.txt$/i.test(path)) return 'doc';
  if (TEXT_EXTENSIONS.has(ext)) return 'code';
  return 'asset';
}

function shouldReadText(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function bump(map, key, amount = 1) {
  map[key] = (Number(map[key]) || 0) + amount;
}

export function scanBaiLongmaRepository(rootDir, { maxTextBytes = 2_000_000 } = {}) {
  const root = clean(rootDir, 2000);
  if (!root || !existsSync(root)) {
    return { ok: false, root, error: 'bailongma_root_missing', files: [], totals: {} };
  }

  /** @type {Array<{path:string, bytes:number, lines:number, category:string}>} */
  const files = [];
  const totals = {
    files: 0,
    bytes: 0,
    lines: 0,
    byCategory: {},
    linesByCategory: {},
    topTextFiles: [],
  };

  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        walk(join(dir, ent.name));
        continue;
      }
      if (!ent.isFile()) continue;
      const file = join(dir, ent.name);
      const path = rel(root, file);
      let stat = null;
      try { stat = statSync(file); } catch { continue; }
      const category = categorizeFile(path);
      let lines = 0;
      if (shouldReadText(path) && stat.size <= maxTextBytes) {
        try { lines = lineCount(readFileSync(file, 'utf8')); } catch { lines = 0; }
      }
      files.push({ path, bytes: stat.size, lines, category });
      totals.files += 1;
      totals.bytes += stat.size;
      totals.lines += lines;
      bump(totals.byCategory, category);
      bump(totals.linesByCategory, category, lines);
    }
  }

  walk(root);
  totals.topTextFiles = files
    .filter((file) => file.lines > 0)
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 20)
    .map(({ path, lines, category }) => ({ path, lines, category }));

  return { ok: true, root, files, totals };
}

function fileSet(inventory) {
  return new Set((inventory?.files || []).map((file) => file.path));
}

function hasAny(files, paths) {
  return paths.some((path) => files.has(path));
}

function packageDeps(packageJson = {}) {
  return {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
    ...(packageJson.optionalDependencies || {}),
  };
}

function depPresent(deps, name) {
  return Object.prototype.hasOwnProperty.call(deps || {}, name);
}

export function detectNoeFusionCapabilities(rootDir = process.cwd()) {
  const root = clean(rootDir, 2000);
  const mindHtml = safeReadText(join(root, 'public/mind.html'));
  const mindJs = safeReadText(join(root, 'public/mind.js'));
  const socialRoutes = safeReadText(join(root, 'src/server/routes/noeSocialInbound.js'));
  const noe100Readiness = safeReadText(join(root, 'scripts/noe-100-readiness.mjs'));
  const noe100ReadinessTest = safeReadText(join(root, 'tests/unit/noe-100-readiness.test.js'));
  const worldEarthPanel = mindHtml.includes('id="worldEarthCanvas"')
    && mindJs.includes('noe-world-earth.js')
    && existsSync(join(root, 'public/src/web/noe-world-earth.js'))
    && existsSync(join(root, 'public/vendor/three/three.module.js'))
    && existsSync(join(root, 'public/vendor/earth/earth_atmos_2048.jpg'))
    && existsSync(join(root, 'public/vendor/earth/earth_clouds_2048.png'));
  const noe100ToolHealthVisible = existsSync(join(root, 'scripts/noe-100-readiness.mjs'))
    && existsSync(join(root, 'tests/unit/noe-100-readiness.test.js'))
    && noe100Readiness.includes('function summarizeToolSurface')
    && noe100Readiness.includes('tool_surface_health_visible')
    && noe100Readiness.includes('executionEnabledCount === 0')
    && noe100ReadinessTest.includes('exposes tool surface health without enabling marketplace execution');
  return {
    socialWebhookInbound: existsSync(join(root, 'src/runtime/NoeSocialWebhookInbound.js'))
      && existsSync(join(root, 'src/server/routes/noeSocialInbound.js')),
    wechatPersonalBridgeContract: existsSync(join(root, 'src/runtime/NoeWeChatPersonalBridge.js'))
      && socialRoutes.includes('/api/noe/social-inbound/wechat-personal/status')
      && socialRoutes.includes('/api/noe/social-inbound/wechat-personal/outbound-dry-run'),
    qqBridgeResearchGate: existsSync(join(root, 'src/runtime/NoeQqBridgeResearchGate.js'))
      && socialRoutes.includes('/api/noe/social-inbound/qq/research-gate')
      && socialRoutes.includes('/api/noe/social-inbound/qq/dry-run'),
    worldSurfacePanel: mindHtml.includes('id="worldSurface"')
      && (mindHtml.includes('id="worldEarthCanvas"') || mindHtml.includes('id="worldSurfaceSvg"'))
      && mindHtml.includes('id="worldSurfaceSvg"')
      && mindJs.includes('function renderWorldSurface')
      && mindJs.includes('/api/noe/readiness')
      && mindJs.includes('/api/noe/social-inbound/status')
      && mindJs.includes('/api/noe/missions?limit=10'),
    worldEarthPanel,
    capabilityToolSurface: existsSync(join(root, 'src/capabilities/ToolRegistry.js'))
      && existsSync(join(root, 'src/capabilities/builtinReadonlyTools.js'))
      && existsSync(join(root, 'src/capabilities/NoeFreedomManifest.js'))
      && existsSync(join(root, 'src/capabilities/NoeToolRouter.js'))
      && existsSync(join(root, 'src/runtime/NoeToolMarketplaceRegistry.js')),
    noe100ToolHealthVisible,
    baiLongmaFusionAudit: existsSync(join(root, 'scripts/noe-bailongma-fusion-audit.mjs')),
  };
}

export function buildBaiLongmaFeatureMap({ inventory, packageJson = {} } = {}) {
  const files = fileSet(inventory);
  const deps = packageDeps(packageJson);
  return [
    {
      id: 'wechat_clawbot_personal_bridge',
      title: 'Personal WeChat QR bridge',
      detected: files.has('src/social/wechat-clawbot.js') && depPresent(deps, 'wechat-ilink-client'),
      upstreamEvidence: ['src/social/wechat-clawbot.js', 'src/ui/brain-ui/wechat-popup.js', 'wechat-ilink-client'],
      noeFusion: 'Implement a NoeInboundGateway adapter behind explicit owner QR binding; persist only status/token metadata with secret redaction.',
      risks: ['personal_account_terms', 'qr_session_secret', 'context_token_expiry'],
    },
    {
      id: 'official_and_webhook_social_hub',
      title: 'Official-account/webhook social hub',
      detected: hasAny(files, ['src/social/webhooks.js', 'src/social/dispatch.js', 'src/social/targets.js']),
      upstreamEvidence: ['src/social/webhooks.js', 'src/social/dispatch.js', 'src/social/targets.js'],
      noeFusion: 'Map webhook inbound messages into NoeInboundGateway with owner-token protected admin status and no plaintext credential echo.',
      risks: ['replay_signature_validation', 'public_endpoint_exposure'],
    },
    {
      id: 'discord_gateway_bridge',
      title: 'Discord gateway connector',
      detected: files.has('src/social/discord.js') && depPresent(deps, 'ws'),
      upstreamEvidence: ['src/social/discord.js', 'ws'],
      noeFusion: 'Reuse Noe generation fence and channel permissions; start only when token readiness check reports configured.',
      risks: ['bot_token_secret', 'gateway_reconnect_loop', 'message_flood'],
    },
    {
      id: 'external_identity_presence',
      title: 'External identity and reachability model',
      detected: files.has('src/identity.js') && files.has('src/runtime/channel.js'),
      upstreamEvidence: ['src/identity.js', 'src/runtime/channel.js', 'src/queue.js'],
      noeFusion: 'Add channel presence snapshots to Noe self-knowledge so proactive delivery chooses the last owner-visible channel without inventing reachability.',
      risks: ['wrong_channel_delivery', 'multi_user_confusion'],
    },
    {
      id: 'globe_hotspot_world_ui',
      title: 'Interactive Earth hotspot interface',
      detected: files.has('src/ui/brain-ui/hotspot-earth.js') && files.has('src/ui/brain-ui/vendor/three/three.module.js'),
      upstreamEvidence: ['src/ui/brain-ui/hotspot-earth.js', 'src/ui/brain-ui/hotspot-panel.js', 'src/hotspots.js'],
      noeFusion: 'Vendor the BaiLongma Three.js earth/textures into Noe as a live evidence hotspot surface, keeping SVG fallback and screenshot/perf gates.',
      risks: ['gpu_cost', 'asset_size', 'decorative_without_evidence'],
    },
    {
      id: 'capability_tool_protocol',
      title: 'Capability tool protocol and audited executor',
      detected: files.has('src/capabilities/executor.js')
        && (files.has('src/capabilities/schemas.js') || files.has('src/capabilities/schemas/filesystem.js'))
        && files.has('src/capabilities/tool-policy.js')
        && files.has('src/runtime/tool-protocol.js'),
      upstreamEvidence: [
        'src/capabilities/executor.js',
        'src/capabilities/schemas.js',
        'src/capabilities/tool-policy.js',
        'src/capabilities/tool-audit.js',
        'src/runtime/tool-protocol.js',
      ],
      noeFusion: 'Map BaiLongma tool schemas/audit policy into Noe ToolRegistry + FreedomManifest capability cards; keep execution disabled by default until permission, rollback, and evidence gates pass.',
      risks: ['tool_protocol_drift', 'unsafe_runtime_execution', 'capability_overclaim'],
    },
    {
      id: 'qq_bridge',
      title: 'QQ bridge',
      detected: false,
      upstreamEvidence: [],
      noeFusion: 'BaiLongma current upstream has no QQ connector. Treat QQ as separate research: OneBot/QQNT/web bridge, explicit owner account approval, no credential scraping.',
      risks: ['unsupported_upstream', 'platform_terms', 'local_client_security'],
    },
  ];
}

function configured(env, keys) {
  const source = env || {};
  return keys.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

export function buildNoeFusionSurface({ env = {}, noePackageJson = {}, noeCapabilities = {} } = {}) {
  const deps = packageDeps(noePackageJson);
  return {
    existingNoeStrengths: [
      'NoeInboundGateway and generation fence already provide channel-neutral inbound handling.',
      'Noe Freedom social chain already handles browser-account social publishing with dry-run, owner approval, and rollback evidence gates.',
      'Noe cognitive/mind pages already expose evidence and readiness, so globe/social status should plug into those surfaces.',
    ],
    dependencyReadiness: {
      ws: depPresent(deps, 'ws'),
      wechatIlinkClient: depPresent(deps, 'wechat-ilink-client'),
      three: depPresent(deps, 'three'),
      vendoredThreeEarth: noeCapabilities.worldEarthPanel === true,
      d3: depPresent(deps, 'd3'),
    },
    envReadiness: {
      telegramBotToken: configured(env, ['TELEGRAM_BOT_TOKEN']),
      discordBotToken: configured(env, ['DISCORD_BOT_TOKEN']),
      wechatOfficial: configured(env, ['WECHAT_OFFICIAL_APP_ID', 'WECHAT_OFFICIAL_APP_SECRET', 'WECHAT_OFFICIAL_TOKEN']),
      wecomIncoming: configured(env, ['WECOM_INCOMING_TOKEN']),
      qqBridge: configured(env, ['QQ_BRIDGE_TOKEN']),
    },
    implementedCapabilities: {
      baiLongmaFusionAudit: noeCapabilities.baiLongmaFusionAudit === true,
      socialWebhookInbound: noeCapabilities.socialWebhookInbound === true,
      wechatPersonalBridgeContract: noeCapabilities.wechatPersonalBridgeContract === true,
      qqBridgeResearchGate: noeCapabilities.qqBridgeResearchGate === true,
      worldSurfacePanel: noeCapabilities.worldSurfacePanel === true,
      worldEarthPanel: noeCapabilities.worldEarthPanel === true,
      capabilityToolSurface: noeCapabilities.capabilityToolSurface === true,
      noe100ToolHealthVisible: noeCapabilities.noe100ToolHealthVisible === true,
    },
    note: 'Only key-presence booleans are reported. Secret values are not read into the report.',
  };
}

export function buildFusionBacklog({ features = [], noeSurface = {} } = {}) {
  const byId = Object.fromEntries(features.map((feature) => [feature.id, feature]));
  return [
    {
      id: 'BML-0',
      status: 'done_by_this_report',
      capability: 'self_model',
      title: 'BaiLongma line inventory and fusion radar',
      acceptance: ['external upstream scanned', 'features classified', 'Noe missing deps/status made explicit'],
    },
    {
      id: 'BML-1',
      status: noeSurface.implementedCapabilities?.wechatPersonalBridgeContract
        ? 'contract_done_transport_pending'
        : byId.wechat_clawbot_personal_bridge?.detected ? 'planned' : 'blocked_upstream_missing',
      capability: 'action',
      title: 'WeChat personal bridge via NoeInboundGateway',
      acceptance: ['QR/status route returns no secret', 'inbound message becomes fenced Noe session', 'outbound reply requires owner-visible channel evidence'],
      blockers: noeSurface.implementedCapabilities?.wechatPersonalBridgeContract
        ? ['live_transport_not_selected_or_started']
        : noeSurface.dependencyReadiness?.wechatIlinkClient ? [] : ['wechat_ilink_client_not_installed_in_noe'],
    },
    {
      id: 'BML-2',
      status: noeSurface.implementedCapabilities?.socialWebhookInbound ? 'done_by_noe_webhook_routes' : 'planned',
      capability: 'action',
      title: 'Webhook social hub for WeChat official, WeCom, Feishu, Discord',
      acceptance: ['signature/replay checks covered by tests', 'NoeInboundGateway receives normalized messages', 'credential readiness only reports booleans'],
    },
    {
      id: 'BML-3',
      status: noeSurface.implementedCapabilities?.qqBridgeResearchGate ? 'research_gate_done_official_webhook_selected' : 'research_required',
      capability: 'action',
      title: 'QQ bridge feasibility',
      acceptance: ['pick one supported transport', 'document owner-account risk', 'dry-run adapter before any live login'],
      blockers: noeSurface.implementedCapabilities?.qqBridgeResearchGate
        ? ['not_present_in_bailongma_upstream', 'qq_live_credentials_and_public_callback_not_configured']
        : ['not_present_in_bailongma_upstream'],
    },
    {
      id: 'BML-4',
      status: noeSurface.implementedCapabilities?.worldEarthPanel
        ? 'done_by_noe_three_earth_world_surface'
        : noeSurface.implementedCapabilities?.worldSurfacePanel ? 'done_by_noe_world_surface' : 'planned',
      capability: 'world_model',
      title: 'World/globe panel for external signals',
      acceptance: ['renders nonblank under Playwright', 'shows real Noe evidence counts or live hotspots', 'GPU/asset budget recorded'],
      blockers: noeSurface.implementedCapabilities?.worldEarthPanel
        || noeSurface.implementedCapabilities?.worldSurfacePanel
        || noeSurface.dependencyReadiness?.three
        || noeSurface.dependencyReadiness?.vendoredThreeEarth ? [] : ['three_not_installed_in_noe'],
    },
    {
      id: 'BML-5',
      status: noeSurface.implementedCapabilities?.capabilityToolSurface
        ? 'foundation_done_protocol_unification_pending'
        : byId.capability_tool_protocol?.detected ? 'planned' : 'blocked_upstream_missing',
      capability: 'action_model',
      title: 'Capability tool protocol into Noe action space',
      acceptance: [
        'BaiLongma schemas mapped to Noe capability cards without enabling arbitrary execution',
        'ToolRegistry and FreedomManifest expose the same risk/rollback/evidence vocabulary',
        'readiness reports verified tool health instead of static presence only',
      ],
      blockers: noeSurface.implementedCapabilities?.capabilityToolSurface
        ? [
          'freedom_manifest_toolregistry_protocol_not_unified',
          ...(
            noeSurface.implementedCapabilities?.noe100ToolHealthVisible
              ? []
              : ['tool_health_not_in_noe100_readiness']
          ),
        ]
        : ['noe_tool_surface_missing'],
    },
  ];
}

export function buildBaiLongmaFusionReport({
  bailongmaRoot,
  upstreamUrl = 'https://github.com/xiaoyuanda666-ship-it/BaiLongma.git',
  upstreamCommit = '',
  noePackageJson = {},
  noeCapabilities = {},
  env = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const inventory = scanBaiLongmaRepository(bailongmaRoot);
  const upstreamPackageJson = inventory.ok ? safeReadJson(join(bailongmaRoot, 'package.json')) || {} : {};
  const features = buildBaiLongmaFeatureMap({ inventory, packageJson: upstreamPackageJson });
  const noeSurface = buildNoeFusionSurface({ env, noePackageJson, noeCapabilities });
  const backlog = buildFusionBacklog({ features, noeSurface });
  return {
    ok: inventory.ok,
    schemaVersion: BAILONGMA_FUSION_SCHEMA_VERSION,
    generatedAt,
    source: {
      upstreamUrl: clean(upstreamUrl, 300),
      upstreamCommit: clean(upstreamCommit, 80),
      bailongmaRoot: inventory.root,
      license: 'MIT',
    },
    inventory,
    features,
    noeSurface,
    backlog,
    executionPolicy: {
      noSecretsRead: true,
      noConnectorsStarted: true,
      noLiveExternalMessagesSent: true,
      qqNotClaimed: true,
      arbitraryToolExecutionNotEnabled: true,
      globeNotClaimedRendered: !noeSurface.implementedCapabilities?.worldSurfacePanel,
      worldSurfaceRendered: noeSurface.implementedCapabilities?.worldSurfacePanel === true,
      threeJsEarthPanel: noeSurface.implementedCapabilities?.worldEarthPanel === true,
      threeJsAssetGateRequired: noeSurface.implementedCapabilities?.worldEarthPanel !== true,
    },
    verdict: inventory.ok
      ? 'BaiLongma is useful as a social-connector and world-UI reference. This report implements the Noe-side fusion radar; live WeChat/QQ/globe work remains gated by the backlog.'
      : 'BaiLongma root was not available; no fusion claim can be made.',
  };
}

export function formatBaiLongmaFusionPlanMarkdown(report = {}) {
  const inventory = report.inventory || {};
  const features = Array.isArray(report.features) ? report.features : [];
  const backlog = Array.isArray(report.backlog) ? report.backlog : [];
  const lines = [
    '# BaiLongma Fusion Plan',
    '',
    `- Source: ${report.source?.upstreamUrl || ''}`,
    `- Commit: ${report.source?.upstreamCommit || 'unknown'}`,
    `- Scan result: ${report.ok ? 'ok' : 'failed'}`,
    `- Files scanned: ${inventory.totals?.files || 0}`,
    `- Counted text lines: ${inventory.totals?.lines || 0}`,
    `- Policy: no secrets read, no external connectors started, no live messages sent`,
    '',
    '## Feature Findings',
    ...features.map((feature) => `- ${feature.detected ? 'detected' : 'missing'}: ${feature.id} — ${feature.noeFusion}`),
    '',
    '## Execution Backlog',
    ...backlog.map((item) => `- ${item.id} [${item.status}] ${item.title}; capability=${item.capability}; acceptance=${(item.acceptance || []).join(' / ')}`),
    '',
    '## Next Safe Execution',
    '1. Use the BML-2 webhook routes with configured provider tokens only; public status must continue reporting booleans only.',
    '2. Keep the BML-1 personal WeChat contract no-secret; select and test a live transport separately before any real login.',
    '3. Keep QQ in research_required until a real transport is selected; do not pretend BaiLongma already has QQ.',
    '4. Build the globe panel with real Noe evidence data first, then add Three.js assets only after render/perf verification.',
    '5. Treat BaiLongma capability tools as schema/audit input first; do not enable arbitrary runtime execution without Noe permission, rollback, and evidence gates.',
  ];
  return `${lines.join('\n')}\n`;
}
