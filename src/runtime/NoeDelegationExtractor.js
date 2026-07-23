// @ts-check
// NoeDelegationExtractor — 对话委托桥（2026-06-11，owner 实痛：「我让他去找找原因，他只表面回答，
// 并没有去找」——对话通道的本地模型是纯文本生成，"做事"能力在另一条线（工作区→目标→research/act），
// 中间缺一座桥：owner 在对话里的委托没有变成目标，所以永远只是"聊"）。
//
// 本模块把桥架上：确定性正则识别 owner 话里的委托语（"去查查/帮我看看/排查一下"），命中即立
// owner 目标（仲裁最优先），带 research 步——下一个认知周期工作区夺冠 → 真上网研究 → 完成后
// 经主动开口回报。镜像 NoeCommitmentExtractor 哲学：零 LLM、宁缺勿滥（错立目标比漏立更伤）。
// env 门控：NOE_DELEGATION=1（装配端把关，本模块纯函数无开关）。

// 委托动词（祈使语气）：动作明确才算；纯疑问（"为什么会这样？"）不算——那是提问不是交办。
const DELEGATE_VERBS = /(?:帮我|给我|你去?|麻烦你?|让你)\s*(?:查一?下|查查|找一?找|找一?下|看一?看|看一?下|排查|调查|研究一?下|分析一?下|检查一?下|核实一?下|对比一?下|整理一?下)|(?:去|你)(?:查查|查一?下|找找|找一?下|排查|调查|研究|核实)(?:一?下)?/;
// 真实语音里 owner 常省掉主语："没有声音呢，找一下是什么原因"。这仍是交办，
// 但纯疑问"为什么没有声音"不是。裸动词只在带"原因/问题/怎么回事"时才认。
const BARE_DIAGNOSTIC_DELEGATION = /(?:查一?下|查查|找一?找|找一?下|再找一?下|看一?看|看一?下|排查|检查一?下|核实一?下)[^。！？!?]{0,80}(?:什么(?:原因|问题)|哪(?:里|儿).*?(?:问题|不对)|为(?:什么|啥)|怎么回事|原因|问题)/;
const OWNER_SELF_ACTION = /(?:^|[，。,；;\s])我\s*(?:去|来|先|再|马上|现在|自己)?\s*(?:查|找|排查|检查|核实|研究)/;
const ASSISTANT_PROMISE_NEGATIVE = /(?:如果|要是|需要的话|你要是).{0,30}(?:我|这边)?.{0,12}(?:查|找|排查|检查|核实|看看)|可以帮你(?:查|找|排查|检查|看看)/;
const ASSISTANT_TASK_PROMISE = /(?:我(?:先|现在|马上|这就|来|会|帮你|给你)?|我这边|这边)\s*(?:去|来)?\s*(?:查一?下|查查|找一?找|找一?下|看看|看一?看|排查|检查一?下|核实一?下|确认|定位)[^。！？!?]{0,90}(?:原因|问题|怎么回事|结果|状态|配置|服务|日志|链路|哪里|为什么|为啥)?|(?:查完|排查完|看完|确认后|有结果|处理完)[^。！？!?]{0,30}(?:告诉|汇报|回报|反馈|再说)/;
// 反指标：含这些词大概率不是给 Noe 的现场委托
const NOT_DELEGATION = /别查|不用查|不需要|刚才|上次|已经查|查过了|如果|要是|假如/;
const LOCAL_DIAGNOSTIC = /本地|项目|仓库|代码|文件|目录|读取|读文件|改代码|修复|排查|报错|bug|崩|失败|测试|语音|声音|听|说话|tts|stt|vad|cosy|kokoro|sherpa|主动|陪伴|开口|proactive|LM\s*Studio|Ollama|本地模型|电脑|Mac|面板|端口|51835|server|记忆|知识图谱|MemoryCore|FactExtractor|NoeMemory|目标|卡住|workspace|goal_step|act|research/i;
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
const DIAGNOSTIC_TEMPLATES = Object.freeze([
  {
    id: 'voice',
    label: '语音链路',
    match: /语音|声音|听|说话|断声|只说|tts|stt|vad|cosy|kokoro|sherpa|voice|audio/i,
    pattern: 'VoiceSession|voice|tts|stt|audio|cosy|kokoro|sherpa|vad|NOE_VOICE|NOE_STT|NOE_COSYVOICE|playPendingRest|fetchRestAudio',
    paths: ['src/voice', 'public/src/web/noe-voice.js', 'tests/unit', 'src/server/routes/noe.js', 'server.js'],
  },
  {
    id: 'model',
    label: '本地模型',
    match: /本地模型|LM\s*Studio|Ollama|模型|adapter|provider|BrainRouter|没反应|脑|加载/i,
    pattern: 'LmStudio|LM Studio|lmstudio|Ollama|ollama|BrainRouter|adapter|provider|local council|NOE_BRAIN|NOE_INNER_MODEL|model.*unavailable',
    paths: ['src/room', 'src/server/services/room-adapters.js', 'src/server/routes/noeLocalCouncil.js', 'tests/unit', 'server.js', 'package.json'],
  },
  {
    id: 'memory',
    label: '记忆',
    match: /记忆|MemoryCore|FactExtractor|NoeMemory|知识图谱|knowledge|没保存|忘/i,
    pattern: 'MemoryCore|FactExtractor|NoeMemory|MemoryCurator|KnowledgeGraph|knowledge|episodic|timeline|source_type|write\\(',
    paths: ['src/memory', 'src/knowledge', 'src/cognition', 'src/server/routes/knowledge.js', 'tests/unit'],
  },
  {
    id: 'goal',
    label: '目标执行',
    match: /目标|卡住|推进|goal|NoeGoal|workspace|act|research|步骤/i,
    pattern: 'NoeGoal|goal_step|recordStepResult|nextStep|act_started|act_done|research_started|research_done|awaiting_approval|blocked',
    paths: ['src/cognition', 'src/loop', 'src/runtime', 'src/server/routes/noeMind.js', 'tests/unit', 'public/mind.js'],
  },
  {
    id: 'panel',
    label: '面板/API',
    match: /面板|端口|51835|server|route|routes|API|500|404|页面|透视页|mind/i,
    pattern: 'register.*Routes|requireOwnerToken|sendError|HTTP|500|404|listen|51835|mind/goals|server.js|route',
    paths: ['src/server/routes', 'src/server/services', 'public', 'tests/unit/routes', 'server.js'],
  },
  {
    id: 'project',
    label: '项目通用',
    match: /项目|仓库|代码|文件|目录|报错|bug|崩|失败|测试|修复|排查/i,
    pattern: 'error|failed|throw|catch|TODO|FIXME|describe\\(|it\\(|test\\(',
    paths: ['src', 'public', 'tests', 'docs', 'server.js', 'package.json'],
  },
]);

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function templatesFor(task) {
  const s = String(task || '');
  const matched = DIAGNOSTIC_TEMPLATES.filter((tpl) => tpl.match.test(s));
  const specific = matched.filter((tpl) => tpl.id !== 'project');
  return specific.length ? specific : matched.length ? matched : [DIAGNOSTIC_TEMPLATES[DIAGNOSTIC_TEMPLATES.length - 1]];
}

