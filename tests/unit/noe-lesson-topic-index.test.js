import { describe, expect, it } from 'vitest';
import {
  tokenizeForTopics,
  extractLessonTopics,
  mergeTopicTags,
  topicOverlapScore,
} from '../../src/memory/NoeLessonTopicIndex.js';

describe('NoeLessonTopicIndex.tokenizeForTopics', () => {
  it('keeps identifiers/library names with internal . _ - / intact', () => {
    const toks = tokenizeForTopics('用 better-sqlite3 配 core.hooksPath 和 qwen3-embedding:0.6b');
    expect(toks).toContain('better-sqlite3');
    expect(toks).toContain('core.hookspath');
    // 冒号是分隔符：qwen3-embedding 与 0.6b 切开，标识符主体保留。
    expect(toks).toContain('qwen3-embedding');
  });

  it('segments CJK into 2-grams plus short whole words', () => {
    const toks = tokenizeForTopics('向量召回');
    expect(toks).toContain('向量召回'); // ≤4 字整词
    expect(toks).toContain('向量');
    expect(toks).toContain('召回');
  });
});

describe('NoeLessonTopicIndex.extractLessonTopics', () => {
  it('extracts concrete topic keywords and drops stopwords/methodology filler', () => {
    const topics = extractLessonTopics('用 better-sqlite3 做了向量、召回相关实验。先搜索再阅读这些方法其实没用。', { max: 6 });
    expect(topics).toContain('better-sqlite3');
    // 具体中文术语进 topic（标点分隔，独立成 2-字段 → 整词）。
    expect(topics).toContain('向量');
    expect(topics).toContain('召回');
    // 停用词/套话/单字虚词碎片不该进 topic
    expect(topics).not.toContain('我');
    expect(topics).not.toContain('方法');
    expect(topics).not.toContain('搜索');
    expect(topics).not.toContain('做了'); // 含单字虚词的碎片被剔
  });

  it('prefers a short CJK whole-word over its 2-gram fragments', () => {
    // 「向量召回」标点/空格独立成 4-字段 → 整词保留，碎片「向量」「召回」「量召」被压制。
    const topics = extractLessonTopics('主题 向量召回 调优', { max: 6 });
    expect(topics).toContain('向量召回');
    expect(topics).not.toContain('向量');
    expect(topics).not.toContain('召回');
    expect(topics).not.toContain('量召');
  });

  it('strips "技能：" / "认知修正：" title decoration when asked', () => {
    const topics = extractLessonTopics('技能：Godot AnimatedSprite2D 帧动画切帧', { stripTitleDecoration: true });
    expect(topics).toContain('godot');
    expect(topics).toContain('animatedsprite2d');
    // 装饰前缀本身不该成 topic
    expect(topics).not.toContain('技能');
  });

  it('strips CJK title decoration words and does not leak them as topics', () => {
    // 「认知修正：」装饰被剥，余下提真主题，装饰词「认知」「修正」不进 topic。
    const topics = extractLessonTopics('认知修正：代理节点切换', { max: 8, stripTitleDecoration: true });
    expect(topics).not.toContain('认知');
    expect(topics).not.toContain('修正');
    expect(topics).not.toContain('认知修正');
    expect(topics).toContain('代理');
    expect(topics).toContain('节点');
    expect(topics).toContain('切换');
  });

  it('eliminates cross-word 2-gram garbage in continuous CJK runs', () => {
    // 连续中文段无空格 → 旧滑窗在词边界产垃圾碎片；只该留词对齐双字词，不留跨词碎片。
    const t1 = extractLessonTopics('代理节点切换', { max: 8 });
    expect(t1).toEqual(expect.arrayContaining(['代理', '节点', '切换']));
    expect(t1).not.toContain('理节'); // 跨词碎片
    expect(t1).not.toContain('点切'); // 跨词碎片

    const t2 = extractLessonTopics('历史召回质量审计', { max: 8 });
    expect(t2).toEqual(expect.arrayContaining(['历史', '召回', '质量', '审计']));
    expect(t2).not.toContain('史召'); // 跨词碎片
    expect(t2).not.toContain('回质'); // 跨词碎片
    expect(t2).not.toContain('量审'); // 跨词碎片

    const t3 = extractLessonTopics('备份失败不重试', { max: 8 });
    expect(t3).toContain('备份');
    expect(t3).toContain('失败');
    expect(t3).not.toContain('份失'); // 跨词碎片
    expect(t3).not.toContain('败不'); // 跨词碎片（且含未对齐）
  });

  it('keeps identifiers/version ids intact while cleaning CJK cross-word garbage', () => {
    // 标识符/版本号优秀现状不动；中文段照样清跨词碎片。
    const topics = extractLessonTopics('用 better-sqlite3 配 qwen3.6-35b-a3b 跑 代理节点切换', { max: 8 });
    expect(topics).toContain('better-sqlite3');
    expect(topics).toContain('qwen3.6-35b-a3b');
    expect(topics).toContain('代理');
    expect(topics).toContain('节点');
    expect(topics).not.toContain('理节');
  });

  it('respects max cap and ranks by frequency (deterministic)', () => {
    const topics = extractLessonTopics('redis redis redis 缓存 缓存 mongodb', { max: 2 });
    expect(topics.length).toBe(2);
    expect(topics[0]).toBe('redis'); // 频率最高排首
    expect(topics).toContain('缓存');
  });

  it('drops pure-number tokens but keeps alnum version ids', () => {
    const topics = extractLessonTopics('node 22 升级 node24 兼容性 兼容性');
    expect(topics).not.toContain('22'); // 纯数字噪声
    expect(topics).toContain('node24'); // 带字母版本号保留
    expect(topics).toContain('node');
  });

  it('returns empty for blank input', () => {
    expect(extractLessonTopics('')).toEqual([]);
    expect(extractLessonTopics('   ')).toEqual([]);
    expect(extractLessonTopics(null)).toEqual([]);
  });
});

