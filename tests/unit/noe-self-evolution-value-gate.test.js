// @ts-check
// P0 真实价值闸（第七道叠加只读闸）单测——堵住"零价值孤儿走完 complete"。
// 核心反向 probe：孤儿(NoeEvolutionMilestone 式)必须被挡、真改进必须放行、flag OFF 零回归。
import { describe, expect, it } from 'vitest';
import { evaluateNoeSelfEvolutionValueGate } from '../../src/room/NoeSelfEvolutionValueGate.js';

function cycle(touchedFiles) {
  return { goal: '测试目标', implementation: { ok: true, touchedFiles } };
}
// 注入式只读引用探针（DI）：测试用 stub，不碰真实 fs/grep。
const orphanProbe = () => ({ referenced: false, hits: [] });
const firstReferencedProbe = (rel) => ({ referenced: /RealHelper/.test(String(rel)), hits: [] });

describe('NoeSelfEvolutionValueGate（self-evolution complete 真实价值闸·第七道叠加只读闸）', () => {
  it('flag OFF（默认）→ skipped，零回归不做价值判定', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['src/util/NoeEvolutionMilestone.js']), { enabled: false, referenceProbe: orphanProbe });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('flag ON + 改动的源文件全仓零引用 → orphan_no_reference，挡下孤儿盖章', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['src/util/NoeEvolutionMilestone.js']), { enabled: true, referenceProbe: orphanProbe });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.errors.some((e) => String(e).startsWith('orphan_no_reference'))).toBe(true);
  });

  it('flag ON + 至少一个源文件被全仓引用 → 放行（真改进通过）', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['src/util/RealHelper.js']), { enabled: true, referenceProbe: firstReferencedProbe });
    expect(r.ok).toBe(true);
  });

  it('flag ON + 只触碰非源文件（docs/.md、config.json）→ 价值闸不按引用性卡，放行', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['docs/NOTE.md', 'package.json']), { enabled: true, referenceProbe: orphanProbe });
    expect(r.ok).toBe(true);
  });

  it('flag ON + 无 touchedFiles → 价值闸不误拦（交由其它闸判定）', () => {
    const r = evaluateNoeSelfEvolutionValueGate({ goal: 'g', implementation: { ok: true } }, { enabled: true, referenceProbe: orphanProbe });
    expect(r.ok).toBe(true);
  });

  it('混合：零引用孤儿 + 被引用文件 → 放行（存在真实锚点即可）', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['src/util/NoeEvolutionMilestone.js', 'src/util/RealHelper.js']), { enabled: true, referenceProbe: firstReferencedProbe });
    expect(r.ok).toBe(true);
  });

  it('忽略测试文件：新增的 .test.js 不参与引用性判定（避免拿测试桩当锚点或误卡）', () => {
    const r = evaluateNoeSelfEvolutionValueGate(cycle(['tests/unit/foo.test.js']), { enabled: true, referenceProbe: orphanProbe });
    expect(r.ok).toBe(true);
  });
});
