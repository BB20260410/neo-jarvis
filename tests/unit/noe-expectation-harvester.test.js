import { describe, it, expect } from 'vitest';
import { createExpectationHarvester } from '../../src/cognition/NoeExpectationHarvester.js';

const T0 = 1_780_000_000_000;

function makeLedger({ detHits = 0 } = {}) {
  const added = [];
  return {
    added,
    harvestFromText: () => detHits,
    add: (e) => { added.push(e); return added.length; },
  };
}
const mkAdapter = (reply) => ({ chat: async () => ({ reply }) });

describe('NoeExpectationHarvester 期望抽取强化（M2）', () => {
  it('确定性命中即收，不再调 LLM', async () => {
    let llmCalled = 0;
    const h = createExpectationHarvester({
      ledger: makeLedger({ detHits: 1 }),
      getAdapter: () => ({ chat: async () => { llmCalled++; return { reply: '{}' }; } }),
      now: () => T0,
    });
    const r = await h.harvest('明天主人应该会继续做卡牌。');
    expect(r).toEqual({ added: 1, via: 'deterministic' });
    expect(llmCalled).toBe(0);
  });

  it('确定性未中 → LLM 兜底抽出 JSON 入账（p/days 钳制）', async () => {
    const ledger = makeLedger();
    const h = createExpectationHarvester({
      ledger,
      getAdapter: () => mkAdapter('<think>嗯</think>{"claim":"心跳这周会一直稳定运行","p":2.0,"days":99}'),
      now: () => T0,
    });
    const r = await h.harvest('我感觉这颗新心脏会一直跳下去。', { source: 'thought' });
    expect(r.via).toBe('llm');
    expect(r.added).toBe(1);
    expect(ledger.added[0].claim).toBe('心跳这周会一直稳定运行');
    expect(ledger.added[0].p).toBe(0.95); // 钳到上限
    expect(ledger.added[0].dueAt).toBe(T0 + 14 * 86_400_000); // days 钳到 14
  });

  it('LLM 判无预测 / 坏 JSON / 无大脑 / 抛错：全部静默 0 入账（fail-open）', async () => {
    const mk = (reply) => createExpectationHarvester({ ledger: makeLedger(), getAdapter: () => mkAdapter(reply), now: () => T0 });
    expect((await mk('{"none":true}').harvest('随便一句感慨而已')).via).toBe('llm_none');
    expect((await mk('我觉得没有').harvest('随便一句感慨而已')).via).toBe('llm_no_json');
    const noBrain = createExpectationHarvester({ ledger: makeLedger(), getAdapter: () => null, now: () => T0 });
    expect((await noBrain.harvest('随便一句感慨而已')).via).toBe('no_brain');
    const boom = createExpectationHarvester({ ledger: makeLedger(), getAdapter: () => ({ chat: async () => { throw new Error('x'); } }), now: () => T0 });
    expect((await boom.harvest('随便一句感慨而已')).via).toBe('llm_error');
  });

  it('太短文本直接跳过', async () => {
    const h = createExpectationHarvester({ ledger: makeLedger(), getAdapter: () => mkAdapter('{}'), now: () => T0 });
    expect((await h.harvest('嗯。')).via).toBe('skip');
  });
});
