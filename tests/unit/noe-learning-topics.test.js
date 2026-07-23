// @ts-check
import { describe, expect, it } from 'vitest';
import {
  NOE_LEARNING_TOPICS,
  learningTopicAtCursor,
  selectLearningTopicForText,
  collectLearningConcepts,
} from '../../src/cognition/NoeLearningTopics.js';
import { createTopicCurator } from '../../src/cognition/NoeTopicCurator.js';

describe('NoeLearningTopics', () => {
  it('keeps capability_discovery as the sixth autonomous learning topic', () => {
    expect(NOE_LEARNING_TOPICS).toHaveLength(6);
    expect(learningTopicAtCursor(5).title).toContain('capability_discovery');
    expect(learningTopicAtCursor(11).title).toContain('capability_discovery');
  });

  it('selects capability discovery for tool/plugin/MCP requests', () => {
    const topic = selectLearningTopicForText('帮 Noe 发现新的 MCP 工具和 plugin 能力');
    expect(topic.title).toContain('capability_discovery');
    expect(topic.localPaths).toContain('src/skills');
    expect(topic.localPaths).toContain('src/mcp');
  });
});

describe('NOE_LEARNING_CONCEPTS — 具体项目池(治 owner 实证「一直搜那几个」)', () => {
  it('collectLearningConcepts 返回 ≥20 个合法且 url 互异的 {title,url,query}', () => {
    const cs = collectLearningConcepts();
    expect(cs.length).toBeGreaterThanOrEqual(20);
    for (const c of cs) {
      expect(c.title).toBeTruthy();
      expect(c.url).toMatch(/^https:\/\/github\.com\//);
      expect(c.query).toBeTruthy();
    }
    expect(new Set(cs.map((c) => c.url)).size).toBe(cs.length); // url 互异,否则撞 add 去重
  });

  it('喂进 topicCurator → 选题从 6 种子扩到具体项目(搜的网页真多样化)', () => {
    const store = {};
    const kv = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
    const curator = createTopicCurator({ kv, seeds: NOE_LEARNING_TOPICS, poolCap: 48, now: () => 1 });
    const dyn = collectLearningConcepts();
    const picked = new Set();
    for (let i = 0; i < 20; i++) {
      const { topic } = curator.getNextTopic({ dynamicConcepts: dyn });
      if (!topic) break;
      picked.add(topic.title);
      curator.recordVisit(topic);
    }
    expect(picked.size).toBeGreaterThan(6); // 远超 6 种子,证明具体项目真进了选题
    const conceptTitles = new Set(dyn.map((c) => c.title));
    expect([...picked].some((t) => conceptTitles.has(t))).toBe(true); // 至少选到一个具体项目
  });
});
