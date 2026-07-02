#!/usr/bin/env node
// @ts-check

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { runNoeMemoryRetrievalSample } from '../src/memory/NoeMemoryRetrievalSample.js';
import { createMemorySemanticIndex } from '../src/memory/NoeMemorySemanticIndex.js';

function flag(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

const writeLogs = flag('--write-logs');
const isolated = flag('--isolated') || !writeLogs;
const semanticEnabled = flag('--semantic') || Boolean(process.env.NOE_MEMORY_EMBED);
const semanticProvider = valueAfter('--semantic-provider', process.env.NOE_MEMORY_EMBED || 'ollama');
const semanticModel = valueAfter('--semantic-model', process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b');
const semanticBaseUrl = valueAfter('--semantic-base-url', process.env.NOE_MEMORY_EMBED_BASEURL || 'http://127.0.0.1:11434');
if (writeLogs && !flag('--ack-retrieval-log-write')) {
  console.error(JSON.stringify({
    ok: false,
    error: 'ack_retrieval_log_write_required',
    message: '真实库 retrieval sample 会写入 noe_memory_retrieval_log；请同时传 --write-logs --ack-retrieval-log-write。',
  }, null, 2));
  process.exit(2);
}

const tmp = isolated ? mkdtempSync(join(tmpdir(), 'noe-memory-retrieval-sample-')) : null;
let report;
try {
  initSqlite(isolated ? join(tmp, 'panel.db') : undefined);
  const semanticIndex = semanticEnabled
    ? createMemorySemanticIndex({ provider: semanticProvider, model: semanticModel, baseUrl: semanticBaseUrl })
    : null;
  const memory = new MemoryCore({ semanticIndex, logger: { warn: () => {}, info: () => {} } });
  if (isolated) {
    memory.write({ id: 'sample-memory', projectId: 'noe', scope: 'fact', body: '长期记忆 retrieval sample fixture', sourceType: 'unit' });
  }
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb() });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });
  report = await runNoeMemoryRetrievalSample({ retriever, projectId: 'noe' });
} finally {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

const outDir = join(process.cwd(), 'output', 'noe-memory-retrieval-sample');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-retrieval-sample-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify({
  ...report,
  generatedAt: new Date().toISOString(),
  mode: isolated ? 'isolated' : 'real_db_write_logs',
  semantic: semanticEnabled ? { provider: semanticProvider, model: semanticModel } : null,
}, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  mode: isolated ? 'isolated' : 'real_db_write_logs',
  semantic: semanticEnabled ? { provider: semanticProvider, model: semanticModel } : null,
  reportPath: file,
  sampled: report.sampled,
  selectedRows: report.selectedRows,
}, null, 2));
if (flag('--require-pass') && !report.ok) process.exit(1);
