#!/usr/bin/env node
// @ts-check
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  DEFAULT_NOE_WORK_MAP_DATA_DIR,
  DEFAULT_NOE_WORK_MAP_ROOT,
  buildNoeWorkMapSnapshot,
  writeNoeWorkMapSnapshot,
} from '../src/runtime/NoeWorkMapSnapshot.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    rootDir: DEFAULT_NOE_WORK_MAP_ROOT,
    dataDir: DEFAULT_NOE_WORK_MAP_DATA_DIR,
    dbPath: '',
    outDir: 'output/noe-work-map',
    itemLimit: 80,
    write: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--root') { opts.rootDir = resolve(String(next || '')); i += 1; }
    else if (arg === '--data-dir') { opts.dataDir = resolve(String(next || '')); i += 1; }
    else if (arg === '--db') { opts.dbPath = resolve(String(next || '')); i += 1; }
    else if (arg === '--out-dir') { opts.outDir = String(next || opts.outDir); i += 1; }
    else if (arg === '--limit') { opts.itemLimit = Math.max(1, Math.min(200, Number(next) || opts.itemLimit)); i += 1; }
    else if (arg === '--no-write') opts.write = false;
  }
  if (!opts.dbPath) opts.dbPath = join(opts.dataDir, 'panel.db');
  return opts;
}

function sqliteReader(dbPath) {
  if (!existsSync(dbPath)) return null;
  return {
    all(sql) {
      const result = spawnSync('sqlite3', ['-readonly', '-json', dbPath, sql], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'sqlite3 failed').trim());
      const text = String(result.stdout || '').trim();
      return text ? JSON.parse(text) : [];
    },
  };
}

const options = parseArgs();
const dbReader = sqliteReader(options.dbPath);
const snapshot = buildNoeWorkMapSnapshot({
  rootDir: options.rootDir,
  dataDir: options.dataDir,
  dbReader,
  dbError: dbReader ? '' : `db_missing:${options.dbPath}`,
  itemLimit: options.itemLimit,
});
const written = options.write ? writeNoeWorkMapSnapshot(snapshot, { rootDir: options.rootDir, outDir: options.outDir }) : null;
console.log(JSON.stringify({ ...snapshot, written }, null, 2));
