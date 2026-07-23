// @ts-check
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MiniMaxTtsClient } from '../voice/MiniMaxTtsClient.js';
import { CosyVoiceTtsClient } from '../voice/CosyVoiceTtsClient.js';
import { QwenVoiceDesignTtsClient } from '../voice/QwenVoiceDesignTtsClient.js';
import { redactSensitiveText } from './NoeContextScrubber.js';

function clean(value, max = 360) {
  return redactSensitiveText(String(value ?? ''))
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function audioPath(format = 'mp3') {
  const safeFormat = String(format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const dir = join(homedir(), '.noe-panel', 'tmp', 'task-reportbacks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `server-reportback-${Date.now()}-${process.pid}-${randomUUID()}.${safeFormat}`);
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.once('exit', (code) => resolve({ ok: code === 0, code }));
    child.once('error', (error) => resolve({ ok: false, error: error?.message || String(error) }));
  });
}

async function playAudioBuffer(audioBuffer, format, { spawnCommand = runCommand } = {}) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/afplay')) return { ok: false, error: 'afplay_unavailable' };
  const file = audioPath(format);
  writeFileSync(file, audioBuffer, { mode: 0o600 });
  try {
    const played = await spawnCommand('/usr/bin/afplay', [file]);
    return played.ok ? { ok: true, command: 'afplay' } : { ok: false, error: played.error || `afplay_exit_${played.code}` };
  } finally {
    await unlink(file).catch(() => {});
  }
}

function itemText(item = {}) {
  const title = clean(item.title || item.taskId || item.goalId || 'Noe 任务', 120);
  const summary = clean(item.summary || '', 260);
  return `主人，${title}。${summary}`.slice(0, 420);
}

export async function speakTaskReportbackWithSystemAudio(item = {}, {
  miniMaxTtsClient = null,
  cosyVoiceTtsClient = null,
  spawnCommand = runCommand,
} = {}) {
  const text = itemText(item);
  const reasons = [];
  const miniMaxMode = String(process.env.NOE_TASK_REPORTBACK_MINIMAX_TTS || '1').trim().toLowerCase();
  if (!['0', 'false', 'off'].includes(miniMaxMode)) {
    const client = miniMaxTtsClient || new MiniMaxTtsClient();
    if (client?.configured?.()) {
      try {
        const audio = await client.synthesize(text);
        const played = await playAudioBuffer(audio.audioBuffer, audio.format, { spawnCommand });
        if (played.ok) return { ok: true, systemSpeechFallback: { attempted: true, command: played.command, provider: 'minimax' } };
        reasons.push(`minimax_play:${played.error || 'failed'}`);
      } catch (error) {
        reasons.push(`minimax:${clean(error?.message || String(error), 120)}`);
      }
    } else {
      reasons.push('minimax:unconfigured');
    }
  }

  const cosyMode = String(process.env.NOE_TASK_REPORTBACK_COSYVOICE_TTS || '1').trim().toLowerCase();
  if (!['0', 'false', 'off'].includes(cosyMode)) {
    const client = cosyVoiceTtsClient || (process.env.NOE_QWEN_TTS === '1' ? new QwenVoiceDesignTtsClient() : new CosyVoiceTtsClient());
    try {
      const available = typeof client.available === 'function' ? await client.available() : client.configured?.();
      if (available) {
        const audio = await client.synthesize(text);
        const played = await playAudioBuffer(audio.audioBuffer, audio.format, { spawnCommand });
        if (played.ok) return { ok: true, systemSpeechFallback: { attempted: true, command: played.command, provider: 'cosyvoice' } };
        reasons.push(`cosyvoice_play:${played.error || 'failed'}`);
      } else {
        reasons.push('cosyvoice:unavailable');
      }
    } catch (error) {
      reasons.push(`cosyvoice:${clean(error?.message || String(error), 120)}`);
    }
  }

  if (process.platform === 'darwin' && existsSync('/usr/bin/say')) {
    const said = await spawnCommand('/usr/bin/say', [text]);
    if (said.ok) return { ok: true, systemSpeechFallback: { attempted: true, command: 'say', provider: 'macos' } };
    reasons.push(`say:${said.error || `exit_${said.code}`}`);
  }
  return { ok: false, error: reasons.join('; ') || 'system_tts_unavailable', systemSpeechFallback: { attempted: false, reason: reasons.join('; ') || 'system_tts_unavailable' } };
}

export function createTaskReportbackSpeechWorker({
  taskReportbacks,
  enabled = true,
  pollMs = 8_000,
  includeBacklogMs = 30_000,
  now = Date.now,
  speak = speakTaskReportbackWithSystemAudio,
  logger = console,
} = {}) {
  const startedAt = now();
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (!enabled || !taskReportbacks?.consumeSpeech || !taskReportbacks?.markSpoken) return { ok: true, skipped: 'disabled_or_unavailable' };
    if (inFlight) return { ok: true, skipped: 'in_flight' };
    const items = taskReportbacks.consumeSpeech({ limit: 1, since: Math.max(0, startedAt - Math.max(0, Number(includeBacklogMs) || 0)) });
    if (!items.length) return { ok: true, claimed: 0 };
    const item = items[0];
    inFlight = true;
    try {
      const result = await speak(item);
      const marked = taskReportbacks.markSpoken(item.id, {
        ok: result?.ok !== false,
        error: result?.error || null,
        systemSpeechFallback: result?.systemSpeechFallback || null,
      });
      return { ok: result?.ok !== false, claimed: 1, itemId: item.id, marked };
    } catch (error) {
      const message = clean(error?.message || String(error), 160);
      const marked = taskReportbacks.markSpoken(item.id, {
        ok: false,
        error: message,
        systemSpeechFallback: { attempted: false, reason: message },
      });
      logger?.warn?.('[noe-reportback-speech] 语音汇报失败：', message);
      return { ok: false, claimed: 1, itemId: item.id, error: message, marked };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!enabled || timer) return { ok: Boolean(enabled), started: false };
    timer = setInterval(() => { tick().catch(() => {}); }, Math.max(2_000, Number(pollMs) || 8_000));
    timer.unref?.();
    tick().catch(() => {});
    return { ok: true, started: true, startedAt };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, status: () => ({ enabled, running: Boolean(timer), inFlight, startedAt }) };
}
