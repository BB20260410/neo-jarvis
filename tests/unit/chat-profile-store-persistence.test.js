// @ts-check
// 修复防回归：内置 chat profile 用户改完重启即还原（2026-06-10 owner 实损 bug）
// 根因：_load() 对 builtIn 行无条件 continue —— upsert 落盘成功但重启后被代码默认值覆盖。
// 修复语义：customized 标记单向粘滞；改过的内置档文件值赢，没改过的继续跟随代码默认值。
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChatProfileStore } from '../../src/voice/ChatProfileStore.js';
import { CHAT_PROFILES } from '../../src/voice/ChatProfiles.js';
import { NOE_MAIN_BRAIN_MODEL } from '../../src/model/NoeLocalModelPolicy.js';

const dir = mkdtempSync(join(tmpdir(), 'noe-chat-profiles-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function freshFile(name) {
  return join(dir, name + '.json');
}

describe('ChatProfileStore 内置档持久化（重启不丢）', () => {
  it('改过的内置档重启后保留用户值（bug 重现路径）', () => {
    const file = freshFile('builtin-survives');
    const a = new ChatProfileStore({ file });
    a.upsert({
      id: 'default',
      adapterId: 'lmstudio',
      model: 'gemma-4-26b-test',
      temperature: 0.7,
      maxCompletionTokens: 16384,
      systemPrompt: '用户自定义提示词',
    });
    // 模拟重启：同一文件新建实例
    const b = new ChatProfileStore({ file });
    const p = b.publicList().find((x) => x.id === 'default');
    expect(p.adapterId).toBe('lmstudio');
    expect(p.model).toBe('gemma-4-26b-test');
    expect(p.temperature).toBe(0.7);
    expect(p.maxCompletionTokens).toBe(16384);
    expect(p.systemPrompt).toBe('用户自定义提示词');
    expect(p.builtIn).toBe(true);
    expect(p.customized).toBe(true);
  });

  it('没改过的内置档继续跟随代码默认值（不被文件影子钉死）', () => {
    const file = freshFile('untouched-follows-code');
    const a = new ChatProfileStore({ file });
    // 只改 default，不碰 m3_companion —— 但 _save 会把所有档都写进文件
    a.upsert({ id: 'default', systemPrompt: '只改这个' });
    const saved = JSON.parse(readFileSync(file, 'utf-8'));
    const companionRow = saved.profiles.find((x) => x.id === 'm3_companion');
    expect(companionRow.customized).toBe(false);
    // 重启后 m3_companion 仍等于代码定义（文件里的未自定义副本被忽略）
    const b = new ChatProfileStore({ file });
    const p = b.list().find((x) => x.id === 'm3_companion');
    expect(p.systemPrompt).toBe(CHAT_PROFILES.m3_companion.systemPrompt);
    expect(p.temperature).toBe(CHAT_PROFILES.m3_companion.temperature);
  });

  it('改过的内置档再次重启（二代文件）仍保留——customized 单向粘滞', () => {
    const file = freshFile('sticky-across-saves');
    const a = new ChatProfileStore({ file });
    a.upsert({ id: 'm3_assistant', model: 'my-model', systemPrompt: '自定义A' });
    const b = new ChatProfileStore({ file });
    // 第二代进程里改别的档触发 _save，再开第三代
    b.upsert({ id: 'default', systemPrompt: '别的修改' });
    const c = new ChatProfileStore({ file });
    const p = c.publicList().find((x) => x.id === 'm3_assistant');
    expect(p.model).toBe('my-model');
    expect(p.systemPrompt).toBe('自定义A');
  });

  it('m3_fast 是独立快速云档，不被 m3_assistant 自定义成本地档污染', () => {
    const file = freshFile('m3-fast-independent');
    const a = new ChatProfileStore({ file });
    a.upsert({ id: 'm3_assistant', adapterId: 'lmstudio', model: 'local-gemma', systemPrompt: '工作模式本地自定义' });
    const b = new ChatProfileStore({ file });
    const assistant = b.publicList().find((x) => x.id === 'm3_assistant');
    const fastPublic = b.publicList().find((x) => x.id === 'm3_fast');
    const fastResolved = b.resolve('m3_fast');
    expect(assistant.adapterId).toBe('lmstudio');
    expect(fastPublic.adapterId).toBe('minimax');
    expect(fastPublic.model).toBe('MiniMax-M3');
    expect(fastPublic.thinkingMode).toBe('disabled');
    expect(fastResolved.adapterChain).toEqual(['minimax']);
  });

  it('自建（非内置）档持久化行为不变', () => {
    const file = freshFile('custom-profile');
    const a = new ChatProfileStore({ file });
    a.upsert({ id: 'my_custom', name: '我的', systemPrompt: '自建档提示词' });
    const b = new ChatProfileStore({ file });
    const p = b.publicList().find((x) => x.id === 'my_custom');
    expect(p?.systemPrompt).toBe('自建档提示词');
    expect(p?.builtIn).toBe(false);
  });

  it('内置档仍禁删（既有约束不回归）', () => {
    const file = freshFile('builtin-no-delete');
    const a = new ChatProfileStore({ file });
    expect(() => a.delete('default')).toThrow();
  });

  it('外部修复写入的 customized 行可被加载（数据修复路径）', () => {
    const file = freshFile('external-repair');
    writeFileSync(file, JSON.stringify({
      version: 1,
      profiles: [{
        id: 'default', name: '默认模式', adapterId: 'lmstudio', model: 'repaired-model',
        mode: 'companion', personaName: '宝贝', temperature: 0.4, maxCompletionTokens: 16384,
        noAbort: true, thinkingMode: 'default', builtIn: true, customized: true,
        systemPrompt: '修复回来的提示词',
      }],
    }, null, 2));
    const s = new ChatProfileStore({ file });
    const p = s.publicList().find((x) => x.id === 'default');
    expect(p.model).toBe('repaired-model');
    expect(p.systemPrompt).toBe('修复回来的提示词');
  });

  it('旧单主脑 Gemma 的内置档持久化会迁移到当前 Q35-6 主脑', () => {
    const file = freshFile('migrate-stale-gemma-main-brain');
    writeFileSync(file, JSON.stringify({
      version: 1,
      profiles: [
        {
          id: 'default',
          name: '默认模式',
          adapterId: 'lmstudio',
          model: 'gemma-4-26b-a4b-it-qat-mlx',
          mode: 'companion',
          personaName: '宝贝',
          temperature: 1,
          maxCompletionTokens: 4096,
          noAbort: true,
          thinkingMode: 'default',
          builtIn: true,
          customized: true,
          systemPrompt: '旧 Gemma 默认档提示词',
        },
        {
          id: 'm3_assistant',
          name: '工作模式',
          adapterId: 'lmstudio',
          model: 'gemma-4-26b-a4b-it-uncensored-heretic-ara-mlx-int6-affine',
          mode: 'assistant',
          personaName: 'Noe',
          temperature: 0.25,
          maxCompletionTokens: 16384,
          noAbort: true,
          thinkingMode: 'default',
          builtIn: true,
          customized: true,
          systemPrompt: '旧 Gemma 工作档提示词',
        },
      ],
    }, null, 2));
    const s = new ChatProfileStore({ file });
    const defaultProfile = s.publicList().find((x) => x.id === 'default');
    const assistantProfile = s.publicList().find((x) => x.id === 'm3_assistant');
    expect(defaultProfile.model).toBe(NOE_MAIN_BRAIN_MODEL);
    expect(defaultProfile.maxCompletionTokens).toBe(8192);
    expect(defaultProfile.customized).toBe(true);
    expect(assistantProfile.model).toBe(NOE_MAIN_BRAIN_MODEL);
    expect(assistantProfile.customized).toBe(true);
  });
});
