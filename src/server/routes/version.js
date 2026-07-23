import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeRuntimeMode } from '../../runtime/NoeBaiLongmaRuntimeMode.js';
import { buildVoiceReadiness } from '../../runtime/NoeVoiceReadiness.js';
import { buildHomeStatusChips } from '../../runtime/NoeHomeShell.js';
import { buildSelfEvolutionHealthSnapshot } from '../../room/NoeSelfEvolutionHealthSnapshot.js';

export function registerVersionRoutes(app, deps) {
  const { rootDir } = deps;

  app.get('/api/version', async (req, res) => {
    let version = 'unknown';
    let buildVersion = '';
    let appName = 'Neo 贾维斯';
    try {
      const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
      version = pkg.version || version;
      appName = pkg.productName || pkg.name || appName;
    } catch {}
    for (const file of ['HANDOFF_NEW_CHAT.md', 'HANDOFF.md']) {
      try {
        const md = readFileSync(join(rootDir, file), 'utf-8');
        const m = md.match(/v(0\.\d+)\b/);
        if (m) { buildVersion = m[1]; break; }
      } catch {}
    }
    // Runtime mode is public-readable (no secrets); enables isolation smoke probes.
    // effectiveEnv reflects post-bootstrap process.env (load-env applied hints before autonomy defaults).
    const runtimeMode = describeRuntimeMode(process.env);
    // Voice readiness: deps.getVoiceFindings may be async (Doctor companion probes).
    let findings = [];
    try {
      if (typeof deps.getVoiceFindings === 'function') {
        findings = (await Promise.resolve(deps.getVoiceFindings())) || [];
      }
    } catch { /* ignore */ }
    if (!Array.isArray(findings)) findings = findings ? [findings] : [];
    const voice = buildVoiceReadiness({ findings });
    // Self-evolution health: rings + profile + honesty (env-only; no secrets / no cycle dumps).
    let selfEvolution = null;
    try {
      const snap = buildSelfEvolutionHealthSnapshot({ env: process.env });
      selfEvolution = {
        schemaVersion: snap.schemaVersion,
        kind: snap.kind,
        profile: snap.profile,
        rings: snap.rings,
        armed: {
          rings: snap.armed?.rings === true,
          realApply: snap.armed?.realApply === true,
          lessonFlywheel: snap.armed?.lessonFlywheel === true,
          heartbeat: snap.armed?.heartbeat === true,
        },
        honesty: snap.honesty,
      };
    } catch {
      selfEvolution = null;
    }
    const statusChips = buildHomeStatusChips({
      runtimeMode: {
        modeId: runtimeMode.modeId,
        label: runtimeMode.label,
        bailongmaStyle: runtimeMode.bailongmaStyle,
        isFullyCloud: runtimeMode.topologyClaim?.isFullyCloud === true,
        effectiveEnv: runtimeMode.effectiveEnv,
        landedBorrow: runtimeMode.landedBorrow,
      },
      voice,
      selfEvolution,
    });
    res.json({
      ok: true,
      version,
      buildVersion,
      appName,
      runtimeMode: {
        modeId: runtimeMode.modeId,
        label: runtimeMode.label,
        bailongmaStyle: runtimeMode.bailongmaStyle,
        topologyClass: runtimeMode.topologyClaim?.topologyClass,
        isFullyCloud: runtimeMode.topologyClaim?.isFullyCloud === true,
        schema: runtimeMode.kind,
        effectiveEnv: runtimeMode.effectiveEnv,
        landedBorrow: runtimeMode.landedBorrow,
      },
      voiceReadiness: voice,
      selfEvolution,
      statusChips,
    });
  });

  /** Lightweight voice readiness probe for primary UI (no secrets). */
  app.get('/api/noe/voice-readiness', async (req, res) => {
    let findings = [];
    try {
      if (typeof deps.getVoiceFindings === 'function') {
        findings = (await Promise.resolve(deps.getVoiceFindings())) || [];
      }
    } catch { /* ignore */ }
    if (!Array.isArray(findings)) findings = findings ? [findings] : [];
    const voice = buildVoiceReadiness({ findings });
    res.json({ ok: true, voice });
  });
}
