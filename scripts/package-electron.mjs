#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);
const builderCli = join(root, 'node_modules', 'electron-builder', 'cli.js');
const nativeDeps = ['better-sqlite3', 'node-pty', '@homebridge/node-pty-prebuilt-multiarch'];
const node22PathEnv = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};
const nodeRestoreEnv = {
  ...node22PathEnv,
  npm_config_runtime: 'node',
  npm_config_target: process.versions.node,
  npm_config_arch: process.arch,
};

function run(cmd, cmdArgs, env = process.env) {
  return spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env,
  });
}

function npmCliPath() {
  const bundled = resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(bundled) ? bundled : '';
}

const buildArgs = existsSync(builderCli)
  ? [builderCli, ...(args.length ? args : ['--mac', '--dir'])]
  : ['node_modules/.bin/electron-builder', ...(args.length ? args : ['--mac', '--dir'])];
const build = run(process.execPath, buildArgs, node22PathEnv);
const buildStatus = typeof build.status === 'number' ? build.status : 1;

console.log('\n[package-electron] restoring root node_modules native ABI for local Node runtime...');
const npmCli = npmCliPath();
const rebuild = npmCli
  ? run(process.execPath, [npmCli, 'rebuild', ...nativeDeps], nodeRestoreEnv)
  : run('npm', ['rebuild', ...nativeDeps], nodeRestoreEnv);
const rebuildStatus = typeof rebuild.status === 'number' ? rebuild.status : 1;

if (rebuildStatus !== 0) {
  process.exit(rebuildStatus);
}
process.exit(buildStatus);