function buildRgArgs(templates) {
  const patterns = uniq(templates.map((tpl) => tpl.pattern)).join('|');
  const paths = uniq(templates.flatMap((tpl) => tpl.paths));
  return [...SAFE_RG_OPTIONS, patterns, ...paths];
}

function buildDelegationSteps(task) {
  if (!LOCAL_DIAGNOSTIC.test(task)) {
    return [{ step: `查清楚并给出结论：${task}`, kind: 'research' }];
  }
  const templates = templatesFor(task);
  const domains = templates.map((tpl) => tpl.id);
  const labels = templates.map((tpl) => tpl.label).join('/');
  return [
    {
      step: `只读诊断${labels}线索：${task}`,
      kind: 'act',
      action: 'shell.exec',
      payload: {
        command: 'rg',
        args: buildRgArgs(templates),
        readonly: true,
        diagnosticDomains: domains,
        timeoutMs: 30000,
      },
    },
    { step: `结合本地诊断输出，归纳根因和下一步安全修复：${task}`, kind: 'think' },
  ];
}

/**
 * 从 owner 的一句话里识别委托。命中返回 {task}（task=整句裁剪——只取宾语会丢上下文，
 * 如「语音系统又出问题了，去找找什么原因」的宾语"什么原因"无信息量，整句才查得动）。
 * @param {string} ownerText
 * @returns {{task: string}|null}
 */
