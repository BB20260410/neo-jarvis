import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'out-noe',
  'output',
  '_archive',
  '.opencode',
  '.unity',
  '.godot',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.build',
  'target',
  'Pods',
  '.swiftpm',
  '.terraform',
  '.serverless',
  '.turbo',
  '.DS_Store',
]);

const DEFAULT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.swift', '.go', '.rs',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.kt', '.cs', '.rb', '.php',
  '.lua', '.dart', '.sh', '.bash', '.zsh',
]);
const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.org', '.tex', '.adoc']);
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.xml', '.plist', '.ini', '.cfg', '.conf']);
const HIGH_VALUE_NAMES = new Set([
  'handoff',
  'readme',
  '交接',
  '设计',
  '方案',
  '架构',
  '规范',
  '需求',
  '产品',
  'overview',
]);
const HIGH_VALUE_EXACT = new Set([
  'package.json',
  'cargo.toml',
  'pyproject.toml',
  'package.swift',
  'project.godot',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
]);
const LOW_VALUE_PATH_PARTS = [
  '_archive',
  '废弃',
  'backup',
  '副本',
  '_old',
  '_bak',
  'node_modules',
  '.git',
  'build',
  'dist',
  '.next',
  'DerivedData',
  '__pycache__',
];
const SENSITIVE_NAME_PATTERNS = [
  /(^|\.)env($|\.)/i,
  /^credentials?\.(json|ya?ml|xml)$/i,
  /(^|[._-])secrets?([._-]|$)/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.(pem|key|p12|pfx|ppk|keystore|jks)$/i,
  /^\.(netrc|npmrc|pgpass|htpasswd)$/i,
  /\.(asc|gpg)$/i,
];
const SENSITIVE_PATH_PATTERNS = [
  /\/\.ssh\//i,
  /\/\.aws\//i,
  /\/\.gnupg\//i,
  /\/\.config\/gcloud\//i,
  /\/\.docker\/config\.json/i,
  /\/keychains?\//i,
];

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function tokenizeQuery(value) {
  const raw = normalizeText(value, 512).trim().toLowerCase();
  if (!raw) return [];
  const latin = raw.match(/[a-z0-9_./:-]{2,}/g) || [];
  const cjk = raw.match(/[\u4e00-\u9fff]{1,}/g) || [];
  const cjkPairs = [];
  for (const part of cjk) {
    for (let i = 0; i < part.length - 1; i += 1) cjkPairs.push(part.slice(i, i + 2));
  }
  return [...new Set([...latin, ...cjk, ...cjkPairs].filter(Boolean))];
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isUnderRoot(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function entryPriority(entry) {
  const name = String(entry?.name || '');
  if (DEFAULT_IGNORES.has(name)) return 100;
  if (['src', 'scripts', 'tests', 'public', 'docs'].includes(name)) return 0;
  if (name.startsWith('.')) return 20;
  return entry?.isDirectory?.() ? 5 : 2;
}

export function isSensitiveFilePath(filePath, name = path.basename(String(filePath || ''))) {
  const normalized = String(filePath || '').split(path.sep).join('/');
  const lowerName = String(name || '').toLowerCase();
  if (SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(lowerName))) return true;
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyFileForNoe(filePath, { name = path.basename(String(filePath || '')), ext = path.extname(String(name || filePath)).toLowerCase() } = {}) {
  if (isSensitiveFilePath(filePath, name)) return { typeClass: 'sensitive', valueTier: 0, sensitive: true };
  const lowerName = String(name || '').toLowerCase();
  const lowerPath = String(filePath || '').toLowerCase().split(path.sep).join('/');
  const lowerExt = String(ext || '').toLowerCase();
  const nameNoExt = lowerName.replace(/\.[^.]*$/, '');
  let typeClass = 'other';
  if (CODE_EXTENSIONS.has(lowerExt)) typeClass = 'code';
  else if (DOC_EXTENSIONS.has(lowerExt)) typeClass = 'doc';
  else if (CONFIG_EXTENSIONS.has(lowerExt)) typeClass = 'config';

  if (LOW_VALUE_PATH_PARTS.some((part) => lowerPath.includes(`/${part.toLowerCase()}/`) || lowerPath.endsWith(`/${part.toLowerCase()}`))) {
    return { typeClass, valueTier: 1, sensitive: false };
  }
  if (HIGH_VALUE_EXACT.has(lowerName)) return { typeClass, valueTier: 3, sensitive: false };
  if ([...HIGH_VALUE_NAMES].some((keyword) => nameNoExt.includes(keyword))) {
    return { typeClass, valueTier: 3, sensitive: false };
  }
  return { typeClass, valueTier: typeClass === 'other' ? 1 : 2, sensitive: false };
}

export class FileIndex {
  constructor({
    allowedRoots = [process.cwd()],
    maxFiles = 1000,
    maxBytesPerFile = 96 * 1024,
    extensions = DEFAULT_EXTENSIONS,
    ignores = DEFAULT_IGNORES,
    clock = Date.now,
  } = {}) {
    this.allowedRoots = allowedRoots
      .filter(Boolean)
      .map((root) => {
        // 与 resolveRoot 的 realpathSync 对称归一化：否则白名单存 symlink 路径
        // （如 macOS /tmp → /private/tmp，或用户软链工作区）时，resolved root 经
        // realpath 后会被判定为「不在白名单内」而误拒所有索引。不存在的路径退回 resolve。
        const resolved = path.resolve(String(root));
        try {
          return fs.realpathSync(resolved);
        } catch {
          return resolved;
        }
      });
    this.maxFiles = maxFiles;
    this.maxBytesPerFile = maxBytesPerFile;
    this.extensions = new Set([...extensions].map((ext) => String(ext).toLowerCase()));
    this.ignores = new Set([...ignores].map(String));
    this.clock = clock;
    this.items = [];
    this.lastIndexedAt = null;
    this.lastRoot = null;
    this.errors = [];
  }

  resolveRoot(root = process.cwd(), { allowOutsideWorkspace = false } = {}) {
    const resolved = fs.realpathSync(path.resolve(String(root || process.cwd())));
    if (allowOutsideWorkspace) return resolved;
    if (!this.allowedRoots.length) return resolved;
    const allowed = this.allowedRoots.some((allowedRoot) => isUnderRoot(resolved, allowedRoot));
    if (!allowed) {
      throw new Error(`file index root outside allowed roots: ${resolved}`);
    }
    return resolved;
  }

  indexPath({
    root = process.cwd(),
    projectId = 'noe',
    maxFiles = this.maxFiles,
    maxBytesPerFile = this.maxBytesPerFile,
    allowOutsideWorkspace = false,
    extensions,
  } = {}) {
    const resolvedRoot = this.resolveRoot(root, { allowOutsideWorkspace });
    const capFiles = clampNumber(maxFiles, this.maxFiles, 1, 10000);
    const capBytes = clampNumber(maxBytesPerFile, this.maxBytesPerFile, 1024, 1024 * 1024);
    const allowedExts = extensions
      ? new Set(extensions.map((ext) => String(ext).toLowerCase()))
      : this.extensions;
    const items = [];
    const errors = [];

    const walk = (dir) => {
      if (items.length >= capFiles) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        errors.push({ path: dir, error: e?.message || String(e) });
        return;
      }
      entries.sort((a, b) => entryPriority(a) - entryPriority(b) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (items.length >= capFiles) return;
        if (this.ignores.has(entry.name)) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        try {
          const stat = fs.statSync(abs);
          if (stat.size > capBytes) continue;
          const classification = classifyFileForNoe(abs, { name: entry.name, ext });
          if (!classification.sensitive && !allowedExts.has(ext)) continue;
          const content = classification.sensitive ? '' : normalizeText(fs.readFileSync(abs, 'utf8'), capBytes);
          items.push({
            projectId: String(projectId || 'noe'),
            path: abs,
            relativePath: path.relative(resolvedRoot, abs),
            name: entry.name,
            ext,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hash: hashText(content),
            text: content,
            typeClass: classification.typeClass,
            valueTier: classification.valueTier,
            sensitive: classification.sensitive,
          });
        } catch (e) {
          errors.push({ path: abs, error: e?.message || String(e) });
        }
      }
    };

    walk(resolvedRoot);
    this.items = items;
    this.errors = errors;
    this.lastRoot = resolvedRoot;
    this.lastIndexedAt = this.clock();
    return this.stats();
  }

  stats() {
    return {
      root: this.lastRoot,
      indexedAt: this.lastIndexedAt,
      count: this.items.length,
      errors: this.errors.slice(0, 50),
      readOnly: true,
    };
  }

  search({ query = '', q, projectId, limit = 20 } = {}) {
    const raw = normalizeText(q ?? query, 512).trim().toLowerCase();
    const cap = clampNumber(limit, 20, 1, 100);
    if (!raw) {
      return this.items
        .filter((item) => !projectId || item.projectId === projectId)
        .slice(0, cap)
        .map((item) => this.#toSearchResult(item, 0));
    }
    const terms = raw.split(/\s+/).filter(Boolean);
    return this.items
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => {
        const haystack = `${item.relativePath}\n${item.text}`.toLowerCase();
        const matchScore = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        const score = matchScore > 0 ? matchScore + (Number(item.valueTier) || 0) / 10 : 0;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.relativePath.localeCompare(b.item.relativePath))
      .slice(0, cap)
      .map(({ item, score }) => this.#toSearchResult(item, score));
  }

  hybridSearch({ query = '', q, projectId, limit = 20 } = {}) {
    const raw = normalizeText(q ?? query, 512).trim().toLowerCase();
    const terms = tokenizeQuery(raw);
    const cap = clampNumber(limit, 20, 1, 100);
    if (!raw || !terms.length) return this.search({ q: raw, projectId, limit: cap });
    return this.items
      .filter((item) => !projectId || item.projectId === projectId)
      .map((item) => {
        const relativePath = String(item.relativePath || '').toLowerCase();
        const name = String(item.name || '').toLowerCase();
        const text = String(item.text || '').toLowerCase();
        let lexical = 0;
        let pathScore = 0;
        let nameScore = 0;
        for (const term of terms) {
          if (text.includes(term)) lexical += 1;
          if (relativePath.includes(term)) pathScore += 2;
          if (name.includes(term)) nameScore += 3;
        }
        if (text.includes(raw)) lexical += 2;
        const tierBoost = (Number(item.valueTier) || 0) * 0.25;
        const typeBoost = item.typeClass === 'doc' || item.typeClass === 'code' ? 0.25 : 0;
        const score = lexical + pathScore + nameScore + tierBoost + typeBoost;
        return { item, score, why: { lexical, pathScore, nameScore, tierBoost, typeBoost } };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.relativePath.localeCompare(b.item.relativePath))
      .slice(0, cap)
      .map(({ item, score, why }) => ({ ...this.#toSearchResult(item, score), why }));
  }

  #toSearchResult(item, score) {
    return {
      projectId: item.projectId,
      path: item.path,
      relativePath: item.relativePath,
      name: item.name,
      ext: item.ext,
      size: item.size,
      mtimeMs: item.mtimeMs,
      hash: item.hash,
      score,
      typeClass: item.typeClass || 'other',
      valueTier: Number(item.valueTier) || 0,
      sensitive: item.sensitive === true,
      preview: item.text.slice(0, 500),
    };
  }

  summarize({ projectId } = {}) {
    const scoped = this.items.filter((item) => !projectId || item.projectId === projectId);
    const byType = new Map();
    const byTier = new Map();
    let totalSize = 0;
    for (const item of scoped) {
      totalSize += Number(item.size) || 0;
      const type = item.typeClass || 'other';
      const tier = Number(item.valueTier) || 0;
      byType.set(type, (byType.get(type) || 0) + 1);
      byTier.set(tier, (byTier.get(tier) || 0) + 1);
    }
    return {
      root: this.lastRoot,
      indexedAt: this.lastIndexedAt,
      total: scoped.length,
      totalSize,
      byType: [...byType.entries()].map(([typeClass, count]) => ({ typeClass, count })).sort((a, b) => b.count - a.count),
      byTier: [...byTier.entries()].map(([valueTier, count]) => ({ valueTier, count })).sort((a, b) => a.valueTier - b.valueTier),
      sensitiveCount: scoped.filter((item) => item.sensitive).length,
      readOnly: true,
    };
  }

  organizePlan({ projectId, duplicateLimit = 20, largeFileLimit = 20 } = {}) {
    const scoped = this.items.filter((item) => !projectId || item.projectId === projectId);
    const dupMap = new Map();
    for (const item of scoped) {
      if (item.sensitive || item.size < 1024) continue;
      const key = `${item.name}:${item.size}`;
      const group = dupMap.get(key) || [];
      group.push(item);
      dupMap.set(key, group);
    }
    const duplicates = [...dupMap.values()]
      .filter((group) => group.length > 1 && new Set(group.map((item) => path.dirname(item.path))).size > 1)
      .map((group) => ({
        name: group[0].name,
        size: group[0].size,
        count: group.length,
        wastedBytes: (group.length - 1) * group[0].size,
        paths: group.map((item) => item.path),
        status: 'suggestion_only',
      }))
      .sort((a, b) => b.wastedBytes - a.wastedBytes)
      .slice(0, duplicateLimit);
    const largeFiles = scoped
      .filter((item) => !item.sensitive)
      .sort((a, b) => b.size - a.size)
      .slice(0, largeFileLimit)
      .map((item) => ({
        path: item.path,
        size: item.size,
        typeClass: item.typeClass || 'other',
        valueTier: Number(item.valueTier) || 0,
        status: 'suggestion_only',
      }));
    const lowValueFiles = scoped
      .filter((item) => !item.sensitive && Number(item.valueTier) <= 1)
      .slice(0, 50)
      .map((item) => ({ path: item.path, typeClass: item.typeClass || 'other', size: item.size }));
    return {
      schemaVersion: 1,
      dryRun: true,
      readOnly: true,
      generatedAt: new Date(this.clock()).toISOString(),
      summary: {
        files: scoped.length,
        duplicateGroups: duplicates.length,
        duplicateWastedBytes: duplicates.reduce((sum, group) => sum + group.wastedBytes, 0),
        largeFiles: largeFiles.length,
        lowValueFiles: lowValueFiles.length,
      },
      duplicates,
      largeFiles,
      lowValueFiles,
      note: 'suggestion_only; this plan never moves, deletes, or writes user files',
    };
  }
}

export const fileIndex = new FileIndex();
