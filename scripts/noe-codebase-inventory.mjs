#!/usr/bin/env node
// @ts-check
// Read-only codebase inventory for the Neo/Noe architecture audit.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_CODEBASE_INVENTORY_OUT_DIR || join(ROOT, 'output', 'noe-codebase-inventory');
const DEFAULT_SCAN_ROOTS = ['server.js', 'src', 'scripts', 'public', 'tests/unit'];
const CODE_EXTS = new Set(['.js', '.mjs', '.cjs']);
const MAX_SYMBOLS = 80;
const MAX_TESTS = 40;
const MAX_ENVS = 40;
const MAX_IMPORTS = 500;

function rel(file, root = ROOT) {
  return relative(root, file).replaceAll('\\', '/');
}

function clean(value = '', max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function walkCodeFiles(target, out = []) {
  if (!existsSync(target)) return out;
  const st = statSync(target);
  if (st.isFile()) {
    if (CODE_EXTS.has(extname(target))) out.push(resolve(target));
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const name of readdirSync(target)) {
    if (name === 'node_modules' || name === '.git' || name === 'output' || name === 'dist' || name === 'coverage') continue;
    walkCodeFiles(join(target, name), out);
  }
  return out;
}

function lineCount(text = '') {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function unique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = clean(value, 1000);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function matchAll(re, text) {
  return [...String(text || '').matchAll(re)].map((match) => clean(match[1] || match[0], 300)).filter(Boolean);
}

function extractSymbols(text = '') {
  return unique([
    ...matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `export:function:${name}`),
    ...matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `export:class:${name}`),
    ...matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `export:const:${name}`),
    ...matchAll(/\bexport\s+let\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `export:let:${name}`),
    ...matchAll(/\bexport\s+default\s+(?:class|function)?\s*([A-Za-z_$][\w$]*)?/g, text).map((name) => `export:default${name ? `:${name}` : ''}`),
    ...matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `class:${name}`),
    ...matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g, text).map((name) => `function:${name}`),
  ]).slice(0, MAX_SYMBOLS);
}

