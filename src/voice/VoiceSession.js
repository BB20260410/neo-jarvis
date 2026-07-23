// VoiceSession — 语音对话编排：wav → 本地 whisper STT → BrainRouter 路由大脑 → 大脑回复 → MiniMax 甜心小玲 TTS
// 复用 Noe 现有 BrainRouter（语音对话默认压本地省 token）+ MemoryCore（对话沉淀）。
import { LocalSttClient } from './LocalSttClient.js';
import { MiniMaxTtsClient } from './MiniMaxTtsClient.js';
import { normalizeTtsText } from './TtsTextNormalizer.js';
import { detectResearchIntent, formatDeepResearchReply, summarizeSearchResults } from '../research/ResearchIntent.js';
import { createLinkUnderstanding } from '../research/NoeLinkUnderstanding.js';
import { detectTaskIntent, formatTaskIntentReply } from '../room/TaskIntentRouter.js';
import { resolveChatProfile } from './ChatProfiles.js';
import { createOwnerGateFromEnv } from './OwnerGate.js';
import { assessChineseOutput, qualityRetryInstruction } from './OutputQualityGate.js';
import { memoryPolicyForProfile } from './MemoryPolicy.js';
import { createGenerationFence, resolveFenceKey } from '../loop/NoeGenerationFence.js';
import { createCommitmentExtractionHook } from '../runtime/NoeCommitmentExtractor.js';
import { detectAssistantTaskPromise, taskTextFromAssistantPromise } from '../runtime/NoeDelegationExtractor.js';
import { NoeTurnContextEngine, buildPeopleBrief } from '../context/NoeTurnContextEngine.js';
import { createEarlySentenceDetector } from './VoiceStreamEarlyTts.js';
import { resolveForegroundChatChain } from '../room/ForegroundChatRouting.js';
import { defaultNoeVoiceActivity } from './NoeVoiceActivity.js';

// 人物库简表已迁入 NoeTurnContextEngine（方向二）；此处 re-export 保持旧 import 路径可用。
export { buildPeopleBrief };

