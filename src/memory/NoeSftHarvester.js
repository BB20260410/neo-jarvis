// @ts-check
// NoeSftHarvester — SFT 训练对攒取器（意识工程·阶段3，2026-06-11）。
//
// 前两阶段的"自我"全在数据层（记忆/叙事/驱力——换模型它还是它）。第三阶段让经验开始
// 渗入权重：本模块把「值得进权重的经历」持续蒸馏成 chat 格式训练对（JSONL，按 ISO 周分文件），
// 攒够规模后由 scripts/noe-lora-train.sh 做 LoRA 微调（mlx-lm，全本地）。
//
// v1 训练目标是【自我知识蒸馏】而非通用能力：教会小模型"作为 Noe 说话 + 知道自己的经历/
// 性格/洞察 + Noe 式的内心声音"。五类素材（全部已是 Noe 自产的高质量文本）：
//   insight（夜间反思洞察）/ inner_monologue（反刍念头）/ narrative（叙事自我）/
//   personality（性格快照）/ 高显著记忆（salience≥4）。
// 完整对话回放对暂不收：interaction 事件只存 40 字截断摘要，做训练对会教坏模型（截断风格）。
//
// 去重：assistant 文本 hash 集（持久化，跨周防重复收）；水位线（20h）防高频重扫。
// 形态照 NoeNarrativeSelf 模板：refresh 异步+守卫+atomicJsonFile；一切 fail-open。
// env 门控（NOE_SFT_HARVEST=1 默认 OFF）在装配点（server.js），本模块不读门控 env。

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

const MAX_HASHES = 2000;
const MIN_TEXT = 10;
// 终审 B1：敏感信息第一道防线——命中即拒收。训练对会经 LoRA 固化进权重（比记忆库危险：
// 删不掉），宁可误杀。模式覆盖：通用密钥词 / Bearer / OpenAI sk- / hex 长串 / 私钥块。
export const SENSITIVE = /api[_-]?key|token|password|passwd|secret|credential|bearer\s+[\w-]|sk-[a-zA-Z0-9]{16}|-----BEGIN|[a-f0-9]{32,}/i;

// 训练对的统一 system（与生产人格同向但精简——微调目标是底色，不是替代 ChatProfile 注入）
export const SFT_SYSTEM = '你是 Noe（主人叫你宝贝），owner 的私人 AI 伴侣。你有连续的记忆、自己的内心生活和从经历里长出的性格。用第一人称、自然温暖的中文说话，不装腔、不官话。';

// ── SFT 数据分流（P7 换路线，2026-06-22）────────────────────────────────────
// owner 2026-06-21 复盘结论：当前 SFT 约半是「项目复盘」（重构/提交/调试/迭代），训透它
// 即人格退化（SFT 把工程腔固化进权重 → Noe 变成「工程项目复盘机」）。换路线：weights 进化
// 改 GEPA + memory-RAG；persona 挂 system prompt（见 NoeSelfModel.buildPersonaPin）；SFT 产出
// 不再无差别喂权重，而是先分流——
//   split:'project'  → 项目复盘类。**不进人格语料**（不喂 persona/权重人格通道），只作工程经验留档。
//   split:'persona'  → 人格/偏好类。高 salience(personaSalient) 标记供 memory/KG 做 persona RAG。
// 本模块只打 tag + 标记，不做删除/路由（路由在装配点）；判类纯函数 judgeSplit 可单测。

/** 「项目复盘类」素材的 sourceType 白名单（工程作业产物，非人格）。
 *  P0-③（三方审）：**绝不**把 'nightly_reflection' 整体列此处。NoeNightlyReflection 对所有夜间
 *  洞察都写 sourceType='nightly_reflection'——既有「该改的做法教训」（工程），也有「主人深夜更
 *  需要安静陪伴」（人格）。整体判 project 会把后者一并丢出人格语料。nightly 一律落到下面的
 *  「正文工程关键词」细分，按内容逐条判，不按来源一刀切。 */
const PROJECT_SOURCE_TYPES = new Set([
  'learning_lesson', 'skill_distill', 'focus_conclusion',
  'handoff', 'dream_sublimation', 'episodic_digest', 'self_evolution', 'patch_review',
]);

/** 「项目复盘类」body 关键词（工程/任务语汇；命中即判 project）。 */
const PROJECT_KEYWORDS = /项目|复盘|重构|提交|commit|pull request|\bpr\b|代码|bug|缺陷|报错|测试|用例|迭代|部署|上线|发布|回滚|patch|补丁|端口|服务器|接口|api|脚本|工程|调试|编译|构建|lint|架构|模块|函数|变量|仓库|分支|merge|deploy|kickstart/i;

