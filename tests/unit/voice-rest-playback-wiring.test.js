// @ts-check
// owner 报障「语音只说开头」防回归（2026-06-10）：源码结构断言钉死前端续播两处修复——
// ①playPendingRest 不得退化回「phase!=='speak' 即丢弃」（实时模式首句播完已切 listen，
//   迟到的剩余段会被整段扔掉=只说开头）；listen 中迟到续播必须重进 speak 相位接上。
// ②fetchRestAudio 必须带代际号（防上一轮迟到结果覆盖新一轮 loading 的竞态）。
// 前端无 DOM 测试基建，按本仓惯例用源码文本断言（同 server-route-wiring / appjs-migration）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'public/src/web/noe-voice.js'), 'utf8');

describe('语音续播接线（只说开头防回归）', () => {
  it('playPendingRest：listen 中迟到续播重进 speak 相位播出，不再按相位丢弃', () => {
    const fn = src.slice(src.indexOf('function playPendingRest'), src.indexOf('function playPendingRest') + 1200);
    // 旧的「非 speak 即丢」整行不得复活
    expect(fn).not.toContain("vadPhase !== 'speak') return false");
    // 必须有 listen 重进 speak 的接上逻辑
    expect(fn).toMatch(/vadPhase === 'listen'[\s\S]{0,80}vadPhase = 'speak'/);
    // 用户已开口（capture/think）时仍要丢弃，不许插嘴
    expect(fn).toMatch(/vadPhase === 'capture' \|\| vadPhase === 'think'/);
  });

  it('fetchRestAudio：带代际号防旧轮迟到结果覆盖新轮', () => {
    expect(src).toContain('pendingRestSeq');
    const fn = src.slice(src.indexOf('function fetchRestAudio'), src.indexOf('function playPendingRest'));
    expect(fn).toMatch(/seq !== pendingRestSeq/);
  });

  it('fetchRestAudio：剩余段合成失败会重试一次，避免偶发失败只播开头', () => {
    const fn = src.slice(src.indexOf('function fetchRestAudio'), src.indexOf('function playPendingRest'));
    expect(fn).toMatch(/const attempt = \(retriesLeft\) =>/);
    expect(fn.match(/retriesLeft > 0\) attempt\(retriesLeft - 1\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(fn).toContain('attempt(1)');
    expect(fn).toContain('剩余语音段合成失败（已重试）');
  });
});