function extractEnvVars(text = '') {
  return unique([
    ...matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g, text),
    ...matchAll(/\bprocess\.env\[['"]([A-Z0-9_]+)['"]\]/g, text),
  ]).slice(0, MAX_ENVS);
}

function extractRouteHints(text = '') {
  return unique([
    ...matchAll(/\bapp\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, text),
    ...matchAll(/\brouter\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, text),
    ...matchAll(/['"`](\/api\/noe\/[^'"`]+)['"`]/g, text),
  ]).slice(0, 60);
}

function extractImports(text = '') {
  return unique([
    ...matchAll(/\bfrom\s+['"]([^'"]+)['"]/g, text),
    ...matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, text),
  ]).filter((item) => item.startsWith('.') || item.startsWith('../')).slice(0, MAX_IMPORTS);
}

function resolveLocalImport(fromFile = '', spec = '', fileSet = new Set()) {
  if (!spec.startsWith('.')) return '';
  const baseParts = fromFile.split('/').slice(0, -1);
  const normalized = [];
  for (const part of [...baseParts, ...spec.split('/')]) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  const base = normalized.join('/');
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.js`,
    `${base}/index.mjs`,
    `${base}/index.cjs`,
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || '';
}

function moduleNameFor(path = '') {
  const parts = path.split('/');
  if (parts[0] === 'src') return parts[1] || 'src-root';
  if (parts[0] === 'scripts') return 'scripts';
  if (parts[0] === 'public') return 'public';
  if (parts[0] === 'tests') return 'tests';
  return parts[0] || 'root';
}

function roleFor(path = '') {
  if (path === 'server.js') return 'main_panel_server';
  if (path.startsWith('src/server')) return 'http_routes_and_panel_services';
  if (path.startsWith('src/cognition')) return 'cognition_expectations_goals_workspace';
  if (path.startsWith('src/loop')) return 'heartbeat_act_pipeline_inner_loop';
  if (path.startsWith('src/runtime')) return 'actions_missions_freedom_runtime';
  if (path.startsWith('src/memory')) return 'memory_write_retrieval_governance';
  if (path.startsWith('src/room')) return 'model_room_and_multimodel_orchestration';
  if (path.startsWith('src/voice')) return 'voice_tts_asr_sessions';
  if (path.startsWith('src/vision')) return 'vision_and_screen_context';
  if (path.startsWith('scripts')) return 'verification_audit_or_maintenance_script';
  if (path.startsWith('public')) return 'browser_ui_asset';
  if (path.startsWith('tests')) return 'unit_or_route_test';
  return 'supporting_module';
}

function basenameStem(path = '') {
  return path.split('/').pop()?.replace(/\.(test\.)?[cm]?js$/, '') || path;
}

function testCoverageFor(path = '', testFiles = [], testIndex = new Map()) {
  if (path.startsWith('tests/')) return [];
  const stem = basenameStem(path).toLowerCase();
  const module = moduleNameFor(path).toLowerCase();
  const direct = testFiles.filter((test) => basenameStem(test).toLowerCase().includes(stem));
  const referenced = testIndex.get(path) || [];
  const byModule = direct.length || referenced.length
    ? []
    : testFiles.filter((test) => test.toLowerCase().includes(`/${module}`)).slice(0, 5);
  return unique([...direct, ...referenced, ...byModule]).slice(0, MAX_TESTS);
}

function buildTestIndex(files = [], { root = ROOT } = {}) {
  const codeFiles = files.filter((file) => !file.startsWith('tests/'));
  const tests = files.filter((file) => file.startsWith('tests/'));
  const index = new Map();
  for (const test of tests) {
    let text = '';
    try { text = readFileSync(join(root, test), 'utf8'); } catch { continue; }
    for (const file of codeFiles) {
      const stem = basenameStem(file);
      if (stem && text.includes(stem)) {
        const arr = index.get(file) || [];
        arr.push(test);
        index.set(file, arr);
      }
    }
  }
  return index;
}

function summarizePackages({ root = ROOT } = {}) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const scripts = Object.entries(pkg.scripts || {})
      .filter(([name]) => /^verify:noe|^audit:noe|^test/.test(name))
      .map(([name, command]) => ({ name, command: clean(command, 500) }));
    return {
      name: pkg.name || '',
      version: pkg.version || '',
      scriptCount: Object.keys(pkg.scripts || {}).length,
      noeVerificationScripts: scripts,
    };
  } catch {
    return { name: '', version: '', scriptCount: 0, noeVerificationScripts: [] };
  }
}

function runtimeHintFor(file = '', item = {}) {
  const hints = [];
  if (file === 'server.js') hints.push('live:51835:/health');
  if (item.routeHints?.length) hints.push('http_route');
  if (file.startsWith('scripts/noe-') || file.startsWith('scripts/')) hints.push('npm_script_or_manual_verifier');
  if (file.startsWith('src/server/routes')) hints.push('registered_route_candidate');
  if (file.startsWith('src/cognition/NoeExpectation')) hints.push('expectation_heartbeat');
  if (file.startsWith('src/loop/ActPipeline')) hints.push('act_pipeline');
  if (file.startsWith('src/runtime/mission')) hints.push('mission_runtime');
  if (file.startsWith('src/memory')) hints.push('memory_runtime_or_maintenance');
  return unique(hints);
}

export function buildCodebaseInventory({
  root = ROOT,
  scanRoots = DEFAULT_SCAN_ROOTS,
  generatedAt = new Date().toISOString(),
} = {}) {
  const absRoots = scanRoots.map((entry) => resolve(root, entry));
  const files = unique(absRoots.flatMap((entry) => walkCodeFiles(entry)).map((file) => rel(file, root))).sort();
  const fileSet = new Set(files);
  const testFiles = files.filter((file) => file.startsWith('tests/'));
  const testIndex = buildTestIndex(files, { root });
  const modules = new Map();
  const importedBy = new Map();
  const items = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(join(root, file), 'utf8'); } catch { text = ''; }
    const item = {
      file,
      module: moduleNameFor(file),
      role: roleFor(file),
      ext: extname(file),
      lines: lineCount(text),
      symbols: extractSymbols(text),
      envVars: extractEnvVars(text),
      routeHints: extractRouteHints(text),
      localImports: extractImports(text),
      tests: [],
      runtimeHints: [],
      sourceImporters: [],
      testImporters: [],
    };
    for (const spec of item.localImports) {
      const target = resolveLocalImport(file, spec, fileSet);
      if (!target) continue;
      const list = importedBy.get(target) || [];
      list.push(file);
      importedBy.set(target, list);
    }
    item.tests = testCoverageFor(file, testFiles, testIndex);
    item.runtimeHints = runtimeHintFor(file, item);
    items.push(item);
    const mod = modules.get(item.module) || {
      module: item.module,
      files: 0,
      lines: 0,
      tests: 0,
      routes: 0,
      envVars: new Set(),
      runtimeHintedFiles: 0,
    };
    mod.files += 1;
    mod.lines += item.lines;
    if (file.startsWith('tests/')) mod.tests += 1;
    if (item.routeHints.length) mod.routes += 1;
    if (item.runtimeHints.length) mod.runtimeHintedFiles += 1;
    for (const env of item.envVars) mod.envVars.add(env);
    modules.set(item.module, mod);
  }
  for (const item of items) {
    const importers = unique(importedBy.get(item.file) || []).sort();
    item.sourceImporters = importers.filter((file) => !file.startsWith('tests/')).slice(0, 80);
    item.testImporters = importers.filter((file) => file.startsWith('tests/')).slice(0, 80);
    item.tests = unique([...item.tests, ...item.testImporters]).slice(0, MAX_TESTS);
  }
  const moduleSummaries = [...modules.values()]
    .map((mod) => ({
      ...mod,
      envVars: [...mod.envVars].sort().slice(0, 80),
    }))
    .sort((a, b) => b.lines - a.lines || a.module.localeCompare(b.module));
  const untestedSourceFiles = items
    .filter((item) => item.file.startsWith('src/') && !item.tests.length)
    .map((item) => item.file);
  const unreferencedSourceFiles = items
    .filter((item) => item.file.startsWith('src/') && !item.sourceImporters.length && !item.testImporters.length)
    .map((item) => item.file);
  return {
    ok: true,
    generatedAt,
    root,
    policy: {
      readOnly: true,
      noDbReads: true,
      noModelCalls: true,
      noOwnerToken: true,
      noEnvFileReads: true,
    },
    totals: {
      files: items.length,
      sourceFiles: items.filter((item) => item.file.startsWith('src/')).length,
      scriptFiles: items.filter((item) => item.file.startsWith('scripts/')).length,
      publicFiles: items.filter((item) => item.file.startsWith('public/')).length,
      testFiles: testFiles.length,
      lines: items.reduce((sum, item) => sum + item.lines, 0),
      sourceLines: items.filter((item) => item.file.startsWith('src/')).reduce((sum, item) => sum + item.lines, 0),
      routeFiles: items.filter((item) => item.routeHints.length).length,
      envVarFiles: items.filter((item) => item.envVars.length).length,
      runtimeHintedFiles: items.filter((item) => item.runtimeHints.length).length,
      untestedSourceFiles: untestedSourceFiles.length,
      unreferencedSourceFiles: unreferencedSourceFiles.length,
    },
    package: summarizePackages({ root }),
    modules: moduleSummaries,
    untestedSourceFiles,
    unreferencedSourceFiles,
    files: items,
  };
}

export function renderInventoryMarkdown(report = {}) {
  const totals = report.totals || {};
  const lines = [
    '# Neo/Noe 代码与功能清单',
    '',
    `生成时间：${report.generatedAt || ''}`,
    `项目根：\`${report.root || ROOT}\``,
    '',
    '## 摘要',
    '',
    `- 文件：${totals.files || 0}；src：${totals.sourceFiles || 0}；scripts：${totals.scriptFiles || 0}；public：${totals.publicFiles || 0}；tests：${totals.testFiles || 0}`,
    `- 总行数：${totals.lines || 0}；src 行数：${totals.sourceLines || 0}`,
    `- route 线索文件：${totals.routeFiles || 0}；runtime 线索文件：${totals.runtimeHintedFiles || 0}；未直接映射测试的 src 文件：${totals.untestedSourceFiles || 0}；无本地 import 入边的 src 文件：${totals.unreferencedSourceFiles || 0}`,
    '',
    '## 模块汇总',
    '',
    '| 模块 | 文件 | 行数 | 测试文件 | route 文件 | runtime 线索 | env vars |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...((report.modules || []).map((mod) => `| \`${mod.module}\` | ${mod.files} | ${mod.lines} | ${mod.tests} | ${mod.routes} | ${mod.runtimeHintedFiles} | ${(mod.envVars || []).slice(0, 8).map((env) => `\`${env}\``).join(', ') || '-'} |`)),
    '',
    '## 高优先审计队列',
    '',
    ...((report.untestedSourceFiles || []).slice(0, 80).map((file) => `- \`${file}\``)),
    '',
    '## 无本地 Import 入边的 Src 文件',
    '',
    ...((report.unreferencedSourceFiles || []).slice(0, 80).map((file) => `- \`${file}\``)),
    '',
    '## 文件清单',
    '',
    '| 文件 | 模块 | 角色 | 行数 | 符号 | 测试 | 引用方 | 运行线索 |',
    '|---|---|---|---:|---|---|---|---|',
    ...((report.files || []).map((item) => `| \`${item.file}\` | \`${item.module}\` | ${item.role} | ${item.lines} | ${(item.symbols || []).slice(0, 4).map((s) => `\`${s}\``).join('<br>') || '-'} | ${(item.tests || []).slice(0, 3).map((t) => `\`${t}\``).join('<br>') || '-'} | ${(item.sourceImporters || []).slice(0, 3).map((t) => `\`${t}\``).join('<br>') || '-'} | ${(item.runtimeHints || []).map((h) => `\`${h}\``).join('<br>') || '-'} |`)),
    '',
  ];
  return lines.join('\n');
}

export function writeCodebaseInventory(report, { outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'latest.json');
  const mdPath = join(outDir, 'latest.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderInventoryMarkdown(report));
  return { jsonPath, mdPath };
}

async function main() {
  const report = buildCodebaseInventory();
  const paths = writeCodebaseInventory(report);
  console.log(JSON.stringify({
    ok: true,
    totals: report.totals,
    modules: report.modules.slice(0, 12),
    jsonPath: rel(paths.jsonPath),
    mdPath: rel(paths.mdPath),
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
