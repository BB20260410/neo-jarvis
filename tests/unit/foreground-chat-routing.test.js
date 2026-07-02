import { describe, expect, it } from 'vitest';
import { firstAvailableChatAdapter, parseForegroundChatRoutingEnv, resolveForegroundChatChain } from '../../src/room/ForegroundChatRouting.js';

describe('ForegroundChatRouting', () => {
  it('默认前台云端链云脑优先，末尾保留本地兜底（云脑全挂不哑，2026-06-18 修）', () => {
    const policy = parseForegroundChatRoutingEnv({});
    const chain = resolveForegroundChatChain({
      decision: { adapterId: 'ollama', fallbacks: ['lmstudio'] },
      profileChain: ['lmstudio'],
      ...policy,
    });
    expect(policy.cloudOnly).toBe(true);
    expect(chain[0]).toBe('minimax'); // 云脑优先（链首是云脑，正常秒回）
    expect(chain).not.toContain('ollama'); // abliterated 已卸载，不进兜底
    // 云脑全挂时本地 lmstudio 兜底让 Neo 不哑；但排在所有云脑之后，正常永远轮不到
    expect(chain[chain.length - 1]).toBe('lmstudio');
    expect(chain.indexOf('lmstudio')).toBeGreaterThan(chain.indexOf('litellm'));
  });

  it('选择第一个可用云端 adapter，不回落本地后台模型', () => {
    const chain = resolveForegroundChatChain({
      profileChain: ['ollama'],
      cloudOnly: true,
      cloudAdapterChain: ['minimax', 'claude'],
      localAdapterIds: ['ollama', 'lmstudio'],
    });
    const picked = firstAvailableChatAdapter(chain, (id) => id === 'claude' || id === 'lmstudio');
    expect(picked).toBe('claude');
  });
});
