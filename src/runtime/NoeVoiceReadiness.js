// @ts-check
/**
 * Honest voice companion readiness — never silent fake green.
 * Consumes Doctor findings (voice.companions) and optional STT probe result.
 */

export const VOICE_READINESS_SCHEMA = 'neo.voice.readiness.v1';

/**
 * @param {object} [opts]
 * @param {Array<{checkId?:string,severity?:string,message?:string}>} [opts.findings]
 * @param {boolean|null} [opts.sttOk] null = not probed
 * @param {boolean} [opts.whisperConfigured]
 * @param {boolean} [opts.ttsConfigured]
 */
export function buildVoiceReadiness(opts = {}) {
  const findings = Array.isArray(opts.findings) ? opts.findings : [];
  const voiceFinding = findings.find((f) => f && f.checkId === 'voice.companions') || null;
  const severity = voiceFinding?.severity || null;
  const message = voiceFinding ? String(voiceFinding.message || '') : '';
  const looksDown = /没起|down|fail|missing|unavailable|未启动|不可用/i.test(message);
  const companionsUp =
    voiceFinding != null && severity !== 'error' && !looksDown
      ? true
      : voiceFinding != null && severity === 'info' && !looksDown
        ? true
        : false;

  /** @type {'ok'|'degraded'|'external_blocked'|'unknown'} */
  let status = 'unknown';
  let fakeGreen = false;

  if (!voiceFinding && opts.sttOk == null) {
    status = 'external_blocked';
  } else if (severity === 'error' || looksDown) {
    status = 'external_blocked';
  } else if (opts.sttOk === false) {
    status = 'external_blocked';
  } else if (opts.sttOk === true && (companionsUp || severity === 'info')) {
    status = 'ok';
  } else if (voiceFinding && severity !== 'error') {
    status = companionsUp ? 'ok' : 'degraded';
  } else {
    status = 'external_blocked';
  }

  // Never claim ok when companions clearly down
  if (status === 'ok' && looksDown) {
    status = 'external_blocked';
    fakeGreen = false;
  }

  const ready = status === 'ok';
  return {
    schemaVersion: 1,
    kind: VOICE_READINESS_SCHEMA,
    status,
    ready,
    fakeGreen: false,
    companionsUp,
    doctorSeverity: severity,
    doctorMessage: message ? message.slice(0, 280) : null,
    sttOk: opts.sttOk === undefined ? null : opts.sttOk,
    whisperConfigured: opts.whisperConfigured === true,
    ttsConfigured: opts.ttsConfigured === true,
    uiHint:
      status === 'ok'
        ? '语音可用：可说话或打字'
        : status === 'degraded'
          ? '语音部分可用：可打字；语音可能不稳'
          : '语音未就绪：请检查本机 Whisper/TTS 或改用打字',
  };
}

/**
 * Map runVoiceStandardLoop result → readiness (shipped loop integration).
 * @param {object} loopResult
 */
export function voiceReadinessFromProductLoop(loopResult) {
  if (!loopResult || loopResult.loop !== 'voice') {
    return buildVoiceReadiness({});
  }
  return buildVoiceReadiness({
    findings: loopResult.doctorVoiceSeverity
      ? [{ checkId: 'voice.companions', severity: loopResult.doctorVoiceSeverity, message: loopResult.doctorVoiceMessage || '' }]
      : [],
    sttOk: loopResult.sttOk,
  });
}
