// CE12 单元测试阶段补测（Claude 成员独立稿）：
// 补 MiniMaxSpawnAdapter 此前未直测的两条路径：
//   - resolveMiniMaxCli 优先采用存在的 env.MINIMAX_BIN（候选解析）
//   - CLI 缺失（bin=''）时 _doChat 仍 fail-safe 返回 patch-only 缺口建议，绝不执行
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MiniMaxSpawnAdapter, resolveMiniMaxCli } from '../../src/room/MiniMaxSpawnAdapter.js';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-minimax-resolve-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MiniMaxSpawnAdapter CLI 解析与缺失兜底', () => {
  it('resolveMiniMaxCli 命中存在的 env.MINIMAX_BIN（候选顺序最优先）', () => {
    const fake = join(tmp, 'fake-minimax');
    writeFileSync(fake, '#!/bin/sh\n');
    // PATH 清空让 `which minimax` 失败，确保返回值来自 env.MINIMAX_BIN 而非本机 PATH
    const resolved = resolveMiniMaxCli({ env: { MINIMAX_BIN: fake, PATH: '' }, homeDir: tmp });
    expect(resolved).toBe(fake);
  });

  it('CLI 缺失（bin=空）时 _doChat 返回 patch-only 缺口建议且 ok=true，不执行任何操作', async () => {
    // 注意：构造函数 `opts.bin || resolveMiniMaxCli()` 会对 falsy bin 回退到本机 CLI，
    // 这里先给个占位 bin 跳过解析，再强制清空以确定性地走 #spawnCli 的「无 bin」兜底分支。
    const adapter = new MiniMaxSpawnAdapter({ bin: 'placeholder' });
    adapter.bin = '';
    const result = await adapter._doChat([{ role: 'user', content: '审计一下' }], {});
    expect(result.ok).toBe(true);
    expect(result.status).toBe('proposal_saved');
    expect(result.reply).toContain('not found');
    // 缺失兜底必须是空 diffs 的 patch-only 计划
    expect(result.raw.plan.diffs).toEqual([]);
  });
});
