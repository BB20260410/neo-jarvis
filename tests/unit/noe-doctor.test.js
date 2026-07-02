import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runNoeDoctor } from '../../src/runtime/NoeDoctor.js';

function makeRequiredFiles(root) {
  for (const file of [
    'src/runtime/NoeDoctor.js',
    'src/runtime/NoePanelRuntimePreflight.js',
    'src/runtime/NoeGatewayProtocol.js',
    'src/runtime/NoeTaskFlowStore.js',
    'src/runtime/NoeLaneQueue.js',
    'src/runtime/NoeContextScrubber.js',
    'src/memory/NoeActiveMemory.js',
    'src/safety/ToolCallGuardrailController.js',
    'src/room/NoeLocalModelCouncil.js',
    'scripts/noe-self-evolution-cycle-assemble.mjs',
    'scripts/noe-consensus-ledger-verify.mjs',
  ]) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), '');
  }
}

describe('NoeDoctor', () => {
  it('runs a read-only lint pass with structured findings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-doctor-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'noe', version: 'test' }));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
      writeFileSync(join(dir, '.gitignore'), '.env\n.env.local\n');
      makeRequiredFiles(dir);
      const commandRunner = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'rev-parse') return `${dir}\n`;
        if (cmd === 'git' && args[0] === 'status') return '';
        if (cmd === 'lsof' && args.includes('-iTCP:51835')) return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 owner 1u IPv4 X 0t0 TCP 127.0.0.1:51835 (LISTEN)\n';
        if (cmd === 'lsof' && args.includes('-iTCP:51735')) throw new Error('no listener');
        if (cmd === 'lsof' && args.includes('-d') && args.includes('cwd')) return `p1\nfcwd\nn${dir}\n`;
        if (cmd === 'ps') return ' 1 0 00:01 node server.js\n';
        throw new Error('unexpected command');
      };
      const out = await runNoeDoctor({ root: dir, commandRunner, skipNetwork: true });

      expect(out.ok).toBe(true);
      expect(out.findings.find((item) => item.checkId === 'panel.runtime.preflight').data.safeToRestart).toBe(true);
      expect(out.findings.find((item) => item.checkId === 'local.models.discovery').message).toContain('skipped');
      expect(out.findings.every((item) => item.checkId && item.severity && item.message)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies dirty git worktrees instead of hiding them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-doctor-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'noe' }));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
      writeFileSync(join(dir, '.gitignore'), '.env\n.env.local\n');
      makeRequiredFiles(dir);
      const commandRunner = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'rev-parse') return `${dir}\n`;
        if (cmd === 'git' && args[0] === 'status') return ' M src/a.js\n?? output/new.json\n';
        if (cmd === 'lsof' && args.includes('-iTCP:51835')) throw new Error('no listener');
        if (cmd === 'lsof' && args.includes('-iTCP:51735')) throw new Error('no listener');
        return '';
      };
      const out = await runNoeDoctor({ root: dir, commandRunner, skipNetwork: true });
      const git = out.findings.find((item) => item.checkId === 'git.status');

      expect(out.ok).toBe(true);
      expect(out.status).toBe('warn');
      expect(git.data.groups.modified).toEqual(['src/a.js']);
      expect(git.data.groups.untracked).toEqual(['output/new.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
