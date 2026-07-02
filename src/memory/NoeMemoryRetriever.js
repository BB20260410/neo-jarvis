// @ts-check

import { NoeMemoryAuditLog } from './NoeMemoryAuditLog.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { extractLessonTopics, topicOverlapScore } from './NoeLessonTopicIndex.js';
import {
  createActiveMemoryRecallCircuitBreaker,
  sanitizeActiveMemoryRecallError,
} from './NoeActiveMemory.js';
import { isPersonaPinMemory } from './NoePersonaPins.js';
export { formatMemoryContextBlock } from './NoeMemoryContextFormatter.js';

// P8：persona_pin 记忆已下沉 system prompt（persona-pin 段），不应再被召回挤占 top-K 名额。
//   仅当 NOE_MEMORY_PERSONA_PIN=1（与下沉同一开关）时排除——OFF 时下沉没发生，召回须逐字回现状（零回归）。
//   判定用 NoePersonaPins.isPersonaPinMemory 单一真源（与下沉选中的是同一集合）。
function personaPinSinkOn() {
  return ['1', 'true', 'on'].includes(String(process.env.NOE_MEMORY_PERSONA_PIN || '0').trim().toLowerCase());
}

const DEFAULT_LIMITS = Object.freeze({
  voice: { fact: 4, user: 3, project: 2, insight: 2, total: 6 },
  chat: { fact: 5, user: 4, project: 3, insight: 2, total: 8 },
  mission: { fact: 4, user: 3, project: 6, insight: 3, total: 10 },
  reflection: { fact: 4, user: 3, project: 4, insight: 6, total: 12 },
});

// P2 杠杆1：lesson 专属召回通道的 source_type 圈定（learning_lesson 的深思认知修正 + skill_distill 技能卡 + surprise_lesson）。
const LESSON_SOURCE_TYPES = Object.freeze(['learning_lesson', 'surprise_lesson', 'skill_distill']);
const LESSON_RESERVE = Math.max(1, Math.min(4, Number(process.env.NOE_MEMORY_LESSON_RESERVE) || 2));

/**
 * M3 召回质量根因修复（NOE_LESSON_TOPIC_INDEX）：lesson 通道按 sourceType 圈定解决「能进」，但不解决「够准」——
 * 同主题盲卡与无关 lesson 平权进 selected。这里用 query 关键词与每条 lesson tags 的重叠度对「召回到的 lesson」重排，
 * 让主题相关的 lesson 优先占 reserved 槽。flag OFF / query 无关键词 / lesson 全无 tags 时返回原序（逐字零回归）。
 * @param {Array<{id?:string, tags?:string[]}>} lessons
 * @param {string} query
 * @returns {Array} 重排后的 lesson 列表（稳定：同分保持原相对顺序）
 */
function rankLessonsByTopic(lessons, query) {
  if (!Array.isArray(lessons) || lessons.length <= 1) return lessons || [];
  const queryTopics = extractLessonTopics(query, { max: 6 });
  if (!queryTopics.length) return lessons;
  let anyOverlap = false;
  const scored = lessons.map((item, index) => {
    const { score } = topicOverlapScore(queryTopics, item?.tags || []);
    if (score > 0) anyOverlap = true;
    return { item, score, index };
  });
  if (!anyOverlap) return lessons; // 无任何重叠 → 不动原序（别因全 0 抖动顺序）
  return scored
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((row) => row.item);
}

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max));
}

function scoreMemory(item, index) {
  // 空候选防御：非对象 / null / undefined 直接落 0，避免空槽进入排序污染结果
  if (!item || typeof item !== 'object') return 0;
  const idx = Number.isFinite(Number(index)) ? Math.max(0, Number(index)) : 0;
  const confidence = Number(item?.confidence);
  const salience = Number(item?.salience);
  const hit = Number(item?.hitCount);
  const raw = (Number.isFinite(confidence) ? confidence : 0.5)
    + (Number.isFinite(salience) ? salience * 0.08 : 0.2)
    + Math.min(0.2, Math.max(0, hit) * 0.005)
    - idx * 0.001;
  // 分数边界裁剪：NaN / ±Infinity / 极端值会破坏排序稳定性，硬裁到 [0, 2] 防止越界污染
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(2, raw));
}

function stableDedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function hasLiteralAnchor(query = '') {
  return String(query || '').split(/\s+/).some((token) => {
    const cleanToken = token.replace(/[^\w:-]/g, '');
    if (cleanToken.length < 8) return false;
    return /_/.test(cleanToken) || /\d{4,}/.test(cleanToken) || /[a-f0-9-]{12,}/i.test(cleanToken);
  });
}

