import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { deriveSurpriseOrigin, isLoosenOnlyFailure, isNonNoiseSurpriseOrigin } from '../../src/cognition/NoeExpectationResolver.js';

// P1-C 双代理验收整改（F1 loosen_fail 噪声桶 / F2 据 source 推导不硬编码 / F3 门 b 消费端可执行）

describe('P1-C surprise origin 分桶（双代理验收整改）', () => {
  describe('deriveSurpriseOrigin（F2：据 source 推导，不硬编码 action_failure）', () => {
    it('loosenOnly 优先标 loosen_fail（F1 噪声桶，覆盖 source）', () => {
      expect(deriveSurpriseOrigin('action', { loosenOnly: true })).toBe('loosen_fail');
      expect(deriveSurpriseOrigin('owner-pred:topic', { loosenOnly: true })).toBe('loosen_fail');
    });
    it('owner→owner_prediction；reflection→reflection_miss；action/goal→action_failure', () => {
      expect(deriveSurpriseOrigin('owner-pred:topic')).toBe('owner_prediction');
      expect(deriveSurpriseOrigin('owner-pred:followup')).toBe('owner_prediction');
      expect(deriveSurpriseOrigin('reflection')).toBe('reflection_miss');
      expect(deriveSurpriseOrigin('action')).toBe('action_failure');
      expect(deriveSurpriseOrigin('noe.goal_step.act')).toBe('action_failure');
    });
    it('DERIVE-REGEX：含 action 子串的非 action source 不误命中（分隔符词界，复核优化）', () => {
      expect(deriveSurpriseOrigin('transaction')).toBe('expectation_miss');
      expect(deriveSurpriseOrigin('interaction')).toBe('expectation_miss');
      expect(deriveSurpriseOrigin('owner_interaction')).toBe('owner_prediction'); // owner 前缀优先于 action
    });
    it('thought/self-obs/未知→expectation_miss（F2 铁证：非 action 预测不再误标 action_failure）', () => {
      expect(deriveSurpriseOrigin('thought')).toBe('expectation_miss');
      expect(deriveSurpriseOrigin('self-observation')).toBe('expectation_miss');
      expect(deriveSurpriseOrigin(undefined)).toBe('expectation_miss');
    });
  });

  describe('isLoosenOnlyFailure（F1：区分 loosen 噪声 vs 真失败）', () => {
    it('loosenFail=OFF → 恒 false', () => expect(isLoosenOnlyFailure('result=cancelled', false)).toBe(false));
    it('仅 loose 失败词(cancelled) → true', () => expect(isLoosenOnlyFailure('证据：任务 cancelled 了', true)).toBe(true));
    it('含 base 失败词(failed) → false（真失败非噪声）', () => expect(isLoosenOnlyFailure('任务 failed 并 cancelled', true)).toBe(false));
    it('无失败词 → false', () => expect(isLoosenOnlyFailure('任务完成', true)).toBe(false));
    it('F1-HASBASE：含 BASE 结构化信号 ok=false/error=true → false（真失败非 loosen 噪声，复核优化）', () => {
      expect(isLoosenOnlyFailure('aborted=true\nok=false', true)).toBe(false);
      expect(isLoosenOnlyFailure('cancelled，error=true', true)).toBe(false);
    });
  });

  describe('isNonNoiseSurpriseOrigin（F3：门 b 判据）', () => {
    it('owner_*/action_failure = 非噪声', () => {
      expect(isNonNoiseSurpriseOrigin('owner_prediction')).toBe(true);
      expect(isNonNoiseSurpriseOrigin('owner_manual')).toBe(true);
      expect(isNonNoiseSurpriseOrigin('action_failure')).toBe(true);
    });
    it('loosen_fail/reflection_miss/expectation_miss/unspecified = 噪声', () => {
      expect(isNonNoiseSurpriseOrigin('loosen_fail')).toBe(false);
      expect(isNonNoiseSurpriseOrigin('expectation_miss')).toBe(false);
      expect(isNonNoiseSurpriseOrigin('unspecified')).toBe(false);
    });
  });

  describe('origin 真落 goal.meta.origin + surpriseOriginBreakdown（代码实证 #1 + F3 消费端）', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-origin-')); initSqlite(join(dir, 'test.db')); });
    afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });

    it('harvestSurprise 的 origin 真写进 goal.meta.origin（落库回读）', () => {
      const gs = createGoalSystem({ now: () => 1000 });
      const id = gs.harvestSurprise({ claim: '部署落空', surprise: 3.0, origin: 'action_failure' });
      expect(id).toBeTruthy();
      expect(gs.get(id).meta.origin).toBe('action_failure');
    });

    it('无 origin + decompose off → meta=null（OFF 零回归基线）', () => {
      const gs = createGoalSystem({ now: () => 1000 });
      const id = gs.harvestSurprise({ claim: '某念头', surprise: 3.0 });
      expect(gs.get(id).meta).toBeNull();
    });

    it('surpriseOriginBreakdown 按 origin 分桶 + non-noise 计数（门 b 可执行）', () => {
      const gs = createGoalSystem({ now: () => 1000 });
      gs.harvestSurprise({ claim: 'a', surprise: 3.0, origin: 'action_failure' });
      gs.harvestSurprise({ claim: 'b', surprise: 3.0, origin: 'owner_prediction' });
      gs.harvestSurprise({ claim: 'c', surprise: 3.0, origin: 'loosen_fail' });
      const bd = gs.surpriseOriginBreakdown();
      expect(bd.total).toBe(3);
      expect(bd.nonNoise).toBe(2); // action_failure + owner_prediction
      expect(bd.noise).toBe(1); // loosen_fail
      expect(bd.byOrigin).toMatchObject({ action_failure: 1, owner_prediction: 1, loosen_fail: 1 });
    });

    it('F3 接线：goalSystem.stats() 含 surpriseOrigins（被 mind route 生产消费→门 b 进运行时）', () => {
      const gs = createGoalSystem({ now: () => 1000 });
      gs.harvestSurprise({ claim: 'x', surprise: 3.0, origin: 'owner_prediction' });
      gs.harvestSurprise({ claim: 'y', surprise: 3.0, origin: 'loosen_fail' });
      const s = gs.stats();
      expect(s.surpriseOrigins).toBeDefined();
      expect(s.surpriseOrigins.nonNoise).toBe(1); // owner_prediction
      expect(s.surpriseOrigins.noise).toBe(1); // loosen_fail
    });

    it('F4-REOPEN 守卫：undefined origin(应验 outcome=1) 落噪声 vs owner_manual(落空 outcome=0) 落非噪声', () => {
      // 锁定 noeMind harvestSurprise 的 outcome===0?'owner_manual':undefined 守卫语义：
      // 仅 owner 手动判落空(outcome=0)算门 b 非噪声；应验(outcome=1)的高惊奇 origin=undefined→噪声。
      const gs = createGoalSystem({ now: () => 1000 });
      gs.harvestSurprise({ claim: '应验高惊奇', surprise: 3.0, origin: undefined }); // noeMind outcome=1 路径
      gs.harvestSurprise({ claim: 'owner判落空', surprise: 3.0, origin: 'owner_manual' }); // noeMind outcome=0 路径
      const bd = gs.surpriseOriginBreakdown();
      expect(bd.nonNoise).toBe(1); // 仅 owner_manual
      expect(bd.noise).toBe(1); // undefined→unspecified→噪声桶
    });
  });
});