describe('NoeLessonTopicIndex.mergeTopicTags', () => {
  it('keeps existing tags first, appends topics, dedupes case-insensitively', () => {
    const merged = mergeTopicTags(['lesson', 'think'], ['Redis', 'redis', '向量']);
    expect(merged.slice(0, 2)).toEqual(['lesson', 'think']);
    expect(merged).toContain('Redis');
    expect(merged).toContain('向量');
    // 'redis' 与 'Redis' 视为同一 tag，不重复
    expect(merged.filter((t) => t.toLowerCase() === 'redis').length).toBe(1);
  });

  it('respects maxTags cap', () => {
    const merged = mergeTopicTags(['a', 'b'], ['c', 'd', 'e'], 3);
    expect(merged).toEqual(['a', 'b', 'c']);
  });
});

describe('NoeLessonTopicIndex.topicOverlapScore', () => {
  it('scores higher with more overlapping topics', () => {
    const low = topicOverlapScore(['redis', '缓存', '向量'], ['lesson', 'redis']);
    const high = topicOverlapScore(['redis', '缓存', '向量'], ['lesson', 'redis', '缓存', '向量']);
    expect(low.overlap).toBe(1);
    expect(high.overlap).toBe(3);
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.matched).toEqual(expect.arrayContaining(['redis', '缓存', '向量']));
  });

  it('returns zero score on no overlap or empty query', () => {
    expect(topicOverlapScore(['redis'], ['mongodb']).score).toBe(0);
    expect(topicOverlapScore([], ['redis']).score).toBe(0);
    expect(topicOverlapScore(['redis'], []).score).toBe(0);
  });

  it('is case-insensitive and ignores duplicate lesson tags', () => {
    const r = topicOverlapScore(['Redis', '向量'], ['REDIS', 'redis', '向量']);
    expect(r.overlap).toBe(2); // redis (去重后) + 向量
  });
});
