import { describe, expect, it } from 'vitest';
import {
  createTaskReportbackSpeechWorker,
  speakTaskReportbackWithSystemAudio,
} from '../../src/runtime/NoeTaskReportbackSpeechWorker.js';

describe('NoeTaskReportbackSpeechWorker', () => {
  // afplay 系统语音兜底是 macOS 专属(worker:37 检测 platform!==darwin / 无 /usr/bin/afplay 即 ok:false);
  //   Neo 是本地 macOS OS,CI ubuntu 非 darwin 跑此功能无意义 → 跳过(macos runner + 本机 darwin 仍正常验证)
  it.skipIf(process.platform !== 'darwin')('speaks with MiniMax first and returns a playback receipt', async () => {
    const calls = [];
    const result = await speakTaskReportbackWithSystemAudio(
      { title: '观察门：仍在等待', summary: '长期观察门仍在等待。' },
      {
        miniMaxTtsClient: {
          configured: () => true,
          synthesize: async (text) => {
            calls.push(['minimax', text]);
            return { audioBuffer: Buffer.from('unit-audio'), format: 'mp3' };
          },
        },
        cosyVoiceTtsClient: {
          available: async () => true,
          synthesize: async () => {
            calls.push(['cosyvoice']);
            return { audioBuffer: Buffer.from('cosy'), format: 'wav' };
          },
        },
        spawnCommand: async (cmd, args) => {
          calls.push(['spawn', cmd, args.at(-1)]);
          return { ok: true, code: 0 };
        },
      },
    );

    expect(result).toMatchObject({ ok: true, systemSpeechFallback: { provider: 'minimax', command: 'afplay' } });
    expect(calls[0][0]).toBe('minimax');
    expect(calls.some((call) => call[0] === 'cosyvoice')).toBe(false);
    expect(calls.some((call) => call[0] === 'spawn')).toBe(true);
  });

  it('claims one server speech reportback and marks it spoken', async () => {
    const claimed = [];
    const marked = [];
    const queue = {
      consumeSpeech: (opts) => {
        claimed.push(opts);
        return [{ id: 'trb-observation', title: '观察门：仍在等待', status: 'blocked', createdAt: 1781320000000 }];
      },
      markSpoken: (id, opts) => {
        marked.push({ id, opts });
        return { id, ...opts };
      },
    };
    const worker = createTaskReportbackSpeechWorker({
      taskReportbacks: queue,
      now: () => 1781320000000,
      speak: async (item) => ({ ok: true, systemSpeechFallback: { attempted: true, provider: 'minimax', command: 'afplay', itemId: item.id } }),
    });

    const result = await worker.tick();

    expect(result).toMatchObject({ ok: true, claimed: 1, itemId: 'trb-observation' });
    expect(claimed[0]).toMatchObject({ limit: 1 });
    expect(marked[0]).toMatchObject({
      id: 'trb-observation',
      opts: { ok: true, systemSpeechFallback: { provider: 'minimax', command: 'afplay' } },
    });
  });
});
