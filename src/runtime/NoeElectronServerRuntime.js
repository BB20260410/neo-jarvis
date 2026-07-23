// @ts-check

/**
 * Packaged Neo must be self-contained. Its server therefore runs through the
 * packaged Electron executable with ELECTRON_RUN_AS_NODE=1, matching the
 * Electron ABI used by native modules inside the app bundle. Development builds
 * may continue to discover an external Node 22 runtime.
 *
 * @param {object} input
 * @param {boolean} input.isPackaged
 * @param {boolean} [input.allowExternalNode]
 * @param {string} input.execPath
 * @param {string} [input.nodeVersion]
 * @param {string} [input.moduleAbi]
 */
export function resolvePackagedElectronServerRuntime({
  isPackaged,
  allowExternalNode = false,
  execPath,
  nodeVersion = '',
  moduleAbi = '',
}) {
  if (!isPackaged || allowExternalNode) return null;
  return {
    bin: execPath,
    version: nodeVersion ? `v${String(nodeVersion).replace(/^v/, '')}` : 'electron',
    modules: String(moduleAbi || ''),
    major: Number(String(nodeVersion || '').replace(/^v/, '').split('.')[0]) || 0,
    isElectron: true,
  };
}
