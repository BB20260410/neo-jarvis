#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const checks = [];

function pass(label, detail = '') {
  checks.push({ ok: true, label, detail });
  console.log(`[PASS] ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  checks.push({ ok: false, label, detail });
  console.error(`[FAIL] ${label}${detail ? ` - ${detail}` : ''}`);
}

function requireFile(file) {
  const ok = existsSync(join(root, file));
  if (ok) pass(`file exists: ${file}`);
  else fail(`file exists: ${file}`);
  return ok;
}

function requireContains(file, snippets) {
  if (!requireFile(file)) return;
  const source = readFileSync(join(root, file), 'utf8');
  const missing = snippets.filter((snippet) => !source.includes(snippet));
  if (missing.length) fail(`content check: ${file}`, `missing ${missing.join(', ')}`);
  else pass(`content check: ${file}`, `${snippets.length} anchors`);
}

function run(label, args) {
  console.log(`\n$ ${process.execPath} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 0) pass(label, 'exit 0');
  else fail(label, `exit ${result.status}`);
}

console.log('=== NOE Phase 5 Code Development Verification ===');
console.log(`cwd=${root}`);
console.log(`node=${process.version}; modules=${process.versions.modules}`);

requireContains('src/storage/SqliteStore.js', [
  'version: 2',
  'noe_memory',
  'noe_memory_fts',
  'noe_focus_stack',
  'noe_tools',
]);
requireContains('src/memory/MemoryCore.js', [
  'export class MemoryCore',
  'write(input = {})',
  'recall(input = {})',
  'ftsAvailable()',
  'hidden = 1',
]);
requireContains('src/memory/FocusStack.js', [
  'export class FocusStack',
  'push(input = {})',
  'pop(id, input = {})',
  'absorbedMemoryId',
]);
requireContains('src/loop/NoeLoop.js', [
  'export class NoeLoop',
  'start(options = {})',
  'async tick(options = {})',
  'noe_loop_tick',
  'BudgetLimitExceededError',
]);
requireContains('src/capabilities/ToolRegistry.js', [
  'export class ToolRegistry',
  'tool.enabled',
  "action: 'shell.exec'",
  'shellGuard: true',
  'tool disabled',
]);
requireContains('src/server/routes/noe.js', [
  'registerNoeRoutes',
  '/api/noe/health',
  '/api/noe/loop/tick',
  '/api/noe/memory',
  '/api/noe/tools/:id/invoke',
  'requireOwnerToken',
]);
requireContains('server.js', [
  "import { registerNoeRoutes } from './src/server/routes/noe.js'",
  'const noeMemoryCore = new MemoryCore()',
  'const noeLoop = new NoeLoop',
  'registerNoeRoutes(app',
]);
requireContains('public/index.html', [
  'id="btnNoeBrain"',
  'id="noeBrainArea"',
  'data-noe-panel="loop"',
  'data-noe-panel="memory"',
  'data-noe-panel="health"',
]);
requireContains('public/main.js', [
  "import './src/web/brain-ui.js",
]);
requireContains('public/src/web/brain-ui.js', [
  'function refreshBrain()',
  "noeFetch('/api/noe/health')",
  'connectThoughtStream()',
  'btnNoeLoopTick',
]);
requireContains('tests/unit/noe-memory-focus.test.js', [
  'MemoryCore',
  'FocusStack',
  'soft hides memories',
  'falls back to LIKE recall',
  'absorbs popped focus into memory',
]);
requireContains('tests/unit/noe-loop-toolregistry.test.js', [
  'NoeLoop',
  'ToolRegistry',
  'dangerous-pattern approval gate',
  'zero-cost tick events',
  'pauses on budget preflight',
]);
requireContains('tests/unit/routes/noe-routes.test.js', [
  'registerNoeRoutes',
  '/api/noe/health',
  'keeps every Noe API route behind owner-token middleware',
  'owner token required',
]);

run('phase2 secret gate', ['NOE_PHASE2_SECRET_GATE.mjs']);
run('phase4 planning gate', ['NOE_PHASE4_VERIFY.mjs']);
run('Noe unit subset', [
  'node_modules/vitest/vitest.mjs',
  'run',
  'tests/unit/schema-migrations.test.js',
  'tests/unit/server-route-wiring.test.js',
  'tests/unit/routes/noe-routes.test.js',
  'tests/unit/noe-memory-focus.test.js',
  'tests/unit/noe-loop-toolregistry.test.js',
]);

const failed = checks.filter((check) => !check.ok);
console.log(`\nResult: ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
