import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { NoeTurnContextEngine } from '../../src/context/NoeTurnContextEngine.js';

// P0.5 注入契约：inner-state（P4 认知态）/ persona-pin（P8 人设下沉）两段的挂载点 + 白名单 + flag + fail-open + 反向 probe。
// 本 P 只钉契约（provider 由 P4/P8 注入），故这里用 stub provider 验证挂载点行为正确。

function makeEngine(deps = {}) {
  return new NoeTurnContextEngine({ logger: { warn: () => {} }, ...deps });
}

const INNER = '【此刻】我有点累，正专注在自我进化上';
const PERSONA = '【我是谁】我是 Noe，hxx 的私人 AI 伴侣';

// hermetic 隔离：每个用例前后都清掉两个 flag，确保「默认值」用例不被外部预置的 env 污染（多模型 review Issue4）。
// 注：inner-state 默认 ON、persona-pin 默认 OFF（persona-pin 注入生产 system prompt 属分量动作，留 owner kickstart）。
beforeEach(() => {
  delete process.env.NOE_TURN_INNER_STATE;
  delete process.env.NOE_MEMORY_PERSONA_PIN;
});
afterEach(() => {
  delete process.env.NOE_TURN_INNER_STATE;
  delete process.env.NOE_MEMORY_PERSONA_PIN;
});

describe('P0.5 inner-state 段契约', () => {
  it('provider 注入 + flag 默认 ON → 段注入，且 provider 收到 transcript/projectId', async () => {
    const seen = [];
    const r = await makeEngine({
      innerStateProvider: (arg) => { seen.push(arg); return INNER; },
    }).supplyTurnContext({ transcript: '在吗', projectId: 'noe' });
    expect(r.text).toContain(INNER);
    expect(seen[0]).toMatchObject({ transcript: '在吗', projectId: 'noe' });
  });

  it('provider 抛错 → fail-open（不加段、不崩，其余段照常）', async () => {
    const r = await makeEngine({
      innerStateProvider: () => { throw new Error('affect probe down'); },
    }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain(INNER);
    expect(r.text).toContain('<noe-self-knowledge>'); // 其余段不受影响
  });

  it('provider 返回空 → 不加段（无空段污染）', async () => {
    const r = await makeEngine({ innerStateProvider: () => '' }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain(INNER);
  });

  it('NOE_TURN_INNER_STATE=0 → 段关闭（即便 provider 在）', async () => {
    process.env.NOE_TURN_INNER_STATE = '0';
    const r = await makeEngine({ innerStateProvider: () => INNER }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain(INNER);
  });

  it('sections 白名单不含 inner-state → 段不跑（连 provider 都不调）', async () => {
    let called = false;
    const r = await makeEngine({
      innerStateProvider: () => { called = true; return INNER; },
    }).supplyTurnContext({ transcript: '在吗', sections: ['recall'] });
    expect(r.text).not.toContain(INNER);
    expect(called).toBe(false);
  });

  it('inner-state 注入位置在 self-knowledge 之后区段（契约：先此刻状态再召回）', async () => {
    const r = await makeEngine({ innerStateProvider: () => INNER }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text.indexOf(INNER)).toBeGreaterThan(r.text.indexOf('<noe-self-knowledge>'));
  });
});

describe('P0.5 persona-pin 段契约', () => {
  // persona-pin 是分量动作（注入生产 system prompt 的稳定人设/记忆角色定位）：默认 OFF 留 owner kickstart。
  it('flag 默认 OFF（未设 env）→ 段不注入，即便 provider 在', async () => {
    const r = await makeEngine({ personaPinProvider: () => PERSONA }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain(PERSONA);
    // self-knowledge 仍在 = 其余段不受影响
    expect(r.text).toContain('<noe-self-knowledge>');
  });

  it('NOE_MEMORY_PERSONA_PIN=1（owner 显式 kickstart）→ 段注入，紧随 self-knowledge', async () => {
    process.env.NOE_MEMORY_PERSONA_PIN = '1';
    const r = await makeEngine({ personaPinProvider: () => PERSONA }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).toContain(PERSONA);
    // 人设类聚拢：persona-pin 在 self-knowledge 之后
    expect(r.text.indexOf(PERSONA)).toBeGreaterThan(r.text.indexOf('<noe-self-knowledge>'));
  });

  it('NOE_MEMORY_PERSONA_PIN=0（显式关）→ 段关闭', async () => {
    process.env.NOE_MEMORY_PERSONA_PIN = '0';
    const r = await makeEngine({ personaPinProvider: () => PERSONA }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain(PERSONA);
  });

  it('provider 抛错（flag ON）→ fail-open', async () => {
    process.env.NOE_MEMORY_PERSONA_PIN = '1';
    const r = await makeEngine({
      personaPinProvider: () => { throw new Error('persona store down'); },
    }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).toContain('<noe-self-knowledge>');
  });
});

describe('P0.5 反向 probe（零行为变化）', () => {
  it('不注入任何 provider（默认）→ 两段完全不出现，等同改造前', async () => {
    const r = await makeEngine().supplyTurnContext({ transcript: '在吗' });
    expect(r.text).not.toContain('inner-state');
    expect(r.text).not.toContain('persona-pin');
    expect(r.text).not.toContain(INNER);
    expect(r.text).not.toContain(PERSONA);
    // self-knowledge 仍在 = 既有行为未被破坏
    expect(r.text).toContain('<noe-self-knowledge>');
    expect(r.dropped).toEqual([]);
  });
});
