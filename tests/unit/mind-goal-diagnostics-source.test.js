import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mind goal diagnostic evidence UI source', () => {
  it('目标卡从 step note 提取诊断证据并渲染折叠块', () => {
    const src = readFileSync(new URL('../../public/mind.js', import.meta.url), 'utf8');
    expect(src).toContain('function goalDiagnosticEvidence');
    expect(src).toContain('class="goal-diagnostics"');
    expect(src).toContain('<summary>诊断证据</summary>');
    expect(src).toMatch(/exit=\|stdout:\|stderr:/);
  });

  it('最近优先列表不缓存 API，并在新内容到来时贴住最新', () => {
    const src = readFileSync(new URL('../../public/mind.js', import.meta.url), 'utf8');
    expect(src).toContain("cache: 'no-store'");
    expect(src).toContain('function renderRecentList');
    expect(src).toContain('box.dataset.manualScrollAt');
    expect(src).toContain("['thoughts', 'journal', 'ticks', 'memoryItems'].forEach(installRecentListScrollMemory)");
    expect(src).toContain("installRecentListScrollMemory('missions')");
    expect(src).toContain("installRecentListScrollMemory('workMapItems')");
    expect(src).toMatch(/renderRecentList\(box, html, firstKey\)/);
  });

  it('生成型反刍失败会写入意识日志诊断，而不是静默吞掉', () => {
    const serverSrc = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(serverSrc).toContain("kind: 'inner_reflect_diagnostic'");
    expect(serverSrc).toContain("reason: 'exception'");
    expect(serverSrc).toContain('redactInnerError');
  });
});
