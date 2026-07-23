// @ts-check
import { describe, expect, it } from 'vitest';
import { buildVoiceReadiness, VOICE_READINESS_SCHEMA } from '../../src/runtime/NoeVoiceReadiness.js';

describe('buildVoiceReadiness', () => {
  it('reports an available voice companion and successful STT probe as ready', () => {
    const result = buildVoiceReadiness({
      findings: [
        {
          checkId: 'voice.companions',
          severity: 'info',
          message: 'Whisper and TTS are running',
        },
      ],
      sttOk: true,
      whisperConfigured: true,
      ttsConfigured: true,
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: VOICE_READINESS_SCHEMA,
      status: 'ok',
      ready: true,
      fakeGreen: false,
      companionsUp: true,
      doctorSeverity: 'info',
      sttOk: true,
      whisperConfigured: true,
      ttsConfigured: true,
    });
  });
});
