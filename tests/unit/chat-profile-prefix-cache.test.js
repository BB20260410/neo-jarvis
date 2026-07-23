import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatProfileStore } from '../../src/voice/ChatProfileStore.js';
import { setCachedHostContextBlock } from '../../src/context/NoeHostContext.js';

// R2-P3（2026-07-03）：NoePromptPrefix 接线 resolve——flag NOE_PROMPT_PREFIX 默认 OFF。
//   把 host/continuity 里的易变行（时间戳/日期/电量数字）剥到末尾 <runtime> 块，让稳定前缀逐轮不变可命中
//   provider prefix cache（省 30-60% 输入 token）。BOUNDARY 始终留在最末。
let dir, store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prefix-cache-'));
  store = new ChatProfileStore({ file: join(dir, 'profiles.json') });
  delete process.env.NOE_PROMPT_PREFIX;
});
afterEach(() => {
  setCachedHostContextBlock('');
  delete process.env.NOE_PROMPT_PREFIX;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('ChatProfileStore.resolve × prefix cache', () => {
  // 用命中默认易变正则的内容（ISO 日期）验证接线机制。诚实说明：host context 是启动缓存（每轮相同、本就
  // 稳定），默认正则也偏英文；本接线的收益在「system prompt 未来引入每轮变的易变行」时才显现，flag 默认 OFF。
  const VOLATILE = '调试标记 current time 2026-06-09T10:00:00 采样';

  it('flag OFF：resolve 逐字不变（零回归）', () => {
    setCachedHostContextBlock(VOLATILE);
    const off = store.resolve('default').systemPrompt;
    expect(off).toContain('2026-06-09');
    expect(off).not.toContain('<runtime>');
  });

  it('flag ON：命中易变正则的行被剥到 <runtime> 块，稳定前缀不含它，信息不丢', () => {
    process.env.NOE_PROMPT_PREFIX = '1';
    setCachedHostContextBlock(VOLATILE);
    const on = store.resolve('default').systemPrompt;
    expect(on).toContain('<runtime>');
    const [prefix, runtimePart] = on.split('<runtime>');
    expect(prefix).not.toContain('2026-06-09'); // 稳定前缀里剥掉了易变行
    expect(runtimePart).toContain('2026-06-09'); // 易变信息仍在末尾 runtime 块
    // BOUNDARY 仍在最末（安全边界不被 runtime 块顶掉）
    expect(on.trimEnd().endsWith('未成年人相关内容。')).toBe(true);
  });

  it('flag ON 但无易变行：系统提示无 runtime 块（前缀天然稳定），BOUNDARY 末尾', () => {
    process.env.NOE_PROMPT_PREFIX = '1';
    setCachedHostContextBlock('');
    const on = store.resolve('default').systemPrompt;
    expect(on).not.toContain('<runtime>');
    expect(on.trimEnd().endsWith('未成年人相关内容。')).toBe(true);
  });
});
