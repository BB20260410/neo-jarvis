#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NoeCloudProviderRegistry } from '../src/cloud/NoeCloudProviderRegistry.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function main() {
  const root = process.cwd();
  const providerId = argValue('--provider', 'mock-minimax-m3');
  const live = hasArg('--live');
  const all = hasArg('--all');
  const requireReady = hasArg('--require-ready');
  const registry = new NoeCloudProviderRegistry();
  const ids = all ? registry.list().map((provider) => provider.id) : [providerId];
  const results = [];
  for (const id of ids) {
    results.push(live ? await registry.preflightLive(id) : registry.preflight(id));
  }
  const readyCount = results.filter((item) => item.ok === true).length;
  const report = {
    ok: requireReady ? readyCount === results.length : true,
    generatedAt: new Date().toISOString(),
    live,
    requireReady,
    providerCount: results.length,
    readyCount,
    providers: results,
    policy: {
      secretValuesReturned: false,
      livePanelTouched: false,
      writesRepo: false,
      defaultProvider: 'mock-minimax-m3',
    },
  };
  const outDir = join(root, 'output', 'noe-cloud-provider-preflight');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `cloud-provider-preflight-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: report.ok,
    reportPath: file,
    live,
    providerCount: report.providerCount,
    readyCount,
    providers: results.map((item) => ({
      providerId: item.providerId,
      provider: item.provider,
      model: item.model,
      ok: item.ok === true,
      mock: item.mock === true,
      configured: item.configured === true,
      reachable: item.reachable === true,
      authOk: item.authOk === true,
      status: item.status || item.reason || item.source || '',
      secretValuesReturned: false,
    })),
    secretValuesReturned: false,
  }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    error: String(error?.message || error).replace(/sk-[A-Za-z0-9_-]{20,}|tp-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}/g, '[redacted]'),
    secretValuesReturned: false,
  }, null, 2));
  process.exitCode = 1;
});
