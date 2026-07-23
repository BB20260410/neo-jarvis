#!/usr/bin/env node
// @ts-check

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { close, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { createMemorySemanticIndex } from '../src/memory/NoeMemorySemanticIndex.js';
import {
  runNoeMemoryRelevanceBenchmark,
  runNoeMemoryRelevanceBenchmarkSelfTest,
} from '../src/memory/NoeMemoryRelevanceBenchmark.js';

function flag(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function readCases(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.cases)) return parsed.cases;
  throw new Error('case file must be an array or contain cases[]');
}

const caseFile = valueAfter('--case-file', '');
const projectId = valueAfter('--project-id', 'noe');
const semanticProvider = valueAfter('--semantic-provider', process.env.NOE_MEMORY_EMBED || process.env.NOE_MEMORY_EMBED_PROVIDER || 'ollama');
const semanticModel = valueAfter('--semantic-model', process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b');
const semanticBaseUrl = valueAfter('--semantic-base-url', process.env.NOE_MEMORY_EMBED_BASEURL || 'http://127.0.0.1:11434');
const noWriteAuditLog = { recordRetrieval() {} };

let report;
try {
  if (!caseFile || flag('--isolated')) {
    report = await runNoeMemoryRelevanceBenchmarkSelfTest();
  } else {
    initSqlite();
    const baselineMemory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    const semanticMemory = new MemoryCore({
      semanticIndex: createMemorySemanticIndex({
        provider: semanticProvider,
        model: semanticModel,
        baseUrl: semanticBaseUrl,
      }),
      logger: { warn: () => {}, info: () => {} },
    });
    report = await runNoeMemoryRelevanceBenchmark({
      baselineRetriever: new NoeMemoryRetriever({
        memory: baselineMemory,
        auditLog: noWriteAuditLog,
        logger: { warn: () => {} },
      }),
      semanticRetriever: new NoeMemoryRetriever({
        memory: semanticMemory,
        auditLog: noWriteAuditLog,
        logger: { warn: () => {} },
      }),
      projectId,
      cases: readCases(caseFile),
      semantic: {
        provider: semanticProvider,
        model: semanticModel,
        baseUrl: semanticBaseUrl,
      },
    });
  }
} finally {
  close();
}

// mode 与 caseFile 单点计算,避免两处条件漂移;self-test(isolated_fixture)未读 case 文件,
// caseFile 字段必须为 null,不能记录命令行传入但未使用的路径(否则产生虚假溯源证据)。
const usedRealMode = Boolean(caseFile) && !flag('--isolated');
const mode = usedRealMode ? 'real_db_read_only' : 'isolated_fixture';

const outDir = join(process.cwd(), 'output', 'noe-memory-relevance-benchmark');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `noe-memory-relevance-benchmark-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify({
  ...report,
  generatedAt: new Date().toISOString(),
  mode,
  caseFile: usedRealMode ? caseFile : null,
}, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify({
  ok: report.ok,
  mode,
  reportPath: file,
  summary: report.summary,
}, null, 2));

if (flag('--require-pass') && !report.ok) process.exit(1);
