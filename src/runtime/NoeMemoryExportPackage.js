// @ts-check
/**
 * One-shot memory export package (JSON + Markdown) for product Home.
 * Strips API keys / owner tokens / .env-like material from exported bodies.
 */

export const MEMORY_EXPORT_SCHEMA = 'neo.memory.export.v1';

const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|PANEL_OWNER_TOKEN\s*=\s*\S+|NOE_.*_KEY\s*=\s*\S+)\b/gi;
const SECRET_LINE_RE = /^\s*(API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|XAI_API_KEY|PANEL_OWNER_TOKEN|OWNER_TOKEN)\s*=.*$/gim;

/**
 * @param {unknown} text
 */
export function scrubSecretsFromText(text) {
  let s = String(text ?? '');
  s = s.replace(SECRET_LINE_RE, '[REDACTED_ENV_LINE]');
  s = s.replace(SECRET_VALUE_RE, '[REDACTED]');
  return s;
}

/**
 * @param {object} item
 */
export function compactExportEntry(item = {}) {
  return {
    id: String(item.id || ''),
    title: scrubSecretsFromText(item.title || '').slice(0, 200),
    body: scrubSecretsFromText(item.body || item.content || '').slice(0, 4000),
    scope: String(item.scope || ''),
    tags: Array.isArray(item.tags) ? item.tags.map((t) => scrubSecretsFromText(t).slice(0, 40)).slice(0, 20) : [],
    updatedAt: item.updatedAt || item.createdAt || null,
    sourceType: String(item.sourceType || ''),
  };
}

/**
 * Build export package from memory items.
 * @param {object[]} items
 * @param {{ format?: 'json'|'markdown'|'both', exportedAt?: string }} [opts]
 */
export function buildMemoryExportPackage(items = [], opts = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((m) => m && m.hidden !== true)
    .map(compactExportEntry)
    .filter((m) => m.id || m.title || m.body);

  const exportedAt = opts.exportedAt || new Date().toISOString();
  const payload = {
    schema: MEMORY_EXPORT_SCHEMA,
    exportedAt,
    count: list.length,
    items: list,
  };

  const jsonText = JSON.stringify(payload, null, 2);
  const mdLines = [
    `# Neo 记忆导出`,
    ``,
    `- 导出时间：${exportedAt}`,
    `- 条目数：${list.length}`,
    ``,
  ];
  for (const it of list) {
    mdLines.push(`## ${it.title || it.id || '(无标题)'}`);
    if (it.id) mdLines.push(`- id: \`${it.id}\``);
    if (it.scope) mdLines.push(`- scope: ${it.scope}`);
    if (it.tags?.length) mdLines.push(`- tags: ${it.tags.join(', ')}`);
    mdLines.push(``);
    mdLines.push(it.body || '_(空)_');
    mdLines.push(``);
  }
  const markdownText = mdLines.join('\n');

  const format = opts.format || 'both';
  return {
    schema: MEMORY_EXPORT_SCHEMA,
    exportedAt,
    count: list.length,
    items: list,
    json: format === 'markdown' ? null : jsonText,
    markdown: format === 'json' ? null : markdownText,
  };
}

/**
 * Secret-scan helper for tests / gates.
 * @param {string} text
 */
export function memoryExportPassesSecretScan(text) {
  const s = String(text || '');
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(s)) return false;
  if (/\bxai-[A-Za-z0-9_-]{16,}\b/.test(s)) return false;
  if (/PANEL_OWNER_TOKEN\s*=\s*\S+/i.test(s)) return false;
  if (/API_KEY\s*=\s*\S+/i.test(s) && !/REDACTED/.test(s)) return false;
  return true;
}
