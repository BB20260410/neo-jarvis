import { describe, it, expect } from 'vitest';
import { createTypeErrorVerify } from '../../src/loop/NoeTypeErrorVerify.js';

// 块4 核心:包装 runtimeVerify——type_error goal 在 npm test 绿后,额外跑 typecheck + 防作弊价值锚。
//   !ok → 返回 {ok:false} → applyAndVerify 现有自动回滚。
// 【2026-06-29 bug 修复】fail-open 改 fail-closed:typecheck 跑不了/输出空 → 不能验证 → reject(绝不放行)。
//   根因:launchd PATH 无 npm → runTypecheck 空输出 → countFileTypeErrors('')=0 → 误判 after=0 总放行 = 假 complete。
const TC_AFTER0 = 'src/zzz.js(9,9): error TS9999: unrelated.'; // 非空(typecheck 真跑了,有别处 error),但不含目标 src/x.js → 目标 0 error
const TC_AFTER1 = 'src/x.js(82,3): error TS2322: still broken.'; // 目标仍有 error

function mk({ base = { ok: true, numTotalTests: 5 }, tc = () => TC_AFTER0, content = 'e instanceof Error ? e.message : e', before = 1 } = {}) {
  let tcCalled = 0;
  const verify = createTypeErrorVerify({
    runTypecheck: () => { tcCalled++; return tc(); },
    readFile: () => content,
    resolvePath: (r, f) => f,
  })({ baseVerify: async () => base, targetFile: 'src/x.js', beforeErrorCount: before, root: '/p' });
  return { verify, tcCalled: () => tcCalled };
}

describe('createTypeErrorVerify', () => {
  it('base 绿 + error 减少(1→0) + 文件干净 → ok', async () => {
    const { verify } = mk();
    const r = await verify({ root: '/p' });
    expect(r.ok).toBe(true);
  });

  it('base(npm test) 不绿 → 直接返回 base,不跑 typecheck', async () => {
    const m = mk({ base: { ok: false, error: 'test failed' } });
    const r = await m.verify({});
    expect(r.ok).toBe(false);
    expect(m.tcCalled()).toBe(0);
  });

  it('error 没减少(目标文件仍有 error) → ok:false(没真修)', async () => {
    const { verify } = mk({ tc: () => TC_AFTER1, before: 1 }); // 目标 after=1, before=1 → 未减少
    const r = await verify({});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/type_error_fix_rejected/);
  });

  it('文件含 @ts-ignore 作弊 → ok:false', async () => {
    const { verify } = mk({ content: '// @ts-ignore\nfoo.bar()', before: 1 });
    const r = await verify({});
    expect(r.ok).toBe(false);
  });

  it('【bug 修复】typecheck 跑不了(抛错) → fail-closed reject(不能验证就绝不放行,防假 complete)', async () => {
    const { verify } = mk({ tc: () => { throw new Error('tsc unavailable'); } });
    const r = await verify({});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/type_error_fix_rejected/);
  });

  it('【bug 修复】typecheck 输出空(launchd PATH 无 npm 那种) → fail-closed reject(不能误判 after=0 假 complete)', async () => {
    const { verify } = mk({ tc: () => '' });
    const r = await verify({});
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/type_error_fix_rejected/);
  });

  it('typecheck 真跑(非空,目标0 error)+readFile 抛错 → content 空,据 error 减少(1→0)通过', async () => {
    const verify = createTypeErrorVerify({
      runTypecheck: () => TC_AFTER0, // 非空:typecheck 真跑了,目标文件无 error
      readFile: () => { throw new Error('no file'); },
      resolvePath: (r, f) => f,
    })({ baseVerify: async () => ({ ok: true }), targetFile: 'src/x.js', beforeErrorCount: 1, root: '/p' });
    const r = await verify({});
    expect(r.ok).toBe(true);
  });
});
