import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectNoeSshInventory,
  parseNoeSshConfig,
} from '../../src/runtime/NoeSshInventory.js';

describe('NoeSshInventory', () => {
  it('parses SSH host metadata without exposing private key paths', () => {
    const hosts = parseNoeSshConfig(`
Host prod prod-alias
  HostName 203.0.113.10
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519_prod
  ProxyJump bastion

Host *
  ForwardAgent no
`);

    expect(hosts).toEqual([
      {
        aliases: ['prod', 'prod-alias'],
        hostName: '203.0.113.10',
        user: 'deploy',
        port: '2222',
        identityFile: { configured: true, basename: 'id_ed25519_prod' },
        proxyJumpConfigured: true,
        localForwardConfigured: false,
        remoteForwardConfigured: false,
      },
    ]);
    expect(JSON.stringify(hosts)).not.toContain('~/.ssh/id_ed25519_prod');
  });

  it('inspects only the config file and never reads private keys or connects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-ssh-inventory-'));
    const config = join(dir, 'config');
    try {
      writeFileSync(config, 'Host demo\n  HostName example.test\n  IdentityFile ./secret_key\n', 'utf8');
      writeFileSync(join(dir, 'secret_key'), 'PRIVATE KEY SHOULD NOT BE READ', 'utf8');

      const out = inspectNoeSshInventory({ path: config });
      expect(out).toMatchObject({
        ok: true,
        configExists: true,
        count: 1,
        privateKeyRead: false,
        networkConnectionAttempted: false,
        passwordPromptAllowed: false,
      });
      expect(out.hosts[0]).toMatchObject({
        aliases: ['demo'],
        hostName: 'example.test',
        identityFile: { configured: true, basename: 'secret_key' },
      });
      expect(JSON.stringify(out)).not.toContain('PRIVATE KEY SHOULD NOT BE READ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on SSH config symlinks by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-ssh-inventory-symlink-'));
    const target = join(dir, 'target-config');
    const link = join(dir, 'config-link');
    try {
      writeFileSync(target, 'Host demo\n  HostName example.test\n', 'utf8');
      symlinkSync(target, link);

      const out = inspectNoeSshInventory({ path: link });
      expect(out).toMatchObject({
        ok: false,
        error: 'ssh_config_symlink_not_allowed',
        privateKeyRead: false,
        networkConnectionAttempted: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
