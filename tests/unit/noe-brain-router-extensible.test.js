import { describe, it, expect } from 'vitest';
import {
  createBrainRouter,
  DEFAULT_BRAIN_ROUTER_RULES,
  DEFAULT_SIGNAL_PROBES,
} from '../../src/room/BrainRouter.js';

// 这组用例覆盖默认五条规则各自的命中路径，用于「重构等价」回归。
const EQUIV_INPUTS = [
  { text: '你好' },
  { text: '帮我把这段日志做个摘要' },
  { text: '安慰我一下吧' },
  { text: '帮我实现一个登录功能' },
  { text: '重构这个模块' },
  { text: '执行命令 ls -la' },
  { text: '修一下这个 bug' },
  { text: '随便说点啥', requiresTools: true },
  { text: '深入分析这两个方案的权衡' },
  { text: '帮我做个架构设计' },
  { text: '审查一下这个方案' },
  { text: '复盘一下这次的得失' },
  { text: '帮我写一篇关于杭州的游记' },
  { text: '帮我润色这段文案' },
  { text: '把这段话翻译成英文' },
  { text: '介绍一下杭州的历史和美食' },
  { text: '推荐一部电影' },
  { text: '讲点限制级的内容' },
  { query: '写个排序算法' },
  { content: '随便聊聊' },
  { text: '', requiresShell: true },
  { text: '把这个文件移动到别处', requiresFileSystem: true },
  { text: '' },
];

// 不依赖内部实现、直接对照「历史 route()」语义的参照实现（用于等价校验的金标准）。
function legacyRoute(input) {
  const t = String(input.text ?? input.query ?? input.content ?? '').trim();
  const requiresExec = Boolean(input.requiresTools || input.requiresShell || input.requiresFileSystem);
  const codeHits = DEFAULT_SIGNAL_PROBES.codeHits({ text: t });
  const deepHits = DEFAULT_SIGNAL_PROBES.deepHits({ text: t });
  const trivialHits = DEFAULT_SIGNAL_PROBES.trivialHits({ text: t });
  const midHits = DEFAULT_SIGNAL_PROBES.midHits({ text: t });
  let tier; let useChain = false;
  if (requiresExec || codeHits.length) tier = 'code';
  else if (deepHits.length) tier = 'deep';
  else if (trivialHits.length) { tier = 'local'; useChain = true; }
  else if (midHits.length) tier = 'mid';
  else { tier = 'local'; useChain = true; }
  return { tier, useChain, signals: { codeHits, deepHits, trivialHits, midHits, length: t.length, requiresExec } };
}

describe('BrainRouter 可扩展重构 — 默认行为零回归', () => {
  it('默认 signals 字段集与历史完全一致（codeHits/deepHits/trivialHits/midHits/length/requiresExec）', () => {
    const router = createBrainRouter({ hasAdapter: () => true });
    for (const input of EQUIV_INPUTS) {
      const { signals } = router.route(input);
      expect(Object.keys(signals).sort()).toEqual(
        ['codeHits', 'deepHits', 'length', 'midHits', 'requiresExec', 'trivialHits'],
      );
    }
  });

  it('默认档位/adapterId/paid/downgraded/signals 与参照实现逐项相等', () => {
    const router = createBrainRouter({ localFallbacks: ['lmstudio'], hasAdapter: () => true });
    const map = { local: 'minimax-highspeed', mid: 'minimax', code: 'codex', deep: 'claude' }; // owner 2026-06-17：local 改 MiniMax highspeed
    const fallbacks = ['lmstudio'];
    const paidTiers = new Set(['local', 'mid', 'code', 'deep']); // local 改走 MiniMax 云
    for (const input of EQUIV_INPUTS) {
      const got = router.route(input);
      const ref = legacyRoute(input);
      expect(got.tier).toBe(ref.tier);
      expect(got.adapterId).toBe(map[ref.tier]);
      expect(got.paid).toBe(paidTiers.has(ref.tier));
      // 仅 local 档带 fallback 链
      expect(got.fallbacks).toEqual(ref.useChain ? fallbacks : []);
      expect(got.signals).toEqual(ref.signals);
      expect(got.tierMap).toEqual(map);
      expect(typeof got.reason).toBe('string');
      expect(got.reason.length).toBeGreaterThan(0);
    }
  });

  it('downgraded 与 fallback 链行为不变（local 主选不在池则降级到备用）', () => {
    const r = createBrainRouter({ localFallbacks: ['lmstudio'], hasAdapter: (id) => id !== 'minimax-highspeed' });
    const d = r.route({ text: '你好' });
    expect(d.adapterId).toBe('lmstudio');
    expect(d.downgraded).toBe(true);
    // 非 local 档不吃 local fallback 链
    const code = r.route({ text: '帮我写个脚本' });
    expect(code.tier).toBe('code');
    expect(code.fallbacks).toEqual([]);
  });

  it('默认导出常量结构稳定（5 条规则，最后一条无条件兜底）', () => {
    expect(DEFAULT_BRAIN_ROUTER_RULES).toHaveLength(5);
    const last = DEFAULT_BRAIN_ROUTER_RULES[DEFAULT_BRAIN_ROUTER_RULES.length - 1];
    expect(last.tier).toBe('local');
    expect(last.match({})).toBe(true);
    expect(DEFAULT_BRAIN_ROUTER_RULES.map((rule) => rule.tier))
      .toEqual(['code', 'deep', 'local', 'mid', 'local']);
  });
});

