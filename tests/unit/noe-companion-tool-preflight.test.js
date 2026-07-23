import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectNoeCompanionToolPreflight,
  compareCompanionVersions,
} from '../../src/runtime/NoeCompanionToolPreflight.js';

const roots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-companion-tools-'));
  roots.push(root);
  return root;
}

function write(file, text = '') {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function makeOpenClawInstall(root, prefix, version) {
  const pkgDir = join(root, prefix, 'lib/node_modules/openclaw');
  const binDir = join(root, prefix, 'bin');
  const entry = join(pkgDir, 'openclaw.mjs');
  const bin = join(binDir, 'openclaw');
  write(join(pkgDir, 'package.json'), JSON.stringify({ name: 'openclaw', version }, null, 2));
  write(entry, '#!/usr/bin/env node\n');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(relative(binDir, entry), bin);
  return { bin, binDir };
}

function makeHermesInstall(root, version = '0.16.0') {
  const project = join(root, '.hermes/hermes-agent');
  const binDir = join(project, 'venv/bin');
  const bin = join(binDir, 'hermes');
  write(join(project, 'pyproject.toml'), `[project]\nname = "hermes-agent"\nversion = "${version}"\n`);
  write(bin, '#!/usr/bin/env python\n');
  return { bin, binDir, project };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Noe companion tool preflight', () => {
  it('detects OpenClaw PATH version drift without reading configs or secrets', () => {
    const root = makeRoot();
    const oldOpenClaw = makeOpenClawInstall(root, 'usr/local', '2026.6.1');
    const newOpenClaw = makeOpenClawInstall(root, 'home/.npm-global', '2026.6.6');
    const hermes = makeHermesInstall(root);
    const clawPanel = join(root, 'home/.openclaw/clawpanel');
    mkdirSync(clawPanel, { recursive: true });

    const report = collectNoeCompanionToolPreflight({
      homeDir: join(root, 'home'),
      pathValue: [oldOpenClaw.binDir, hermes.binDir].join(':'),
      openClawCandidates: [oldOpenClaw.bin, newOpenClaw.bin],
      hermesCandidates: [hermes.bin],
      clawPanelPaths: [clawPanel],
    });

    expect(report).toMatchObject({
      ok: true,
      status: 'warn',
      policy: {
        readOnly: true,
        configFilesRead: false,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
    expect(report.warnings).toContain('openclaw:active_openclaw_older_than_available_candidate');
    expect(report.tools.openclaw).toMatchObject({
      activePath: oldOpenClaw.bin,
      activeVersion: '2026.6.1',
      newestCandidatePath: newOpenClaw.bin,
      newestCandidateVersion: '2026.6.6',
    });
    expect(report.repairPlan).toMatchObject({
      status: 'attention_required',
      summary: {
        safeAutomatic: 0,
        manual: 2,
        blocked: 0,
        requiresOwnerApproval: 2,
      },
      policy: {
        noPathMutation: true,
        noPackageInstall: true,
        noConfigRead: true,
        noSecretRead: true,
        actionsPerformed: false,
      },
    });
    expect(report.repairPlan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'prefer_newer_openclaw_candidate',
        tool: 'openclaw',
        currentVersion: '2026.6.1',
        targetVersion: '2026.6.6',
        repairable: false,
        requiresOwnerApproval: true,
      }),
    ]));
    expect(report.tools.hermes).toMatchObject({
      activePath: hermes.bin,
      activeVersion: '0.16.0',
    });
    expect(report.tools.hermes.activeProjectPath).toMatch(/\.hermes\/hermes-agent$/);
    expect(JSON.stringify(report)).not.toMatch(/api[_-]?key|owner-token|Bearer\s+[A-Za-z0-9]/i);
  });

  it('marks missing companion tools as blocked manual follow-up without pretending to repair them', () => {
    const root = makeRoot();
    const report = collectNoeCompanionToolPreflight({
      homeDir: join(root, 'home'),
      pathValue: '',
      openClawCandidates: [join(root, 'missing/openclaw')],
      hermesCandidates: [join(root, 'missing/hermes')],
      clawPanelPaths: [join(root, 'missing/clawpanel')],
    });

    expect(report.status).toBe('warn');
    expect(report.warnings).toEqual(expect.arrayContaining([
      'openclaw:openclaw_not_on_path',
      'hermes:hermes_not_on_path',
      'clawpanel:claw_panel_state_dirs_not_found',
    ]));
    expect(report.repairPlan.summary).toMatchObject({
      safeAutomatic: 0,
      manual: 0,
      blocked: 3,
      requiresOwnerApproval: 3,
    });
    expect(report.repairPlan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'install_openclaw_cli', repairable: false, blocked: true }),
      expect.objectContaining({ id: 'install_hermes_cli', repairable: false, blocked: true }),
      expect.objectContaining({ id: 'locate_claw_panel_state_or_source', repairable: false, blocked: true }),
    ]));
    expect(report.policy).toMatchObject({
      readOnly: true,
      configFilesRead: false,
      secretValuesReturned: false,
      actionsPerformed: false,
    });
  });

  it('compares date-style and semantic companion versions', () => {
    expect(compareCompanionVersions('2026.6.6', '2026.6.1')).toBeGreaterThan(0);
    expect(compareCompanionVersions('0.16.0', '0.15.9')).toBeGreaterThan(0);
    expect(compareCompanionVersions('1.0.0', '1.0.0')).toBe(0);
  });
});