export function extractDelegation(ownerText) {
  const t = String(ownerText || '').trim();
  if (t.length < 6 || t.length > 400) return null;
  if (NOT_DELEGATION.test(t)) return null;
  const explicit = DELEGATE_VERBS.test(t);
  const bareDiagnostic = !OWNER_SELF_ACTION.test(t) && BARE_DIAGNOSTIC_DELEGATION.test(t);
  if (!explicit && !bareDiagnostic) return null;
  return { task: t.slice(0, 140) };
}

/**
 * 检测 Noe 回复里的"我去查/我马上排查/查完告诉你"。如果嘴已经承诺异步做事，
 * 但 owner 原话没有被委托桥命中，就用这个兜底补一张真实任务，避免悬空承诺。
 * @param {string} reply
 * @returns {boolean}
 */
export function detectAssistantTaskPromise(reply) {
  const text = String(reply || '').trim();
  if (text.length < 4) return false;
  if (ASSISTANT_PROMISE_NEGATIVE.test(text)) return false;
  return ASSISTANT_TASK_PROMISE.test(text);
}

/**
 * @param {string} transcript
 * @returns {string}
 */
export function taskTextFromAssistantPromise(transcript) {
  return `帮我排查一下：${String(transcript || '').trim().slice(0, 180)}`;
}

/**
 * 建一个对话钩子：owner 每句话过一遍，命中委托 → 立 owner 目标（同名未关目标由
 * GoalSystem 自动去重，重复委托不会重复立项）。
 * @param {object} deps
 * @param {{add: Function}} deps.goalSystem
 * @param {(e: object) => void} [deps.recordEpisode] 接了委托也是一段经历（高盐度，反刍/回报素材）
 * @param {(text: string) => {task: string}|null} [deps.extract]
 * @param {boolean} [deps.returnReceipt] true 时返回结构化接单回执；默认保持旧契约返回 goalId
 * @param {{add?: Function}} [deps.taskReportbacks] 可选任务回报队列
 * @returns {(ownerText: string) => string|object|null} 返回 goalId 或接单回执（未命中/失败 null）
 */
export function createDelegationHook({ goalSystem, recordEpisode = null, extract = extractDelegation, returnReceipt = false, taskReportbacks = null } = {}) {
  return (ownerText) => {
    try {
      if (!goalSystem?.add) return null;
      const d = extract(ownerText);
      if (!d) return null;
      const steps = buildDelegationSteps(d.task);
      const title = `主人委托：${d.task}`;
      const goalId = goalSystem.add({
        title,
        source: 'owner',
        why: '对话里主人直接交办（NoeDelegationExtractor 桥）',
        steps,
      });
      if (goalId) {
        try { recordEpisode?.({ type: 'interaction', summary: `主人交办我去办：${d.task.slice(0, 50)}，我接下了`, salience: 4 }); } catch { /* 留痕失败不阻断 */ }
        const firstStep = steps[0] || null;
        const receipt = {
          goalId,
          taskId: goalId,
          title,
          task: d.task,
          status: 'accepted',
          source: 'owner',
          nextStep: firstStep ? firstStep.step : '',
          kind: firstStep?.kind || 'think',
          createdAt: Date.now(),
          summary: firstStep ? `已接单，正在执行：${firstStep.step}` : '已接单，正在拆解下一步。',
        };
        try { taskReportbacks?.add?.({ ...receipt, status: 'accepted', speak: false, source: 'delegation' }); } catch { /* 回报队列失败不阻断 */ }
        return returnReceipt ? receipt : goalId;
      }
      return null;
    } catch { return null; }
  };
}
