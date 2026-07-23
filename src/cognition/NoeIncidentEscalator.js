// @ts-check
// NoeIncidentEscalator — self-detected system fault → repair goal.
//
// Inner monologue is only awareness. This module is the missing bridge that turns
// a concrete runtime fault signal into a deduped, owner-visible, executable
// system_repair goal.

const SAFE_RG_OPTIONS = Object.freeze([
  '-n',
  '-i',
  '--max-count',
  '80',
  '--glob',
  '!**/.env*',
  '--glob',
  '!**/*token*',
  '--glob',
  '!**/*cookie*',
  '--glob',
  '!**/*oauth*',
  '--glob',
  '!**/room-adapters.json',
  '--glob',
  '!games/cartoon-apocalypse/**',
]);

const INCIDENT_TEMPLATES = Object.freeze([
  {
    domain: 'voice',
    label: '语音链路',
    match: /语音|声音|听|说话|断声|断了|没听全|没有声音|只说|tts|stt|vad|cosy|kokoro|sherpa|audio/i,
    pattern: 'VoiceSession|voice|tts|stt|audio|cosy|kokoro|sherpa|vad|restTtsText|playNoeResponseAudio|taskReportbacks|speech-ack',
    paths: ['src/voice', 'public/cognitive.html', 'public/src/web/noe-voice.js', 'src/server/routes/noe.js', 'server.js', 'tests/unit'],
    verify: ['test', '--', 'tests/unit/noe-voice-session.test.js', 'tests/unit/noe-task-reportback-wiring.test.js', 'tests/unit/noe-task-reportback-queue.test.js', 'tests/unit/routes/noe-routes.test.js'],
  },
  {
    domain: 'task_reportback',
    label: '任务回报链路',
    match: /任务|回报|汇报|状态栏|执行中|reportback|speech-ack|task card|spokenAt|deliveredAt/i,
    pattern: 'NoeTaskReportbackQueue|taskReportbacks|speech-ack|upsertTaskCard|speakTaskReport|onGoalReportback|taskReceipt',
    paths: ['src/cognition', 'src/server/routes/noe.js', 'src/voice', 'public/cognitive.html', 'tests/unit'],
    verify: ['test', '--', 'tests/unit/noe-task-reportback-wiring.test.js', 'tests/unit/noe-task-reportback-queue.test.js', 'tests/unit/routes/noe-routes.test.js'],
  },
  {
    domain: 'goal',
    label: '目标执行链路',
    match: /目标|卡住|推进|goal|workspace|goal_step|act|research|步骤|行动失败|blocked|failed/i,
    pattern: 'NoeGoal|goal_step|recordStepResult|nextStep|act_started|act_done|research_started|research_done|awaiting_approval|blocked|failed',
    paths: ['src/cognition', 'src/loop', 'src/runtime', 'src/server/routes/noeMind.js', 'public/mind.js', 'tests/unit'],
    verify: ['test', '--', 'tests/unit/noe-workspace-goals.test.js', 'tests/unit/noe-goal-system.test.js'],
  },
  {
    domain: 'panel',
    label: '面板/API',
    match: /面板|页面|端口|51835|server|route|routes|api|500|404|mind|cognitive/i,
    pattern: 'register.*Routes|requireOwnerToken|sendError|HTTP|500|404|listen|51835|cognitive|mind|route',
    paths: ['src/server/routes', 'src/server/services', 'public', 'tests/unit/routes', 'server.js'],
    verify: ['test', '--', 'tests/unit/routes/noe-routes.test.js', 'tests/unit/routes/noe-mind-routes.test.js'],
  },
  {
    domain: 'model',
    label: '本地模型',
    match: /本地模型|LM\s*Studio|Ollama|模型|adapter|provider|BrainRouter|没反应|脑|加载|unavailable/i,
    pattern: 'LmStudio|LM Studio|lmstudio|Ollama|ollama|BrainRouter|adapter|provider|NOE_BRAIN|NOE_INNER_MODEL|model.*unavailable',
    paths: ['src/room', 'src/model', 'src/server/services/room-adapters.js', 'tests/unit', 'server.js', 'package.json'],
    verify: ['test', '--', 'tests/unit/lmstudio-chat-adapter.test.js', 'tests/unit/lmstudio-loader.test.js', 'tests/unit/noe-local-model-policy.test.js'],
  },
  {
    domain: 'memory',
    label: '记忆链路',
    match: /记忆|MemoryCore|FactExtractor|NoeMemory|知识图谱|knowledge|没保存|忘|timeline/i,
    pattern: 'MemoryCore|FactExtractor|NoeMemory|MemoryCurator|KnowledgeGraph|knowledge|episodic|timeline|source_type|write\\(',
    paths: ['src/memory', 'src/knowledge', 'src/cognition', 'src/server/routes/knowledge.js', 'tests/unit'],
    verify: ['test', '--', 'tests/unit/noe-memory-focus.test.js', 'tests/unit/noe-fact-extractor.test.js'],
  },
  {
    domain: 'system',
    label: '系统运行',
    match: /报错|bug|崩|失败|异常|error|exception|timeout|hang|stuck|crash/i,
    pattern: 'error|failed|blocked|throw|catch|timeout|hang|exception|describe\\(|it\\(|test\\(',
    paths: ['src', 'public', 'tests', 'server.js', 'package.json'],
    verify: ['test:p0:unit'],
  },
]);

