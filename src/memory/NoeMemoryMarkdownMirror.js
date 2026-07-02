// @ts-check
//
// NoeMemoryMarkdownMirror — Neo 长期记忆 / 知识图谱实体的「Markdown 镜像层」（单向导出）。
//
// 借鉴 Basic Memory（basicmachines-co/basic-memory，AGPL）的「NOTE-FORMAT」理念，
// 不抄其 Python 代码、不引其依赖：把 Neo 的高显著度记忆（MemoryCore facts）与
// 知识图谱实体/关系（NoeKnowledgeGraph entity/relation）导出成「frontmatter + Markdown 正文」，
// 让 owner 能直接用 Obsidian 人读人改 Neo 的「内心世界」，破除 SQLite 黑盒（契合 feedback_kb：
// owner 反复要的「可人读可编辑、避免黑盒」）。
//
// 设计取舍（诚实划界，避免和 Neo 已有能力重复）：
//   - Neo 已有 NoeKnowledgeGraph（entity/relation）、MemoryCore（FTS+语义+RRF）、
//     NoeMemoryContextFormatter（喂给模型的 <noe-memory-v2> XML 块）。本模块只补「给人看的 .md 文本」缺口。
//   - 借 Basic Memory 的两点格式约定：
//       · 观察（observation）行：`- [category] 事实内容 #tag1 #tag2`
//       · 关系（relation）行：`- rel_type [[目标实体]]`（[[wikilink]] 即 Obsidian/Basic Memory 互链语义）
//     —— Neo 此前没有任何 .md 落盘镜像（grep 全仓无 frontmatter/markdown 序列化）。
//   - **单向导出**：只产文本、不解析回灌（不做 file↔db 双向一致性），从根上消除一致性复杂度风险。
//   - **注入式 / 纯函数**：本模块绝不写盘、绝不触网、绝不读时钟做决策。写盘交调用方（如 obsidian-local-rest
//     MCP 或 fs.writeFile 到 ~/.noe-panel/memory-md/）；唯一外部依赖是「脱敏函数」，默认注入 Neo 现成的
//     redactSensitiveText，确保镜像文件里不会泄漏 secret 原值。
//   - **不引新依赖**：frontmatter 用本文件自写的极简 YAML 序列化（标量/扁平数组/嵌套对象），不引 gray-matter。
//
// env 门控理念：行为变化（是否真把记忆导出成磁盘镜像）由 NOE_MEMORY_MD_MIRROR 控制，默认 OFF。
//   本模块只提供纯判定 isMirrorEnabled(env) 供调用方在接线处门控「要不要调用 buildMirrorDocuments + 写盘」；
//   模块自身不读 process.env 做副作用，env 由调用方注入，便于测试与多环境隔离。

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认显著度阈值：只镜像 salience >= 此值的高显著度记忆（owner 关心的，不淹没在低价值碎片里）。 */
export const DEFAULT_SALIENCE_THRESHOLD = 4;

/** 环境变量名（理念门控，默认 OFF）。 */
export const NOE_MEMORY_MD_MIRROR_ENV = 'NOE_MEMORY_MD_MIRROR';

/**
 * 纯判定：镜像功能是否启用（默认 OFF）。
 * 借「新功能 env 门控、默认 OFF」的 Neo 工程纪律：只有显式 '1' / 'true' / 'on' 才算开。
 * @param {Record<string, any>} [env] 注入的环境（默认空对象 → OFF；生产调用方传 process.env）
 * @returns {boolean}
 */
