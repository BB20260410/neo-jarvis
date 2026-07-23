// @ts-check
import { describe, expect, it } from 'vitest';
import {
  detectOsSandbox,
  loadThirdPartyPlugin,
  permissionBrokerDecide,
  encodePluginIpcMessage,
  refuseMainProcessPluginRequire,
} from '../../src/runtime/NoePluginHost.js';

describe('NoePluginHost fail-closed', () => {
  it('detects sandbox-exec on darwin (real probe)', () => {
    const s = detectOsSandbox();
    // On this macOS machine sandbox-exec exists and probe should pass
    if (process.platform === 'darwin') {
      expect(s.engine).toBe('sandbox-exec');
      expect(s.available).toBe(true);
    }
  });

  it('denies third-party when sandbox unavailable', () => {
    const r = loadThirdPartyPlugin(
      { id: 'evil', entry: '/tmp/x.js' },
      {
        sandboxDeps: {
          platform: 'darwin',
          which: () => null,
        },
      },
    );
    expect(r.loaded).toBe(false);
    expect(r.failClosed).toBe(true);
    expect(r.decision.blockers).toContain('os_sandbox_required_fail_closed');
  });

  it('denies main-process import path always', () => {
    const r = loadThirdPartyPlugin(
      { id: 'x', mainProcessImport: true },
      {
        sandboxDeps: {
          platform: 'darwin',
          which: () => '/usr/bin/sandbox-exec',
          run: () => ({ status: 0, stdout: 'noe-sandbox-ok\n' }),
        },
      },
    );
    expect(r.loaded).toBe(false);
    expect(r.reason).toBe('main_process_import_forbidden');
  });

  it('allows host plan only when sandbox+isolation+ipc+broker', () => {
    const r = loadThirdPartyPlugin(
      { id: 'safe', entry: '/plugins/safe/index.js', grantedCapabilities: [] },
      {
        pluginHostIsolated: true,
        typedIpc: true,
        permissionBroker: true,
        sandboxDeps: {
          platform: 'darwin',
          which: () => '/usr/bin/sandbox-exec',
          run: () => ({ status: 0, stdout: 'noe-sandbox-ok\n' }),
        },
      },
    );
    expect(r.loaded).toBe(true);
    expect(r.hostPlan.mode).toBe('child_process_os_sandbox');
    expect(r.hostPlan.capabilities.fs).toBe(false);
  });

  it('permission broker default-denies fs/net', () => {
    const d = permissionBrokerDecide({ requested: ['fs', 'net'], granted: [] });
    expect(d.denied).toEqual(expect.arrayContaining(['fs', 'net']));
  });

  it('typed IPC encodes JSON-only payload', () => {
    const m = encodePluginIpcMessage({ type: 'invoke', id: '1', payload: { a: 1 } });
    expect(m.v).toBe(1);
    expect(m.payload).toEqual({ a: 1 });
    expect(() => encodePluginIpcMessage({ type: 'x', payload: { f: () => 1 } })).toThrow();
  });

  it('refuseMainProcessPluginRequire always refuses', () => {
    const r = refuseMainProcessPluginRequire('/evil/plugin.js');
    expect(r.refused).toBe(true);
    expect(r.ok).toBe(false);
  });
});
