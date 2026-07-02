import { describe, expect, it } from 'vitest';
import {
  buildNoeContextSufficiencyBlock,
  evaluateNoeContextSufficiency,
} from '../../src/context/NoeContextSufficiencyGatherer.js';

describe('NoeContextSufficiencyGatherer', () => {
  it('passes when required context is present in safe sources', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '实现工具路由',
      requiredContext: [{ id: 'tool-router', keywords: ['tool router'] }],
      contextBundle: {
        sources: [{ kind: 'brief', ref: 'output/brief.md', text: 'BaiLongma has a tool router and find_tool flow.' }],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sufficient).toBe(true);
    expect(result.missingContext).toEqual([]);
  });

  it('blocks critical missing context and round budget exhaustion', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '执行动作',
      requiredContext: [{ id: 'permission evidence', critical: true, keywords: ['permission'] }],
      contextBundle: { sources: [{ kind: 'brief', text: 'approval data is absent' }] },
      maxRounds: 1,
      roundsUsed: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.sufficient).toBe(false);
    expect(result.blockers).toContain('critical_context_missing');
    expect(result.blockers).toContain('context_gather_round_budget_exhausted');
  });

  it('blocks sensitive sources and redacts secret-looking values', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '读取配置',
      requiredContext: [],
      contextBundle: {
        sources: [{ kind: 'file', ref: '.env', text: 'XIAOMI_API_KEY=tp-unitsecret000000000000000000000000000000' }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.blockers.some((item) => item.startsWith('blocked_sensitive_source:file'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('tp-unitsecret');
  });

  it('builds a visible sufficiency block for prompt context', () => {
    const result = evaluateNoeContextSufficiency({
      goal: '计划',
      requiredContext: [{ id: 'brief', keywords: ['brief'] }],
      contextBundle: { messages: [{ role: 'system', content: 'brief exists' }] },
    });
    const block = buildNoeContextSufficiencyBlock(result);

    expect(block).toContain('<noe-context-sufficiency>');
    expect(block).toContain('"sufficient": true');
  });
});
