// 审计 §3.3 P1⑤ / P2③ 测试：充分性 id 匹配收窄到 kind/ref、去重归一覆盖 CJK 扩展区与全角数字
import { describe, expect, it } from 'vitest';
import { evaluateNoeContextSufficiency } from '../../src/context/NoeContextSufficiencyGatherer.js';
import { normalizeForDedup } from '../../src/memory/NoeMemoryDedup.js';

describe('§3.3 P1⑤ 充分性 id 只匹配 kind/ref', () => {
  it('无 keywords 的短 id 只在 source 正文出现时不算满足（不再形同虚设）', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '测试',
      requiredContext: [{ id: 'user' }], // 无 keywords、短 id
      contextBundle: {
        sources: [{ kind: 'brief', ref: 'output/brief.md', text: 'the user asked about the weather today' }],
      },
    });
    // 'user' 仅在 text 出现（kind/ref 不含）→ 修复后不满足该 requirement
    expect(result.sufficient).toBe(false);
  });

  it('id 命中 kind 仍算满足', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '测试',
      requiredContext: [{ id: 'identity' }],
      contextBundle: {
        sources: [{ kind: 'identity', ref: 'output/identity.md', text: 'owner profile here' }],
      },
    });
    expect(result.sufficient).toBe(true); // kind='identity' 精确匹配
  });
});

describe('§3.3 P2③ normalizeForDedup 覆盖 CJK 扩展区/全角数字', () => {
  it('CJK 扩展 B 汉字保留（不再被当标点删）', () => {
    expect(normalizeForDedup('𠀀甲乙')).toBe('𠀀甲乙');
  });

  it('全角数字保留，标点被删', () => {
    expect(normalizeForDedup('价格１２３元。')).toBe('价格１２３元');
  });

  it('基本汉字 + ASCII + 半角数字行为不变', () => {
    expect(normalizeForDedup('我喜欢Coffee123！')).toBe('我喜欢coffee123');
  });

  it('纯标点空白归一为空', () => {
    expect(normalizeForDedup('！？。，  ')).toBe('');
  });
});
