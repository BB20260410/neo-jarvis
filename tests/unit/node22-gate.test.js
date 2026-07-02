// FR-P0-1 验证门单测：覆盖「Node22 命中 / 低于 22 fail / 找不到 Node22 fail-closed」。
// 测的是 scripts/ensure-node22.mjs（GPT 落地的 canonical）导出的纯函数 selectNodeRuntime / candidateNodeBins。
import { describe, expect, it } from 'vitest';
import { selectNodeRuntime, candidateNodeBins } from '../../scripts/ensure-node22.mjs';

const info = (bin, major, ok = true) => ({
  bin, ok, version: `v${major}.0.0`, major, modules: String(major === 22 ? 127 : 147), execPath: bin,
});

describe('ensure-node22 gate（FR-P0-1）', () => {
  it('当前已是 Node22：requiredMajor=22 命中 current_exact', () => {
    const r = selectNodeRuntime({ current: info('/cur/node', 22), candidates: [], requiredMajor: 22 });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('current_exact');
    expect(r.selected.major).toBe(22);
  });

  it('当前 Node26 但候选里有 Node22：requiredMajor=22 选 candidate_exact', () => {
    const r = selectNodeRuntime({
      current: info('/opt/node26', 26),
      candidates: [info('/nvm/node22', 22)],
      requiredMajor: 22,
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('candidate_exact');
    expect(r.selected.bin).toBe('/nvm/node22');
  });

  it('requiredMajor=22 且没有任何可用 Node22：fail-closed（ok=false）', () => {
    const r = selectNodeRuntime({
      current: info('/opt/node26', 26),
      candidates: [info('/opt/node20', 20), info('/broken', 0, false)],
      requiredMajor: 22,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Node 22/);
  });

  it('minimum 模式：当前 < 22 且无候选 >=22 → fail（低于 22 fail-fast 语义）', () => {
    const r = selectNodeRuntime({
      current: info('/opt/node18', 18),
      candidates: [info('/opt/node20', 20)],
      minimumMajor: 22,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Node >=22/);
  });

  it('minimum 模式：当前 < 22 但候选有 >=22 → fallback 命中', () => {
    const r = selectNodeRuntime({
      current: info('/opt/node18', 18),
      candidates: [info('/nvm/node22', 22)],
      minimumMajor: 22,
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('candidate_minimum_ok');
    expect(r.selected.major).toBe(22);
  });

  it('不可用候选（ok=false）不会被选中', () => {
    const r = selectNodeRuntime({
      current: info('/opt/node26', 26),
      candidates: [{ bin: '/broken22', ok: false, error: 'dlopen' }],
      requiredMajor: 22,
    });
    expect(r.ok).toBe(false);
  });

  it('candidateNodeBins 把 NOE_NODE_BIN 与 .nvmrc 推导路径纳入候选', () => {
    const bins = candidateNodeBins({
      root: process.cwd(),
      env: { NOE_NODE_BIN: '/custom/node22', USER: 'tester' },
      execPath: '/opt/node26',
      homeDir: '/tmp/noe-e2e-home',
    });
    expect(bins).toContain('/custom/node22');
    // .nvmrc 内容 22.22.2 → 推出 nvm 安装路径
    expect(bins).toContain('/Users/tester/.nvm/versions/node/v22.22.2/bin/node');
    expect(bins).toContain('/opt/node26');
  });
});
