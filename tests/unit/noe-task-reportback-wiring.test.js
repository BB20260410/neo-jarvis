import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('任务执行态与语音回报 wiring', () => {
  it('开发者自由默认档打开 NOE_DELEGATION，避免语音委托桥生产未通电', () => {
    const server = readFileSync('server.js', 'utf8');
    expect(server).toContain("NOE_DELEGATION: '1'");
  });

  it('服务端任务回报语音默认静默，只有显式开启才播报', () => {
    const server = readFileSync('server.js', 'utf8');
    expect(server).toContain("process.env.NOE_TASK_REPORTBACK_SERVER_SPEECH || '0'");
    expect(server).toContain("['1', 'true', 'on'].includes");
  });

  it('认知面板处理 restTtsText 续播，避免只说开头几句', () => {
    const html = readFileSync('public/cognitive.html', 'utf8');
    expect(html).toContain('function playNoeResponseAudio');
    expect(html).toContain('function playRestTtsText');
    expect(html).toContain('r.restTtsText');
    expect(html).toContain("api('/api/noe/voice/tts',{text:clean})");
    expect(html).toContain('playNoeResponseAudio(d,true)');
  });

  it('任务语音回报失败也会 ack 后端，避免故障只停在前端消息里', () => {
    const html = readFileSync('public/cognitive.html', 'utf8');
    expect(html).toContain("api('/api/noe/tasks/reportbacks/speech-ack'");
    expect(html).toContain('taskSpeechInFlight');
    expect(html).toContain('new AbortController()');
    expect(html).toContain('play_start_timeout');
    expect(html).toContain('window.cogUnlockAudio=unlockSharedAudio');
    expect(html).toContain('document.addEventListener(\'pointerdown\',unlockSharedAudio');
    expect(html).toContain('await ack(false,msg)');
    expect(html).toContain("onFailed:e=>ack(false,e?.message||e||'play_failed')");
  });
});