export class NoeMemoryRetriever {
  constructor({
    memory = null,
    auditLog = null,
    now = Date.now,
    logger = console,
    circuitBreaker = null,
    // 度量诚实修复：主对话/任务召回 recallChannel 一律 bumpHits:false（召回阶段不给所有 candidates 计数），
    //   导致真正注入对话的 selected 记忆 hit_count 永不+1 → hit_count 严重低估真实使用（93.7% 假"没人读"被它误导）。
    //   ON 时让 retrieve() 选出的 selected（真注入决策的）计 hit。因 hit 影响 scoreMemory 排序（正反馈强化常用记忆），
    //   属分量动作，默认 OFF 等 owner 点火（NOE_MEMORY_USAGE_BUMP=1）。
    recordUsageHits = process.env.NOE_MEMORY_USAGE_BUMP === '1',
  } = {}) {
    this.memory = memory;
    this.auditLog = auditLog || new NoeMemoryAuditLog({ db: () => memory?.db?.(), now });
    this.now = now;
    this.logger = logger;
    this.circuitBreaker = circuitBreaker || createActiveMemoryRecallCircuitBreaker({ now });
    this.recordUsageHits = recordUsageHits;
  }

  async recallChannel({ q, projectId, scope, sourceTypes, limit, literalOnly = false }) {
    if (!this.memory?.recall) return { items: [], droppedReason: 'empty_or_unwired', circuit: null };
    const circuitKey = `${projectId || 'noe'}:${scope || 'all'}:retriever`;
    const circuit = this.circuitBreaker?.canAttempt?.(circuitKey);
    if (circuit && circuit.ok === false) {
      return { items: [], droppedReason: 'recall_circuit_open', circuit };
    }
    const args = { q, projectId, scope, limit, bumpHits: false, ...(sourceTypes ? { sourceTypes } : {}) };
    try {
      const raw = literalOnly || !this.memory.recallFused ? this.memory.recall(args) : await this.memory.recallFused(args);
      this.circuitBreaker?.recordSuccess?.(circuitKey);
      // P8：排除已下沉 system prompt 的 persona_pin（flag ON 时）——类比 scope!=='voice' 过滤；OFF 时谓词恒 false 零回归。
      const excludePersonaPin = personaPinSinkOn();
      return {
        items: Array.isArray(raw)
          ? raw.filter((m) => m && m.body && m.scope !== 'voice' && !(excludePersonaPin && isPersonaPinMemory(m)))
          : [],
        droppedReason: '',
        circuit: this.circuitBreaker?.status?.(circuitKey) || null,
      };
    } catch (error) {
      const failure = this.circuitBreaker?.recordFailure?.(circuitKey, error) || null;
      throw Object.assign(new Error(sanitizeActiveMemoryRecallError(error)), {
        cause: error,
        circuit: failure,
      });
    }
  }