export function isMirrorEnabled(env = {}) {
  const raw = String(env?.[NOE_MEMORY_MD_MIRROR_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** 折叠空白、裁剪、并默认做脱敏（防 secret 写进镜像文件）。 */
function clean(value, max, redact) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, Math.max(0, max));
  return typeof redact === 'function' ? redact(s) : s;
}

/**
 * 把 tag 规整成 Obsidian / Basic Memory 友好的 `#tag` 词元：
 * 去掉前导 #、把内部空白与非法字符换成连字符（# 标签不能含空格）。空 tag 丢弃。
 */
function normalizeTag(tag, redact) {
  const raw = clean(tag, 80, redact).replace(/^#+/, '');
  const slug = raw.replace(/[\s#[\]]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `#${slug}` : '';
}

/** YAML 标量是否需要加引号（避免被解析成日期/数字/布尔/null 或破坏结构）。纯 ASCII/CJK 普通词保持裸写更易读。 */
function yamlScalarNeedsQuote(s) {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true; // 首尾空白
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s)) return true; // YAML 特殊字符
  if (/^[-?]/.test(s)) return true; // 以 - 或 ? 开头会被当序列/复杂键
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true; // 布尔/null 字面量
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true; // 看起来像数字
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true; // 看起来像日期
  return false;
}

/** 序列化单个 YAML 标量（字符串/数字/布尔/null）。字符串按需加双引号并转义。 */
function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  if (!yamlScalarNeedsQuote(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * 极简 YAML 序列化（替代 gray-matter，仅覆盖本模块所需子集）：
 *   - 标量：string / number / boolean / null
 *   - 数组：用流式 `[a, b, c]`（扁平，元素只允许标量；嵌套数组降级为字符串）
 *   - 对象：嵌套一层缩进的块映射（值只允许标量或扁平数组）
 * 键按字母序稳定输出，保证确定性（同输入永远同字节）。
 * @param {Record<string, any>} obj
 * @returns {string} 不含 `---` 包裹的 YAML 主体（末尾无换行）
 */
function serializeYamlBlock(obj, indent = '') {
  const keys = Object.keys(obj || {})
    .filter((k) => obj[k] !== undefined)
    .sort();
  const lines = [];
  for (const key of keys) {
    const v = obj[key];
    const safeKey = yamlScalarNeedsQuote(key) ? `"${key.replace(/"/g, '\\"')}"` : key;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${indent}${safeKey}: []`);
      } else {
        const items = v.map((item) => (item && typeof item === 'object' ? yamlScalar(JSON.stringify(item)) : yamlScalar(item)));
        lines.push(`${indent}${safeKey}: [${items.join(', ')}]`);
      }
    } else if (v && typeof v === 'object') {
      lines.push(`${indent}${safeKey}:`);
      lines.push(serializeYamlBlock(v, `${indent}  `));
    } else {
      lines.push(`${indent}${safeKey}: ${yamlScalar(v)}`);
    }
  }
  return lines.join('\n');
}

/**
 * 渲染一条「观察 / 事实」行（借 Basic Memory observation 格式）：`- [category] 事实内容 #tag1 #tag2`。
 * category 缺省为 `fact`。事实内容必填（空则返回 ''，由调用方过滤）。
 * @param {{category?:string, text?:string, body?:string, tags?:string[]}} fact
 * @param {(s:string)=>string} [redact]
 * @returns {string}
 */
export function factToLine(fact = {}, redact = redactSensitiveText) {
  const text = clean(fact.text ?? fact.body, 4000, redact);
  if (!text) return '';
  const category = clean(fact.category, 60, redact) || 'fact';
  const tags = (Array.isArray(fact.tags) ? fact.tags : [])
    .map((t) => normalizeTag(t, redact))
    .filter(Boolean);
  const tagStr = tags.length ? ` ${tags.join(' ')}` : '';
  return `- [${category}] ${text}${tagStr}`;
}

/**
 * 渲染一条「关系」行（借 Basic Memory relation 格式）：`- rel_type [[目标实体]]`。
 * @param {{relType?:string, rel_type?:string, target?:string, dst?:string, dstName?:string}} relation
 * @param {(s:string)=>string} [redact]
 * @returns {string}
 */
export function relationToLine(relation = {}, redact = redactSensitiveText) {
  const target = clean(relation.target ?? relation.dst ?? relation.dstName, 300, redact);
  if (!target) return '';
  const relType = (clean(relation.relType ?? relation.rel_type, 80, redact) || 'related_to')
    .replace(/[\s]+/g, '_'); // rel_type 用下划线分词（Basic Memory 习惯：has_type / relates_to）
  return `- ${relType} [[${target}]]`;
}

/**
 * 纯函数核心：把一篇记忆文档（frontmatter + facts + relations）渲染成 Markdown 字符串。
 *
 * 输出结构（Basic Memory NOTE-FORMAT 风）：
 *   ---
 *   <frontmatter YAML>
 *   ---
 *   # <title 或 frontmatter.title 或 "记忆">
 *   ## Observations            （有 facts 时才出现）
 *   - [category] 事实 #tag
 *   ## Relations               （有 relations 时才出现）
 *   - rel_type [[实体]]
 *
 * @param {object} input
 * @param {Record<string, any>} [input.frontmatter] 任意可序列化键值（title/type/tags/created/...）
 * @param {Array} [input.facts] 观察/事实数组（见 factToLine 入参）
 * @param {Array} [input.relations] 关系数组（见 relationToLine 入参）
 * @param {string} [input.title] 正文 H1 标题（缺省取 frontmatter.title，再缺省 "记忆"）
 * @param {object} [opts]
 * @param {(s:string)=>string} [opts.redact] 脱敏函数（默认 Neo redactSensitiveText，防 secret 入镜像）
 * @returns {string} 完整 Markdown 文档（末尾带单个换行，POSIX 文本文件惯例）
 */
export function toMarkdown({ frontmatter = {}, facts = [], relations = [], title } = {}, opts = {}) {
  const redact = typeof opts.redact === 'function' ? opts.redact : redactSensitiveText;

  // frontmatter 同样过一遍脱敏：字符串标量与字符串数组元素都脱敏，防 secret 进 YAML 头。
  const safeFrontmatter = {};
  for (const [k, v] of Object.entries(frontmatter || {})) {
    if (v === undefined) continue;
    if (typeof v === 'string') safeFrontmatter[k] = redact(v);
    else if (Array.isArray(v)) safeFrontmatter[k] = v.map((x) => (typeof x === 'string' ? redact(x) : x));
    else safeFrontmatter[k] = v;
  }

  const h1 = clean(title ?? safeFrontmatter.title, 300, redact) || '记忆';

  const factLines = (Array.isArray(facts) ? facts : [])
    .map((f) => factToLine(f, redact))
    .filter(Boolean);
  const relationLines = (Array.isArray(relations) ? relations : [])
    .map((r) => relationToLine(r, redact))
    .filter(Boolean);

  const parts = ['---', serializeYamlBlock(safeFrontmatter), '---', '', `# ${h1}`];
  if (factLines.length) {
    parts.push('', '## Observations', ...factLines);
  }
  if (relationLines.length) {
    parts.push('', '## Relations', ...relationLines);
  }
  // 折叠 serializeYamlBlock 为空时产生的空行（`---\n\n---`），保持紧凑确定输出。
  return `${parts.join('\n').replace(/---\n\n---/, '---\n---')}\n`;
}

/** 文件名 slug：把实体/标题转成跨平台安全、稳定的文件名（不含扩展名）。 */
export function slugifyFilename(name, { max = 80 } = {}) {
  const s = String(name ?? '').trim();
  if (!s) return 'untitled';
  // 去掉路径分隔符与 Windows/Obsidian 非法字符；保留中英文与连字符，空白折叠为连字符。
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return cleaned || 'untitled';
}

/**
 * 适配器（纯函数）：把一个知识图谱实体（NoeKnowledgeGraph.oneHop 风格的结果）映射成 toMarkdown 入参。
 * 单向导出：只读，不改图谱。把实体 description 当一条 [概要] 观察，edges 映射成关系行。
 * @param {{entity?:object, edges?:Array}} hop oneHop 返回结构 { entity:{name,type,description,refs}, edges:[{rel_type,name,...}] }
 * @param {object} [opts]
 * @param {string} [opts.projectId]
 * @returns {{filename:string, doc:{frontmatter:object, facts:Array, relations:Array}}|null}
 */
export function knowledgeEntityToMirrorDoc(hop = {}, opts = {}) {
  const e = hop?.entity;
  if (!e || !e.name) return null;
  const refs = Array.isArray(e.refs) ? e.refs.filter(Boolean).slice(0, 10) : [];
  const facts = [];
  if (e.description) facts.push({ category: e.type || 'entity', text: e.description, tags: e.type ? [e.type] : [] });
  const relations = (Array.isArray(hop.edges) ? hop.edges : [])
    .filter((edge) => edge && (edge.name || edge.dstName || edge.dst))
    .map((edge) => ({ relType: edge.rel_type || edge.relType, target: edge.name || edge.dstName || edge.dst }));
  return {
    filename: `${slugifyFilename(e.name)}.md`,
    doc: {
      frontmatter: {
        title: e.name,
        type: e.type || 'entity',
        project: opts.projectId || 'noe',
        source: 'knowledge_graph',
        refs,
      },
      facts,
      relations,
    },
  };
}

/**
 * 适配器（纯函数）：把一批 MemoryCore 风格的「高显著度记忆」聚合成一篇镜像文档。
 * 借 Basic Memory「一个 note 聚合多条 observation」：按 scope 分组渲染成不同 category。
 * 只导出 salience >= threshold 的记忆（高显著度 owner 才关心），且 sensitive 记忆整条剔除。
 * @param {Array<{body?:string,scope?:string,salience?:number,confidence?:number,tags?:string[],sensitive?:boolean}>} memories
 * @param {object} [opts]
 * @param {number} [opts.salienceThreshold]
 * @param {string} [opts.title]
 * @param {string} [opts.projectId]
 * @returns {{frontmatter:object, facts:Array, relations:Array}}
 */
export function memoriesToMirrorDoc(memories = [], opts = {}) {
  const threshold = Number.isFinite(opts.salienceThreshold) ? Number(opts.salienceThreshold) : DEFAULT_SALIENCE_THRESHOLD;
  const list = (Array.isArray(memories) ? memories : []).filter((m) => {
    if (!m || m.sensitive) return false;
    const sal = Number(m.salience);
    return !Number.isFinite(sal) || sal >= threshold; // salience 缺失视为通过（保守：不漏掉无标注的）
  });
  const facts = list.map((m) => ({
    category: m.scope || 'fact',
    text: m.body,
    tags: Array.isArray(m.tags) ? m.tags : [],
  }));
  return {
    frontmatter: {
      title: opts.title || 'Neo 长期记忆',
      type: 'memory',
      project: opts.projectId || 'noe',
      source: 'memory_core',
      count: facts.length,
      salience_min: threshold,
    },
    facts,
    relations: [],
  };
}

/**
 * 顶层编排（纯函数，仍不写盘）：在门控开启时把高显著度记忆 + 一批实体 hop 渲染成「待写文件清单」。
 * 调用方拿到 [{ relPath, content }] 后自行决定写到 ~/.noe-panel/memory-md/（或经 obsidian MCP）。
 * 门控关闭时返回 { enabled:false, files:[] }，调用方据此跳过写盘——这就是 env 门控的落点。
 * @param {object} input
 * @param {Array} [input.memories] MemoryCore 风格记忆
 * @param {Array} [input.entityHops] NoeKnowledgeGraph.oneHop 结果数组
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.env] 注入环境（默认 {} → OFF）
 * @param {number} [opts.salienceThreshold]
 * @param {string} [opts.projectId]
 * @param {(s:string)=>string} [opts.redact]
 * @returns {{enabled:boolean, files:Array<{relPath:string, content:string}>}}
 */
export function buildMirrorDocuments({ memories = [], entityHops = [] } = {}, opts = {}) {
  if (!isMirrorEnabled(opts.env || {})) return { enabled: false, files: [] };
  const redact = typeof opts.redact === 'function' ? opts.redact : redactSensitiveText;
  const files = [];

  const memDoc = memoriesToMirrorDoc(memories, opts);
  if (memDoc.facts.length) {
    files.push({ relPath: 'memory/long-term.md', content: toMarkdown(memDoc, { redact }) });
  }

  for (const hop of Array.isArray(entityHops) ? entityHops : []) {
    const mapped = knowledgeEntityToMirrorDoc(hop, opts);
    if (mapped) files.push({ relPath: `entities/${mapped.filename}`, content: toMarkdown(mapped.doc, { redact }) });
  }

  return { enabled: true, files };
}

// 写盘（副作用层，与纯函数 buildMirrorDocuments 分离）：把镜像文档写到 baseDir 下。
// 放本模块内是为了让 server.js 不必 import writeFileSync from 'fs'（持久化函数外迁约定）。
export function writeMirrorDocuments({ files = [], baseDir } = {}) {
  if (!baseDir || !Array.isArray(files)) return 0;
  let written = 0;
  for (const f of files) {
    if (!f || !f.relPath || f.content == null) continue;
    const abs = join(baseDir, f.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    written += 1;
  }
  return written;
}
