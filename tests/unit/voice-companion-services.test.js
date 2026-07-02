// C11 伴生语音服务探活：分级原则 = 该服务在"当前配置下会被用到"才 warn，可选档不起只 info。
import { describe, expect, it } from 'vitest';
import { checkVoiceCompanionServices } from '../../src/runtime/NoeDoctor.js';

function fetchUp(ports) {
  return async (url) => {
    const port = Number(new URL(url).port);
    if (ports.includes(port)) return { ok: true };
    throw new Error('ECONNREFUSED');
  };
}

describe('checkVoiceCompanionServices', () => {
  it('全部在线 → info', async () => {
    const f = await checkVoiceCompanionServices({
      fetchImpl: fetchUp([8123, 8124, 8125, 8126]),
      env: { NOE_KOKORO: '1' },
      sherpaStatus: () => ({ available: false }),
      cosyStatus: () => ({ available: true }),
    });
    expect(f.severity).toBe('info');
    expect(f.message).toContain('全部在线');
  });

  it('sherpa 未就位 + whisper 没起 → warn（主转写缺位）', async () => {
    const f = await checkVoiceCompanionServices({
      fetchImpl: fetchUp([]),
      env: {},
      sherpaStatus: () => ({ available: false }),
      cosyStatus: () => ({ available: false }),
    });
    expect(f.severity).toBe('warn');
    expect(f.message).toContain('whisper');
  });

  it('sherpa 就位时 whisper 不起只 info（纯兜底不警）；kokoro 未启用不警', async () => {
    const f = await checkVoiceCompanionServices({
      fetchImpl: fetchUp([]),
      env: {}, // NOE_KOKORO 未开、NOE_COSYVOICE 默认开但模型未下
      sherpaStatus: () => ({ available: true }),
      cosyStatus: () => ({ available: false }),
    });
    expect(f.severity).toBe('info');
    expect(f.message).toContain('可选档未起');
  });

  it('cosyvoice 模型已下载但服务没起 → warn（兜底是空话）；NOE_COSYVOICE=0 时不警', async () => {
    const base = {
      fetchImpl: fetchUp([]),
      sherpaStatus: () => ({ available: true }),
      cosyStatus: () => ({ available: true }),
    };
    const warn = await checkVoiceCompanionServices({ ...base, env: {} });
    expect(warn.severity).toBe('warn');
    expect(warn.message).toContain('cosyvoice');
    expect(warn.fixHint).toContain('noe-cosyvoice-server.py');
    expect(warn.fixHint).toContain('NOE_COSYVOICE_ENGINE=cosyvoice3-mlx');
    const off = await checkVoiceCompanionServices({ ...base, env: { NOE_COSYVOICE: '0' } });
    expect(off.severity).toBe('info');
  });
});