describe('BrainRouter 可扩展重构 — 注入即生效（不改核心代码就能加新档/规则）', () => {
  it('注入自定义 rules：新增 vision 档，命中关键词路由到注入的 adapter', () => {
    const rules = [
      { tier: 'vision', reason: '图像理解 → 视觉脑', match: (ctx) => /看图|图片|截图|image/i.test(ctx.text) },
      ...DEFAULT_BRAIN_ROUTER_RULES,
    ];
    const router = createBrainRouter({
      rules,
      tierMap: { vision: 'qwen-vl' },
      paidTiers: ['mid', 'code', 'deep', 'vision'],
      hasAdapter: () => true,
    });
    const d = router.route({ text: '帮我看图描述一下这张截图' });
    expect(d.tier).toBe('vision');
    expect(d.adapterId).toBe('qwen-vl');
    expect(d.paid).toBe(true);
    // 未命中 vision 的输入仍走默认链路（零回归）
    expect(router.route({ text: '你好' }).tier).toBe('local');
    expect(router.route({ text: '帮我实现一个登录功能' }).tier).toBe('code');
  });

  it('注入自定义 signalProbes：新增信号挂进 result.signals，可被自定义 rule 读取', () => {
    const router = createBrainRouter({
      signalProbes: {
        ...DEFAULT_SIGNAL_PROBES,
        mathHits: (ctx) => (/积分|微分|矩阵|求导|证明.*定理/.test(ctx.text) ? ['math'] : []),
      },
      rules: [
        { tier: 'deep', reason: '数学推导 → 深推理', match: (ctx) => ctx.signals.mathHits.length > 0 },
        ...DEFAULT_BRAIN_ROUTER_RULES,
      ],
      hasAdapter: () => true,
    });
    const d = router.route({ text: '帮我求这个矩阵的逆' });
    expect(d.signals.mathHits).toEqual(['math']);
    expect(d.tier).toBe('deep');
    expect(d.adapterId).toBe('claude');
    // 默认信号仍齐备
    expect(d.signals).toHaveProperty('codeHits');
    expect(d.signals).toHaveProperty('length');
  });

  it('注入 paidTiers：可把某档改成免费/付费而不动 route() 本体', () => {
    // 把 mid 从付费改成免费（例如换了本地中文模型）
    const router = createBrainRouter({ paidTiers: ['code', 'deep'], hasAdapter: () => true });
    const d = router.route({ text: '帮我写一篇关于杭州的游记' });
    expect(d.tier).toBe('mid');
    expect(d.paid).toBe(false); // mid 不再算付费
    expect(router.route({ text: '帮我实现登录功能' }).paid).toBe(true); // code 仍付费
  });

  it('自定义 rule match 抛错时被吞掉，落到下一条/兜底，不影响其余路由', () => {
    const router = createBrainRouter({
      rules: [
        { tier: 'boom', reason: 'broken', match: () => { throw new Error('boom'); } },
        ...DEFAULT_BRAIN_ROUTER_RULES,
      ],
      hasAdapter: () => true,
    });
    // 抛错规则被跳过，仍按默认五条判定
    expect(router.route({ text: '你好' }).tier).toBe('local');
    expect(router.route({ text: '深入分析利弊' }).tier).toBe('deep');
  });

  it('空 rules 数组回退到默认规则（防御注入失误，零回归）', () => {
    const router = createBrainRouter({ rules: [], hasAdapter: () => true });
    expect(router.route({ text: '你好' }).tier).toBe('local');
    expect(router.route({ text: '重构模块' }).tier).toBe('code');
  });
});
