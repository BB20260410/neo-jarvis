const MAX_CONTEXT_FILES = 40;
const MAX_PATH = 260;
const MAX_TEXT = 2000;

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function compactPath(value) {
  let text = safeString(value, MAX_PATH);
  if (!text) return '';
  text = text.replace(/^[ MADRCU?!]{1,3}\s+/, '').trim();
  if (text.includes(' -> ')) text = text.split(' -> ').pop().trim();
  return text.replace(/\\/g, '/');
}

function textLines(value) {
  return safeString(value, 32_000)
    .split(/[\n,]+/)
    .map((line) => compactPath(line))
    .filter(Boolean);
}

function pickField(input, keys) {
  for (const key of keys) {
    const value = input[key];
    if (value) return value;
  }
  return undefined;
}

function normalizeFileEntry(input) {
  if (typeof input !== 'object' || !input) return null;
  const path = compactPath(pickField(input, ['path', 'file', 'name', 'relativePath']));
  if (!path) return null;
  return {
    path,
    name: safeString(pickField(input, ['name']) || path.split('/').pop(), 120),
    content: safeString(pickField(input, ['content', 'snippet', 'diff']) || '', MAX_TEXT),
  };
}

function pushStrings(out, value) {
  if (typeof value !== 'string') return;
  for (const path of textLines(value)) out.push({ path });
}

function pushArray(out, value) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === 'string') pushStrings(out, item);
    else out.push(item);
  }
}

function pushValue(out, value) {
  if (!value) return;
  if (typeof value === 'string') pushStrings(out, value);
  else if (Array.isArray(value)) pushArray(out, value);
  else if (typeof value === 'object') out.push(value);
}

function collectFromFields(out, input) {
  pushValue(out, input.affectedFiles);
  pushValue(out, input.files);
  pushValue(out, input.projectFiles);
  pushValue(out, input.changedFiles);
  pushValue(out, input.projectContext?.files);
  pushValue(out, input.bundle?.files);
}

function dedupeEntries(out) {
  const seen = new Set();
  const normalized = [];
  for (const item of out) {
    const entry = normalizeFileEntry(item);
    if (!entry) continue;
    const key = entry.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
    if (normalized.length >= MAX_CONTEXT_FILES) break;
  }
  return normalized;
}

function collectFileInputs(input = {}) {
  const out = [];
  if (typeof input === 'string' || Array.isArray(input)) {
    pushValue(out, input);
  } else if (input && typeof input === 'object') {
    collectFromFields(out, input);
  }
  return dedupeEntries(out);
}

function addSignal(signals, tag, reason, score) {
  if (!tag || !reason) return;
  const existing = signals.find((item) => item.tag === tag && item.reason === reason);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    return;
  }
  signals.push({ tag, reason, score });
}

