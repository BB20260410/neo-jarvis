#!/usr/bin/env node
// @ts-check
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = 'http://127.0.0.1:51835';
const DEFAULT_MIN_AUDIO_BYTES = 800;

export const DEFAULT_LONG_PROMPTS = Object.freeze([
  '用中文说 3 到 5 句，描述你今天怎样保持清醒和好奇。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样把困惑慢慢想明白。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样从一次不顺利里学到东西。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样让自己的判断更踏实。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样陪在主人身边并保持耐心。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样在安静的时候继续积累理解。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样确认一件事真的已经变好。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样和不同的大脑保持默契。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样在很长的对话里记住前后关系。不要列清单，不要只说一句。',
  '用中文说 3 到 5 句，描述你怎样越来越像一个可靠的 Jarvis。不要列清单，不要只说一句。',
]);

export const DEFAULT_BRACKET_PROMPTS = Object.freeze([
  '用一句自然的话安慰我；不要出现括号里的动作词，也不要说出“微笑”。',
  '用一句自然的话鼓励我继续前进；不要出现括号里的动作词。',
  '用一句自然的话告诉我你在认真陪着；不要出现动作、语气或旁白。',
  '用一句自然的话告诉我你会仔细看清楚；不要出现“点头”“叹气”“声音放软”。',
  '用一句自然的陪伴话回应我；不要出现全角括号。',
]);

export const DEFAULT_WAKE_NEGATIVE_PHRASES = Object.freeze([
  '今天的天气还不错',
  '我准备整理一下桌面',
  '打开这个网页看一眼',
  '不是在叫任何助手',
  '帮我记录一下这段话',
  '这里有一段普通背景声音',
  '我们继续做当前任务',
  '这个按钮稍后再点',
  '先检查一下日志输出',
  '我正在阅读屏幕内容',
]);

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const args = {
    baseUrl: env.NOE_PANEL_URL || DEFAULT_BASE,
    outDir: '',
    docDate: env.NOE_VOICE_EAR_DATE || shanghaiDate(),
    profileId: env.NOE_VOICE_EAR_PROFILE || 'default',
    wakePrefix: env.NOE_VOICE_EAR_WAKE_PREFIX || '',
    wakePrefixExplicit: Boolean(env.NOE_VOICE_EAR_WAKE_PREFIX),
    longRounds: Number(env.NOE_VOICE_EAR_LONG_ROUNDS || 10),
    bracketRounds: Number(env.NOE_VOICE_EAR_BRACKET_ROUNDS || 5),
    wakeRounds: Number(env.NOE_VOICE_EAR_WAKE_ROUNDS || 10),
    minAudioBytes: Number(env.NOE_VOICE_EAR_MIN_AUDIO_BYTES || DEFAULT_MIN_AUDIO_BYTES),
    requestTimeoutMs: Number(env.NOE_VOICE_EAR_TIMEOUT_MS || 0),
    play: false,
    skipVoice: false,
    skipWake: false,
    writeDoc: true,
    explicitAckReadOwnerToken: env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') args.baseUrl = argv[++i] || args.baseUrl;
    else if (arg.startsWith('--base-url=')) args.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--out-dir') args.outDir = argv[++i] || args.outDir;
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length);
    else if (arg === '--date') args.docDate = argv[++i] || args.docDate;
    else if (arg.startsWith('--date=')) args.docDate = arg.slice('--date='.length);
    else if (arg === '--profile') args.profileId = argv[++i] || args.profileId;
    else if (arg.startsWith('--profile=')) args.profileId = arg.slice('--profile='.length);
    else if (arg === '--wake-prefix') { args.wakePrefix = argv[++i] ?? args.wakePrefix; args.wakePrefixExplicit = true; }
    else if (arg.startsWith('--wake-prefix=')) { args.wakePrefix = arg.slice('--wake-prefix='.length); args.wakePrefixExplicit = true; }
    else if (arg === '--long-rounds') args.longRounds = Number(argv[++i] || args.longRounds);
    else if (arg.startsWith('--long-rounds=')) args.longRounds = Number(arg.slice('--long-rounds='.length));
    else if (arg === '--bracket-rounds') args.bracketRounds = Number(argv[++i] || args.bracketRounds);
    else if (arg.startsWith('--bracket-rounds=')) args.bracketRounds = Number(arg.slice('--bracket-rounds='.length));
    else if (arg === '--wake-rounds') args.wakeRounds = Number(argv[++i] || args.wakeRounds);
    else if (arg.startsWith('--wake-rounds=')) args.wakeRounds = Number(arg.slice('--wake-rounds='.length));
    else if (arg === '--min-audio-bytes') args.minAudioBytes = Number(argv[++i] || args.minAudioBytes);
    else if (arg.startsWith('--min-audio-bytes=')) args.minAudioBytes = Number(arg.slice('--min-audio-bytes='.length));
    else if (arg === '--request-timeout-ms') args.requestTimeoutMs = Number(argv[++i] || args.requestTimeoutMs);
    else if (arg.startsWith('--request-timeout-ms=')) args.requestTimeoutMs = Number(arg.slice('--request-timeout-ms='.length));
    else if (arg === '--play') args.play = true;
    else if (arg === '--skip-voice') args.skipVoice = true;
    else if (arg === '--skip-wake') args.skipWake = true;
    else if (arg === '--no-doc') args.writeDoc = false;
    else if (arg === '--ack-read-owner-token') args.explicitAckReadOwnerToken = true;
  }
  args.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: args.explicitAckReadOwnerToken,
    scope: 'voice-live:run',
  });
  args.ackReadOwnerToken = args.ownerTokenAuthorization.authorized;
  args.baseUrl = String(args.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  args.wakePrefix = String(args.wakePrefix || '');
  args.longRounds = Math.max(0, Math.min(50, Number.isFinite(args.longRounds) ? args.longRounds : 10));
  args.bracketRounds = Math.max(0, Math.min(30, Number.isFinite(args.bracketRounds) ? args.bracketRounds : 5));
  args.wakeRounds = Math.max(0, Math.min(50, Number.isFinite(args.wakeRounds) ? args.wakeRounds : 10));
  args.minAudioBytes = Math.max(1, Number.isFinite(args.minAudioBytes) ? args.minAudioBytes : DEFAULT_MIN_AUDIO_BYTES);
  args.requestTimeoutMs = Math.max(0, Number.isFinite(args.requestTimeoutMs) ? args.requestTimeoutMs : 0);
  args.outDir = args.outDir ? resolve(args.outDir) : join(ROOT, 'output', 'noe-voice-ear-acceptance', `voice-ear-${timestamp()}`);
  return args;
}