const FAULT_RE = /出问题|故障|断了|没听全|没有声音|没声音|只说|失败|报错|异常|崩|卡住|阻塞|blocked|failed|error|exception|timeout|500|404/i;
const NEGATIVE_RE = /如果|假如|别管|不用|不需要|只是想|有点遗憾但不用|测试一下情绪/i;
const BROWSER_PLAYBACK_CONFIRM_RE = /\bplay_(?:start|confirm)_timeout\b|browser_audio_failed|浏览器任务语音播放失败|任务语音汇报播放失败/i;
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;}]+|[^\s,;}]+)/gi;

function cleanText(value, max = 240) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function templateFor(text) {
  const t = String(text || '');
  return INCIDENT_TEMPLATES.find((tpl) => tpl.match.test(t)) || INCIDENT_TEMPLATES[INCIDENT_TEMPLATES.length - 1];
}

function templateForIncident({ source = '', status = '', text = '' } = {}) {
  const s = `${source} ${status}`;
  if (/task_reportback/i.test(s)) {
    return INCIDENT_TEMPLATES.find((tpl) => tpl.domain === 'task_reportback') || templateFor(text);
  }
  return templateFor(text);
}

function buildRgArgs(template) {
  return [...SAFE_RG_OPTIONS, template.pattern, ...template.paths].slice(0, 38);
}

function incidentStateKey(incident) {
  return `noe.incident.${incident.domain}`;
}

function goalTitleFor(incident) {
  return `系统自修复：${incident.label}`;
}

function findOpenGoal(goalSystem, title) {
  try {
    const rows = goalSystem?.list?.({ limit: 100 }) || [];
    return rows.find((g) => g?.title === title && ['open', 'active'].includes(String(g.status || '')));
  } catch { return null; }
}

export function classifyIncidentSignal(input = {}) {
  const source = cleanText(input.source || input.type || '', 80);
  const status = cleanText(input.status || '', 40);
  const text = cleanText(input.text || input.summary || input.error || input.message || '', 500);
  if (!text || NEGATIVE_RE.test(text)) return null;
  if (/task_reportback/i.test(source) && BROWSER_PLAYBACK_CONFIRM_RE.test(`${status} ${text}`)) return null;
  if (source === 'inner_monologue' && BROWSER_PLAYBACK_CONFIRM_RE.test(text)) return null;
  const explicitFailureSource = /failed_action|voice_error|task_reportback|runtime_error/i.test(source);
  const failedStatus = /failed|blocked|error|exception|play_failed|tts_failed/i.test(status);
  if (!explicitFailureSource && !failedStatus && !FAULT_RE.test(text)) return null;
  const tpl = templateForIncident({ source, status, text });
  if (source === 'inner_monologue' && tpl.domain === 'system' && !FAULT_RE.test(text)) return null;
  return {
    domain: tpl.domain,
    label: tpl.label,
    source: source || 'unknown',
    status: status || null,
    text,
    title: goalTitleFor(tpl),
    template: tpl,
    at: Number(input.ts || input.at) || Date.now(),
    ref: cleanText(input.ref || input.id || '', 160) || null,
  };
}