  async retrieve({
    transcript = '',
    task = '',
    goal = '',
    person = '',
    projectId = 'noe',
    routeType = 'chat',
    memoryPolicy = null,
    turnId = null,
    limit = null,
  } = {}) {
    const query = clean([transcript, task, goal, person].filter(Boolean).join('\n'), 1600);
    if (!query || !this.memory?.recall) return { ok: true, query, selected: [], channels: {}, droppedReasons: ['empty_or_unwired'] };
    const profile = DEFAULT_LIMITS[routeType] || DEFAULT_LIMITS.chat;
    const policyLimit = Number(memoryPolicy?.recallLimit) || null;
    const totalLimit = Math.max(1, Math.min(20, Number(limit) || Number(memoryPolicy?.injectLimit) || profile.total));
    const per = {
      fact: Math.max(profile.fact, policyLimit || 0),
      user: Math.max(profile.user || 0, policyLimit || 0),
      project: profile.project,
      insight: profile.insight,
    };
    const channels = {};
    try {
      const literalAnchor = hasLiteralAnchor(query);
      let literalResults = null;
      if (literalAnchor) {
        literalResults = await Promise.all([
          this.recallChannel({ q: query, projectId, scope: 'fact', limit: per.fact, literalOnly: true }),
          this.recallChannel({ q: query, projectId, scope: 'user', limit: per.user, literalOnly: true }),
          this.recallChannel({ q: query, projectId, scope: 'project', limit: per.project, literalOnly: true }),
          this.recallChannel({ q: query, projectId, scope: 'insight', limit: per.insight, literalOnly: true }),
        ]);
      }
      const literalHit = literalResults?.some((result) => result.items.length > 0) === true;
      // P2 杠杆1：lesson 专属通道并入 Promise.all 作第5路并行(三方互评 Claude/codex:勿串行追加增延迟)。literal anchor 命中走精确
      //   字面路径、lesson 通道不参与(避免 codex 关切的"literal 抑制语义却仍跑 lesson")；flag 默认 OFF 时该路返回空、逐字零回归。
      const lessonChannelOn = process.env.NOE_MEMORY_LESSON_CHANNEL === '1' && !!this.memory?.recallFused;
      const [factResult, userResult, projectResult, insightResult, lessonResult] = literalHit
        ? [...literalResults, { items: [], droppedReason: '' }]
        : await Promise.all([
          this.recallChannel({ q: query, projectId, scope: 'fact', limit: per.fact }),
          this.recallChannel({ q: query, projectId, scope: 'user', limit: per.user }),
          this.recallChannel({ q: query, projectId, scope: 'project', limit: per.project }),
          this.recallChannel({ q: query, projectId, scope: 'insight', limit: per.insight }),
          lessonChannelOn
            ? this.recallChannel({ q: query, projectId, scope: '', sourceTypes: LESSON_SOURCE_TYPES, limit: LESSON_RESERVE })
            : Promise.resolve({ items: [], droppedReason: '' }),
        ]);
      channels.fact = factResult.items;
      channels.user = userResult.items;
      channels.project = projectResult.items;
      channels.insight = insightResult.items;
      if (lessonResult.items.length) channels.lesson = lessonResult.items;
      const circuitDrops = [factResult, userResult, projectResult, insightResult, lessonResult]
        .filter((result) => result.droppedReason)
        .map((result) => result.droppedReason);
      const candidates = stableDedupe([...channels.fact, ...channels.user, ...channels.project, ...channels.insight])
        .map((item, index) => ({ item, score: scoreMemory(item, index) }))
        .sort((a, b) => b.score - a.score)
        .map((row) => row.item);
      // P2 杠杆1 lesson 保底进 selected：治"lesson 元认知抽象句被同 scope 的 nightly_reflection 裸竞争淹"(实测 insight 133次0命中、
      //   lesson hit 全0)。三方互评一致修正:lesson 放 selected 末尾、至多占 min(RESERVE, totalLimit-1) 席(至少留 1 席给四通道,治
      //   "小 totalLimit 时 lesson 独占挤掉 fact/user"的 SERIOUS);零命中 lessonResult.items=[] → lessonSlots=0 fail-safe 不强塞(三方确认)。
      // P-topic（NOE_LESSON_TOPIC_INDEX 默认 OFF）：召回到的 lesson 先按 query 主题重叠加权重排，再占 reserved 槽，
      //   让主题相关的 lesson 优先（治「lesson 只按 sourceType 能进、不按主题够准」）。OFF 时维持原 stableDedupe 序逐字零回归。
      const lessonReserved = process.env.NOE_LESSON_TOPIC_INDEX === '1'
        ? rankLessonsByTopic(stableDedupe(lessonResult.items), query)
        : stableDedupe(lessonResult.items);
      const lessonSlots = Math.min(lessonReserved.length, Math.max(0, totalLimit - 1));
      let selected;
      if (lessonSlots > 0) {
        const reservedTop = lessonReserved.slice(0, lessonSlots);
        const reservedIds = new Set(reservedTop.map((m) => m.id));
        const nonLesson = candidates.filter((c) => !reservedIds.has(c.id));
        selected = [...nonLesson.slice(0, totalLimit - lessonSlots), ...reservedTop];
      } else {
        selected = candidates.slice(0, totalLimit);
      }
      const hitIds = stableDedupe([...candidates, ...lessonReserved]).map((m) => m.id);
      const selectedIds = selected.map((m) => m.id);
      // 度量诚实：只有进入 selected（真注入对话/决策）的记忆才算"被使用"→ 计 hit_count；召回但没选上的 candidates 不计。
      if (this.recordUsageHits && selectedIds.length && typeof this.memory?.bumpHitMany === 'function') {
        try { this.memory.bumpHitMany(selectedIds); } catch { /* 计数失败不阻断召回 */ }
      }
      const droppedReasons = [
        ...new Set([
          ...circuitDrops,
          ...(literalHit ? ['semantic_suppressed_by_literal_anchor'] : []),
          ...(candidates.length > selected.length ? ['over_budget'] : []),
        ]),
      ];
      try {
        this.auditLog?.recordRetrieval?.({
          turnId,
          projectId,
          routeType,
          query,
          channels: Object.fromEntries(Object.entries(channels).map(([k, v]) => [k, v.length])),
          hitIds,
          selectedIds,
          droppedReasons,
        });
      } catch { /* audit fail-open */ }
      return {
        ok: true,
        query,
        channels,
        selected,
        hitIds,
        selectedIds,
        droppedReasons,
        recallCircuit: {
          fact: factResult.circuit,
          user: userResult.circuit,
          project: projectResult.circuit,
          insight: insightResult.circuit,
        },
      };
    } catch (e) {
      this.logger?.warn?.('[noe-memory-retriever] 召回失败:', sanitizeActiveMemoryRecallError(e));
      return {
        ok: false,
        query,
        selected: [],
        channels: {},
        droppedReasons: ['recall_failed'],
        recallCircuit: e?.circuit || null,
      };
    }
  }
}
