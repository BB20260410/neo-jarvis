import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestWiki, lintWiki } from '../src/knowledge/LLMWiki.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const root = arg('--root', 'knowledge/llm-wiki');

if (hasFlag('--check')) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'noe-wiki-ingest-check-'));
  const sourceRoot = resolve(root);
  const tmpRepo = join(tmpRoot, 'repo');
  const checkRoot = join(tmpRepo, 'knowledge', 'llm-wiki');
  try {
    await cp(sourceRoot, checkRoot, { recursive: true });
    await cp(join(REPO_ROOT, 'docs'), join(tmpRepo, 'docs'), { recursive: true });
    const ingest = await ingestWiki({ root: checkRoot });
    const lint = await lintWiki({ root: checkRoot });
    console.log(JSON.stringify({
      ok: ingest.ok === true && lint.ok === true,
      check: true,
      sourceRoot,
      ingest: { ok: ingest.ok, rawCount: ingest.rawCount, pageCount: ingest.pageCount },
      lint: { ok: lint.ok, checked: lint.checked, rawChecked: lint.rawChecked, issues: lint.issues },
    }, null, 2));
    if (lint.ok !== true) process.exitCode = 1;
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
} else {
  const result = await ingestWiki({ root });
  console.log(JSON.stringify(result, null, 2));
}
