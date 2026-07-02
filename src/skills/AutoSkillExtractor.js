import { createHash } from 'node:crypto';
import { skillStore as defaultSkillStore } from './SkillStore.js';
import { createSkillExtractor } from './SkillExtractor.js';

const DONE_EVENTS = new Set(['debate_done', 'squad_done', 'arena_done', 'cross_verify_done']);
const DEFAULT_LOCAL_ADAPTERS = ['ollama', 'lmstudio'];

function text(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function digest(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function pushMessage(messages, role, content) {
  const c = text(content);
  if (c) messages.push({ role, content: c });
}

export function roomMessagesForSkillExtraction(room = {}) {
  const messages = [];
  pushMessage(messages, 'user', room.topic || room.objective?.description || room.objective?.title || room.name);
  for (const c of (Array.isArray(room.conversation) ? room.conversation : [])) {
    pushMessage(messages, c.from === 'user' ? 'user' : 'assistant', c.content);
  }
  for (const round of (Array.isArray(room.rounds) ? room.rounds : [])) {
    for (const turn of (Array.isArray(round?.turns) ? round.turns : [])) {
      pushMessage(messages, 'assistant', `[${round.kind || 'round'} · ${turn.displayName || turn.speaker || 'AI'}] ${turn.content || ''}`);
    }
  }
  for (const task of (Array.isArray(room.taskList) ? room.taskList : [])) {
    pushMessage(messages, 'assistant', `[task] ${task.title || task.desc || ''} ${task.summary || ''}`);
    for (const attempt of (Array.isArray(task.attempts) ? task.attempts : [])) pushMessage(messages, 'assistant', attempt.content);
    for (const review of (Array.isArray(task.reviews) ? task.reviews : [])) pushMessage(messages, 'assistant', typeof review === 'string' ? review : JSON.stringify(review));
  }
  pushMessage(messages, 'assistant', room.finalConsensus);
  return messages.slice(-24);
}

export function createLocalChat({ getAdapter, adapterIds = DEFAULT_LOCAL_ADAPTERS, taskId = 'noe-auto-skill-extract' } = {}) {
  return async (messages, opts = {}) => {
    let lastErr = null;
    for (const id of adapterIds) {
      const adapter = getAdapter?.(id);
      if (!adapter || typeof adapter.chat !== 'function') continue;
      try {
        const out = await adapter.chat(messages, { ...opts, budgetContext: { projectId: 'noe', taskId, adapterId: id }, think: false });
        if (out?.reply) return out;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`本地技能提取大脑不可用: ${lastErr?.message || adapterIds.join('→')}`);
  };
}

export function createAutoSkillExtractor({
  roomStore,
  getAdapter,
  store = defaultSkillStore,
  logger = console,
  schedule = setImmediate,
  enabled = process.env.NOE_AUTO_SKILL_EXTRACT !== '0',
  adapterIds = DEFAULT_LOCAL_ADAPTERS,
  minConfidence = 0.6,
} = {}) {
  const chat = createLocalChat({ getAdapter, adapterIds });
  const extractor = createSkillExtractor({ chat, store });
  const seen = new Set();

  async function extractRoom(room) {
    const messages = roomMessagesForSkillExtraction(room);
    if (!extractor.shouldExtract(messages)) return { extracted: false, reason: '未达自动提取触发条件' };
    return extractor.extract(messages, { minConfidence });
  }

  function handleRoomEvent(roomId, event = {}) {
    if (!enabled || !DONE_EVENTS.has(String(event?.type || ''))) return { queued: false, reason: 'ignored_event' };
    const room = roomStore?.get?.(roomId);
    if (!room) return { queued: false, reason: 'room_not_found' };
    const messages = roomMessagesForSkillExtraction(room);
    const key = `${roomId}:${digest(messages.map((m) => `${m.role}:${m.content}`).join('\n'))}`;
    if (seen.has(key)) return { queued: false, reason: 'already_queued' };
    seen.add(key);
    const promise = new Promise((resolve) => {
      schedule(() => {
        extractor.extract(messages, { minConfidence })
          .then(resolve)
          .catch((e) => {
            logger?.warn?.('[auto-skill-extract] failed:', e?.message || e);
            resolve({ extracted: false, reason: e?.message || String(e) });
          });
      });
    });
    return { queued: true, key, promise };
  }

  return { extractRoom, handleRoomEvent, roomMessagesForSkillExtraction };
}
