import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const TEXT_EXT = new Set(['.md', '.markdown', '.txt']);
const SKIP_WIKI = new Set(['index.md', 'log.md']);
const REQUIRED_RAW_FIELDS = ['concept', 'title', 'decision', 'priority'];

function posixRel(p) {
  return p.split(path.sep).join('/');
}

function slugify(value) {
  return String(value || 'note')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note';
}

function parseFrontmatter(text) {
  const raw = String(text || '');
  if (!raw.startsWith('---\n')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    data[m[1]] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean)
      : value;
  }
  return { data, body };
}

function firstHeading(body) {
  return String(body || '').match(/^#\s+(.+)$/m)?.[1]?.trim() || '';
}

function section(body, name) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`.toLowerCase());
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function excerpt(text, max = 900) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^---[\s\S]*?---/m, '')
    .replace(/^#+\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function markdownLinks(text) {
  const out = [];
  for (const match of String(text || '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    out.push({ label: match[1], url: match[2] });
  }
  return out;
}

function normalizedRawBody(body) {
  return String(body || '')
    .replace(/^#+\s+.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyHash(body) {
  const normalized = normalizedRawBody(body);
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex');
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(p));
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase()) && entry.name !== '.gitkeep') out.push(p);
  }
  return out.sort();
}

async function parseRawNote(filePath, root) {
  const text = await fs.readFile(filePath, 'utf8');
  const { data, body } = parseFrontmatter(text);
  const rel = posixRel(path.relative(root, filePath));
  const title = data.title || firstHeading(body) || path.basename(filePath, path.extname(filePath));
  const concept = slugify(data.concept || title);
  const sourceBlock = section(body, 'Sources');
  const links = markdownLinks(sourceBlock);
  if (data.source_url) links.unshift({ label: data.source_label || data.source_url, url: data.source_url });
  return {
    filePath,
    rel,
    concept,
    title,
    tags: Array.isArray(data.tags) ? data.tags : [],
    decision: data.decision || 'review',
    priority: data.priority || '',
    summary: section(body, 'Summary') || excerpt(body),
    why: section(body, 'Why It Helps Noe'),
    replication: section(body, 'Replication'),
    risks: section(body, 'Risks'),
    sources: links,
    openQuestions: section(body, 'Open Questions') || 'None.',
  };
}

function renderPage(concept, notes, date) {
  const main = notes[0];
  const allTags = [...new Set(notes.flatMap((n) => n.tags))];
  const sources = [];
  for (const note of notes) {
    sources.push(`- [raw:${note.rel}](../${note.rel})`);
    for (const src of note.sources) sources.push(`- [${src.label}](${src.url})`);
  }
  return [
    '---',
    `title: ${main.title}`,
    `concept: ${concept}`,
    `updated: ${date}`,
    `decision: ${main.decision}`,
    `priority: ${main.priority}`,
    `tags: [${['noe-llm-wiki', ...allTags].join(', ')}]`,
    '---',
    '',
    `# ${main.title}`,
    '',
    '## Summary',
    notes.map((n) => n.summary).filter(Boolean).join('\n\n'),
    '',
    '## Why It Helps Noe',
    notes.map((n) => n.why).filter(Boolean).join('\n\n') || '- No direct value recorded yet.',
    '',
    '## Replication',
    notes.map((n) => n.replication).filter(Boolean).join('\n\n') || '- Keep as research only until a low-burden path is proven.',
    '',
    '## Risks',
    notes.map((n) => n.risks).filter(Boolean).join('\n\n') || '- No material risk recorded.',
    '',
    '## Sources',
    [...new Set(sources)].join('\n'),
    '',
    '## Open Questions',
    notes.map((n) => n.openQuestions).filter(Boolean).join('\n\n'),
    '',
  ].join('\n');
}

function renderIndex(pages, date) {
  const rows = pages.map((p) => `- [${p.title}](./${p.file}) — ${p.decision}${p.priority ? `, ${p.priority}` : ''}`);
  return [
    '# Noe LLM Wiki Index',
    '',
    `Updated: ${date}`,
    '',
    '## Pages',
    rows.join('\n') || 'No concept pages have been ingested yet.',
    '',
    '## Operating Rule',
    '',
    'Put durable sources in `raw/`, run `npm run wiki:ingest`, then run `npm run wiki:lint`. Do not manually maintain page lists unless lint says a generated link is wrong.',
    '',
    '## Intake Queue',
    '',
    '- Add source notes, transcripts, research summaries, or durable decisions to `raw/`.',
    '- Keep Obsidian optional until a real vault and Local REST API key exist.',
    '',
  ].join('\n');
}