// 剥离 reasoning 模型输出的 <think>…</think> 推理（think:false 对部分 abliterated 模型不生效），只留真正回复
function stripThink(s) {
  // 配对剥除（大小写无关），与 proactiveTick 一致；只在有开标签时剥，不误切回复里字面出现的 </think>
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

function isIncompleteBrainResult(result = {}) {
  const finishReason = String(result.finishReason || result.finish_reason || '').trim().toLowerCase();
  const completionStatus = String(result.completionStatus || '').trim().toLowerCase();
  return result.incomplete === true
    || result.truncated === true
    || result.continuationRequired === true
    || completionStatus === 'incomplete_length'
    || finishReason === 'length'
    || finishReason === 'max_tokens';
}

function incompleteBrainError(result = {}) {
  const finishReason = String(result.finishReason || result.finish_reason || 'length').trim() || 'length';
  const err = new Error(`大脑输出被截断（finish_reason=${finishReason}），已丢弃半截结果，未写入历史或长期记忆。`);
  err.code = 'BRAIN_INCOMPLETE';
  err.finishReason = finishReason;
  return err;
}

const META_PAREN_RE = /\b(?:looks?\s+good|uses?\s+master|no\s+markdown|emojis?|markdown\/emojis|responds?\s+to|user'?s|exhaustion|sentences?|natural|draft|final|polish|colloquial|tone|persona|constraints?|response|output)\b/i;
const PROVIDER_INPUT_REJECTED_RE = /PROVIDER_INPUT_REJECTED|new_sensitive|unprocessable_entity/i;
const VISION_QUESTION_RE = /(你.*能.*看|你.*看|看见|看到|摄像头|镜头|屏幕|画面|我在(?:干嘛|干什么|做什么|做啥)|我现在.*(?:干嘛|干什么|做什么|做啥|在做|穿|拿)|我.*(?:穿什么|表情|姿势|手里|拿着))/;
const CORRECTION_QUESTION_RE = /(谁啊|是谁|哪来的|你说的.*(?:谁|什么)|为什么说|你怎么知道|从哪看出|刚才.*(?:谁|什么)|叔叔|阿姨|聊天对象)/;
const FACE_GATE_THRESHOLD = 0.55;
const FACE_GATE_AFTER_VOICE_THRESHOLD = 0.58;
const VOICE_GATE_FACE_BACKUP_FLOOR = 0.68;

function stripMetaParentheticals(text) {
  return String(text || '').replace(/[（(]([^()（）]{0,360})[）)]\s*[.,，。;；:：、]*/g, (whole, inner) => {
    const ascii = (inner.match(/[A-Za-z]/g) || []).length;
    const cjk = (inner.match(/[一-鿿]/g) || []).length;
    return ascii >= 10 && cjk === 0 && META_PAREN_RE.test(inner) ? '' : whole;
  });
}

function isVisionQuestion(text) {
  return VISION_QUESTION_RE.test(String(text || ''));
}

// "这是谁/他是谁/认识吗/镜头里是谁" → 触发人脸认人(排除"我是谁"这种问主人自己的)
const WHO_QUESTION_RE = /((这|那|镜头里|摄像头里|画面里|前面)(个|位|人)?是?谁)|((他|她|ta|这个人|这位)是谁)|认(识|得)(出)?(他|她|ta|这个?人|这位)?(是谁|吗)/i;
function isWhoQuestion(text) {
  return WHO_QUESTION_RE.test(String(text || ''));
}

// 首句切分（C9 流式语音）：TTS 先合成第一句尽快出声（首声=首句合成时间），剩余文本
// 由前端经 /api/noe/voice/tts 二次请求续播。不值得拆返回 null：整段短/无句界/
// 首句占比已超 70%；首句不足 6 字并入下一句（防"嗯。"碎句开播）。
// 2026-06-10 owner 报障"只说开头"根因：长回复切首句后剩余 rest 靠前端续播，首句播完时长 rest
// 常还在合成（loading）→ 前端 drainRest 旧逻辑直接丢弃 → 只说开头。根治在前端 noe-voice.js
// （drainRest 改 loading 时挂等待、合成完再无缝接上），后端切分口径不变（早鸟探测器同口径联动）。
export function splitFirstSentence(text) {
  const t = String(text || '').trim();
  if (t.length < 40) return null;
  const re = /[。！？!?…；;\n]/g;
  let m;
  let cut = -1;
  while ((m = re.exec(t))) {
    const pos = m.index + 1;
    if (pos >= 6) { cut = pos; break; }
  }
  if (cut < 0 || cut > t.length * 0.7) return null;
  const first = t.slice(0, cut).trim();
  const rest = t.slice(cut).trim();
  if (!first || !rest) return null;
  return { first, rest };
}

function isCorrectionQuestion(text) {
  return CORRECTION_QUESTION_RE.test(String(text || ''));
}

function formatGateScore(hit) {
  if (!hit || typeof hit.score !== 'number') return '';
  return `（分数 ${hit.score} / 阈值 ${hit.threshold ?? 'unknown'}）`;
}

// 输出消毒：剥 think + Noe→宝贝 + 剥 markdown/HTML + 剥 i1 量化偶发串入的外文杂字
function sanitize(s, { personaName = '宝贝' } = {}) {
  let t = String(s || '');
  // reasoning 模型(gemma-26b harmony 格式)：思考是大段英文分析+草稿、最终回复在最后且是中文 → 剥 harmony 标记后取最后一段含中文的正文作回复
  if (/<\|channel|<\|message/i.test(t)) {  // 只认 harmony 结构标记，不用宽松的 thought（正常回复可能含该词被误砍）
    t = t.replace(/<\|[^>]*?\|?>/g, '\n');
    const blocks = t.split(/\n\s*\n+/).map((b) => b.trim())
      .filter((b) => /[一-鿿]/.test(b) && !/^[*\-\d.]/.test(b) && b.length > 4);
    if (blocks.length) t = blocks[blocks.length - 1];
  }
  // 剥 reasoning 模型泄漏的英文格式自检标注，如 "(4 sentences. No markdown. No emojis. Natural.)" 及中文正文前的英文/草稿前缀
  t = stripMetaParentheticals(t);
  t = t.replace(/[（(]\s*\d*\s*(?:sentences?|no markdown|no emojis?|natural|draft|final|polish|colloquial|tone|persona|constraints?|response|output)[^)）]*[)）]/gi, '');
  t = t.replace(/^[A-Za-z][^一-鿿]*(?=[一-鿿])/, '').trim();  // 只剥「英文字母开头」的 meta/草稿前缀；不动数字/emoji/中文标点开头(防 "5分钟"→"分钟")
  // 剥全角括号动作/神态/语气描写（陪伴模型爱加「（微笑）（撅嘴）（声音放软）」，语音会原样念出来很怪——owner 2026-06-10 报障）。
  // 只剥全角（）：动作描写习惯用全角；半角 () 留给技术内容（代码/英文缩写）。提示词层也要求模型别生成，这是兜底防它不听话。
  t = t.replace(/（[^（）]*）/g, '').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/[“”"]/g, '');  // 剥 reasoning 模型给回复乱加的引号（也会干扰下面去重）
  // 整句重复去重：reasoning 模型(尤其 26b)偶发把同一段回复连说两遍 → 同一句只留一遍
  const sents = t.split(/(?<=[。！？～…\n])/).map((x) => x.trim()).filter(Boolean);
  if (sents.length > 1) {
    const seen = []; const out = [];
    for (const sent of sents) {
      const k = sent.replace(/[^\w一-鿿]/g, '');
      if (!k) continue;
      // 近似去重：与已收句公共前缀占比 ≥70% 视为重复（拦 26b "…真好"/"…真开心" 这种只改结尾的草稿）
      let dup = false;
      for (const sk of seen) { const m = Math.min(k.length, sk.length); let c = 0; while (c < m && k[c] === sk[c]) c++; if (m >= 8 && c >= m * 0.7) { dup = true; break; } }
      if (!dup) { seen.push(k); out.push(sent); }
    }
    t = out.join(' ');
  }
  t = dedupe(t);  // 鲁棒去重：开头段在后面重复出现就砍掉（不依赖标点分句，治 26b 各种重复模式）
  return stripThink(t)
    .replace(/\b(noe|neo)\b/gi, personaName)
    .replace(/```+[a-z]*\n?/gi, '').replace(/```+/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[฀-๿؀-ۿ가-힯Ѐ-ӿ]+/g, '')
    .replace(/[ \t]{2,}/g, ' ').trim();
}

// 复读检测：两句去空格后前 30 字完全相同 → 判定模型卡死复读（连续追问时 history 把同一句反复喂回）
function isRepeat(a, b) {
  const norm = (s) => String(s || '').replace(/\s/g, '').slice(0, 30);
  const na = norm(a);
  return na.length >= 8 && na === norm(b);
}

// 鲁棒去重：开头一段(去空白≥8字)在后面原样重复出现 → 砍到第二次出现处（不依赖标点分句，治 26b 各种重复模式）
function dedupe(t) {
  const compact = String(t || '').replace(/\s/g, '');
  for (let len = Math.min(40, compact.length >> 1); len >= 8; len--) {
    const head = compact.slice(0, len);
    const idx = compact.indexOf(head, len);
    if (idx >= 0) {
      let cnt = 0, cut = String(t).length;
      for (let i = 0; i < t.length; i++) { if (!/\s/.test(t[i])) { if (cnt === idx) { cut = i; break; } cnt++; } }
      return t.slice(0, cut).trim();
    }
  }
  return t;
}

const RECEIPT_SECRET_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
function receiptText(value, max = 240) {
  return String(value || '')
    .replace(RECEIPT_SECRET_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTaskReceipt(value, transcript) {
  if (!value) return null;
  if (typeof value === 'string') {
    return {
      goalId: receiptText(value, 180),
      taskId: receiptText(value, 180),
      title: `主人委托：${receiptText(transcript, 120)}`,
      task: receiptText(transcript, 160),
      status: 'accepted',
      summary: '已接单，正在进入执行队列。',
    };
  }
  if (typeof value !== 'object') return null;
  const goalId = receiptText(value.goalId || value.taskId || '', 180);
  return {
    ...value,
    goalId: goalId || null,
    taskId: receiptText(value.taskId || goalId || '', 180) || goalId || null,
    title: receiptText(value.title || value.task || transcript, 180),
    task: receiptText(value.task || transcript, 180),
    status: receiptText(value.status || 'accepted', 40) || 'accepted',
    summary: receiptText(value.summary || value.nextStep || '已接单，正在进入执行队列。', 280),
    nextStep: receiptText(value.nextStep || '', 240),
    kind: receiptText(value.kind || '', 80) || undefined,
  };
}

export class VoiceSession {
  constructor({ sttClient, ttsClient, brainRouter, getAdapter, memory = null, memoryWriteGate = null, memoryRetriever = null, visionSession = null, factExtractor = null, kokoroTts = null, voiceGatewayTts = null, cosyVoiceTts = null, sileroVad = null, webSearch = null, searchSummarizer = null, researcher = null, chatProfileStore = null, ownerGate = createOwnerGateFromEnv(), identityStore = null, personStore = null, toolRegistry = null, commitmentStore = null, delegationHook = null, personCardStore = null, prefetchStore = null, generationFence = null, contextEngine = null, innerStateProvider = null, personaPinProvider = null, episodicTimeline = null, foregroundChatRouting = null, llmStream = process.env.NOE_VOICE_LLM_STREAM === '1', preferLocalChinese = false, projectId = 'noe' } = {}) {
    this.stt = sttClient || new LocalSttClient();
    this.tts = ttsClient || new MiniMaxTtsClient();
    this.cosyVoiceTts = cosyVoiceTts; // 本地中文 TTS 槽（CosyVoice 或 Qwen 志玲 VoiceDesign）。preferLocalChinese=true 时做中文主声音，否则做兜底
    this.preferLocalChinese = preferLocalChinese; // 注入 true（NOE_QWEN_TTS=1）：中文优先本地志玲做主声音，MiniMax 退为备用
    this.voiceGatewayTts = voiceGatewayTts; // 注入才启用 OpenAI-compatible 本地语音网关，默认 OFF
    this.sileroVad = sileroVad; // 注入才启用神经网络 VAD 精筛（NOE_SILERO_VAD=1）：STT 前判真人声，噪声段直接丢不烧链
    this.brainRouter = brainRouter;
    this.episodicTimeline = episodicTimeline; // 连续记忆脊椎（第四节）：注入才记录对话到自传体时间线
    this.getAdapter = getAdapter;
    this.memory = memory;
    this.memoryWriteGate = memoryWriteGate;
    this.factExtractor = factExtractor; // 注入才开启对话→事实提炼
    this.kokoroTts = kokoroTts; // 注入才启用英文降级档（本地 Kokoro，省 MiniMax 配额）
    this.webSearch = webSearch;
    this.searchSummarizer = searchSummarizer;
    this.researcher = researcher;
    this.chatProfileStore = chatProfileStore;
    this.ownerGate = ownerGate;
    this.identityStore = identityStore;
    this.personStore = personStore;
    this.toolRegistry = toolRegistry; // 注入才让对话大脑能"真跑工具"(记忆/文件/图谱检索等)，而非空口
    this.commitmentStore = commitmentStore; // 建提醒/待办的真执行(到点 proactiveTick 主动叫)；到期承诺也注入回复上下文(T1)
    // T7 承诺抽取（波次6 接线）：Noe 回复里"我会X"自动记成承诺（治说过就忘）；用户"提醒我X"仍走动作桥不重叠
    this.commitmentExtract = commitmentStore?.add ? createCommitmentExtractionHook({ store: commitmentStore }) : null;
    // 对话委托桥（2026-06-11，治"让他去找原因他只表面回答"）：主人话里的"去查X/帮我看看Y"
    // 直接立 owner 目标走工作区真推进——对话生成是嘴，目标系统才是手；嘴答应了手没接到=假答应。
    this.delegationHook = typeof delegationHook === 'function' ? delegationHook : null;
    this.personCardStore = personCardStore; // NoePersonCards 人物关系卡:识别出对话者时注入称呼/偏好(T1 接线,注入式可选)
    this.prefetchStore = prefetchStore;     // NoePrefetchStore 预取池:高频环境数据问到秒答(T1 接线,注入式可选)
    this.visionSession = visionSession; // 注入才让对话大脑"看得到"（摄像头/屏幕的最近视觉摘要）
    this.projectId = projectId;
    // LLM 流式早鸟（方向三，NOE_VOICE_LLM_STREAM=1 默认 OFF）：大脑边吐字边检首句并行启动 TTS，
    // 与剩余生成重叠 ⇒ 首声提前 1-2s；收尾与整段管线对账，对不上丢早鸟走旧路（见 _respondCore）。
    this.llmStream = llmStream === true;
    // 方向二（ContextEngine 通电）：上下文供给统一走 NoeTurnContextEngine，本类只管语音编排；可注入便于测试。
    // P4：注入 innerStateProvider（当下认知态），让语音回复也带"此刻心情+焦点"；未注入则 inner-state 段 no-op（零回归）。
    // 契约（多模型审 finding C）：仅默认自建 contextEngine 时本类才把 innerStateProvider 接进去；
    //   若调用方注入了自己的 contextEngine，inner-state 由【调用方】在构造该 contextEngine 时自行注入——
    //   本类不会替注入的 engine 补挂，否则会有"两个 engine 配置漂移"的隐患。下面的 warn 只在两者同时给却可能漏接时提示，不改变行为。
    if (contextEngine && innerStateProvider) {
      try { console.warn('[VoiceSession] 同时注入了 contextEngine 与 innerStateProvider：本类只用注入的 contextEngine，innerStateProvider 不会被接入——请确认它已在该 contextEngine 内部注入。'); } catch { /* 日志失败不阻断 */ }
    }
    // P8-fix(总验收三方一致):自建 engine 也传 personaPinProvider,否则语音 owner 回复永不下沉稳定人设(persona-pin 只到聊天室)。
    this.contextEngine = contextEngine || new NoeTurnContextEngine({ memory, memoryWriteGate, memoryRetriever, personStore, commitmentStore, personCardStore, prefetchStore, toolRegistry, episodicTimeline, innerStateProvider, personaPinProvider });
    this.foregroundChatRouting = foregroundChatRouting || null;
    // 链接自动理解（蒸馏自 OpenClaw link-understanding）：owner 在对话里贴 URL 时自动安全抓取摘要注入上下文。
    //   复用 webSearch.fetchContent（已走 SsrfGuard.safeFetchPublicUrl，不另开出站口）。flag NOE_LINK_UNDERSTANDING 默认 OFF。
    this.linkUnderstanding = (process.env.NOE_LINK_UNDERSTANDING === '1' && typeof webSearch?.fetchContent === 'function')
      ? createLinkUnderstanding({ fetchContent: (u, o) => webSearch.fetchContent(u, o) })
      : null;
    this.generationFence = generationFence || createGenerationFence(); // 代际栅栏：连发时压制旧回复，防「旧覆新」连击（T1 接线）
    this.history = []; // 会话内短期对话历史（最近若干轮），让对话连续记得上一句；长期记忆走 memory.recall
  }

  // whisper 对静音/噪声常"幻听"出 YouTube 字幕残留（"..."/"Here we go"/"Thank you"/"谢谢观看"等）。
  // 这些不是用户真说的，丢弃不回复，防止 Noe 自言自语。
  static isJunkTranscript(text) {
    const s = String(text || '').trim().replace(/^[\s.,。，、…!?！？·\-—~]+|[\s.,。，、…!?！？·\-—~]+$/g, '').trim();
    if (s.length < 2 && !/[一-鿿]/.test(s)) return true; // 单字中文(嗯/对/好)是真实回应不算垃圾；只挡单字非中文(孤立字母/标点)
    if (!/[一-鿿A-Za-z0-9]/.test(s)) return true; // 纯标点/符号
    if (/^(here we go|thank you|thanks for watching.*|please subscribe.*|see you.*|bye|you|okay|outro|music|字幕.*|谢谢(大家)?观看.*|请(点赞)?订阅.*|下次?再见.*|明镜.*|点点栏目.*)$/i.test(s)) return true;
    return false;
  }

  // 按语言分档选 TTS：preferLocalChinese 时含中文 → 本地志玲(主声音)；否则含中文 → MiniMax；纯英文且配 Kokoro → 本地 Kokoro（省配额）
  _pickTts(text) {
    const hasZh = /[一-鿿]/.test(String(text || ''));
    if (this.preferLocalChinese && hasZh && this.cosyVoiceTts) return this.cosyVoiceTts; // 中文主声音 = 本地志玲；MiniMax 在回退链里兜底
    if (this.kokoroTts && !hasZh) return this.kokoroTts;
    return this.tts;
  }

  // 说（统一回退链）：主选 _pickTts → MiniMax 主音色 → CosyVoice 本地中文兜底（卡②链尾：
  // 断网/MiniMax 不可用时中文不哑；纯英文不走 CosyVoice——Kokoro 失败后 MiniMax 已是终点）。
  // 返回 {audioBase64, audioFormat, ttsErr}；全失败 audioBase64=null + ttsErr=最后一个错。
  async _synthesize(reply, opts = {}) {
    let ttsErr = null;
    // 回退链入口统一归一化：堵 Kokoro/CosyVoice/Gateway 兜底引擎念 emoji/markdown；归一化后为空则回退原文(fail-open 不哑)。
    const norm = normalizeTtsText(reply);
    const text = norm || String(reply || '').trim();
    const chain = [this._pickTts(text), this.tts, this.voiceGatewayTts];
    if (this.cosyVoiceTts && /[一-鿿]/.test(text)) chain.push(this.cosyVoiceTts);
    const tried = new Set();
    for (const client of chain) {
      if (!client || tried.has(client)) continue;
      tried.add(client);
      try {
        const { audioBuffer, format } = await client.synthesize(text, opts);
        return { audioBase64: audioBuffer.toString('base64'), audioFormat: format, ttsErr: null };
      } catch (e) { ttsErr = e; }
    }
    return { audioBase64: null, audioFormat: null, ttsErr };
  }

  // 纯文本转语音（C9 续播端点用，也可作通用 TTS）：走同一回退链（主选→MiniMax→CosyVoice 中文兜底）。
  async synthesizeText(text, opts = {}) {
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) return { audioBase64: null, audioFormat: null, ttsErr: new Error('文本为空') };
    return this._synthesize(clean, opts);
  }

  /**
   * 一问一答：16kHz mono wav → {transcript, reply, audioBase64}
   * @param {Buffer} wavBuffer
   * @param {object} [opts] {tts:{voiceId,emotion}}
   */
  async chat(wavBuffer, opts = {}) {
    // 第三阶段·全模态:语音 turn 到达即标记语音通道活跃,多模态融合据此知道「语音在线」(让四模态都活)。fail-open。
    try { defaultNoeVoiceActivity.markActive(); } catch { /* 追踪失败不阻断语音 */ }
    // 0) 神经网络 VAD 精筛放整条链最前（深析改进#2）：噪声段直接丢，连声纹/人脸门禁的
    // CAMPPlus 推理都不跑（比 VAD 重得多）。判真人声而非比响度；VAD 不可用/异常一律降级放行。
    if (this.sileroVad?.detect) {
      try {
        const v = this.sileroVad.detect(wavBuffer);
        if (v.ok && !v.hasSpeech) return { ok: false, intent: 'no_speech', ignored: true, error: '已忽略：没有检测到人声（疑似环境噪声）。' };
      } catch { /* VAD 自身异常不阻断对话 */ }
    }
    const ownerStatus = this.identityStore?.status?.() || {};
    const modelSettings = this.personStore?.modelSettings?.status?.() || { voice: { enabled: true }, face: { enabled: true } };
    let pendingVoiceReject = null;
    if (modelSettings.voice?.enabled !== false && this.identityStore?.shouldGateVoice?.()) {
      let voice = null;
      try {
        voice = ownerStatus.voice?.ownerPersonId && this.personStore?.identifyVoiceForPerson
          ? await this.personStore.identifyVoiceForPerson(ownerStatus.voice.ownerPersonId, wavBuffer, { threshold: ownerStatus.voice.threshold, minSamples: 3 })
          : await this.identityStore.verifyVoice(wavBuffer);
      } catch (e) { voice = { ok: false, error: e?.message || String(e), threshold: ownerStatus.voice?.threshold }; }
      if (voice.ok) opts = { ...opts, ownerVerified: true, voice, personVoice: voice.person ? voice : opts.personVoice };
      else pendingVoiceReject = voice;
    }
    if (modelSettings.face?.enabled !== false && this.identityStore?.shouldGateFace?.()) {
      let face = null;
      const configuredFaceThreshold = Number(ownerStatus.face?.threshold) || FACE_GATE_THRESHOLD;
      const faceThreshold = Math.min(configuredFaceThreshold, opts.voice?.ok ? FACE_GATE_AFTER_VOICE_THRESHOLD : FACE_GATE_THRESHOLD);
      try {
        face = opts.faceEmbedding
          ? (ownerStatus.face?.ownerPersonId && this.personStore?.identifyFaceForPerson
              ? this.personStore.identifyFaceForPerson(ownerStatus.face.ownerPersonId, opts.faceEmbedding, { threshold: faceThreshold, minSamples: 1 })
              : this.identityStore.verifyFaceEmbedding(opts.faceEmbedding))
          : { ok: false, missing: true, threshold: faceThreshold };
      } catch (e) { face = { ok: false, error: e?.message || String(e), threshold: faceThreshold }; }
      if (face && face.threshold === undefined) face.threshold = faceThreshold;
      if (!face.ok) return { ok: false, intent: 'owner_identity_gate', ignored: true, error: face.missing ? '已忽略：人脸门禁已开启，但这次没有拿到当前摄像头画面。' : `已忽略：人脸未通过主人验证${formatGateScore(face)}。`, voice: opts.voice || null, face };
      opts = { ...opts, ownerVerified: true, face, personFace: face.person ? face : opts.personFace, ownerTrust: 'voice_face' };
    }
    if (pendingVoiceReject) {
      const score = Number(pendingVoiceReject.score);
      const faceBacked = opts.face?.ok && Number.isFinite(score) && score >= VOICE_GATE_FACE_BACKUP_FLOOR;
      if (faceBacked) {
        opts = { ...opts, ownerVerified: true, voice: { ...pendingVoiceReject, ok: true, softPassedByFace: true }, personVoice: pendingVoiceReject.person ? pendingVoiceReject : opts.personVoice, ownerTrust: 'face_voice_soft' };
      } else {
        return { ok: false, intent: 'voiceprint_gate', ignored: true, error: `已忽略：声纹未通过主人验证${formatGateScore(pendingVoiceReject)}。`, voice: pendingVoiceReject };
      }
    }
    if (modelSettings.voice?.enabled !== false && this.personStore?.identifyVoice && !opts.personVoice) {
      try { const personVoice = await this.personStore.identifyVoice(wavBuffer); if (personVoice?.person) opts = { ...opts, personVoice }; } catch { /* 人物声纹识别失败不阻断对话 */ }
    }
    // 1) 听：本地 whisper 转写
    const transcript = (await this.stt.transcribe(wavBuffer)).trim().slice(0, 2000); // 上限防超长转写撑爆本地大脑 context
    if (!transcript) return { ok: false, error: '没听清（转写为空）' };
    if (VoiceSession.isJunkTranscript(transcript)) return { ok: false, error: '忽略（静音/噪声幻听）', transcript }; // 防 whisper 静音幻听导致自言自语
    return this._respond(transcript, opts);
  }

  /**
   * 文字对话：直接给文本（跳过 STT），复用同一套大脑路由 + TTS + 记忆。
   * 默认不合成语音（省 MiniMax 配额）；opts.noTts=false 才出声。
   * @param {string} text
   * @param {object} [opts] {tts, noTts}
   */
  async chatText(text, opts = {}) {
    const transcript = String(text || '').trim().slice(0, 2000);
    if (!transcript) return { ok: false, error: '空消息' };
    return this._respond(transcript, opts);
  }

  async _respondWithResearch(transcript, intent, opts = {}) {
    const profile = opts.profile || (this.chatProfileStore?.resolve ? this.chatProfileStore.resolve(opts.profileId) : resolveChatProfile(opts.profileId));
    const memoryPolicy = opts.memoryPolicy || memoryPolicyForProfile(profile);
    let reply = '';
    let payload = {};
    let lastErr = null;
    try {
      if ((intent.mode === 'deep' || opts.deep === true) && this.researcher?.research) {
        const out = await this.researcher.research(intent.query, { maxRounds: Math.min(Number(opts.maxRounds) || 2, 4), perQuery: 3, fetchTop: 3 });
        reply = sanitize(formatDeepResearchReply(out, { voice: true }), { personaName: profile.personaName });
        payload = { mode: 'deep', rounds: out.rounds, sources: out.sources, report: out.report };
      } else {
        let out;
        try {
          out = typeof this.webSearch.searchWithMeta === 'function'
            ? await this.webSearch.searchWithMeta(intent.query, { count: 5 })
            : { results: await this.webSearch.search(intent.query, { count: 5 }) };
        } catch (e) {
          throw e;
        }
        const results = out.results || [];
        reply = sanitize(await summarizeSearchResults(this.searchSummarizer, intent.query, results, { personaName: profile.personaName }), { personaName: profile.personaName });
        payload = { mode: 'search', results, count: results.length, source: out.source || results[0]?.source || null, viaModel: out.viaModel || results[0]?.viaModel || null };
      }
    } catch (e) {
      // 搜索失败：本 turn 尚未立目标，taskReceipt 恒为 null（delegationHook 延迟到下方守卫窗口才调）。
      return { ok: false, transcript, intent: 'research', query: intent.query, taskReceipt: null, error: `搜索失败：${e?.message || String(e)}` };
    }

    // 栅栏检查（只读不消费）：本代被更新一代 superseded 时，本 research 回复会被外壳丢弃为 superseded，
    // 不写 history/长期记忆、不立委托目标、跳过 TTS（省配额）——否则旧搜索回复污染会话与记忆（Task 0.5 Step2/Step3）。
    const fenceSuppressed = this._fenceSuppressed(opts);
    // 对话委托桥：「帮我查X」既现场搜一轮、交办语义也立 owner 目标由工作区跟踪到底（原早立目标的产品意图）；
    // 真实写库延迟到此 fence 守卫窗口，被 superseded 的旧代不立目标（Task 0.5 Step3）。
    let taskReceipt = null;
    if (!fenceSuppressed) {
      taskReceipt = this._runDelegationHook(transcript, opts);
      this.history.push({ role: 'user', content: transcript }, { role: 'assistant', content: reply });
      if (this.history.length > 16) this.history = this.history.slice(-16);
    }

    let audioBase64 = null;
    let audioFormat = null;
    if (!opts.noTts && !fenceSuppressed) {
      const r = await this._synthesize(reply, opts.tts || {});
      audioBase64 = r.audioBase64;
      audioFormat = r.audioFormat;
      if (r.ttsErr) lastErr = r.ttsErr;
    }

    const dialogue = `用户：${transcript}\nNoe：${reply}`;
    if (!fenceSuppressed) {
      try { this.memory?.write?.({ projectId: this.projectId, scope: 'voice', sourceType: 'voice', body: dialogue, tags: [...memoryPolicy.tags, 'research'], confidence: memoryPolicy.dialogueConfidence }); } catch { /* 记忆失败不阻断 */ }
    }
    return { ok: true, transcript, reply, intent: 'research', query: intent.query, ...payload, taskReceipt, audioBase64, audioFormat, ttsError: audioBase64 ? null : (lastErr?.message || null) };
  }

  // 想 + 说 + 记 的外壳：代际栅栏防连击——同一会话连发多条时，旧回复可能比新回复后完成，
  // 只让最新一代可见投递、旧代静默压制（NoeGenerationFence T1 接线；opts.fence===false 旁路）。
  async _respond(transcript, opts = {}) {
    const fence = opts.fence === false ? null : this.generationFence;
    const snapshot = fence
      ? fence.begin(resolveFenceKey({ sessionKey: opts.sessionKey || `voice:${this.projectId}`, channel: opts.channel || 'voice' }))
      : null;
    if (!snapshot) return this._respondCore(transcript, opts);
    try {
      const result = await this._respondCore(transcript, { ...opts, _fenceSnapshot: snapshot });
      // markDelivered 单点判定并消费快照：被更新一代抢先则返回 false → 压制本（旧）代
      const visible = fence.markDelivered(snapshot);
      if (!visible) return { ok: false, transcript, intent: 'superseded', ignored: true, suppressed: true, error: '已忽略：之后又收到更新的消息，这条旧回复被压制。' };
      return result;
    } catch (e) {
      fence.release(snapshot); // 出错放弃本代（catch 路径上快照必未被消费过）
      throw e;
    }
  }

  // 本代是否已被代际栅栏压制（只读检查，不消费快照）。被压制时本回复终将被外壳 _respond 丢弃为
  // superseded，所有真实写库副作用（动作桥/记忆/时间线/承诺/事实）都必须跳过，防旧回复污染。
  _fenceSuppressed(opts = {}) {
    return opts._fenceSnapshot ? this.generationFence?.shouldSuppress?.(opts._fenceSnapshot) === true : false;
  }

  // 对话委托桥真实写库（goalSystem.add via delegationHook）。被代际栅栏 superseded 时绝不调用——
  // 旧代连击不该立目标（Task 0.5 Step3）。统一在「reply 生成后的 fence 判定窗口」内调用，时序上
  // 才拦得住「旧代卡在 LLM 生成、新代抢先」的连击；turn 开头早调那一刻新代往往尚未到达，拦不住。
  _runDelegationHook(transcript, opts = {}) {
    if (!this.delegationHook || this._fenceSuppressed(opts)) return null;
    try { return normalizeTaskReceipt(this.delegationHook(transcript), transcript); } catch { return null; }
  }

  // 想 + 说 + 记（chat / chatText 共用）。transcript = 用户这轮输入文本。
  async _respondCore(transcript, opts = {}) {
    const owner = this.ownerGate?.check?.(transcript, opts);
    if (owner && !owner.ok) return { ok: false, transcript, intent: 'owner_gate', ignored: true, error: owner.error || '已忽略：未通过主人验证。' };
    // 对话委托桥（delegationHook）真实写库延迟到 reply 后的 fence 守卫窗口统一执行（见 _runDelegationHook /
    // 下方写库节）；research 分流前不再早立目标——research 分支在自己的 fence 守卫窗口里立（Task 0.5 Step3）。
    let taskReceipt = null;
    if (this.personStore?.identifyFace && opts.faceEmbedding && !opts.personFace) {
      try { const personFace = this.personStore.identifyFace(opts.faceEmbedding); if (personFace?.person) opts = { ...opts, personFace }; } catch { /* 人物人脸识别失败不阻断对话 */ }
    }
    const profile = this.chatProfileStore?.resolve ? this.chatProfileStore.resolve(opts.profileId) : resolveChatProfile(opts.profileId);
    const memoryPolicy = memoryPolicyForProfile(profile);
    // 修复潜在 ReferenceError（2026-06-10 终检 lint 抓到）：下方"这是谁"分支引用 modelSettings，
    // 但它原来只在 chat() 里定义——chatText 路径问"这是谁"且视觉开启会直接崩。此处按 chat() 同款兜底定义。
    const modelSettings = this.personStore?.modelSettings?.status?.() || { voice: { enabled: true }, face: { enabled: true } };
    const researchIntent = detectResearchIntent(transcript);
    // research 分支自己在 fence 守卫窗口里立委托目标，不再从此处透传 taskReceipt（已统一延迟，见 Task 0.5 Step3）。
    if (researchIntent && this.webSearch) return this._respondWithResearch(transcript, researchIntent, { ...opts, profile, memoryPolicy });
    const taskIntent = detectTaskIntent(transcript);
    if (taskIntent) {
      const reply = sanitize(formatTaskIntentReply(taskIntent));
      let audioBase64 = null;
      let audioFormat = null;
      let lastErr = null;
      if (!opts.noTts) {
        const r = await this._synthesize(reply, opts.tts || {});
        audioBase64 = r.audioBase64;
        audioFormat = r.audioFormat;
        lastErr = r.ttsErr;
      }
      // codex post-review: direct delegate_task 也要在 fence 守卫窗口内立委托目标(_runDelegationHook 含 superseded 抑制)，
      // 否则 Task 0.5 延迟改造把本分支 taskReceipt 弄成恒 null = 回归(direct 派活不再真实写库)。
      taskReceipt = this._runDelegationHook(transcript, opts);
      return { ok: true, transcript, reply, intent: 'delegate_task', plan: taskIntent, confirmEndpoint: '/api/noe/delegate/confirm', taskReceipt, audioBase64, audioFormat, ttsError: audioBase64 ? null : (lastErr?.message || null) };
    }

    // 2) 想：BrainRouter 路由大脑（语音对话多为闲聊，默认压本地 ollama，省 token）
    if (!this.brainRouter || !this.getAdapter) return { ok: false, transcript, error: 'brainRouter 未配置' };
    const decision = this.brainRouter.route({ text: transcript });
    // 智能路由：尊重 BrainRouter 按难度选的档（code→codex / deep→claude / mid→minimax / local→本地 abliterated）；
    // 末尾兜底本地 ollama+lmstudio，保证云档没配/失败也能聊（闲聊/敏感话题 BrainRouter 默认就走本地无限制档）。
    const forcedChain = Array.isArray(profile.adapterChain) && profile.adapterChain.length ? profile.adapterChain : null;
    const cloudOnly = this.foregroundChatRouting?.cloudOnly === true;
    const chain = cloudOnly
      ? resolveForegroundChatChain({ decision, profileChain: forcedChain, ...this.foregroundChatRouting })
      : (forcedChain || [...new Set([decision.adapterId, ...(Array.isArray(decision.fallbacks) ? decision.fallbacks : []), 'lmstudio'])]); // owner 2026-06-17：abliterated 卸载，去 ollama，本地兜底退 lmstudio 主脑
    const visionQuestion = isVisionQuestion(transcript);
    const correctionQuestion = isCorrectionQuestion(transcript);

    // 摄像头/双视觉模式：每次对话前现看一眼当前画面，让回应反映用户此刻的动作/表情（用户选「每句都现看」）。
    // 审计 §3.4 P0-8：两分支动作相同（force glance），合并为单一条件，杜绝任何"双 if 双调 VLM"回归（_inflight 清零触发第二次 90s VLM）。
    const visionMode = this.visionSession?.mode || 'off';
    const shouldGlance = !!this.visionSession && visionMode !== 'off'
      && (visionQuestion || /^(camera|both)$/.test(visionMode));
    if (shouldGlance) {
      // 摄像头/双视觉模式每句都等本地 VLM 看完（用户要求工作中的模型不要中途超时）。
      try { await this.visionSession.glance({ force: true }); } catch { /* 视觉失败不阻断对话 */ }
    }
    // "这是谁"：问身份且认人没关闭 → InsightFace 提脸 + identifyFace 1:N，结果作硬证据(不让大脑凭画面猜名字)。
    let whoResult = null;
    if (this.visionSession?.recognizeWho && isWhoQuestion(transcript) && (this.visionSession.faceRecog || 'ask') !== 'off' && modelSettings.face?.enabled !== false) {
      try { whoResult = await this.visionSession.recognizeWho(); } catch { /* 认人失败不阻断对话 */ }
    }
    const vis = this.visionSession?.latest?.();
    // 方向二（ContextEngine 通电）：原十余段 ctx.add 内联供给整体迁入 NoeTurnContextEngine——
    // 段顺序/keep/文案逐字一致（引擎单测+本文件注入测试钉死）；NoeContextBudgeter 仍做预算裁剪，
    // 超 NOE_CONTEXT_BUDGET_TOKENS(默认 6000t) 的裁剪观测 warn 由引擎统一发。
    // 代际栅栏时序对齐：动作桥跑在大脑生成前，而同一事件循环里同步连发的后续 turn 要到各自 _respond
    // 才 fence.begin 登记。此处先让出一个微任务，确保后续代已登记，本代在动作桥执行点的 superseded 判定
    // （suppressActions 谓词）才能看到更新代——否则旧代会抢在新代 begin 前跑完动作桥副作用（连击重复建提醒/写记忆）。
    if (opts._fenceSnapshot) await Promise.resolve();
    const composed = await this.contextEngine.supplyTurnContext({
      transcript,
      projectId: this.projectId,
      systemPrompt: profile.systemPrompt,
      memoryPolicy,
      identity: { voice: opts.voice, face: opts.face, ownerTrust: opts.ownerTrust, personVoice: opts.personVoice, personFace: opts.personFace },
      whoResult,
      vis,
      visionMode: this.visionSession?.mode || '',
      visionQuestion,
      correctionQuestion,
      // 代际栅栏守卫(Task 0.5 同源):动作桥跑在大脑生成之前,被更新一代 superseded 的旧代连击
      // 绝不能真写记忆/真建提醒承诺。传惰性谓词,让引擎在动作执行点现算最新 fence 状态——
      // 此处一次性布尔会漏掉「supplyTurnContext 内部 await 期间新代才登记」的在途竞态。
      suppressActions: () => this._fenceSuppressed(opts),
    });
    // 链接自动理解：检测 transcript 里的 URL → 安全抓取摘要 → 注入 system（flag OFF 时 linkUnderstanding=null 零成本跳过）。
    let linkBlock = '';
    if (this.linkUnderstanding) {
      try { const lu = await this.linkUnderstanding.understand(transcript); if (lu.contextBlock) linkBlock = `\n\n${lu.contextBlock}`; }
      catch { /* 链接理解失败不阻断对话 */ }
    }
    const sys = profile.systemPrompt + composed.text + linkBlock;
    // 短期对话历史：带最近几轮让对话连续（记得上一句说了啥）
    const historyMsgs = (visionQuestion || correctionQuestion) ? [] : this.history.slice(-8);
    const adapterOpts = { model: profile.model || undefined, noAbort: profile.noAbort === true, thinkingMode: profile.thinkingMode || 'default' };
    if (typeof profile.temperature === 'number') adapterOpts.temperature = profile.temperature;
    if (typeof profile.maxCompletionTokens === 'number') {
      adapterOpts.maxCompletionTokens = profile.maxCompletionTokens;
      adapterOpts.maxTokens = profile.maxCompletionTokens;
    }

    let reply = '';
    let usedAdapter = null;
    let usedModel = null;
    let lastErr = null;
    let earlyTts = null; // LLM 流式早鸟：{sentence, promise}——成功的 adapter 尝试里首句早合成的 TTS
    for (const aid of chain) {
      const adapter = this.getAdapter(aid);
      if (!adapter || typeof adapter.chat !== 'function') continue;
      // LLM 流式早鸟（NOE_VOICE_LLM_STREAM=1 默认 OFF）：支持流式的 adapter（ollama）边吐字边检首句，
      // 首句一成形并行启动 TTS（与剩余生成重叠）。不支持流式的 adapter 自动忽略 onDelta，零影响。
      let early = null;
      const detector = (this.llmStream && !opts.noTts && opts.streamTts !== false)
        ? createEarlySentenceDetector({ sanitize: (s) => sanitize(s, { personaName: profile.personaName }) })
        : null;
      const onDelta = detector ? (piece) => {
        if (early) return;
        const first = detector.push(piece);
        // 栅栏已压制本代就不浪费 TTS 配额（只读检查，不消费快照）
        if (first && !(opts._fenceSnapshot && this.generationFence?.shouldSuppress?.(opts._fenceSnapshot))) {
          early = { sentence: first, promise: this._synthesize(first, opts.tts || {}).catch((err) => ({ audioBase64: null, audioFormat: null, ttsErr: err })) };
        }
      } : null;
      try {
        const messages = [{ role: 'system', content: sys }, ...historyMsgs, { role: 'user', content: transcript }];
        const r = await adapter.chat(
          messages,
          { budgetContext: { projectId: this.projectId, taskId: `noe-voice:${profile.id}`, agentProfileId: profile.id }, think: false, ...adapterOpts, ...(onDelta ? { onDelta } : {}) }, // 本地 reasoning 仍关；MiniMax thinkingMode 由 profile 控制
        );
        if (isIncompleteBrainResult(r)) {
          lastErr = incompleteBrainError(r);
          continue;
        }
        reply = sanitize(r?.reply, { personaName: profile.personaName });
        usedAdapter = aid;
        usedModel = profile.model || adapter.model || null;
        if (reply) { earlyTts = early; break; } // 只有成功出 reply 的尝试保留早鸟；失败尝试的早鸟随循环丢弃
      } catch (e) {
        lastErr = e;
        if (aid === 'minimax' && historyMsgs.length && (e?.code === 'PROVIDER_INPUT_REJECTED' || PROVIDER_INPUT_REJECTED_RE.test(e?.message || ''))) {
          try {
            const r2 = await adapter.chat(
              [{ role: 'system', content: sys }, { role: 'user', content: transcript }],
              { budgetContext: { projectId: this.projectId, taskId: `noe-voice-no-history:${profile.id}`, agentProfileId: profile.id }, think: false, ...adapterOpts },
            );
            if (isIncompleteBrainResult(r2)) {
              lastErr = incompleteBrainError(r2);
              continue;
            }
            reply = sanitize(r2?.reply, { personaName: profile.personaName });
            usedAdapter = aid;
            usedModel = profile.model || adapter.model || null;
            if (reply) break;
          } catch (e2) { lastErr = e2; }
        }
      }
    }
    if (!reply) {
      const rejected = lastErr?.code === 'PROVIDER_INPUT_REJECTED' || PROVIDER_INPUT_REJECTED_RE.test(lastErr?.message || '');
      const hint = lastErr?.code === 'BRAIN_INCOMPLETE'
        ? lastErr.message
        : (rejected ? 'MiniMax 云端拒绝了当前输入或上下文；已尝试去掉历史重试。请换更温和表达，或切到另一个云端聊天档。' : `大脑不可用（${chain.join('→')}）: ${lastErr?.message || ''}`);
      // 闲聊大脑挂了，但 owner 原话若命中委托（"帮我查X"）仍要立目标——嘴没答应不代表手不接（交办不丢）。
      // _runDelegationHook 内含 fence 守卫：被 superseded 的旧代不立目标（Task 0.5 Step3）。
      return { ok: false, transcript, taskReceipt: this._runDelegationHook(transcript, opts), error: hint };
    }

    const quality = assessChineseOutput(reply);
    if (!quality.ok && quality.severe) {
      for (const aid of chain) {
        const adapter = this.getAdapter(aid);
        if (!adapter || typeof adapter.chat !== 'function') continue;
        try {
          const r2 = await adapter.chat(
            [{ role: 'system', content: `${sys}\n\n${qualityRetryInstruction(quality.reasons)}` }, { role: 'user', content: transcript }],
            { budgetContext: { projectId: this.projectId, taskId: `noe-voice-quality-retry:${profile.id}`, agentProfileId: profile.id }, think: false, ...adapterOpts },
          );
          if (isIncompleteBrainResult(r2)) continue;
          const r2reply = sanitize(r2?.reply, { personaName: profile.personaName });
          if (r2reply && assessChineseOutput(r2reply).ok) { reply = r2reply; usedAdapter = aid; usedModel = profile.model || adapter.model || null; break; }
          if (r2reply && !reply) reply = r2reply;
        } catch { /* 质检重试失败则保留清洗后的原回复 */ }
      }
    }

    // 反复读：本次回复与最近一条雷同 → 模型卡死了（history 把同一句反复喂回），斩断历史 + 强制换说法重生成一次
    const lastAssist = [...this.history].reverse().find((m) => m.role === 'assistant')?.content || '';
    if (lastAssist && isRepeat(reply, lastAssist)) {
      for (const aid of chain) {
        const adapter = this.getAdapter(aid);
        if (!adapter || typeof adapter.chat !== 'function') continue;
        try {
          const r2 = await adapter.chat(
            [{ role: 'system', content: sys + '\n\n【纠正】你刚才的回复和上一句几乎完全一样，主人已经在追问你为什么老重复了。这次必须正面回应主人当前这句话、换一种全新的说法，绝不重复之前的内容，更不要再说“换个话题/听音乐/看电影/吃点甜的”这类转移话题的话。' },
            { role: 'user', content: transcript }],   // 不带 history，斩断复读源
            { budgetContext: { projectId: this.projectId, taskId: `noe-voice-retry:${profile.id}`, agentProfileId: profile.id }, think: false, ...adapterOpts },
          );
          if (isIncompleteBrainResult(r2)) continue;
          const r2reply = sanitize(r2?.reply, { personaName: profile.personaName });
          if (r2reply && !isRepeat(r2reply, lastAssist)) { reply = r2reply; usedAdapter = aid; usedModel = profile.model || adapter.model || null; break; }
        } catch { /* 重试失败则保持原 reply */ }
      }
    }

    // 栅栏中途检查（只读不消费）：本代已被更新一代压制时，本回复会被外壳 _respond 丢弃为 superseded。
    // 此时绝不能写 history/长期记忆/时间线/事实/承诺/动作桥——否则旧回复污染会话与记忆（Task 0.5 Step2/Step3）。
    const fenceSuppressed = this._fenceSuppressed(opts);

    // 对话委托桥（owner 原话命中"去查X/帮我看看Y"）：延迟到此处的 fence 守卫窗口才真实写库（立 owner 目标），
    // 保证旧代连击被 superseded 时不立目标（_runDelegationHook 内含 fence 守卫；Task 0.5 Step3）。
    if (!fenceSuppressed) taskReceipt = this._runDelegationHook(transcript, opts) || taskReceipt;

    // 承诺兜底：如果模型自己说了"我去查/我马上排查/查完告诉你"，但 owner 原话未命中委托桥，
    // 立刻把这句话补成真实 owner 目标。否则它会像旧问题一样只说去做，后面没有任何执行态。
    // 被压制的旧代不补建任务（delegationHook 真实写库），交给最新一代去立目标（Task 0.5 Step3）。
    if (!fenceSuppressed && !taskReceipt && this.delegationHook && detectAssistantTaskPromise(reply)) {
      taskReceipt = this._runDelegationHook(taskTextFromAssistantPromise(transcript), opts);
      if (taskReceipt && !/任务|状态栏|执行进度|持续显示/.test(reply)) {
        reply = `${reply}\n我已经把这件事挂到任务里，状态栏会持续显示执行结果。`;
      }
    }

    // 更新会话内短期历史（reply 已确认有效），留最近 8 轮，下一句对话带上保持连续；被压制的旧代不进 history。
    if (!fenceSuppressed) {
      this.history.push({ role: 'user', content: transcript }, { role: 'assistant', content: reply });
      if (this.history.length > 16) this.history = this.history.slice(-16);
    }

    // 3) 说：统一回退链 _synthesize — 主选(按语言分档) → MiniMax 主音色 → CosyVoice 本地中文兜底(卡②)
    // 本代被压制时跳过 TTS——反正外壳会丢弃本回复，别浪费 MiniMax 配额
    let audioBase64 = null;
    let audioFormat = null;
    let restTtsText = null;
    if (!opts.noTts && !fenceSuppressed) {
      const split = opts.streamTts === false ? null : splitFirstSentence(reply);
      // LLM 流式早鸟对账（NOE_VOICE_LLM_STREAM=1）：早鸟句与最终首句逐字一致才采用——
      // 质检/复读重试换了答案、或前缀清洗与整段口径有出入时，丢早鸟走下面旧路（绝不放错音频）。
      if (earlyTts && split && split.first === earlyTts.sentence) {
        const r = await earlyTts.promise; // 与生成重叠跑，此刻多半已就绪 ⇒ 首声提前 ≈ 一次 TTS 时长
        if (r.audioBase64) {
          audioBase64 = r.audioBase64;
          audioFormat = r.audioFormat;
          restTtsText = split.rest;
        } else if (r.ttsErr) lastErr = r.ttsErr;
      }
      if (!audioBase64) {
        // C9 流式语音：长回复只先合成首句（首声提前数秒），剩余文本带回给前端续播；
        // 首句合成失败（兜底链全挂）时按旧行为返回 ttsError，不再多试一次整段（同一条链结果相同）。
        const r = await this._synthesize(split ? split.first : reply, opts.tts || {});
        audioBase64 = r.audioBase64;
        audioFormat = r.audioFormat;
        if (r.ttsErr) lastErr = r.ttsErr;
        if (split && audioBase64) restTtsText = split.rest;
      }
    }

    // 4) 记：先落自传体情景，再让长期记忆事实带 sourceEpisodeId，避免孤儿事实。
    // 整节被 fenceSuppressed 守卫（Task 0.5 Step2/Step3）：本代被更新一代压制时，回复会被外壳丢弃为
    // superseded，绝不写时间线/长期记忆/承诺/事实——否则旧回复污染记忆（含 factExtractor 的异步写库副作用）。
    const dialogue = `用户：${transcript}\nNoe：${reply}`;
    if (!fenceSuppressed) {
      let sourceEpisodeId = null;
      try {
        const eventId = this.episodicTimeline?.record?.({
          type: 'interaction',
          summary: `主人说"${String(transcript).slice(0, 40)}"，我答"${String(reply).slice(0, 40)}"`,
          salience: 3,
        });
        if (eventId !== undefined && eventId !== null) sourceEpisodeId = String(eventId).slice(0, 240);
      } catch { /* 记录失败不阻断对话 */ }
      if (memoryPolicy.writeDialogue) {
        try {
          this.memory?.write?.({ projectId: this.projectId, scope: 'voice', sourceType: 'voice', body: dialogue, tags: memoryPolicy.tags, confidence: memoryPolicy.dialogueConfidence, sourceEpisodeId });
        } catch { /* 记忆失败不阻断对话 */ }
      }
      // 4c) T7 承诺抽取（波次6 接线）：Noe 这轮说了"我会X" → 真记进 CommitmentStore（确定性正则零额度，失败不阻断）
      if (this.commitmentExtract) {
        try { this.commitmentExtract(reply); } catch { /* 抽取失败不阻断对话 */ }
      }
      // 4b) 异步提炼「值得长期记住的事实」沉淀进记忆（不阻断返回；本地 gemma4:31b 慢也没关系）
      if (this.factExtractor && memoryPolicy.extractFacts) {
        const extractFacts = this.factExtractor.extractRecords
          ? this.factExtractor.extractRecords(dialogue, { confidence: memoryPolicy.factConfidence, sourceEpisodeId, evidenceRefs: sourceEpisodeId ? [`episode:${sourceEpisodeId}`] : [] })
          : this.factExtractor.extract(dialogue);
        Promise.resolve(extractFacts)
          .then((facts) => {
            for (const f of (facts || [])) {
              const record = typeof f === 'string' ? { body: f } : (f || {});
              try {
                const candidate = {
                  kind: record.kind || 'fact',
                  projectId: this.projectId,
                  scope: record.scope || 'fact',
                  sourceType: 'fact_extract',
                  body: record.body || record.text || f,
                  tags: memoryPolicy.factTags,
                  confidence: record.confidence ?? memoryPolicy.factConfidence,
                  salience: record.salience,
                  validFrom: record.validFrom,
                  validTo: record.validTo,
                  noWriteReason: record.noWriteReason,
                  sourceEpisodeId: record.sourceEpisodeId ?? sourceEpisodeId,
                  evidenceRefs: record.evidenceRefs || (sourceEpisodeId ? [`episode:${sourceEpisodeId}`] : []),
                };
                if (this.memoryWriteGate?.commit) this.memoryWriteGate.commit(candidate);
                else if (!record.noWriteReason) this.memory?.write?.(candidate);
              } catch { /* noop */ }
            }
          })
          .catch(() => { /* 抽取失败静默，不影响对话 */ });
      }
    }
    return { ok: true, transcript, reply, tier: forcedChain ? 'profile' : decision.tier, profileId: profile.id, profileName: profile.name, usedAdapter, usedModel, people: { face: opts.personFace || null, voice: opts.personVoice || null }, taskReceipt, audioBase64, audioFormat, restTtsText, ttsError: audioBase64 ? null : (lastErr?.message || null) };
  }
}