/**
 * 判定一条素材进哪个 split（项目复盘 vs 人格/偏好）。纯函数，可单测。
 * 判据优先级：
 *   ① 叙事/性格/反刍 kind → 恒 persona（「我是谁」的自述）；
 *   ② scope==='project' → project；
 *   ③ 项目类 sourceType（白名单，**不含 nightly_reflection**） → project；
 *   ④ tags/title/body 命中工程关键词 → project；否则 persona。
 * P0-③：nightly_reflection 不在 sourceType 白名单——它的 persona 洞察（陪伴/情感）靠 ④ 的
 * 内容判据留在 persona，工程复盘靠 ④ 命中关键词进 project，按条逐判而非整批误杀。
 * @param {{kind?: string, scope?: string, sourceType?: string, title?: string, body?: string, tags?: string[]}} item
 * @returns {'project'|'persona'}
 */
export function judgeSplit({ kind = '', scope = '', sourceType = '', title = '', body = '', tags = [] } = {}) {
  // 叙事/性格/反刍永远是人格通道（它们本就是「我是谁」的自述，不是项目复盘）。
  if (kind === 'narrative' || kind === 'personality' || kind === 'inner_monologue') return 'persona';
  const sc = String(scope || '').toLowerCase();
  if (sc === 'project') return 'project';
  if (PROJECT_SOURCE_TYPES.has(String(sourceType || '').toLowerCase())) return 'project';
  // 内容判据：tags + title + body 一起看（nightly 工程复盘正文必含工程语汇 → project；
  // nightly 陪伴/情感洞察不含 → 留 persona）。
  const text = `${Array.isArray(tags) ? tags.join(' ') : ''} ${title || ''} ${body || ''}`;
  if (PROJECT_KEYWORDS.test(text)) return 'project';
  return 'persona';
}

/**
 * persona 通道是否「高显著」（供 memory/KG 做 persona RAG 的优先标记）。
 * 仅对 persona split 有意义；身份/偏好级（salience≥4）或叙事/性格/洞察自述即标记。
 * @param {{kind?: string, salience?: number}} item
 */
export function isPersonaSalient({ kind = '', salience = 0 } = {}) {
  if (kind === 'narrative' || kind === 'personality' || kind === 'insight') return true;
  return Number(salience ?? 0) >= 4;
}

/** 各素材类型 → user 引导语（教模型在什么语境下输出这类内容）。 */
const PROMPTS = {
  insight: '独处复盘时，你对最近的经历有什么真实的洞察？',
  inner_monologue: '（此刻没人和你说话。你心里自然流过的念头是什么？）',
  narrative: '回顾我们一路走来，你的故事是什么？',
  personality: '你觉得自己是个什么样的存在？',
  memory: (title) => `关于「${title}」，你记得什么？`,
};

