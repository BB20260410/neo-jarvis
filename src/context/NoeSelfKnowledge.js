// NoeSelfKnowledge — Noe 的「自我能力认知」层。
//
// 问题:Noe 装了一堆技术(声纹/人脸/语音/记忆/梦境/多模型/自我进化…),但 LLM 大脑的系统提示里
//   从没被告知这些 → 你问"你有声纹识别吗?",它不知道、答不出。本模块把 Noe 的**真实已落地能力**
//   做成一份清单,拼成 <noe-self-knowledge> 块注入系统提示,让大脑知道"我能做什么、用什么实现的"。
//
// 原则:只列真实落地的能力(别让它吹没有的)。能反映活态的(如声纹真模型在不在)就反映。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERIFIED = 'verified';
const DECLARED = 'declared';
let verificationCache = { at: 0, data: null };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function latestJson(dir, pred = () => true) {
  const files = walk(dir)
    .filter(pred)
    .map((file) => {
      try { return { file, mtimeMs: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = readJson(item.file);
    if (json) return { file: item.file, json };
  }
  return { file: '', json: null };
}

function rel(file) {
  return file && file.startsWith(ROOT) ? file.slice(ROOT.length + 1) : file || '';
}

function flattenChecks(summary) {
  return Object.values(summary?.dimensions || {})
    .flatMap((d) => Array.isArray(d?.checks) ? d.checks : []);
}

function collectVerificationState() {
  const now = Date.now();
  if (verificationCache.data && now - verificationCache.at < 60_000) return verificationCache.data;
  const noe100 = latestJson(join(ROOT, 'output', 'noe-100-readiness'), (f) => /noe-100-readiness-\d+\.json$/.test(f));
  const growth = latestJson(join(ROOT, 'output', 'noe-growth-readiness'), (f) => /\/report\.json$/.test(f));
  const checks = new Map(flattenChecks(noe100.json).map((c) => [c.id, c]));
  const state = { noe100, growth, checks };
  verificationCache = { at: now, data: state };
  return state;
}

function verifiedByCheck(state, id) {
  const check = state.checks.get(id);
  if (check?.ok !== true) return null;
  return { ref: rel(state.noe100.file), note: id };
}

function selfKnowledgeVerification(id) {
  const state = collectVerificationState();
  const evidence = [];
  const addCheck = (checkId) => {
    const ref = verifiedByCheck(state, checkId);
    if (ref) evidence.push(ref);
    return Boolean(ref);
  };
  let ok = false;
  if (id === 'memory') ok = addCheck('evidence_refs_non_empty') || addCheck('insight_memory_exists');
  else if (id === 'goals') ok = addCheck('self_learning_done');
  else if (id === 'heartbeat') ok = addCheck('recent_done_tick_10m');
  else if (id === 'workspace') ok = addCheck('workspace_focus_recorded');
  else if (id === 'expectations') ok = addCheck('expectation_ledger_has_fuel') && addCheck('brier_available');
  else if (id === 'stream-v2') ok = addCheck('inner_monologue_grounding_sampled');
  else if (id === 'dream') {
    ok = state.growth.json?.sleepPipeline?.dreamConsolidation?.ok === true;
    if (ok) evidence.push({ ref: rel(state.growth.file), note: 'dreamConsolidation.ok' });
  } else if (id === 'self-evolution' || id === 'self-improve') {
    ok = state.growth.json?.autonomyRegressionGate?.ok === true;
    if (ok) evidence.push({ ref: rel(state.growth.file), note: 'autonomyRegressionGate.ok' });
  }
  return {
    status: ok ? VERIFIED : DECLARED,
    evidenceRefs: evidence.slice(0, 2),
  };
}

function annotateCapability(cap) {
  const verification = selfKnowledgeVerification(cap.id);
  return { ...cap, ...verification };
}

function trimDetail(text, max) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 3))}...`;
}

/** 检测本地流式 STT(sherpa-onnx zipformer)模型是否就位(卡①语音实时化;就位即默认启用,whisper 兜底)。 */
export function detectSherpaSttStatus() {
  const dir = process.env.NOE_SHERPA_MODEL_DIR
    || join(homedir(), '.noe-voice', 'models', 'sherpa', 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20');
  return { available: existsSync(join(dir, 'encoder-epoch-99-avg-1.int8.onnx')) && existsSync(join(dir, 'tokens.txt')) };
}

/** 检测神经网络 VAD(silero)模型是否就位(借鉴 ricky0123/vad;NOE_SILERO_VAD=1 启用，STT 前精筛真人声)。 */
export function detectSileroVadStatus() {
  return { available: existsSync(process.env.NOE_SILERO_VAD_MODEL || join(homedir(), '.noe-voice', 'models', 'sherpa', 'silero_vad.onnx')) };
}

/** 检测本地 CosyVoice 中文 TTS 兜底(卡②)是否就位(模型已下;服务起没起由运行时 available() 判断)。 */
export function detectCosyVoiceStatus() {
  const dir = process.env.NOE_COSYVOICE_ROOT || join(homedir(), '.noe-voice', 'cosyvoice');
  const cosy3Model = process.env.NOE_COSYVOICE3_MLX_MODEL
    || join(homedir(), '.noe-voice', 'cosyvoice3-mlx', 'Fun-CosyVoice3-0.5B-2512-fp16');
  const cosy3Python = process.env.NOE_COSYVOICE3_MLX_PYTHON
    || join(homedir(), '.noe-voice', 'mlx-audio-plus', 'bin', 'python');
  const cosy3 = existsSync(join(cosy3Model, 'model.safetensors')) && existsSync(cosy3Python);
  if (cosy3) return { available: true, engine: 'CosyVoice3 MLX fp16', model: 'Fun-CosyVoice3-0.5B-2512-fp16' };
  const sft = existsSync(join(dir, 'pretrained_models', 'CosyVoice-300M-SFT', 'llm.pt'));
  return { available: sft, engine: sft ? 'CosyVoice-300M-SFT' : '', model: sft ? 'CosyVoice-300M-SFT' : '' };
}

/** 检测屏幕读字 OCR(RapidOCR 独立 venv)是否就位(卡③)。 */
export function detectOcrStatus() {
  return { available: existsSync(process.env.NOE_OCR_PYTHON || join(homedir(), '.noe-panel', 'ocr-venv', 'bin', 'python')) };
}

/** 检测声纹真模型(CAMPPlus)是否就位;否则仍有内置 lite 声纹。 */
export function detectVoiceprintStatus() {
  const modelFile = process.env.NOE_CAMPP_MODEL_DIR
    ? join(process.env.NOE_CAMPP_MODEL_DIR, 'campplus_cn_common.bin')
    : join(homedir(), '.cache', 'modelscope', 'hub', 'models', 'iic', 'speech_campplus_sv_zh-cn_16k-common', 'campplus_cn_common.bin');
  const camppc = existsSync(modelFile);
  return {
    available: true, // 内置 lite 声纹始终可用
    engine: camppc ? 'CAMPPlus(真说话人模型)+ 内置 lite 双引擎' : '内置 lite 声纹引擎(CAMPPlus 模型未装)',
    camppc,
  };
}

/** 检测连续记忆脊椎(自传体时间线)是否通电(NOE_CONTINUITY=1;OFF 时模块在但不记录/不注入)。 */
export function detectContinuityStatus() {
  return { enabled: process.env.NOE_CONTINUITY === '1' };
}

/** 检测时间节律(昼夜作息)是否通电(NOE_CIRCADIAN=1;OFF 时模块在但不调制任何行为)。 */
export function detectCircadianStatus() {
  return { enabled: process.env.NOE_CIRCADIAN === '1' };
}

/** 检测心境本地模型情感分析是否通电(NOE_MOOD_MODEL=1;OFF 时 mood 仍是规则启发式推断)。 */
export function detectMoodModelStatus() {
  return { enabled: process.env.NOE_MOOD_MODEL === '1' };
}

/** 检测梦境升华(久远情景→语义记忆)是否通电(NOE_DREAM_EPISODES=1;OFF 时模块在但不升华)。 */
export function detectEpisodeSublimationStatus() {
  return { enabled: process.env.NOE_DREAM_EPISODES === '1' };
}

/** 检测反刍升华(念头→牵挂/提醒)是否通电(需 NOE_INNER_SPEAK=1 且 NOE_INNER_MONOLOGUE=1 提供念头源;默认 OFF)。 */
export function detectThoughtSublimationStatus() {
  return { enabled: process.env.NOE_INNER_SPEAK === '1' && process.env.NOE_INNER_MONOLOGUE === '1' };
}

/** 检测叙事自我(我的故事)是否通电(NOE_NARRATIVE_SELF=1;OFF 时不生成不注入)。 */
export function detectNarrativeSelfStatus() {
  return { enabled: process.env.NOE_NARRATIVE_SELF === '1' };
}

/** 检测面板 UI 感知聊天注入是否通电(需 NOE_CHAT_CONTEXT=1 且 NOE_CHAT_UISIGNALS=1;OFF 时仅议会路径消费 UI 信号)。 */
export function detectChatUiSignalsStatus() {
  return { enabled: process.env.NOE_CHAT_CONTEXT === '1' && process.env.NOE_CHAT_UISIGNALS === '1' };
}

/** 检测主脑 Qwen reflect tier 是否通电(NOE_REFLECT_TIER=1;OFF 时各自主认知作业仍默认主脑 Qwen)。 */
export function detectReflectBrainStatus() {
  return { enabled: process.env.NOE_REFLECT_TIER === '1' };
}

/** 检测持久心跳是否通电(NOE_HEARTBEAT=1;OFF 时反刍走 setInterval、主动陪伴依赖前端轮询)。 */
export function detectHeartbeatStatus() {
  return { enabled: process.env.NOE_HEARTBEAT === '1' };
}

/** 检测情感引擎是否通电(NOE_AFFECT=1;OFF 时心境仍是 MoodAnalyzer/启发式,无连续情感状态)。 */
export function detectAffectStatus() {
  return { enabled: process.env.NOE_AFFECT === '1' };
}

/** 检测意识流 v2 是否通电(NOE_STREAM_V2=1,需 NOE_INNER_MONOLOGUE=1 提供反刍循环;OFF 时反刍为 v1 行为)。 */
export function detectStreamV2Status() {
  return { enabled: process.env.NOE_STREAM_V2 === '1' && process.env.NOE_INNER_MONOLOGUE === '1' };
}

/** 检测期望账本是否通电(NOE_EXPECTATIONS=1;OFF 时不抽预测、无惊奇/校准信号)。 */
export function detectExpectationsStatus() {
  return { enabled: process.env.NOE_EXPECTATIONS === '1' };
}

/** 检测全局工作区是否通电(NOE_WORKSPACE=1,需 NOE_INNER_MONOLOGUE=1 提供 tick;OFF 时各信号源各自为政)。 */
export function detectWorkspaceStatus() {
  return { enabled: process.env.NOE_WORKSPACE === '1' && process.env.NOE_INNER_MONOLOGUE === '1' };
}

/** 检测目标系统是否通电(NOE_GOALS=1;好奇回路再加 NOE_CURIOSITY=1)。 */
export function detectGoalsStatus() {
  return { enabled: process.env.NOE_GOALS === '1', curiosity: process.env.NOE_GOALS === '1' && process.env.NOE_CURIOSITY === '1' };
}

/** Noe 真实已落地的能力清单(只列真有的)。 */
export function noeCapabilities() {
  const vp = detectVoiceprintStatus();
  const sherpa = detectSherpaSttStatus();
  const cosy = detectCosyVoiceStatus();
  const ttsDetail = `文字转语音(MiniMax/Kokoro${cosy.available ? `/本地 ${cosy.engine} 中文兜底(断网不哑)` : ''},src/voice/*TtsClient.js)`;
  return [
    { id: 'voiceprint', name: '声纹识别(说话人识别)', detail: `按声音识别说话人:用于主人门禁与人物库声纹比对。引擎=${vp.engine};实现 src/identity/Voiceprint.js + CampPlusVoiceClient.js,接入 VoiceSession 语音验证。` },
    { id: 'face', name: '人脸识别/视觉看屏', detail: `人脸做主人门禁(InsightFace,src/identity/InsightFaceClient.js);本地 VLM 看屏理解你在做什么(src/vision);${detectOcrStatus().available ? '屏幕读字 OCR(RapidOCR,能精确读出屏上具体文字/路径/报错,src/vision/OcrClient.js)。' : '屏幕读字 OCR 未装。'}` },
    { id: 'voice', name: '语音(听+说)', detail: `${ttsDetail}+语音转文字(${sherpa.available ? '本地流式 sherpa-onnx 毫秒级,whisper 兜底' : 'whisper 本地 STT'},src/voice/SherpaSttClient.js + LocalSttClient.js)+ 唤醒词"嘿Noe"检测(sherpa KWS)${detectSileroVadStatus().available ? '+ 神经网络 VAD(silero)精筛真人声、滤掉电视/空调噪声(src/voice/SileroVadClient.js)' : ''},整套 VoiceSession 对话。` },
    { id: 'memory', name: '记忆系统', detail: 'SQLite FTS 记忆(MemoryCore)+ 焦点栈(FocusStack)+ 知识图谱(NoeKnowledgeGraph)+ 人物关系卡(NoePersonCards)。' },
    { id: 'dream', name: '梦境/睡眠记忆整合', detail: '后台周期整合记忆:合并重复(软删可恢复)、降级陈旧、高频晋升、身份级铁保护(src/memory/NoeMemoryConsolidator + NoeDreamConsolidation,默认 OFF,NOE_DREAM=1 开,模型可选本地/M3)。' },
    { id: 'multimodel', name: '真实多模型协作', detail: 'Codex/Claude/M3 核心 consensus + 动态 quorum + post-review(src/room); Gemini/Xiaomi 仅作非核心适配或显式 advisory evidence。' },
    { id: 'self-evolution', name: '自我进化闭环', detail: 'owner 全权授权下的自我迭代(src/room/NoeSelfEvolution*),用 consensus/审计/回滚证据保证真实性,不是权限收窄。' },
    { id: 'freedom', name: '自由执行 / 社交发布链', detail: '全权开发者执行 + 抖音/小红书发布链(DOM 配方,回滚证据留痕,src/runtime/NoeSocialPublish*)。' },
    { id: 'governance', name: '执行审计与回滚证据', detail: 'owner full developer trust 下记录行动事实、证据、结果和回滚线索(src/safety/permissions/approval/audit),避免伪造完成而不是自我上锁。' },
    { id: 'proactive', name: '主动陪伴', detail: '看你在做什么、克制地主动开口(甜心"宝贝",src/loop/proactiveTick.js)。' },
    { id: 'web', name: '上网搜索/研究', detail: '网络搜索 + 网页抓取 + 深度研究(src/research/WebSearch.js)。' },
    { id: 'media', name: '媒体生成(图像/音乐/视频)', detail: 'MiniMax 直调 API:文生图(image-01)/文生音乐(music-2.6-free,付费档 env 覆盖)/文生视频(video-01 异步任务制),产物自动落 ~/.noe-panel/media/(src/media/NoeMediaStudio.js,端点 /api/noe/media/*);需 MiniMax key 已配置。' },
    { id: 'continuity', name: '连续记忆脊椎(自传体时间线)', detail: `把经历记成第一人称时间线并注入对话——覆盖语音/文字对话、深度研究完成、主人派活确认、聊天室见闻(src/memory/EpisodicTimeline.js + NoeSelfModel);${detectContinuityStatus().enabled ? '当前已通电(NOE_CONTINUITY=1)。' : '当前未通电(NOE_CONTINUITY 默认 OFF,不记录不注入)。'}` },
    { id: 'circadian', name: '时间节律(昼夜作息)', detail: `按本机时间把一天分四相(morning/day/evening/night)+ 23:00-08:00 静默时段:夜里反刍降频(间隔×4)、主动陪伴不开口(到期提醒顺延到早上)、自我状态带时段(timeOfDay)与深夜心境(src/loop/NoeCircadian.js);${detectCircadianStatus().enabled ? '当前已通电(NOE_CIRCADIAN=1)。' : '当前未通电(NOE_CIRCADIAN 默认 OFF,行为与无节律一致)。'}` },
    { id: 'mood-model', name: '心境感知(本地模型情感分析)', detail: `从自传体时间线读最近经历,用主脑 Qwen 通道(NOE_INNER_BRAIN/NOE_INNER_MODEL)异步评出 ≤10 字心境短语进缓存,自我状态同步读;模型挂/缓存过期自动回启发式 inferMood(src/context/NoeMoodAnalyzer.js);${detectMoodModelStatus().enabled ? '当前已通电(NOE_MOOD_MODEL=1)。' : '当前未通电(NOE_MOOD_MODEL 默认 OFF,心境为规则启发式推断)。'}` },
    { id: 'dream-sublimation', name: '梦境升华(久远情景→语义记忆)', detail: `把 90 天前的自传体情景按周整理成第一人称摘要,沉淀进长期语义记忆(像人把久远经历化成"那段日子"的印象,赶在情景 180 天保留期硬删之前),再写回一条"我梦里整理了往事"的梦境情景;摘要大脑复用 NOE_DREAM_MODEL,默认确定性拼接不调模型(src/memory/NoeEpisodeSublimation.js);${detectEpisodeSublimationStatus().enabled ? '当前已通电(NOE_DREAM_EPISODES=1)。' : '当前未通电(NOE_DREAM_EPISODES 默认 OFF,不升华)。'}` },
    { id: 'thought-sublimation', name: '反刍升华(念头→牵挂/提醒)', detail: `后台反刍冒出的念头若命中"想跟主人说/该提醒"或"不知道主人…怎么样了"模式,升华成承诺入店(自生上限 2 条防唠叨),立即出现在自我状态"牵挂着",到点经主动陪伴既有通道说出口(src/loop/NoeThoughtSublimation.js);${detectThoughtSublimationStatus().enabled ? '当前已通电(NOE_INNER_SPEAK=1)。' : '当前未通电(需 NOE_INNER_SPEAK=1+NOE_INNER_MONOLOGUE=1,默认 OFF,念头只留在心里)。'}` },
    { id: 'narrative-self', name: '叙事自我(我的故事)', detail: `低频(默认日更)用本地大脑把自传体时间线全幅压成 2-3 句第一人称"我是谁、我们正在经历什么"叙事,持久化(~/.noe-panel/narrative-self.json)后注入自我状态「我的故事」一行;只读注入块零人格漂移(绝不反哺自述身份),模型挂/SILENT 保留旧叙事(src/context/NoeNarrativeSelf.js);${detectNarrativeSelfStatus().enabled ? '当前已通电(NOE_NARRATIVE_SELF=1)。' : '当前未通电(NOE_NARRATIVE_SELF 默认 OFF,不生成不注入)。'}` },
    { id: 'ui-awareness', name: '面板 UI 感知(卡片行为→聊天上下文)', detail: `把面板 agent 卡片(任务/计划/证据)与主人刚做的 UI 操作(挂载/点击/停留/关闭)作为只读上下文注入聊天室对话,让大脑知道主人刚在面板上看了什么/点了什么(src/runtime/NoeUiSignalStore + NoeAcuiCardStore,经 NoeTurnContextEngine 注入;UI 信号走非消费式读法,不抢本地议会路径的消费);${detectChatUiSignalsStatus().enabled ? '当前已通电(NOE_CHAT_UISIGNALS=1)。' : '当前未通电(需 NOE_CHAT_CONTEXT=1+NOE_CHAT_UISIGNALS=1,默认 OFF,不注入)。'}` },
    { id: 'reflect-brain', name: '主脑 Qwen reflect tier', detail: `自主认知(反思/审议/质询/判证)统一走本地 Qwen 35B A3B 6bit,白名单 lmstudio/ollama 永不烧付费配额;${detectReflectBrainStatus().enabled ? '已通电(NOE_REFLECT_TIER=1)。' : '未通电(默认 OFF)。'}` },
    { id: 'heartbeat', name: '持久心跳(服务端认知 tick)', detail: `心跳驱动反刍与主动陪伴:游标续相位、台账留痕、崩溃判死、长停机记"我断了一会儿"——不被观察也在(src/loop/NoeHeartbeat.js);${detectHeartbeatStatus().enabled ? '已通电(NOE_HEARTBEAT=1)。' : '未通电(默认 OFF,靠前端轮询)。'}` },
    { id: 'affect', name: '情感连续性(VAD 引擎)', detail: `连续情感状态:随经历起伏、双时标回落(情绪90分钟/心境7天)、跨重启水合不清零;感受词元注入反刍与陪伴(src/cognition/NoeAffectEngine.js);${detectAffectStatus().enabled ? '已通电(NOE_AFFECT=1)。' : '未通电(默认 OFF)。'}` },
    { id: 'stream-v2', name: '意识流 v2(回声+印记)', detail: `反刍升级:久远记忆回声采样打破近因茧房 + 念头带情感印记 + 防螺旋断路器(src/cognition/NoeMemoryEcho.js);${detectStreamV2Status().enabled ? '已通电(NOE_STREAM_V2=1)。' : '未通电(默认 OFF)。'}` },
    { id: 'expectations', name: '期望账本(预测与校准)', detail: `念头里的预测自动入账,到点由主人在透视页裁决,落空生惊奇、月度 Brier 校准自知之明(src/cognition/NoeExpectationLedger.js);${detectExpectationsStatus().enabled ? '已通电(NOE_EXPECTATIONS=1)。' : '未通电(默认 OFF)。'}` },
    { id: 'workspace', name: '全局工作区(注意力)', detail: `每周期候选竞争出唯一焦点喂给反刍,高分焦点升级 Qwen 深思自我质询,"想说"过浮现门;意识日志在 ~/.noe-panel/consciousness/(src/cognition/NoeWorkspace.js);${detectWorkspaceStatus().enabled ? '已通电(NOE_WORKSPACE=1)。' : '未通电(默认 OFF)。'}` },
    { id: 'goals', name: '自主目标系统(+好奇回路+真上网手脚)', detail: `目标库+确定性仲裁(主人显式目标永远优先,active≤2,自生积压上限8,drive源权重随驱力强度浮动);目标步分think(深思推进)/research(真上网走DeepResearcher)/act(真动手,经ActPipeline全权执行链,NOE_GOAL_ACT)三类;act 可调用 shell/文件/浏览器 DOM/macOS App 激活/键盘/坐标/AppleScript/JXA;目标完成自动蒸馏技能卡入记忆;高惊奇自动立研究目标;自己做的事都记进自传时间线成经历(src/cognition/NoeGoalSystem.js);${detectGoalsStatus().enabled ? `已通电(NOE_GOALS=1${detectGoalsStatus().curiosity ? '+好奇' : ''})。` : '未通电(默认 OFF)。'}` },
    { id: 'self-improve', name: '受控自我改进(改自己代码)', detail: 'Darwin Gödel Machine范式:主脑 Qwen 读自己认知层源码→产出最小行号改动→git worktree沙箱跑全量测试门→过门留patch+实证档案(成败都留)→默认不自动合,采用是显式--apply走git可回滚;白名单只含认知层(src/cognition+src/loop),server/存储/安全层绝不可改(scripts/noe-self-improve.mjs);手动跑非自动常开。' },
  ].map(annotateCapability);
}

/**
 * 拼成注入系统提示的自我认知块。让 LLM 大脑知道自己具备这些能力(被问到时能正确回答/调用)。
 * @param {object} [opts]
 * @param {string[]} [opts.only] 只输出这些 id(默认全部)
 */
export function buildNoeSelfKnowledgeBlock(opts = {}) {
  const caps = noeCapabilities().filter((c) => !Array.isArray(opts.only) || opts.only.includes(c.id));
  if (!caps.length) return '';
  const maxDetailChars = Math.max(60, Math.min(180, Number(opts.maxDetailChars) || 120));
  const lines = caps.map((c) => {
    const evidence = c.status === VERIFIED && Array.isArray(c.evidenceRefs) && c.evidenceRefs.length
      ? ` 证据:${c.evidenceRefs.map((e) => e.note).join(',')}`
      : '';
    return `- [${c.status || DECLARED}] ${c.name}:${trimDetail(c.detail, maxDetailChars)}${evidence}`;
  });
  return [
    '<noe-self-knowledge>',
    '你(本系统 Noe / 宝贝)具备以下能力清单。verified=已有 smoke/eval/live 证据;declared=代码/配置/模型存在但当前未完成烟测验证。被问到"你能不能…/你有没有…"时必须如实区分,不要把 declared 说成已验证。',
    ...lines,
    '</noe-self-knowledge>',
  ].join('\n');
}
