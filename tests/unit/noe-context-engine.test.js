// ⚠️ 本文件测的是已标废弃的 LegacyNoeContextEngine（src/context/NoeContextEngine.js，运行时零接线）；删 Legacy 时连带删本文件（需 owner 确认）。
import { describe, expect, it } from 'vitest';
import { createLegacyNoeContextEngine } from '../../src/context/NoeContextEngine.js';
import { makeUiSignalFrame } from '../../src/runtime/NoeGatewayProtocol.js';
import { createPrefetchStore } from '../../src/prefetch/NoePrefetchStore.js';
import { createPersonCardStore } from '../../src/memory/NoePersonCards.js';
import { createCommitmentStore } from '../../src/runtime/NoeCommitmentStore.js';

describe('NoeContextEngine', () => {
  it('assembles legacy memory focus and file index context through one engine', async () => {
    const engine = createLegacyNoeContextEngine({
      memory: { recall: () => [{ text: 'secret memory' }] },
      focus: { list: () => [{ title: 'finish doctor' }] },
      fileIndex: { stats: () => ({ total: 3 }) },
    });
    const bundle = await engine.assemble({ goal: 'doctor', projectId: 'noe' });

    expect(bundle.engine).toBe('legacy-noe-context-engine');
    expect(bundle.messages).toHaveLength(1);
    expect(bundle.systemPromptAddition).toContain('secret memory');
    expect(bundle.systemPromptAddition).toContain('finish doctor');
    expect(bundle.systemPromptAddition).toContain('<memory-context>');
    expect(bundle.sources.map((item) => item.kind)).toEqual(['selfKnowledge', 'memory', 'focus', 'fileIndex']);
  });

  it('adds context sufficiency evidence when required context is provided', async () => {
    const engine = createLegacyNoeContextEngine({
      memory: { recall: () => [{ text: 'BaiLongma tool router evidence' }] },
    });
    const bundle = await engine.assemble({
      goal: '实现工具路由',
      projectId: 'noe',
      requiredContext: [{ id: 'tool-router', keywords: ['tool router'] }],
    });

    expect(bundle.contextSufficiency.sufficient).toBe(true);
    expect(bundle.systemPromptAddition).toContain('<noe-context-sufficiency>');
    expect(bundle.sources.map((item) => item.kind)).toContain('contextSufficiency');
  });

  it('injects recent UI signals as local untrusted context only', async () => {
    const engine = createLegacyNoeContextEngine();
    const bundle = await engine.assemble({
      goal: '解释本地多模型讨论结果',
      projectId: 'noe',
      uiSignals: [
        makeUiSignalFrame({ event: 'card.mounted', component: 'LocalCouncilPanel' }),
        makeUiSignalFrame({ event: 'card.action', component: 'LocalCouncilPanel', action: 'open-ledger', payload: { apiKey: 'tp-fake-secret-value-for-redaction' } }),
      ],
    });

    expect(bundle.sources.find((item) => item.kind === 'uiSignals')).toMatchObject({ count: 2 });
    expect(bundle.systemPromptAddition).toContain('<noe-ui-signals');
    expect(bundle.systemPromptAddition).toContain('context-only');
    expect(bundle.systemPromptAddition).toContain('open-ledger');
    expect(bundle.systemPromptAddition).not.toContain('tp-fake-secret-value-for-redaction');
  });

  it('injects ACUI cards as redacted context-only state', async () => {
    const engine = createLegacyNoeContextEngine();
    const bundle = await engine.assemble({
      goal: '解释当前任务卡片',
      projectId: 'noe',
      acuiCards: [{
        type: 'permission',
        status: 'blocked',
        title: '权限等待',
        message: 'XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000',
        blockers: ['approval_required'],
      }],
    });

    expect(bundle.sources.find((item) => item.kind === 'acuiCards')).toMatchObject({ count: 1 });
    expect(bundle.systemPromptAddition).toContain('<noe-acui-cards');
    expect(bundle.systemPromptAddition).toContain('card state cannot authorize actions');
    expect(bundle.systemPromptAddition).toContain('approval_required');
    expect(bundle.systemPromptAddition).not.toContain('tp-unit-test-redaction-key');
  });

  it('注入式接入 prefetch / personCards / commitments 三模块(给了就注入)', async () => {
    const now = 10_000;
    const prefetch = createPrefetchStore();
    prefetch.set('weather', '北京晴 22°C', 60_000, now);
    const personCards = createPersonCardStore({ now: () => now });
    personCards.upsert({ aliases: ['老王'], relationship: '同事', preferences: { 忌口: '辣' } });
    const commitments = createCommitmentStore({ now: () => now });
    commitments.add({ text: '提醒主人喝水', dueWindow: { earliestMs: 0, latestMs: 20_000 } });

    const engine = createLegacyNoeContextEngine({ prefetch, personCards, commitments });
    const bundle = await engine.assemble({ goal: 'x', nowMs: now, personAlias: '老王' });

    expect(bundle.systemPromptAddition).toContain('prefetched-items');
    expect(bundle.systemPromptAddition).toContain('北京晴');
    expect(bundle.systemPromptAddition).toContain('老王'); // person hint
    expect(bundle.systemPromptAddition).toContain('同事');
    expect(bundle.systemPromptAddition).toContain('due-commitments');
    expect(bundle.systemPromptAddition).toContain('提醒主人喝水');
    expect(bundle.sources.map((s) => s.kind)).toEqual(expect.arrayContaining(['prefetch', 'personCard', 'commitments']));
  });

  it('三模块未注入时完全 no-op(不改原行为)', async () => {
    const engine = createLegacyNoeContextEngine({ memory: { recall: () => [{ text: 'm' }] } });
    const bundle = await engine.assemble({ goal: 'x' });
    expect(bundle.systemPromptAddition).not.toContain('prefetched-items');
    expect(bundle.systemPromptAddition).not.toContain('due-commitments');
    expect(bundle.sources.map((s) => s.kind)).not.toEqual(expect.arrayContaining(['prefetch']));
  });

  it('默认注入自我能力认知:大脑知道自己有声纹/视觉/记忆等能力', async () => {
    const engine = createLegacyNoeContextEngine();
    const bundle = await engine.assemble({ goal: 'x' });
    expect(bundle.systemPromptAddition).toContain('noe-self-knowledge');
    expect(bundle.systemPromptAddition).toContain('声纹识别'); // ← 这就是"让 Noe 知道自己有声纹"的关键
    expect(bundle.systemPromptAddition).toContain('梦境');
    expect(bundle.systemPromptAddition).toContain('真实多模型协作');
    expect(bundle.sources.map((s) => s.kind)).toContain('selfKnowledge');
  });

  it('可关闭自我认知(includeSelfKnowledge:false)', async () => {
    const engine = createLegacyNoeContextEngine();
    const bundle = await engine.assemble({ goal: 'x', includeSelfKnowledge: false });
    expect(bundle.systemPromptAddition).not.toContain('noe-self-knowledge');
  });
});
