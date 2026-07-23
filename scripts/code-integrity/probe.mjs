#!/usr/bin/env node
// @ts-check

import { closeSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const DENIED_CODES = new Set(['EACCES', 'EPERM']);

/** @param {string} name @param {() => void} action */
function expectDenied(name, action) {
  try {
    action();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (DENIED_CODES.has(code)) {
      process.stdout.write(`${JSON.stringify({ name, denied: true, code })}\n`);
      return;
    }
    throw error;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

/** @param {string} host @param {number} port */
async function expectNetworkDenied(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('network probe timed out instead of being denied'));
    }, 1500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error('network probe unexpectedly connected'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (!DENIED_CODES.has(code)) {
        reject(new Error(`network was not sandbox-denied: ${code || error.message}`));
        return;
      }
      process.stdout.write(`${JSON.stringify({ name: 'network', denied: true, code })}\n`);
      resolve(undefined);
    });
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'allowed-write') {
    writeFileSync(args[0], 'allowed\n', { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ name: mode, allowed: true })}\n`);
    return;
  }
  if (mode === 'open-rplus-denied') {
    expectDenied(mode, () => {
      const fd = openSync(args[0], 'r+');
      closeSync(fd);
    });
    return;
  }
  if (mode === 'read-denied') {
    expectDenied(mode, () => readFileSync(args[0]));
    return;
  }
  if (mode === 'create-denied') {
    expectDenied(mode, () => writeFileSync(args[0], 'must-not-exist\n', { flag: 'wx', mode: 0o600 }));
    return;
  }
  if (mode === 'control-dir-rename-denied') {
    expectDenied(mode, () => renameSync(args[0], `${args[0]}-moved-by-probe`));
    return;
  }
  if (mode === 'symlink-rplus-denied') {
    symlinkSync(args[1], args[0]);
    expectDenied(mode, () => {
      const fd = openSync(args[0], 'r+');
      closeSync(fd);
    });
    return;
  }
  if (mode === 'symlink-read-denied') {
    symlinkSync(args[1], args[0]);
    expectDenied(mode, () => readFileSync(args[0]));
    return;
  }
  if (mode === 'signal-zero-denied') {
    const pid = Number(args[0]);
    expectDenied(mode, () => process.kill(pid, 0));
    return;
  }
  if (mode === 'launchctl-denied') {
    const result = spawnSync('/bin/launchctl', ['print', 'system'], { encoding: 'utf8' });
    const code = result.error && 'code' in result.error ? String(result.error.code) : '';
    if (DENIED_CODES.has(code)) {
      process.stdout.write(`${JSON.stringify({ name: mode, denied: true, code })}\n`);
      return;
    }
    throw new Error(`launchctl was not blocked at exec: status=${result.status} code=${code || 'none'}`);
  }
  if (mode === 'network-denied') {
    await expectNetworkDenied(args[0], Number(args[1]));
    return;
  }
  throw new Error(`unknown probe mode: ${mode}`);
}

main().catch((error) => {
  process.stderr.write(`probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