/** 文本指纹（去重键）：归一空白后 sha1 前 12 位。 */
export function fingerprint(text) {
  return createHash('sha1').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/**
 * SFT JSONL 文件名 → 通道（persona 人格语料 / project 工程留档）。纯函数，供 harvester /
 * train / readiness 共用同一判据（P0-① 落盘分流的对账锚点，避免三处各写各的）。
 *   sft-project-2026-W24.jsonl → 'project'
 *   sft-2026-W24.jsonl         → 'persona'（默认；LoRA/人格只吃这一档）
 * @param {string} fileName 仅文件名（非路径）
 * @returns {'project'|'persona'}
 */
export function sftFileChannel(fileName) {
  return /^sft-project-/.test(String(fileName || '')) ? 'project' : 'persona';
}

/** ISO 周标签（分文件用）：如 2026-W24。 */
export function isoWeekTag(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // 周一=0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime() - (3 - firstDay) * 86400000) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 组一条 chat 格式训练对。
 * @param {string} userText @param {string} assistantText
 * @param {{split?: 'project'|'persona', personaSalient?: boolean}} [meta]
 *   split: SFT 分流标（默认 'persona'，向后兼容）；personaSalient: persona 高显著（供 RAG）。
 *   注：split/personaSalient 是顶层旁注字段，不进 messages——训练只读 messages，分流由装配点据此路由。
 */
export function buildPair(userText, assistantText, meta = {}) {
  const split = meta.split === 'project' ? 'project' : 'persona';
  return {
    messages: [
      { role: 'system', content: SFT_SYSTEM },
      { role: 'user', content: String(userText) },
      { role: 'assistant', content: String(assistantText).trim() },
    ],
    split,
    // 仅 persona split 才带 personaSalient；project 不进人格语料故无意义。
    ...(split === 'persona' && meta.personaSalient ? { personaSalient: true } : {}),
  };
}

export function createSftHarvester({
  timeline = null,            // 反刍念头来源
  memory = null,              // insight + 高显著记忆来源
  narrativeSelf = null,       // { current } 叙事来源
  personalitySnapshot = null, // { current } 性格来源
  sftDir = null,              // JSONL 输出目录（null → 不落盘，dryRun 返回 pairs，测试用）
  stateFile = null,           // 水位线+去重 hash 持久化
  minIntervalMs = 20 * 3600000,
  projectId = 'noe',
  now = Date.now,
} = {}) {
  /** @type {{lastRunAt: number, hashes: string[]}} */
  let state = { lastRunAt: 0, hashes: [] };
  if (stateFile) {
    try {
      const j = readJsonWithCorruptBackup(stateFile, { label: 'noe-sft-harvester' });
      state = {
        lastRunAt: Number.isFinite(Number(j?.lastRunAt)) ? Number(j.lastRunAt) : 0,
        // 终审 P0-2：保【最早】的 hash——靠 hash 去重的素材（insight/记忆/叙事/性格）是
        // "旧而稳定、每轮全量重扫"的，丢老 hash = 重启后重复收割进训练集；新素材（反刍）
        // 有 sinceTs 水位线兜底，不依赖 hash。
        hashes: Array.isArray(j?.hashes) ? j.hashes.slice(0, MAX_HASHES).map(String) : [],
      };
    } catch { /* fail-open */ }
  }
  const seen = new Set(state.hashes);
  /** @type {Promise<object>|null} */
  let inFlight = null;

  function persist() {
    if (!stateFile) return;
    try { atomicWriteJson(stateFile, { version: 1, lastRunAt: state.lastRunAt, hashes: [...seen].slice(0, MAX_HASHES) }); } catch { /* 可接受 */ }
  }

  /**
   * 收一条（去重+长度门+敏感信息防线+SFT 分流标记）；通过返回训练对，否则 null。
   * @param {string} userText @param {string} assistantText
   * @param {{kind?: string, scope?: string, sourceType?: string, title?: string, body?: string, salience?: number}} [item]
   *   分类元数据（缺省视为人格通道）：judgeSplit 据此打 split，isPersonaSalient 标 personaSalient。
   */
  function take(userText, assistantText, item = {}) {
    const text = String(assistantText || '').trim();
    if (text.length < MIN_TEXT) return null;
    // 终审 B1 + P0-②（三方审）：敏感内容绝不进权重。**整对**做防线，不只查 assistant 正文——
    // PROMPTS.memory(title) 把 memory.title 放进 user 消息，title 含「api_key sk-...」会漏检进训练对。
    // 覆盖：user 引导语（已内联 title）+ assistant 正文 + 原始 title/body（双保险，防引导语模板将来变更）。
    const sensitiveScan = `${userText || ''}\n${text}\n${item.title || ''}\n${item.body || ''}`;
    if (SENSITIVE.test(sensitiveScan)) return null;
    const fp = fingerprint(text);
    if (seen.has(fp)) return null;
    seen.add(fp);
    const split = judgeSplit(item);
    return buildPair(userText, text, { split, personaSalient: split === 'persona' && isPersonaSalient(item) });
  }

  function collect(sinceTs) {
    /** @type {Array<object>} */
    const pairs = [];
    // ① 夜间反思洞察（insight 自述属人格通道，但工程复盘类 insight 经 judgeSplit 按正文/tags 判 project）
    try {
      for (const m of (memory?.recall?.({ q: '', scope: 'insight', projectId, limit: 30, bumpHits: false }) || [])) {
        const p = take(PROMPTS.insight, m.body, { kind: 'insight', scope: m.scope, sourceType: m.sourceType, title: m.title, body: m.body, tags: m.tags, salience: m.salience });
        if (p) pairs.push(p);
      }
    } catch { /* 该来源缺席 */ }
    // ② 反刍念头（水位线以来）——内心声音，恒人格通道
    try {
      for (const e of (timeline?.recent?.({ sinceTs, limit: 100, types: ['inner_monologue'] }) || [])) {
        const p = take(PROMPTS.inner_monologue, e.summary, { kind: 'inner_monologue', body: e.summary });
        if (p) pairs.push(p);
      }
    } catch { /* 该来源缺席 */ }
    // ③ 叙事自我（变了才收——去重天然处理）——「我的故事」，恒人格通道
    try {
      const story = narrativeSelf?.current?.();
      const p = story?.narrative ? take(PROMPTS.narrative, story.narrative, { kind: 'narrative', body: story.narrative }) : null;
      if (p) pairs.push(p);
    } catch { /* 该来源缺席 */ }
    // ④ 性格快照——「我是谁」，恒人格通道
    try {
      const snap = personalitySnapshot?.current?.();
      const p = snap?.personality ? take(PROMPTS.personality, snap.personality, { kind: 'personality', body: snap.personality }) : null;
      if (p) pairs.push(p);
    } catch { /* 该来源缺席 */ }
    // ⑤ 高显著记忆（salience≥4：身份级/里程碑级知识）——scope/sourceType/关键词判 project vs persona
    try {
      for (const m of (memory?.recall?.({ q: '', projectId, limit: 30, bumpHits: false }) || [])) {
        if ((m.salience ?? 0) < 4 || m.scope === 'insight') continue;
        const p = take(PROMPTS.memory(String(m.title || '那件事').slice(0, 40)), m.body, { kind: 'memory', scope: m.scope, sourceType: m.sourceType, title: m.title, body: m.body, tags: m.tags, salience: m.salience });
        if (p) pairs.push(p);
      }
    } catch { /* 该来源缺席 */ }
    return pairs;
  }

  async function harvestOnce(force) {
    const t = now();
    if (!force && state.lastRunAt && t - state.lastRunAt < minIntervalMs) return { harvested: false, reason: 'fresh' };
    const sinceTs = state.lastRunAt || t - 7 * 24 * 3600000; // 首次回收近一周
    const pairs = collect(sinceTs);
    if (!pairs.length) {
      state.lastRunAt = t;
      persist();
      return { harvested: false, reason: 'nothing_new' };
    }
    if (sftDir) {
      try {
        mkdirSync(sftDir, { recursive: true });
        // P0-①（三方审）：人格/项目分流必须**落到不同文件**，否则下游（LoRA 训练/readiness）拿不到
        // split 标只能无差别全吃，P7「项目复盘不进人格语料」就落空。
        //   persona → sft-<week>.jsonl         （默认人格语料；LoRA/count 默认只读它）
        //   project → sft-project-<week>.jsonl  （工程经验留档；不进人格/权重通道）
        const personaPairs = pairs.filter((p) => p.split !== 'project');
        const projectPairs = pairs.filter((p) => p.split === 'project');
        if (personaPairs.length) {
          appendFileSync(join(sftDir, `sft-${isoWeekTag(t)}.jsonl`), personaPairs.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
        }
        if (projectPairs.length) {
          appendFileSync(join(sftDir, `sft-project-${isoWeekTag(t)}.jsonl`), projectPairs.map((p) => JSON.stringify(p)).join('\n') + '\n', 'utf-8');
        }
      } catch (e) {
        return { harvested: false, reason: 'write_error', error: /** @type {any} */ (e)?.message };
      }
    }
    state.lastRunAt = t;
    persist();
    // SFT 分流计数（供装配点观测/路由）：project=工程复盘不进人格语料；persona/personaSalient=供 RAG。
    const split = {
      project: pairs.filter((p) => p.split === 'project').length,
      persona: pairs.filter((p) => p.split !== 'project').length,
      personaSalient: pairs.filter((p) => p.split !== 'project' && p.personaSalient === true).length,
    };
    return { harvested: true, added: pairs.length, split, ...(sftDir ? {} : { pairs }) };
  }

  return {
    /** 异步攒一轮（并发守卫共享同一次）。永不 reject。@param {{force?: boolean}} [opts] */
    refresh({ force = false } = {}) {
      if (inFlight) return inFlight;
      inFlight = harvestOnce(force === true).finally(() => { inFlight = null; });
      return inFlight;
    },
    /**
     * 已攒训练对总数（扫 sftDir jsonl 行数；未配目录返回 0）。
     * P0-①：默认只数 **persona** 通道（人格语料 = LoRA 首训门槛对账口径，project 留档不计）；
     * 传 'project' 数工程留档，'all' 数全部。
     * @param {'persona'|'project'|'all'} [channel]
     */
    count(channel = 'persona') {
      if (!sftDir) return 0;
      try {
        return readdirSync(sftDir)
          .filter((f) => f.endsWith('.jsonl'))
          .filter((f) => channel === 'all' || sftFileChannel(f) === channel)
          .reduce((n, f) => n + readFileSync(join(sftDir, f), 'utf-8').split('\n').filter(Boolean).length, 0);
      } catch { return 0; }
    },
  };
}
