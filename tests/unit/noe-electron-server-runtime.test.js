import { describe, expect, it } from 'vitest';
import { resolvePackagedElectronServerRuntime } from '../../src/runtime/NoeElectronServerRuntime.js';

describe('packaged Electron server runtime', () => {
  it('uses the packaged executable by default so native modules match Electron ABI', () => {
    expect(resolvePackagedElectronServerRuntime({
      isPackaged: true,
      execPath: '/Applications/Neo 贾维斯.app/Contents/MacOS/Neo 贾维斯',
      nodeVersion: '22.17.0',
      moduleAbi: '136',
    })).toEqual({
      bin: '/Applications/Neo 贾维斯.app/Contents/MacOS/Neo 贾维斯',
      version: 'v22.17.0',
      modules: '136',
      major: 22,
      isElectron: true,
    });
  });

  it('allows external Node discovery only through an explicit compatibility override', () => {
    expect(resolvePackagedElectronServerRuntime({
      isPackaged: true,
      allowExternalNode: true,
      execPath: '/Applications/Neo 贾维斯.app/Contents/MacOS/Neo 贾维斯',
    })).toBeNull();
  });

  it('does not alter the development runtime path', () => {
    expect(resolvePackagedElectronServerRuntime({
      isPackaged: false,
      execPath: '/path/to/Electron',
    })).toBeNull();
  });
});