export function buildRepairGoal(incident) {
  const tpl = incident.template || templateFor(incident.text);
  const task = cleanText(incident.text, 160);
  return {
    title: goalTitleFor({ label: tpl.label }),
    source: 'system_repair',
    why: `Noe 自己检测到${tpl.label}故障（${incident.source || 'unknown'}）：${task}`,
    steps: [
      {
        step: `只读诊断${tpl.label}故障线索：${task}`,
        kind: 'act',
        action: 'shell.exec',
        payload: {
          command: 'rg',
          args: buildRgArgs(tpl),
          readonly: true,
          diagnosticDomains: ['incident_repair', tpl.domain],
          timeoutMs: 30000,
        },
      },
      {
        step: `运行${tpl.label}相关验证，判断故障是否已被覆盖或仍失败`,
        kind: 'act',
        action: 'shell.exec',
        payload: {
          command: 'npm',
          args: tpl.verify,
          readonly: true,
          diagnosticDomains: ['incident_repair', tpl.domain, 'verification'],
          timeoutMs: 120000,
        },
      },
      {
        step: `结合诊断和验证输出，给出${tpl.label}根因、已修复证据或 blocked 条件`,
        kind: 'think',
      },
    ],
    incident: {
      domain: tpl.domain,
      label: tpl.label,
      source: incident.source,
      ref: incident.ref || null,
      at: incident.at,
    },
  };
}

export function createIncidentEscalator({
  goalSystem = null,
  taskReportbacks = null,
  recordEpisode = null,
  state = null,
  now = Date.now,
  cooldownMs = 20 * 60_000,
} = {}) {
  const mem = new Map();
  const getState = (key) => {
    try { return state?.get ? state.get(key) : mem.get(key); } catch { return null; }
  };
  const setState = (key, value) => {
    try { state?.set ? state.set(key, value) : mem.set(key, value); } catch { /* state is best-effort */ }
  };

  function observe(input = {}) {
    try {
      if (!goalSystem?.add) return { ok: false, reason: 'no_goal_system' };
      const incident = classifyIncidentSignal(input);
      if (!incident) return { ok: true, created: false, reason: 'not_incident' };
      const title = goalTitleFor(incident);
      const existing = findOpenGoal(goalSystem, title);
      if (existing?.id) return { ok: true, created: false, deduped: true, reason: 'open_goal_exists', goalId: existing.id, incident };
      const key = incidentStateKey(incident);
      const last = getState(key);
      if (last?.at && now() - Number(last.at) < cooldownMs) {
        return { ok: true, created: false, deduped: true, reason: 'cooldown', goalId: last.goalId || null, incident };
      }
      const goal = buildRepairGoal({ ...incident, at: now() });
      const goalId = goalSystem.add(goal);
      if (!goalId) return { ok: false, created: false, reason: 'goal_add_failed', incident };
      setState(key, { at: now(), goalId, title });
      const firstStep = goal.steps[0];
      const report = {
        goalId,
        taskId: goalId,
        title: goal.title,
        summary: `已自动接入自修复：${firstStep.step}`,
        status: 'accepted',
        kind: 'incident_repair',
        source: 'incident_escalator',
        speak: false,
        dedupeKey: `incident:${incident.domain}:${goalId}:accepted`,
      };
      try { taskReportbacks?.add?.(report); } catch { /* reportback failure must not block repair */ }
      try { recordEpisode?.({ type: 'observation', summary: `我检测到${incident.label}故障，已创建自修复目标：${goal.title}`, salience: 5 }); } catch { /* timeline best-effort */ }
      return { ok: true, created: true, goalId, incident, goal };
    } catch (e) {
      return { ok: false, reason: 'exception', error: cleanText(e?.message || e, 180) };
    }
  }

  return { observe, classify: classifyIncidentSignal, buildRepairGoal };
}