const FILE_SIGNAL_RULES = [
  { pattern: /\.(js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|go|rs|swift|kt|java|rb|php|cs)$/, on: 'path', tag: 'implementation', reason: 'source file', score: 2 },
  { pattern: /(^|\/)(test|tests|__tests__|e2e|spec)(\/|$)|(\.|-)(test|spec)\.(js|mjs|ts|tsx|jsx)$|playwright|vitest/, on: 'text', tag: 'verification', reason: 'test surface', score: 5 },
  { pattern: /^public\/|\/public\/|\.css$|\.scss$|\.html$|index\.html$|component|modal|layout|ui|style/, on: 'path', tag: 'design', reason: 'frontend surface', score: 4 },
  { pattern: /^public\/|\/public\/|\.css$|\.scss$|\.html$|index\.html$|component|modal|layout|ui|style/, on: 'path', tag: 'implementation', reason: 'frontend code', score: 1 },
  { pattern: /src\/server\/routes\/|server\.js$|\/api\/|route|controller|middleware/, on: 'path', tag: 'implementation', reason: 'api route', score: 3 },
  { pattern: /src\/server\/routes\/|server\.js$|\/api\/|route|controller|middleware/, on: 'path', tag: 'architecture', reason: 'server boundary', score: 2 },
  { pattern: /src\/agents\/|agent|skillregistry|dispatcher|roomadapter|src\/room\/|skillinjector/, on: 'path', tag: 'architecture', reason: 'agent runtime boundary', score: 4 },
  { pattern: /src\/agents\/|agent|skillregistry|dispatcher|roomadapter|src\/room\/|skillinjector/, on: 'path', tag: 'implementation', reason: 'agent runtime code', score: 2 },
  { pattern: /budget|approval|audit|governance|delegation|autopilot|policy|permission|guard/, on: 'text', tag: 'governance', reason: 'governance surface', score: 5 },
  { pattern: /storage|sqlite|database|migration|schema|db\./, on: 'path', tag: 'architecture', reason: 'storage contract', score: 3 },
  { pattern: /storage|sqlite|database|migration|schema|db\./, on: 'path', tag: 'governance', reason: 'persistent state', score: 2 },
  { pattern: /package\.json$|package-lock\.json$|pnpm-lock|yarn\.lock|dockerfile|render\.yaml|vercel\.json|netlify\.toml|\.github\/workflows\/|release|deploy|ship/, on: 'path', tag: 'release', reason: 'delivery config', score: 4 },
  { patterns: [/\.(md|mdx|txt)$/, /readme|handoff|交接|docs?\//], on: 'path', tag: 'planning', reason: 'project context document', score: 3 },
  { pattern: /refactor|interface|contract|dependency|import|symbol|索引|架构|迁移/, on: 'text', tag: 'architecture', reason: 'architecture language', score: 2 },
  { pattern: /test|verify|qa|browser|screenshot|回归|验证|测试/, on: 'text', tag: 'verification', reason: 'verification language', score: 2 },
  { pattern: /ui|ux|css|layout|modal|interaction|界面|交互|布局/, on: 'text', tag: 'design', reason: 'ui language', score: 2 },
];

function compareFileSignals(a, b) {
  return b.score - a.score || a.tag.localeCompare(b.tag);
}

function inferFileSignals(file) {
  const lower = safeString(file.path, MAX_PATH).toLowerCase();
  const text = `${lower}\n${safeString(file.content, MAX_TEXT).toLowerCase()}`;
  const sources = { path: lower, text };
  const signals = [];

  for (const rule of FILE_SIGNAL_RULES) {
    const patterns = rule.patterns || [rule.pattern];
    if (patterns.some((p) => p.test(sources[rule.on]))) {
      addSignal(signals, rule.tag, rule.reason, rule.score);
    }
  }

  signals.sort(compareFileSignals);
  return signals;
}

/**
 * Infers structured context signals from a collection of file inputs.
 *
 * This function normalizes various input formats (strings, arrays, objects)
 * into a standardized list of file entries, then analyzes each file's path
 * and content to extract semantic signals (e.g., 'verification', 'architecture',
 * 'governance'). It aggregates these signals by tag, calculating a cumulative
 * score and collecting unique reasons and file paths.
 *
 * @param {Object} [input={}] - The input object containing file data.
 * @param {string|string[]|Object} [input.affectedFiles] - Affected files as a string (newline-separated paths),
 *   an array of strings, or an object with file details.
 * @param {string|string[]|Object} [input.files] - General files input.
 * @param {string|string[]|Object} [input.projectFiles] - Project-wide files.
 * @param {string|string[]|Object} [input.changedFiles] - Changed files.
 * @param {Object} [input.projectContext] - Project context object, potentially containing a `files` property.
 * @param {Object} [input.bundle] - Bundle object, potentially containing a `files` property.
 * @returns {Object} An object containing:
 *   - `files`: An array of file objects, each with `path`, `name`, and `signals` (array of {tag, reason, score}).
 *   - `byTag`: A Map where keys are signal tags and values are objects with `tag`, `score`, `reasons` (Set), and `paths` (Set).
 */
export function inferCodeContextSignals(input = {}) {
  const entries = collectFileInputs(input);
  const files = entries.map((entry) => ({
    path: entry.path,
    name: entry.name || entry.path.split('/').pop(),
    signals: inferFileSignals(entry),
  })).filter((entry) => entry.signals.length > 0);

  const byTag = new Map();
  for (const file of files) {
    for (const signal of file.signals) {
      if (!byTag.has(signal.tag)) {
        byTag.set(signal.tag, {
          tag: signal.tag,
          score: 0,
          reasons: new Set(),
          paths: new Set(),
        });
      }
      const tag = byTag.get(signal.tag);
      tag.score += signal.score;
      tag.reasons.add(signal.reason);
      tag.paths.add(file.path);
    }
  }

  const tags = [...byTag.values()]
    .map((tag) => ({
      tag: tag.tag,
      score: tag.score,
      reasons: [...tag.reasons].slice(0, 8),
      paths: [...tag.paths].slice(0, 10),
    }))
    .sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));

  return {
    fileCount: entries.length,
    signalFileCount: files.length,
    files,
    tags,
  };
}