export async function resolveWakePrefix(args, token) {
  if (args.wakePrefixExplicit) return { prefix: String(args.wakePrefix || ''), source: 'explicit' };
  const fallback = '嘿 Noe，';
  try {
    const r = await requestJson(`${args.baseUrl}/api/noe/owner-gate`, { token, timeoutMs: Math.min(args.requestTimeoutMs || 5000, 5000) });
    const cfg = r.data?.config || {};
    if (cfg.enabled === false) return { prefix: '', source: 'owner_gate_disabled' };
    const passphrase = Array.isArray(cfg.passphrases) ? String(cfg.passphrases[0] || '').trim() : '';
    if (passphrase) return { prefix: `${passphrase} `, source: 'passphrase' };
    const wake = Array.isArray(cfg.wakeWords) ? String(cfg.wakeWords[0] || '').trim() : '';
    if (wake) return { prefix: `${wake}，`, source: 'wake_word' };
  } catch {
    // Fallback keeps the script useful against older servers without owner-gate publicConfig.
  }
  return { prefix: fallback, source: 'fallback' };
}

function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: String(process.env.NOE_OWNER_TOKEN).trim(), source: 'env', policyBlocked: false, reason: '' };
  try {
    return { token: readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  }
}

function fetchSignal(timeoutMs) {
  return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

// 传输层瞬时故障（连接被对端 keep-alive 回收/重置 → `fetch failed`、status=null）才重试；
// HTTP 响应（含 200+ok:false / 4xx / 5xx）一律照原样返回，不重试（那是真实业务结果）。
// 不加 AbortSignal 超时（owner 红线）；只在 fetch() 本身 throw 时重发，并强制新 socket 规避复用竞态。
const TRANSPORT_RETRY_RE = /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang ?up|other side closed|terminated|UND_ERR|network|connection (?:reset|closed|refused)/i;

export function isTransportError(err) {
  if (!err || err.name === 'AbortError') return false; // 主动/超时中断不重试
  const msg = `${err?.message || ''} ${err?.cause?.message || ''} ${err?.cause?.code || ''} ${err?.code || ''}`;
  return TRANSPORT_RETRY_RE.test(msg);
}

async function requestJson(url, { method = 'GET', token = '', body = null, timeoutMs = 0, transportRetries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= transportRetries; attempt += 1) {
    const headers = {};
    if (token) headers['X-Panel-Owner-Token'] = token;
    if (body) headers['Content-Type'] = 'application/json';
    // 重试时强制 Connection: close —— 不复用可能已被服务端 FIN 的 keep-alive socket（治 status=null fetch failed）。
    if (attempt > 0) headers['Connection'] = 'close';
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: fetchSignal(timeoutMs),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < transportRetries && isTransportError(e)) {
        console.warn(`[voice-ear] transport retry ${attempt + 1}/${transportRetries} url=${url.replace(/^https?:\/\/[^/]+/, '')} err=${String(e?.message || e).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      throw e;
    }
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
    return { ok: res.ok, status: res.status, data };
  }
  throw lastErr; // 不可达（循环内必 return 或 throw）
}

function run(command, args, { cwd = ROOT, timeoutMs = 45_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveRun({ ok: false, code: null, stdout, stderr, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ ok: code === 0, code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ ok: false, code: null, stdout, stderr, error: e?.message || String(e) });
    });
  });
}

function safeExt(format) {
  const raw = String(format || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!raw) return 'mp3';
  if (raw === 'mpeg') return 'mp3';
  return raw.slice(0, 8);
}

function decodeAudioBytes(audioBase64) {
  if (!audioBase64 || typeof audioBase64 !== 'string') return 0;
  try {
    return Buffer.from(audioBase64, 'base64').length;
  } catch {
    return 0;
  }
}

function sentenceCount(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const parts = s.split(/[。！？!?；;\n]+/).map((x) => x.trim()).filter(Boolean);
  return Math.max(1, parts.length);
}

export function containsActionParenthetical(text) {
  const s = String(text || '');
  const actionWords = '微笑|叹气|声音|动作|沉默|低头|眨眼|温柔|笑|摸头|拥抱|抱|停顿|皱眉|点头|语气|眼神|内心|旁白|歪头|撅嘴|轻声|放软';
  const fullWidthAny = /（[^（）]{0,120}）/.test(s);
  const actionParen = new RegExp(`[（(][^()（）]{0,120}(?:${actionWords})[^()（）]{0,120}[）)]`).test(s);
  return fullWidthAny || actionParen;
}

export function analyzeVoiceRound({ kind, prompt, response, restResponse = null, minAudioBytes = DEFAULT_MIN_AUDIO_BYTES }) {
  const data = response?.data || {};
  const restData = restResponse?.data || {};
  const reply = String(data.reply || '');
  const restTtsText = String(data.restTtsText || '');
  const firstAudioBytes = decodeAudioBytes(data.audioBase64);
  const restAudioBytes = restTtsText ? decodeAudioBytes(restData.audioBase64) : 0;
  const hasFirstAudio = firstAudioBytes >= minAudioBytes;
  const hasRestAudio = !restTtsText || restAudioBytes >= minAudioBytes;
  const bracketLeak = containsActionParenthetical(reply) || containsActionParenthetical(restTtsText);
  const delegatePlanLeak = data.intent === 'delegate_task' || /^【派活计划】/.test(reply);
  const replyLength = [...reply].length;
  const sentences = sentenceCount(reply);
  const longEnough = kind !== 'long' || replyLength >= 80 || sentences >= 3;
  const onlyFirstSentenceRisk = Boolean(restTtsText && !hasRestAudio);
  const ok = Boolean(response?.ok && data.ok && hasFirstAudio && hasRestAudio && longEnough && !bracketLeak && !delegatePlanLeak);
  return {
    kind,
    prompt,
    ok,
    status: response?.status || null,
    restStatus: restResponse?.status || null,
    reply,
    replyLength,
    sentenceCount: sentences,
    restTtsText,
    firstAudioBytes,
    restAudioBytes,
    hasFirstAudio,
    hasRestAudio,
    longEnough,
    bracketLeak,
    delegatePlanLeak,
    onlyFirstSentenceRisk,
    ttsError: data.ttsError || restData.error || null,
    usedAdapter: data.usedAdapter || null,
    usedModel: data.usedModel || null,
  };
}

function writeAudioFile(outDir, prefix, audioBase64, format) {
  const bytes = decodeAudioBytes(audioBase64);
  if (!bytes) return null;
  const file = join(outDir, `${prefix}.${safeExt(format)}`);
  writeFileSync(file, Buffer.from(audioBase64, 'base64'));
  return file;
}

async function captureVoiceRound({ kind, index, prompt, args, token }) {
  const sentText = `${args.wakePrefix}${prompt}`;
  const response = await requestJson(`${args.baseUrl}/api/noe/voice/chat`, {
    method: 'POST',
    token,
    body: { text: sentText, voice: true, profileId: args.profileId },
    timeoutMs: args.requestTimeoutMs,
  }).catch((e) => ({ ok: false, status: null, data: { ok: false, error: e?.message || String(e) } }));
  let restResponse = null;
  const restText = String(response.data?.restTtsText || '').trim();
  if (response.ok && response.data?.ok && restText) {
    restResponse = await requestJson(`${args.baseUrl}/api/noe/voice/tts`, {
      method: 'POST',
      token,
      body: { text: restText },
      timeoutMs: args.requestTimeoutMs,
    }).catch((e) => ({ ok: false, status: null, data: { ok: false, error: e?.message || String(e) } }));
  }
  const analysis = analyzeVoiceRound({ kind, prompt, response, restResponse, minAudioBytes: args.minAudioBytes });
  const label = `${kind}-${String(index + 1).padStart(2, '0')}`;
  const firstFile = writeAudioFile(args.outDir, `${label}-first`, response.data?.audioBase64, response.data?.audioFormat);
  const restFile = restResponse ? writeAudioFile(args.outDir, `${label}-rest`, restResponse.data?.audioBase64, restResponse.data?.audioFormat) : null;
  return {
    ...analysis,
    round: index + 1,
    wakePrefixSource: args.wakePrefixSource || '',
    wakePrefixLength: args.wakePrefix ? [...String(args.wakePrefix)].length : 0,
    firstAudioFile: firstFile ? relative(ROOT, firstFile) : '',
    restAudioFile: restFile ? relative(ROOT, restFile) : '',
    error: response.data?.error || restResponse?.data?.error || null,
  };
}

async function synthesizeWakeAudio(text, wavFile) {
  const aiff = wavFile.replace(/\.wav$/i, '.aiff');
  const say = await run('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, text], { timeoutMs: 45_000 });
  const sayOk = say.ok || (await run('/usr/bin/say', ['-o', aiff, text], { timeoutMs: 45_000 })).ok;
  if (!sayOk || !existsSync(aiff)) return { ok: false, error: say.stderr || say.error || 'say_failed' };
  const convert = await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wavFile], { timeoutMs: 45_000 });
  return { ok: convert.ok && existsSync(wavFile), error: convert.stderr || convert.error || null };
}

export function analyzeWakeResult({ phrase, response, expectedSpotted = false }) {
  const data = response?.data || {};
  const endpointUnavailable = response?.status === 501;
  const spotted = data.spotted === true || data.wake === true || data.detected === true;
  const ok = endpointUnavailable ? false : Boolean(response?.ok && data.ok !== false && spotted === expectedSpotted);
  return {
    phrase,
    ok,
    status: response?.status || null,
    endpointUnavailable,
    expectedSpotted,
    spotted,
    error: data.error || null,
  };
}

async function captureWakeRound({ phrase, index, args, token, expectedSpotted = false }) {
  const wavFile = join(args.outDir, `wake-${expectedSpotted ? 'positive' : 'negative'}-${String(index + 1).padStart(2, '0')}.wav`);
  const audio = await synthesizeWakeAudio(phrase, wavFile);
  if (!audio.ok) {
    return { phrase, ok: false, status: null, endpointUnavailable: false, expectedSpotted, spotted: null, error: audio.error || 'audio_generation_failed', audioFile: relative(ROOT, wavFile) };
  }
  const response = await requestJson(`${args.baseUrl}/api/noe/voice/wakeword`, {
    method: 'POST',
    token,
    body: { audio: readFileSync(wavFile).toString('base64') },
    timeoutMs: args.requestTimeoutMs,
  }).catch((e) => ({ ok: false, status: null, data: { ok: false, error: e?.message || String(e) } }));
  return { ...analyzeWakeResult({ phrase, response, expectedSpotted }), round: index + 1, audioFile: relative(ROOT, wavFile) };
}

function mdBool(value) {
  if (value === true) return '是';
  if (value === false) return '否';
  return '待确认';
}

function rel(file) {
  return file ? relative(ROOT, file) : '';
}

export function renderMarkdownReport(report) {
  const longRows = report.longRounds.map((r) => `| ${r.round} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.replyLength} | ${r.sentenceCount} | ${r.firstAudioBytes} | ${r.restTtsText ? '是' : '否'} | ${r.restAudioBytes || 0} | ${mdBool(r.onlyFirstSentenceRisk)} | ${mdBool(r.delegatePlanLeak)} | 待听 | ${r.firstAudioFile}${r.restAudioFile ? `<br>${r.restAudioFile}` : ''} |`);
  const bracketRows = report.bracketRounds.map((r) => `| ${r.round} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.replyLength} | ${mdBool(r.bracketLeak)} | ${mdBool(r.delegatePlanLeak)} | 待听 | ${r.firstAudioFile}${r.restAudioFile ? `<br>${r.restAudioFile}` : ''} |`);
  const wakeRows = report.wakeRounds.map((r) => `| ${r.round} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.phrase.replace(/\|/g, '/')} | ${r.status || ''} | ${r.endpointUnavailable ? '是' : '否'} | ${mdBool(r.spotted)} | 待确认 | ${r.audioFile || ''} |`);
  return `# 语音真耳验收 ${report.docDate}

> 自动脚本只验证接口、音频文件、续播文本、括号动作泄漏和 wakeword 误触信号；“是否真的听完整、是否听到括号、音色是否自然”必须由 owner 在本机扬声器/耳机现场确认。

## 元数据

- checkedAt: ${report.checkedAt}
- baseUrl: ${report.baseUrl}
- profileId: ${report.profileId}
- report: ${rel(report.reportFile)}
- audioDir: ${rel(report.outDir)}
- ownerTokenPrinted: false

## 自动结论

- longReply: ${report.summary.longPassed}/${report.summary.longTotal} pass
- bracketText: ${report.summary.bracketPassed}/${report.summary.bracketTotal} pass
- wakeFalsePositive: ${report.summary.wakePassed}/${report.summary.wakeTotal} pass
- needsOwnerEarReview: true

## 10 轮长回复

| 轮次 | 自动 | 回复字数 | 句数 | 首段音频 bytes | 有续播文本 | 续播音频 bytes | 只播开头风险 | 派活误判 | 人耳是否完整 | 音频 |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- |
${longRows.join('\n') || '| - | SKIP | - | - | - | - | - | - | - | - | - |'}

## 5 轮括号/动作文本

| 轮次 | 自动 | 回复字数 | 自动检测括号动作泄漏 | 派活误判 | 人耳是否念括号 | 音频 |
| --- | --- | ---: | --- | --- | --- | --- |
${bracketRows.join('\n') || '| - | SKIP | - | - | - | - | - |'}

## 10 次 wake word 误触

| 轮次 | 自动 | 负样本文本 | HTTP | KWS 未就位 | 是否误触 | 现场是否误触 | 音频 |
| --- | --- | --- | ---: | --- | --- | --- | --- |
${wakeRows.join('\n') || '| - | SKIP | - | - | - | - | - | - |'}

## Owner 现场复核

- [ ] 顺序播放每个 long round 的 first/rest 音频，确认不只播首句。
- [ ] 顺序播放 bracket round 音频，确认不念“微笑/点头/声音放软”等括号动作。
- [ ] 在真实麦克风/扬声器环境复测 wake word，确认普通旁音不误触。
- [ ] 如发现问题，把轮次、听到的内容和环境写回本文件。
`;
}

async function maybePlay(files) {
  for (const file of files.filter(Boolean)) {
    await run('/usr/bin/afplay', [resolve(ROOT, file)], { timeoutMs: 180_000 });
  }
}

async function main() {
  const args = parseArgs();
  mkdirSync(args.outDir, { recursive: true });
  const tokenPolicy = ownerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  const token = tokenPolicy.token;
  if (!token) {
    const reportFile = join(args.outDir, 'report.json');
    const report = {
      ok: false,
      kind: 'noe_voice_ear_acceptance',
      checkedAt: new Date().toISOString(),
      docDate: args.docDate,
      baseUrl: args.baseUrl,
      profileId: args.profileId,
      outDir: args.outDir,
      reportFile,
      ownerTokenPrinted: false,
      tokenPolicy: {
        source: tokenPolicy.source,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: Boolean(tokenPolicy.policyBlocked),
        reason: tokenPolicy.reason || '',
        secretValueReturned: false,
      },
      summary: { longTotal: 0, longPassed: 0, bracketTotal: 0, bracketPassed: 0, wakeTotal: 0, wakePassed: 0 },
      longRounds: [],
      bracketRounds: [],
      wakeRounds: [],
    };
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`report=${reportFile}`);
    process.exit(tokenPolicy.policyBlocked ? 2 : 1);
  }
  const wakePrefix = await resolveWakePrefix(args, token);
  args.wakePrefix = wakePrefix.prefix;
  args.wakePrefixSource = wakePrefix.source;
  console.log(`wakePrefixSource=${wakePrefix.source} wakePrefixLength=${[...wakePrefix.prefix].length}`);

  const longPrompts = DEFAULT_LONG_PROMPTS.slice(0, args.longRounds);
  const bracketPrompts = DEFAULT_BRACKET_PROMPTS.slice(0, args.bracketRounds);
  const wakePhrases = DEFAULT_WAKE_NEGATIVE_PHRASES.slice(0, args.wakeRounds);
  const longRounds = [];
  const bracketRounds = [];
  const wakeRounds = [];

  if (!args.skipVoice) {
    for (let i = 0; i < longPrompts.length; i += 1) {
      const round = await captureVoiceRound({ kind: 'long', index: i, prompt: longPrompts[i], args, token });
      longRounds.push(round);
      console.log(`${round.ok ? 'PASS' : 'FAIL'} long ${round.round} len=${round.replyLength} firstBytes=${round.firstAudioBytes} restBytes=${round.restAudioBytes}`);
    }
    for (let i = 0; i < bracketPrompts.length; i += 1) {
      const round = await captureVoiceRound({ kind: 'bracket', index: i, prompt: bracketPrompts[i], args, token });
      bracketRounds.push(round);
      console.log(`${round.ok ? 'PASS' : 'FAIL'} bracket ${round.round} leak=${round.bracketLeak} firstBytes=${round.firstAudioBytes} restBytes=${round.restAudioBytes}`);
    }
  }

  if (!args.skipWake) {
    for (let i = 0; i < wakePhrases.length; i += 1) {
      const round = await captureWakeRound({ phrase: wakePhrases[i], index: i, args, token, expectedSpotted: false });
      wakeRounds.push(round);
      console.log(`${round.ok ? 'PASS' : 'FAIL'} wake-negative ${round.round} spotted=${round.spotted} status=${round.status || 'n/a'}`);
    }
  }

  const reportFile = join(args.outDir, 'report.json');
  const summary = {
    longTotal: longRounds.length,
    longPassed: longRounds.filter((r) => r.ok).length,
    bracketTotal: bracketRounds.length,
    bracketPassed: bracketRounds.filter((r) => r.ok).length,
    wakeTotal: wakeRounds.length,
    wakePassed: wakeRounds.filter((r) => r.ok).length,
  };
  const report = {
    ok: [
      ...longRounds,
      ...bracketRounds,
      ...wakeRounds,
    ].every((r) => r.ok),
    kind: 'noe_voice_ear_acceptance',
    checkedAt: new Date().toISOString(),
    docDate: args.docDate,
    baseUrl: args.baseUrl,
    profileId: args.profileId,
    outDir: args.outDir,
    reportFile,
    minAudioBytes: args.minAudioBytes,
    ownerTokenPrinted: false,
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: false,
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    wakePrefixSource: args.wakePrefixSource,
    wakePrefixLength: [...String(args.wakePrefix || '')].length,
    needsOwnerEarReview: true,
    summary,
    longRounds,
    bracketRounds,
    wakeRounds,
  };
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  if (args.writeDoc) {
    const docFile = join(ROOT, 'docs', `语音真耳验收_${args.docDate}.md`);
    writeFileSync(docFile, renderMarkdownReport(report));
    report.docFile = docFile;
    writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`doc=${docFile}`);
  }
  if (args.play) {
    await maybePlay([...longRounds, ...bracketRounds].flatMap((r) => [r.firstAudioFile, r.restAudioFile]));
  }
  console.log(`report=${reportFile}`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || e);
    process.exit(1);
  });
}
