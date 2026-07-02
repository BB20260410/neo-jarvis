import { describe, expect, it } from 'vitest';
import {
  analyzeVoiceRound,
  analyzeWakeResult,
  containsActionParenthetical,
  isTransportError,
  parseArgs,
  renderMarkdownReport,
} from '../../scripts/noe-voice-ear-acceptance.mjs';

const audio = Buffer.from('x'.repeat(1200)).toString('base64');

describe('noe voice ear acceptance helpers', () => {
  it('marks a long reply with first and rest audio as pass', () => {
    const result = analyzeVoiceRound({
      kind: 'long',
      prompt: '讲长一点',
      response: {
        ok: true,
        status: 200,
        data: {
          ok: true,
          reply: '第一句讲清楚现在的状态。第二句继续说明后续动作。第三句把证据和验收说完整。',
          audioBase64: audio,
          audioFormat: 'mp3',
          restTtsText: '第二句继续说明后续动作。第三句把证据和验收说完整。',
        },
      },
      restResponse: {
        ok: true,
        status: 200,
        data: { ok: true, audioBase64: audio, audioFormat: 'mp3' },
      },
      minAudioBytes: 800,
    });

    expect(result.ok).toBe(true);
    expect(result.onlyFirstSentenceRisk).toBe(false);
    expect(result.hasRestAudio).toBe(true);
  });

  it('flags first-sentence risk when restTtsText exists but rest audio is missing', () => {
    const result = analyzeVoiceRound({
      kind: 'long',
      prompt: '讲长一点',
      response: {
        ok: true,
        status: 200,
        data: {
          ok: true,
          reply: '第一句讲清楚现在的状态。第二句继续说明后续动作。第三句把证据和验收说完整。',
          audioBase64: audio,
          restTtsText: '第二句继续说明后续动作。第三句把证据和验收说完整。',
        },
      },
      restResponse: { ok: false, status: 502, data: { ok: false, error: 'TTS down' } },
      minAudioBytes: 800,
    });

    expect(result.ok).toBe(false);
    expect(result.onlyFirstSentenceRisk).toBe(true);
    expect(result.hasRestAudio).toBe(false);
  });

  it('fails voice rounds that accidentally hit delegate-task routing', () => {
    const result = analyzeVoiceRound({
      kind: 'bracket',
      prompt: '用一句自然的话安慰我',
      response: {
        ok: true,
        status: 200,
        data: {
          ok: true,
          intent: 'delegate_task',
          reply: '【派活计划】目标：合适的协作房间',
          audioBase64: audio,
        },
      },
      minAudioBytes: 800,
    });

    expect(result.ok).toBe(false);
    expect(result.delegatePlanLeak).toBe(true);
  });

  it('detects bracket action leakage in replies', () => {
    expect(containsActionParenthetical('主人，我在这里。')).toBe(false);
    expect(containsActionParenthetical('主人，（微笑）我在这里。')).toBe(true);
    expect(containsActionParenthetical('主人，(声音放软)我在这里。')).toBe(true);
  });

  it('scores wake negative samples as failed when they are spotted', () => {
    const result = analyzeWakeResult({
      phrase: '今天的天气还不错',
      expectedSpotted: false,
      response: { ok: true, status: 200, data: { ok: true, spotted: true } },
    });

    expect(result.ok).toBe(false);
    expect(result.spotted).toBe(true);
  });

  it('renders reports without token fields and keeps owner review pending', () => {
    const report = {
      checkedAt: '2026-06-12T00:00:00.000Z',
      docDate: '2026-06-12',
      baseUrl: 'http://127.0.0.1:51835',
      profileId: 'default',
      reportFile: '~/Desktop/Neo 贾维斯/output/noe-voice-ear-acceptance/demo/report.json',
      outDir: '~/Desktop/Neo 贾维斯/output/noe-voice-ear-acceptance/demo',
      summary: { longPassed: 1, longTotal: 1, bracketPassed: 0, bracketTotal: 0, wakePassed: 0, wakeTotal: 0 },
      longRounds: [{
        round: 1,
        ok: true,
        replyLength: 90,
        sentenceCount: 3,
        firstAudioBytes: 1200,
        restTtsText: '',
        restAudioBytes: 0,
        onlyFirstSentenceRisk: false,
        firstAudioFile: 'output/noe-voice-ear-acceptance/demo/long-01-first.mp3',
        restAudioFile: '',
      }],
      bracketRounds: [],
      wakeRounds: [],
    };
    const md = renderMarkdownReport(report);

    expect(md).toContain('ownerTokenPrinted: false');
    expect(md).toContain('needsOwnerEarReview: true');
    expect(md).not.toMatch(/X-Panel-Owner-Token|Bearer|sk-/);
  });

  it('keeps live request timeout disabled by default', () => {
    const args = parseArgs([], {});
    expect(args.requestTimeoutMs).toBe(0);
    expect(args.wakePrefix).toBe('');
    expect(args.wakePrefixExplicit).toBe(false);
    expect(args.longRounds).toBe(10);
    expect(args.bracketRounds).toBe(5);
    expect(args.wakeRounds).toBe(10);
  });

  it('tracks explicit wake prefix without requiring it in reports', () => {
    const args = parseArgs(['--wake-prefix=主人口令 '], {});
    expect(args.wakePrefix).toBe('主人口令 ');
    expect(args.wakePrefixExplicit).toBe(true);
  });

  // 传输层瞬时故障判定（治 keep-alive socket 被服务端回收 → fetch failed/status=null 的偶发空返回）：
  // 这类才重试；HTTP 状态错误/主动中断不算传输故障，不重试。
  it('treats fetch failed / ECONNRESET as retryable transport errors', () => {
    expect(isTransportError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransportError(Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransportError(Object.assign(new Error('socket hang up'), {}))).toBe(true);
    expect(isTransportError(Object.assign(new Error('y'), { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
  });

  it('does not retry HTTP-status errors, aborts, or unrelated errors', () => {
    expect(isTransportError(new Error('🟦 OpenAI 兼容 400: bad request'))).toBe(false);
    expect(isTransportError(new Error('🟦 OpenAI 兼容 500: upstream busy'))).toBe(false);
    expect(isTransportError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError(new Error('某个业务校验失败'))).toBe(false);
  });
});
