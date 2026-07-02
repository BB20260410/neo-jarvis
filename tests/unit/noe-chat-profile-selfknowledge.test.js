import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatProfileStore } from '../../src/voice/ChatProfileStore.js';
import { setCachedHostContextBlock } from '../../src/context/NoeHostContext.js';
import { buildNoeSelfKnowledgeBlock, noeCapabilities } from '../../src/context/NoeSelfKnowledge.js';

// 用临时不存在的 file → _load return → 用内置 CHAT_PROFILES，不碰用户 ~/.noe-panel
let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-a2-'));
  store = new ChatProfileStore({ file: join(dir, 'profiles.json') });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  setCachedHostContextBlock('');   // 清缓存防泄漏到其他测试
});

describe('A2: ChatProfileStore.resolve 注入自我能力认知', () => {
  it('resolve 的 systemPrompt 含 <noe-self-knowledge>（文字聊天注入数 0→1）', () => {
    const p = store.resolve('default');
    expect(p.systemPrompt).toContain('<noe-self-knowledge>');
    expect(p.systemPrompt).toContain('声纹');               // 能力清单确实拼进去了
  });

  it('BOUNDARY 硬规则仍保留（A2 注入不破坏既有边界）', () => {
    const p = store.resolve('default');
    expect(p.systemPrompt).toContain('硬规则');
    // 顺序：原 systemPrompt → self-knowledge → BOUNDARY（边界在最后）
    expect(p.systemPrompt.indexOf('<noe-self-knowledge>')).toBeLessThan(p.systemPrompt.indexOf('硬规则'));
  });

  it('未知 profile 回退 default 也注入', () => {
    const p = store.resolve('不存在的profile');
    expect(p.systemPrompt).toContain('<noe-self-knowledge>');
  });

  // verified 状态依赖本机 output/noe-100-readiness 等运行时验证报告(collectVerificationState 读固定路径);
  //   CI/clone 干净环境无报告 → 全 declared → 跳过(本机有报告仍正常验证 verified/declared 区分机制)。
  it.skipIf(noeCapabilities().every((c) => c.status !== 'verified'))('能力清单区分 verified 与 declared，避免把未烟测能力说成已验证', () => {
    const caps = noeCapabilities();
    expect(caps.length).toBeGreaterThan(5);
    expect(caps.every((c) => c.status === 'verified' || c.status === 'declared')).toBe(true);
    expect(caps.some((c) => c.status === 'verified')).toBe(true);
    expect(caps.some((c) => c.status === 'declared')).toBe(true);
    expect(caps.find((c) => c.id === 'memory')?.status).toBe('verified');
    expect(caps.find((c) => c.id === 'voiceprint')?.status).toBe('declared');

    const block = buildNoeSelfKnowledgeBlock();
    expect(block).toContain('[verified]');
    expect(block).toContain('[declared]');
    expect(block).not.toContain('output/noe-');
    expect(block.length).toBeLessThan(4000);
  });
});

describe('波次6: 感知三件套缓存 → ChatProfileStore.resolve 注入', () => {
  it('缓存有内容时注入 <noe-host-context>，顺序在 BOUNDARY 前', () => {
    setCachedHostContextBlock('git 身份：owner <x@y.z>\n\n本机环境：M5 Max');
    const p = store.resolve('default');
    expect(p.systemPrompt).toContain('<noe-host-context>');
    expect(p.systemPrompt).toContain('M5 Max');
    expect(p.systemPrompt.indexOf('<noe-host-context>')).toBeLessThan(p.systemPrompt.indexOf('硬规则'));
  });

  it('未采集(空缓存)时不注入，零行为影响', () => {
    setCachedHostContextBlock('');
    const p = store.resolve('default');
    expect(p.systemPrompt).not.toContain('<noe-host-context>');
  });
});
