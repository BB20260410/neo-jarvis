import { describe, it, expect } from 'vitest';
import { createEvolutionLogicGate } from '../../src/loop/NoeEvolutionLogicGate.js';

// P3 受控逻辑改进门：把「改逻辑」从无门 apply → 受控。
//   doc_only/neutral 放行（当前行为不变）；logic_changed 默认拒（flag OFF）；
//   flag ON 时 logic_changed 需双绿门（改前绿 baseline + 改后绿 verify）；test_only（纯增量补测试）豁免，只需绿。
//   纯函数 + DI（logicEnabled/isTestPath），便于单测。preCheck 早拒省 verify，postCheck 双绿门。

const mkSummary = (verdict, extra = {}) => ({ verdict, codeChanged: verdict === 'logic_changed' ? 4 : 0, jsdocImproved: verdict === 'doc_only' ? 1 : 0, filesChanged: 1, ...extra });
const SRC = ['src/a.js'];
const TESTS = ['tests/unit/a.test.js'];

describe('NoeEvolutionLogicGate', () => {
  describe('classify', () => {
    it('全 test 路径 → test_only', () => {
      const g = createEvolutionLogicGate();
      expect(g.classify(['tests/unit/a.test.js', 'tests/x.test.js'])).toBe('test_only');
    });
    it('含 src 路径 → src', () => {
      const g = createEvolutionLogicGate();
      expect(g.classify(['tests/a.test.js', 'src/a.js'])).toBe('src');
    });
    it('空路径 → src（保守，当作改 src）', () => {
      const g = createEvolutionLogicGate();
      expect(g.classify([])).toBe('src');
    });
  });

  describe('preCheck（早拒，省 verify）', () => {
    it('doc_only → 不 block（当前行为不受限）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      expect(g.preCheck({ summary: mkSummary('doc_only'), paths: SRC }).block).toBe(false);
    });
    it('neutral → 不 block', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      expect(g.preCheck({ summary: mkSummary('neutral'), paths: SRC }).block).toBe(false);
    });
    it('logic_changed + flag OFF → block(logic_change_disabled)', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      const r = g.preCheck({ summary: mkSummary('logic_changed'), paths: SRC });
      expect(r.block).toBe(true);
      expect(r.reason).toBe('logic_change_disabled');
    });
    it('logic_changed + test_only paths → 不 block（纯增量豁免，即便 flag OFF）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      expect(g.preCheck({ summary: mkSummary('logic_changed'), paths: TESTS }).block).toBe(false);
    });
    it('logic_changed + flag ON → 不 block（留给 postCheck 双绿门）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => true });
      expect(g.preCheck({ summary: mkSummary('logic_changed'), paths: SRC }).block).toBe(false);
    });
  });

  describe('postCheck（双绿门）', () => {
    it('doc_only → allow（不受门限）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      expect(g.postCheck({ summary: mkSummary('doc_only'), paths: SRC, baselineGreen: false, verifyGreen: true }).allow).toBe(true);
    });
    it('logic_changed + flag ON + 双绿 → allow(logic_change_verified)', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => true });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: SRC, baselineGreen: true, verifyGreen: true });
      expect(r.allow).toBe(true);
      expect(r.reason).toBe('logic_change_verified');
    });
    it('logic_changed + flag ON + baseline 不绿 → reject(baseline_not_green)', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => true });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: SRC, baselineGreen: false, verifyGreen: true });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('baseline_not_green');
    });
    it('logic_changed + flag ON + verify 不绿 → reject(verify_not_green)', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => true });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: SRC, baselineGreen: true, verifyGreen: false });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('verify_not_green');
    });
    it('logic_changed + flag OFF → reject(logic_change_disabled)（postCheck 兜底）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: SRC, baselineGreen: true, verifyGreen: true });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('logic_change_disabled');
    });
    it('test_only + verify 绿 → allow（纯增量只需绿，免 baseline）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: TESTS, baselineGreen: false, verifyGreen: true });
      expect(r.allow).toBe(true);
      expect(r.reason).toBe('test_increment');
    });
    it('test_only + verify 不绿 → reject(verify_not_green)', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      const r = g.postCheck({ summary: mkSummary('logic_changed'), paths: TESTS, baselineGreen: false, verifyGreen: false });
      expect(r.allow).toBe(false);
      expect(r.reason).toBe('verify_not_green');
    });
  });

  describe('fail-open / 边界', () => {
    it('无 summary → 不 block / allow（缺度量不阻断闭环）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => false });
      expect(g.preCheck({ summary: null, paths: SRC }).block).toBe(false);
      expect(g.postCheck({ summary: null, paths: SRC, baselineGreen: true, verifyGreen: true }).allow).toBe(true);
    });
    it('logicEnabled 抛错 → 视为 OFF（保守拒改逻辑）', () => {
      const g = createEvolutionLogicGate({ logicEnabled: () => { throw new Error('x'); } });
      expect(g.preCheck({ summary: mkSummary('logic_changed'), paths: SRC }).block).toBe(true);
    });
    it('自定义 isTestPath 生效', () => {
      const g = createEvolutionLogicGate({ isTestPath: (p) => p.endsWith('.spec.js') });
      expect(g.classify(['x.spec.js'])).toBe('test_only');
      expect(g.classify(['tests/a.test.js'])).toBe('src'); // 默认规则被覆盖
    });
  });
});