export async function ingestWiki({ root = path.resolve('knowledge/llm-wiki'), date = new Date().toISOString().slice(0, 10) } = {}) {
  const rawDir = path.join(root, 'raw');
  const wikiDir = path.join(root, 'wiki');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(wikiDir, { recursive: true });
  const notes = await Promise.all((await listFiles(rawDir)).map((file) => parseRawNote(file, root)));
  const groups = new Map();
  for (const note of notes) {
    if (!groups.has(note.concept)) groups.set(note.concept, []);
    groups.get(note.concept).push(note);
  }
  const pages = [];
  for (const [concept, group] of groups) {
    const file = `${concept}.md`;
    await fs.writeFile(path.join(wikiDir, file), renderPage(concept, group, date));
    pages.push({ file, title: group[0].title, decision: group[0].decision, priority: group[0].priority });
  }
  pages.sort((a, b) => a.file.localeCompare(b.file));
  await fs.writeFile(path.join(wikiDir, 'index.md'), renderIndex(pages, date));
  await fs.appendFile(path.join(wikiDir, 'log.md'), `\n- ${date}: ingested ${notes.length} raw notes into ${pages.length} wiki pages.\n`);
  return { ok: true, root, rawCount: notes.length, pageCount: pages.length, pages };
}

export async function lintWiki({ root = path.resolve('knowledge/llm-wiki') } = {}) {
  const rawDir = path.join(root, 'raw');
  const wikiDir = path.join(root, 'wiki');
  const index = await fs.readFile(path.join(wikiDir, 'index.md'), 'utf8').catch(() => '');
  const files = (await listFiles(wikiDir)).filter((file) => !SKIP_WIKI.has(path.basename(file)));
  const rawFiles = await listFiles(rawDir);
  const issues = [];
  const rawBodyHashes = new Map();
  for (const file of rawFiles) {
    const rel = posixRel(path.relative(root, file));
    const text = await fs.readFile(file, 'utf8');
    const { data, body } = parseFrontmatter(text);
    for (const field of REQUIRED_RAW_FIELDS) {
      const value = data[field];
      if (value === undefined || value === null || String(value).trim() === '') {
        issues.push({ file: rel, type: 'raw_missing_frontmatter', message: `raw note missing required field ${field}` });
      }
    }
    const hash = bodyHash(body);
    if (hash) {
      const prior = rawBodyHashes.get(hash);
      if (prior) issues.push({ file: rel, type: 'duplicate_raw_body', message: `raw note body duplicates ${prior}` });
      else rawBodyHashes.set(hash, rel);
    }
  }
  for (const file of files) {
    const rel = posixRel(path.relative(wikiDir, file));
    const text = await fs.readFile(file, 'utf8');
    if (!index.includes(`./${rel}`) && !index.includes(rel)) issues.push({ file: rel, type: 'orphan', message: 'wiki page is not linked from index.md' });
    if (!/## Sources\s+[\s\S]*\]\(/.test(text)) issues.push({ file: rel, type: 'missing_sources', message: 'page has no markdown source links' });
    for (const link of markdownLinks(text)) {
      if (/^(https?:|mailto:|obsidian:|#)/i.test(link.url)) continue;
      const target = path.resolve(path.dirname(file), link.url.split('#')[0]);
      try { await fs.stat(target); } catch { issues.push({ file: rel, type: 'broken_link', message: `missing local target ${link.url}` }); }
    }
  }
  return { ok: issues.length === 0, root, checked: files.length, rawChecked: rawFiles.length, issues };
}

function terms(query) {
  const q = String(query || '').toLowerCase().trim();
  return [...new Set([q, ...(q.match(/[a-z0-9\u4e00-\u9fff]+/g) || [])].filter((t) => t.length >= 2))];
}

function titleOf(text, file) {
  return firstHeading(text) || path.basename(file, path.extname(file));
}

function snippetFor(text, needles) {
  const clean = excerpt(text, 5000);
  const lower = clean.toLowerCase();
  let pos = -1;
  for (const t of needles) {
    pos = lower.indexOf(t);
    if (pos >= 0) break;
  }
  const start = Math.max(0, pos < 0 ? 0 : pos - 120);
  return clean.slice(start, start + 420).trim();
}

export async function searchWiki({ root = path.resolve('knowledge/llm-wiki'), query = '', topK = 5 } = {}) {
  const wikiDir = path.join(root, 'wiki');
  const needles = terms(query);
  if (!needles.length) return { ok: true, query: String(query || ''), hits: [] };
  const files = (await listFiles(wikiDir)).filter((file) => !SKIP_WIKI.has(path.basename(file)));
  const hits = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of needles) {
      const count = lower.split(t).length - 1;
      score += count * (path.basename(file).includes(slugify(t)) ? 3 : 1);
    }
    if (score > 0) {
      const rel = posixRel(path.relative(root, file));
      hits.push({ title: titleOf(text, file), file: rel, score, snippet: snippetFor(text, needles) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return { ok: true, query: String(query || ''), hits: hits.slice(0, Math.min(Number(topK) || 5, 20)) };
}

export const LLMWikiInternals = { parseFrontmatter, slugify, markdownLinks, normalizedRawBody };
