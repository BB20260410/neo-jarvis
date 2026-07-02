import { describe, it, expect } from 'vitest';
import { createBrainRouter } from '../../src/room/BrainRouter.js';

describe('BrainRouter 多模型分工路由', () => {
  const router = createBrainRouter({ hasAdapter: () => true });

  it('local 本地：闲聊/苦力/短文本，免配额', () => {
    expect(router.route({ text: '你好' }).tier).toBe('local');
    expect(router.route({ text: '帮我把这段日志做个摘要' }).tier).toBe('local');
    expect(router.route({ text: '安慰我一下吧' }).tier).toBe('local');
    const d = router.route({ text: '你好' });
    expect(d.adapterId).toBe('minimax-highspeed'); // owner 2026-06-17：local 闲聊/情感/苦力改 MiniMax-M2.7-highspeed
    expect(d.paid).toBe(true); // 走 MiniMax 云（已订阅）
  });

  it('code → Codex：写代码/工具/执行', () => {
    expect(router.route({ text: '帮我实现一个登录功能' }).adapterId).toBe('codex');
    expect(router.route({ text: '重构这个模块' }).adapterId).toBe('codex');
    expect(router.route({ text: '执行命令 ls -la' }).adapterId).toBe('codex');
    expect(router.route({ text: '修一下这个 bug' }).adapterId).toBe('codex');
    expect(router.route({ text: '随便说点啥', requiresTools: true }).tier).toBe('code');
    expect(router.route({ text: '帮我实现一个登录功能' }).paid).toBe(true);
  });

  it('deep → Claude：深推理/规划/架构/审查/拍板', () => {
    expect(router.route({ text: '深入分析这两个方案的权衡' }).adapterId).toBe('claude');
    expect(router.route({ text: '帮我做个架构设计' }).adapterId).toBe('claude');
    expect(router.route({ text: '审查一下这个方案' }).adapterId).toBe('claude');
    expect(router.route({ text: '复盘一下这次的得失' }).adapterId).toBe('claude');
    expect(router.route({ text: '深入分析这两个方案的权衡' }).tier).toBe('deep');
  });

  it('mid → MiniMax M3：中文创作/写作/润色/翻译', () => {
    const d = router.route({ text: '帮我写一篇关于杭州的游记' });
    expect(d.tier).toBe('mid');
    expect(d.adapterId).toBe('minimax');
    expect(d.paid).toBe(true);
    expect(router.route({ text: '帮我润色这段文案' }).tier).toBe('mid');
    expect(router.route({ text: '把这段话翻译成英文' }).tier).toBe('mid');
    expect(router.route({ text: '写个关于秋天的故事' }).tier).toBe('mid');
  });

  it('默认/一般问答 → 本地 abliterated（无审查·免费，不擅自上云）', () => {
    // 新设计：拿不准的默认走本地无审查档，不再默认 MiniMax（敏感/限制话题也走本地）
    expect(router.route({ text: '介绍一下杭州的历史和美食' }).tier).toBe('local');
    expect(router.route({ text: '推荐一部电影' }).tier).toBe('local');
    expect(router.route({ text: '讲点限制级的内容' }).tier).toBe('local');
  });

  it('本地 fallback 链：local 档(MiniMax-highspeed) 主选 + LM Studio 自动备用', () => {
    const r = createBrainRouter({ localFallbacks: ['lmstudio'], hasAdapter: () => true });
    const d = r.route({ text: '你好' });
    expect(d.adapterId).toBe('minimax-highspeed'); // owner 2026-06-17：local 主选 MiniMax highspeed
    expect(d.fallbacks).toEqual(['lmstudio']);     // 备用链 LM Studio
    // minimax-highspeed 不在池 → 自动用 lmstudio
    const r2 = createBrainRouter({ localFallbacks: ['lmstudio'], hasAdapter: (id) => id !== 'minimax-highspeed' });
    const d2 = r2.route({ text: '你好' });
    expect(d2.adapterId).toBe('lmstudio');
    expect(d2.downgraded).toBe(true);
  });

  it('可配置 tierMap：本地切换 + 线上分工', () => {
    const r = createBrainRouter({ tierMap: { local: 'lmstudio', code: 'codex', deep: 'claude' }, hasAdapter: () => true });
    expect(r.route({ text: '你好' }).adapterId).toBe('lmstudio'); // 本地切 LM Studio
    expect(r.route({ text: '写个排序算法' }).adapterId).toBe('codex');
    expect(r.route({ text: '深入分析利弊' }).adapterId).toBe('claude');
  });
});
