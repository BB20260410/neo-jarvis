// @ts-check
// NoeThinkLessonPersist — P1 闭环闭合：把 think 末步深思产的【认知修正】独立落库成可召回的 learning_lesson。
//   治断点2：深思(NOE_THINK_DELIBERATE)产出的 improvement 原本只写进 goal step note、从不进 noe_memory，
//   对话召回器(NoeMemoryRetriever 按 scope 查库)永远看不到 →「读→产 lesson→召回用上」在 think 主路断裂。
//   本模块把非 SKIP 的认知修正写成 kind=insight/scope=insight 的 learning_lesson(自动落 insight 召回通道)。
//   注入式(DI)：writeGate/getDb/dedupTextSimilarity/timeline 全从参数传入，纯逻辑可单测、零全局抓取。
//   仿 NoeLearningHook surprise_lesson 写法(kind:insight 需 source evidence → 给 episode+ref 过 gate) + distillSkill 去重防灌水。
//   调用方门控 NOE_THINK_LESSON_PERSIST(默认 OFF)；本模块只负责"被调用时怎么落库"，不读 env。

import { extractLessonTopics, mergeTopicTags } from '../memory/NoeLessonTopicIndex.js';

const SKIP_HEAD_RE = /^["「]?SKIP\b/i;
const SKIP_ONLY_RE = /^["「]?SKIP["」]?$/i;
const BASE_LESSON_TAGS = Object.freeze(['lesson', 'think']);

/** 去 <think> 思维标签 + 截断 500（与 distillSkill / NoeLearningHook 同款清洗）。 */
function cleanLesson(raw) {
  return String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim()
    .slice(0, 500);
}

/**
 * @param {object} deps
 * @param {{commit:Function}|null} [deps.writeGate]   NoeMemoryWriteGate
 * @param {(()=>any)|null} [deps.getDb]               返回 better-sqlite3 Database 的取库函数（去重查询用）
 * @param {((a:string,b:string)=>number)|null} [deps.dedupTextSimilarity]  文本相似度(0..1)，近重去重用
 * @param {{record:Function}|null} [deps.timeline]    NoeEpisodicTimeline（产 source evidence 过 gate）
 * @param {boolean} [deps.topicIndex]                 是否提取 topic 关键词进 tags（门控 NOE_LESSON_TOPIC_INDEX，调用方传入；默认 false 逐字零回归）
 * @param {{log?:Function}} [deps.logger]
 */
export function createThinkLessonPersist({
  writeGate = null,
  getDb = null,
  dedupTextSimilarity = null,
  timeline = null,
  topicIndex = false,
  logger = console,
} = {}) {
  /**
   * 把一条深思认知修正落库为可召回的 learning_lesson。纯同步、fail-open，绝不抛。
   * @param {string} rawReply 深思脑原始产出
   * @param {string} topic    学习主题
   * @returns {{persisted:boolean, reason?:string, memId?:any}}
   */
  function persist(rawReply, topic) {
    if (!writeGate || typeof writeGate.commit !== 'function') return { persisted: false, reason: 'no_write_gate' };
    const lesson = cleanLesson(rawReply);
    // SKIP 判定提到长度判定之前（三方互评一致：裸 SKIP=4字本会先命中 too_short → reason 语义错位、SKIP_RE 成死代码）。
    //   先剥首部 markdown/引号/列表符再判（深思脑偶尔回 **SKIP** / - SKIP / 「SKIP」）。
    const skipHead = lesson.replace(/^[\s>*_\-"「『（(]+/, '').trim();
    if (SKIP_HEAD_RE.test(skipHead) || SKIP_ONLY_RE.test(skipHead)) return { persisted: false, reason: 'skip' };
    if (lesson.length < 15) return { persisted: false, reason: 'too_short' };
    const cleanTopic = String(topic || '').slice(0, 80).trim();
    if (cleanTopic.length < 4) return { persisted: false, reason: 'no_topic' };

    // 去重仿 distillSkill：exact-body 强拒 + 近 50 张 learning_lesson 0.9 相似度跳过（治灌水分母拉低 hit>0 占比）。
    try {
      const db = typeof getDb === 'function' ? getDb() : null;
      if (db && typeof db.prepare === 'function') {
        const exactDup = db.prepare("SELECT id FROM noe_memory WHERE source_type='learning_lesson' AND body=? LIMIT 1").get(lesson);
        if (exactDup) return { persisted: false, reason: 'exact_dup' };
        if (typeof dedupTextSimilarity === 'function') {
          const recent = db.prepare("SELECT body FROM noe_memory WHERE source_type='learning_lesson' ORDER BY created_at DESC LIMIT 50").all();
          if (recent.some((s) => dedupTextSimilarity(lesson, String(s.body || '')) > 0.9)) return { persisted: false, reason: 'near_dup' };
        }
      }
    } catch { /* 去重查询失败不阻断入库（fail-open） */ }

    // source evidence：kind=insight 需过 candidateNeedsSourceEvidence 门 → 留情景痕作 episode ref，失败回退 topic ref。
    let sourceEpisodeId = null;
    try {
      if (timeline && typeof timeline.record === 'function') {
        // type 用白名单内 'milestone'（'insight' 不在 EPISODE_TYPES 白名单，record 会退化成 interaction——codex 互评发现）。
        sourceEpisodeId = String(timeline.record({ type: 'milestone', summary: `我在「${cleanTopic.slice(0, 40)}」上想明白了一条认知修正`, salience: 4 }) || '').slice(0, 240) || null;
      }
    } catch { /* 留痕失败不阻断落库 */ }

    // P-topic：从主题 + 认知修正正文提取 2-4 个 topic 关键词进 tags，供召回侧按 query 重叠加权（NOE_LESSON_TOPIC_INDEX）。
    //   主题权重高（topic 是这条 lesson 的「关于什么」），故先喂 cleanTopic 再喂正文；失败不阻断落库。
    let lessonTags = BASE_LESSON_TAGS;
    if (topicIndex) {
      try {
        const topics = extractLessonTopics(`${cleanTopic}\n${lesson}`, { max: 4, stripTitleDecoration: true });
        lessonTags = mergeTopicTags(BASE_LESSON_TAGS, topics);
      } catch { lessonTags = BASE_LESSON_TAGS; }
    }

    try {
      const c = writeGate.commit({
        kind: 'insight', projectId: 'noe', scope: 'insight',
        title: `认知修正：${cleanTopic.slice(0, 60)}`,
        body: lesson,
        sourceType: 'learning_lesson',
        tags: lessonTags,
        salience: 4,
        confidence: 0.72,
        sourceEpisodeId,
        evidenceRefs: [sourceEpisodeId ? `episode:${sourceEpisodeId}` : `topic:${cleanTopic.slice(0, 60)}`],
      });
      if (c && c.ok !== false && c.memory && c.memory.id) {
        try { logger && logger.log && logger.log('[noe-think-lesson] 💡 深思认知修正入库:', cleanTopic.slice(0, 40)); } catch { /* ignore */ }
        return { persisted: true, memId: c.memory.id };
      }
      return { persisted: false, reason: (c && c.reason) || 'commit_rejected' };
    } catch (e) {
      return { persisted: false, reason: `commit_failed:${String((e && e.message) || e).slice(0, 80)}` };
    }
  }

  return { persist };
}
