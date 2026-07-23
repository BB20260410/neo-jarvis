// @ts-check
import { clamp01 } from '../cognition/_mathUtils.js';

const STALE_AFTER_MS = 120_000;

const TERMS = Object.freeze({
  coding: ['代码', '写代码', '编程', '终端', '编辑器', '函数', '测试', 'debug', '调试', 'IDE', '报错', '失败', '构建', '日志'],
  reading: ['文档', '阅读', '网页', '文章', 'PDF', '资料', '报告', '笔记', '看资料'],
  meeting: ['会议', '视频会议', '通话', '开会', '摄像头会议', '共享屏幕'],
  chatting: ['聊天', '消息', '微信', '对话', '回复', '输入消息'],
  media: ['视频', '电影', '直播', '音乐', '游戏', '播放', '观看'],
  idle: ['空白', '桌面', '黑屏', '无内容', '没有明显活动', '发呆'],
  focused: ['专注', '认真', '打字', '盯着', '正在写', '正在读', '聚焦'],
  stuck: ['卡住', '困惑', '反复', '犹豫', '不知道', '停住', '报错', '失败', '错误', '问题'],
  tired: ['累', '疲惫', '困', '揉眼', '打哈欠', '久坐', '疲劳', '低头', '皱眉'],
  switching: ['切换', '来回', '频繁', '多个窗口', '多任务', '跳来跳去'],
});

function norm(value) {
  return String(value || '').toLowerCase();
}

function hit(text, terms) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function confidenceFor(flags, { stale, summary }) {
  if (!summary) return 0;
  const count = Object.values(flags).filter(Boolean).length;
  let confidence = 0.18 + Math.min(0.52, count * 0.08);
  if (flags.activityKnown) confidence += 0.16;
  if (flags.attentionKnown) confidence += 0.1;
  if (flags.needKnown) confidence += 0.06;
  if (stale) confidence = Math.min(confidence, 0.35);
  return Math.round(clamp01(confidence) * 100) / 100;
}

/**
 * 将 VLM 的自然语言摘要压成可审计的处境状态。只用确定性关键词，不调用模型，不保存原始画面。
 * @param {object} input
 * @returns {{version:number,activity:string,attention:string,possibleNeed:string,shouldInterrupt:boolean,confidence:number,evidence:string[],stale:boolean,ageMs:number|null,mode:string}}
 */
export function classifyNoeVisionSituation({ summary = '', mode = 'unknown', at = null, now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const text = norm(summary);
  const ts = timestampMs(at);
  const current = Number(typeof now === 'function' ? now() : now) || Date.now();
  const ageMs = ts ? Math.max(0, current - ts) : null;
  const stale = !text.trim() || !ts || (ageMs !== null && ageMs > staleAfterMs);

  const flags = {
    coding: hit(text, TERMS.coding),
    reading: hit(text, TERMS.reading),
    meeting: hit(text, TERMS.meeting),
    chatting: hit(text, TERMS.chatting),
    media: hit(text, TERMS.media),
    idle: hit(text, TERMS.idle),
    focused: hit(text, TERMS.focused),
    stuck: hit(text, TERMS.stuck),
    tired: hit(text, TERMS.tired),
    switching: hit(text, TERMS.switching),
    activityKnown: false,
    attentionKnown: false,
    needKnown: false,
  };

  let activity = 'unknown';
  if (flags.switching) activity = 'task_switching';
  else if (flags.meeting) activity = 'meeting';
  else if (flags.chatting) activity = 'chatting';
  else if (flags.coding) activity = 'coding';
  else if (flags.reading) activity = 'reading';
  else if (flags.media) activity = 'media';
  else if (flags.idle) activity = 'idle';
  flags.activityKnown = activity !== 'unknown';

  let attention = 'unknown';
  if (flags.tired) attention = 'tired';
  else if (flags.stuck) attention = 'stuck';
  else if (flags.switching) attention = 'distracted';
  else if (flags.focused || flags.coding || flags.reading) attention = 'focused';
  else if (flags.media || flags.idle) attention = 'relaxed';
  flags.attentionKnown = attention !== 'unknown';

  let possibleNeed = 'unknown';
  if (flags.tired) possibleNeed = 'rest';
  else if (flags.stuck && flags.coding) possibleNeed = 'debug_help';
  else if (flags.stuck) possibleNeed = 'task_refocus';
  else if (flags.switching) possibleNeed = 'task_refocus';
  else if (flags.reading) possibleNeed = 'reading_summary';
  else if (flags.meeting || flags.chatting) possibleNeed = 'conversation_support';
  else if (flags.coding || flags.media || flags.idle) possibleNeed = 'none';
  flags.needKnown = possibleNeed !== 'unknown';

  const shouldInterrupt = !stale && (flags.tired || flags.stuck || flags.switching);
  const evidence = [];
  for (const [name, value] of Object.entries(flags)) {
    if (value === true && !name.endsWith('Known')) evidence.push(`signal:${name}`);
  }
  if (shouldInterrupt) evidence.push('policy:interrupt_allowed');
  if (stale) evidence.push('policy:stale_no_interrupt');

  return {
    version: 1,
    activity,
    attention,
    possibleNeed,
    shouldInterrupt,
    confidence: confidenceFor(flags, { stale, summary: text }),
    evidence: evidence.slice(0, 12),
    stale,
    ageMs,
    mode: String(mode || 'unknown').slice(0, 40),
  };
}
