// @ts-check
// P1.2 P10：NoeTopicDiscovery 动态发现（带 evidence/source/score）并入 GoalSystem 选题（不只静态 seed）。
//   反向 probe：注入 discoverDynamicTopics → 376 并入动态(evidence 保留不剥)；未注入→纯静态(零回归)；源抛错→fail-open 回退静态。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-p10-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

const DYN = { title: '动态发现主题', url: 'https://example.com/dyn-topic', query: 'dynamic discovery q', source: 'kg_entity', evidence: { name: 'X', mentionCount: 5 }, score: 0.8 };

function mockCurator() {
  const state = { captured: null };
  return {
    state,
    getNextTopic(args) { state.captured = args; return { topic: (args.dynamicConcepts || [])[0] || null, reason: 'test' }; },
    recordVisit() {},
  };
}

function withDynamicTopicsEnv(fn) {
  const prevDyn = process.env.NOE_DYNAMIC_TOPICS;
  const prevAuto = process.env.NOE_AUTONOMOUS_LEARNING;
  process.env.NOE_DYNAMIC_TOPICS = '1';
  process.env.NOE_AUTONOMOUS_LEARNING = '1'; // maybeSeedAutonomousLearning 的 enable 门（NoeGoalSystem:365）
  try { return fn(); } finally {
    if (prevDyn === undefined) delete process.env.NOE_DYNAMIC_TOPICS; else process.env.NOE_DYNAMIC_TOPICS = prevDyn;
    if (prevAuto === undefined) delete process.env.NOE_AUTONOMOUS_LEARNING; else process.env.NOE_AUTONOMOUS_LEARNING = prevAuto;
  }
}

describe('P1.2 P10 动态发现接选题', () => {
  it('注入 discoverDynamicTopics → 376 并入动态发现(带 evidence)，静态+动态共存', () => {
    withDynamicTopicsEnv(() => {
      const curator = mockCurator();
      const gs = createGoalSystem({ topicCurator: curator, discoverDynamicTopics: () => [DYN] });
      gs.maybeSeedAutonomousLearning(Date.now());
      const concepts = curator.state.captured?.dynamicConcepts || [];
      const dyn = concepts.find((c) => c.url === DYN.url);
      expect(dyn).toBeTruthy();                 // 动态发现真进了选题池（机制失效则只有静态）
      expect(dyn.evidence).toEqual(DYN.evidence); // evidence 保留不被剥（P1.2 核心）
      expect(dyn.source).toBe('kg_entity');
      expect(dyn.score).toBe(0.8);
      expect(concepts.length).toBeGreaterThan(1); // 并入非替换（静态 seed 仍在）
    });
  });

  it('零回归：未注入 discoverDynamicTopics → 只静态 seed', () => {
    withDynamicTopicsEnv(() => {
      const curator = mockCurator();
      const gs = createGoalSystem({ topicCurator: curator });
      gs.maybeSeedAutonomousLearning(Date.now());
      const concepts = curator.state.captured?.dynamicConcepts || [];
      expect(concepts.length).toBeGreaterThan(0);                       // 静态 seed 在
      expect(concepts.find((c) => c.url === DYN.url)).toBeFalsy();      // 无动态
    });
  });

  it('fail-open：discoverDynamicTopics 抛错 → 回退纯静态，不阻断选题', () => {
    withDynamicTopicsEnv(() => {
      const curator = mockCurator();
      const gs = createGoalSystem({ topicCurator: curator, discoverDynamicTopics: () => { throw new Error('动态源挂了'); } });
      gs.maybeSeedAutonomousLearning(Date.now());
      // fail-open 核心：动态源抛错没阻断选题（getNextTopic 仍被调 = 到了选题逻辑）+ 回退纯静态。
      const concepts = curator.state.captured?.dynamicConcepts || [];
      expect(concepts.length).toBeGreaterThan(0);                       // 静态 seed 在（不崩，回退静态）
      expect(concepts.find((c) => c.url === DYN.url)).toBeFalsy();      // 抛错的动态没混进
    });
  });

  it('P0#2：动态发现种子排在静态 concepts 之前（防 curator poolCap 截断挤出 TopicDiscovery）', () => {
    withDynamicTopicsEnv(() => {
      const curator = mockCurator();
      const gs = createGoalSystem({ topicCurator: curator, discoverDynamicTopics: () => [DYN] });
      gs.maybeSeedAutonomousLearning(Date.now());
      const concepts = curator.state.captured?.dynamicConcepts || [];
      const dynIdx = concepts.findIndex((c) => c.url === DYN.url);
      const staticIdx = concepts.findIndex((c) => c.url && c.url !== DYN.url);
      expect(dynIdx).toBeGreaterThanOrEqual(0);
      expect(staticIdx).toBeGreaterThanOrEqual(0);
      expect(dynIdx).toBeLessThan(staticIdx); // 动态发现排静态前 → pool.slice(poolCap) 先保动态、不被静态挤出
    });
  });
});
