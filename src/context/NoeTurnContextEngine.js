// @ts-check
// NoeTurnContextEngine — 每轮对话的上下文供给引擎（ROADMAP 方向二：ContextEngine 通电）。
//
// 问题：VoiceSession._respondCore 里十余段 ctx.add 手工注入（自我认知/人物库/承诺/预取/人物卡/
//   工具桥/动作桥/身份/认人/视觉/纠错/记忆召回），供给逻辑长在语音入口里，文字聊天室无法复用。
// 方案：供给逻辑收进本引擎（供给层），NoeContextBudgeter 继续做预算裁剪（裁剪层）——
//   VoiceSession / SoloChatDispatcher 等任何对话入口都调 supplyTurnContext() 拿同一套上下文。
//   依赖全注入、未注入则对应段 no-op；以后新增上下文源 = 在这里加一段 provider，不再往入口塞 sys+=。
// 行为契约：段顺序 / keep 等级 / 文案与 VoiceSession 旧内联逐字一致
//   （tests/unit/noe-voice-context-injection.test.js 经 VoiceSession 钉死，本引擎另有独立单测）。

import { createContextComposer } from './NoeContextBudgeter.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { buildNoeSelfKnowledgeBlock } from './NoeSelfKnowledge.js';
import { runQueryTools } from '../voice/NoeToolBridge.js';
import { detectAction, runAction } from '../voice/NoeActionBridge.js';
import { rankProfileMemories } from '../voice/MemoryPolicy.js';
import { formatMemoryContextBlock } from '../memory/NoeMemoryContextFormatter.js';

// 把主人的人物库做成简表注入对话上下文：问到库里的人就直接答，杜绝"我去找/稍等"却给不出的空转。
// （原 VoiceSession.buildPeopleBrief 原样迁入；VoiceSession 仍 re-export 保持旧 import 路径可用。）
export function buildPeopleBrief(personStore, { max = 40, notesLen = 200 } = {}) {
  if (!personStore?.list) return '';
  let people;
  try { people = personStore.list(); } catch { return ''; }
  if (!Array.isArray(people) || !people.length) return '';
  const lines = people.slice(0, max).map((p) => {
    const head = p.relation ? `${p.displayName}（${p.relation}）` : p.displayName;
    const extra = [p.notes, (p.aliases || []).length ? `别名：${p.aliases.join('、')}` : ''].filter(Boolean).join('；');
    return `- ${head}${extra ? `：${String(extra).slice(0, notesLen)}` : ''}`;
  });
  return `【主人的人物库（你已经认识下面这些人，资料就在这里）】\n${lines.join('\n')}\n`
    + '用户问到上面任何人，立刻根据这里的资料直接回答——资料已经在你眼前了，不要说"我去找/稍等/马上查/正在翻找"（你没有异步查找的动作，说了也找不来）；只有这里没列出的人才说不认识。';
}

function formatVisionSituationForContext(situation) {
  if (!situation || typeof situation !== 'object') return '';
  const interrupt = situation.shouldInterrupt === true ? '是' : '否';
  const confidence = Number.isFinite(Number(situation.confidence)) ? Number(situation.confidence).toFixed(2) : 'unknown';
  return `；处境判断：activity=${situation.activity || 'unknown'}, attention=${situation.attention || 'unknown'}, possibleNeed=${situation.possibleNeed || 'unknown'}, shouldInterrupt=${interrupt}, confidence=${confidence}`;
}

function sanitizeProviderError(error, max = 180) {
  const raw = typeof error === 'string' ? error : (error?.message || error?.code || error?.name || 'context_provider_failed');
  return redactSensitiveText(String(raw || '').trim().slice(0, max))
    .replace(/\bBearer\s+\S{12,}/gi, 'Bearer [redacted]')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:tp|sk|pk|rk|gh[pousr]|xox[baprs]?)-[A-Za-z0-9_-]{12,}\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim() || 'context_provider_failed';
}

// suppressActions 可传 boolean 或惰性谓词函数（() => boolean）：动作桥跑在大脑生成之前，
// 对话入口的代际栅栏状态此刻可能还在变（更新一代正在登记）——传函数则在动作执行点现算，
// 守卫住「旧代卡在后续 await、新代抢先」的在途连击。谓词自身异常一律按「不压制」放行
// （守卫绝不能因自身故障吞掉正常用户的记忆/提醒动作）。
function resolveSuppressActions(suppressActions) {
  if (typeof suppressActions === 'function') {
    try { return suppressActions() === true; } catch { return false; }
  }
  return suppressActions === true;
}

function recordActionSourceEpisode(episodicTimeline, action) {
  if (!episodicTimeline?.record || !['remember', 'remind'].includes(String(action?.type || ''))) return null;
  try {
    const id = episodicTimeline.record({
      type: 'interaction',
      summary: `主人发出显式${action.type === 'remember' ? '记忆' : '提醒'}动作，动作桥已处理。`,
      salience: 4,
      meta: { source: 'turn_context_action_bridge', actionType: action.type },
    });
    return id === undefined || id === null ? null : String(id).slice(0, 240);
  } catch {
    return null;
  }
}

export function createTurnContextProviderGuard({
  failureThreshold = 3,
  cooldownMs = 60_000,
  now = Date.now,
} = {}) {
  const threshold = Math.max(1, Number(failureThreshold) || 3);
  const cooldown = Math.max(1, Number(cooldownMs) || 60_000);
  const clock = typeof now === 'function' ? now : Date.now;
  const states = new Map();
  const keyOf = (id) => String(id || 'unknown').replace(/\s+/g, '_').slice(0, 120) || 'unknown';
  const fresh = () => ({ failures: 0, openedAt: 0, retryAt: 0, lastError: '' });

  function read(id) {
    const key = keyOf(id);
    const state = states.get(key) || fresh();
    const nowMs = clock();
    if (state.retryAt && nowMs >= state.retryAt) {
      state.openedAt = 0;
      state.retryAt = 0;
      states.set(key, state);
    }
    return { key, state, nowMs };
  }

  return {
    canAttempt(id = 'unknown') {
      const { key, state, nowMs } = read(id);
      if (state.retryAt && nowMs < state.retryAt) {
        return {
          ok: false,
          open: true,
          reason: 'context_provider_quarantined',
          providerId: key,
          failures: state.failures,
          retryAt: state.retryAt,
          remainingMs: Math.max(0, state.retryAt - nowMs),
          lastError: state.lastError,
        };
      }
      return {
        ok: true,
        open: false,
        reason: '',
        providerId: key,
        failures: state.failures,
        retryAt: state.retryAt,
        remainingMs: 0,
        lastError: state.lastError,
      };
    },
    recordSuccess(id = 'unknown') {
      const key = keyOf(id);
      states.delete(key);
      return { ok: true, open: false, providerId: key, failures: 0, retryAt: 0, remainingMs: 0, lastError: '' };
    },
    recordFailure(id = 'unknown', error = null) {
      const key = keyOf(id);
      const state = states.get(key) || fresh();
      const nowMs = clock();
      state.failures += 1;
      state.lastError = sanitizeProviderError(error);
      if (state.failures >= threshold) {
        state.openedAt = nowMs;
        state.retryAt = nowMs + cooldown;
      }
      states.set(key, state);
      return {
        ok: false,
        open: Boolean(state.retryAt && nowMs < state.retryAt),
        reason: state.retryAt ? 'context_provider_quarantined' : 'context_provider_failed',
        providerId: key,
        failures: state.failures,
        retryAt: state.retryAt,
        remainingMs: state.retryAt ? Math.max(0, state.retryAt - nowMs) : 0,
        lastError: state.lastError,
      };
    },
    reset(id = '') {
      if (id) states.delete(keyOf(id));
      else states.clear();
      return { ok: true };
    },
  };
}

export class NoeTurnContextEngine {
  /**
   * 长期依赖全注入（与 VoiceSession 同款 store API）；未注入的依赖对应段直接跳过。
   * 工具桥/动作桥/composer/时钟/日志也可注入，便于测试与替换。
   */
  constructor({
    memory = null,
    personStore = null,
    commitmentStore = null,
    personCardStore = null,
    prefetchStore = null,
    uiSignalStore = null,
    acuiCardStore = null,
    toolRegistry = null,
    memoryRetriever = null,
    memoryWriteGate = null,
    episodicTimeline = null,
    innerStateProvider = null,
    personaPinProvider = null,
    queryToolsRunner = runQueryTools,
    actionDetect = detectAction,
    actionRun = runAction,
    createComposer = createContextComposer,
    providerGuard = null,
    now = Date.now,
    logger = console,
  } = {}) {
    this.memory = memory;
    this.personStore = personStore;
    this.commitmentStore = commitmentStore;
    this.personCardStore = personCardStore;
    this.prefetchStore = prefetchStore;
    // ACUI 收口（ContextEngine 房务裁决书指引）：UI 信号 / agent 卡片两个共享 store，
    // 仅在装配点 NOE_CHAT_UISIGNALS=1（默认 OFF）才注入；未注入对应段完全 no-op。
    this.uiSignalStore = uiSignalStore;
    this.acuiCardStore = acuiCardStore;
    this.toolRegistry = toolRegistry;
    this.memoryRetriever = memoryRetriever;
    this.memoryWriteGate = memoryWriteGate;
    this.episodicTimeline = episodicTimeline;
    // P0.5 注入契约：inner-state（P4 填认知态）/ persona-pin（P8 填人设下沉）的内容 provider，
    //   默认 null = 段完全 no-op（本 P 只预留挂载点+契约，不产内容；P4/P8 各自注入 provider 即生效）。
    this.innerStateProvider = innerStateProvider;
    this.personaPinProvider = personaPinProvider;
    this.queryToolsRunner = queryToolsRunner;
    this.actionDetect = actionDetect;
    this.actionRun = actionRun;
    this.createComposer = createComposer;
    this.providerGuard = providerGuard || createTurnContextProviderGuard({ now });
    this.now = now;
    this.logger = logger;
  }

  /**
   * 供给一轮对话的全部注入段并按预算裁剪。
   * @param {object} turn 本轮入参（全部可选，缺省即对应段不注入）：
   *   transcript 用户本轮输入；projectId 项目域；systemPrompt 人格系统提示（用于 self-knowledge 幂等防重复）；
   *   memoryPolicy 记忆策略（recallLimit/injectLimit，见 MemoryPolicy）；
   *   identity {voice,face,ownerTrust,personVoice,personFace} 身份验证/识别结果（即 VoiceSession 的 opts 同名字段）；
   *   whoResult 人脸认人结果；vis 最近视觉证据；visionMode 视觉会话模式；
   *   visionQuestion/correctionQuestion 本轮是否视觉/纠错类问题（命中时跳过记忆召回）；
   *   sections 段级白名单（方向一：null=全开即 VoiceSession 旧行为；数组=只跑列出的段 id，
   *     白名单外的段连副作用都不跑——聊天室入口借此关掉 self-knowledge（Noe 人格）/action（写记忆库）等不适用段）；
   *   suppressActions 代际栅栏守卫（boolean 或惰性谓词 ()=>boolean）：被更新一代 superseded 的旧代连击时
   *     由对话入口传 true/谓词，命中即整段跳过动作桥（actionRun 真写记忆 + recordActionSourceEpisode 真写时间线），
   *     只读上下文照常供给。默认 false ⇒ 无 fence 的入口（SoloChatDispatcher）/旧调用方行为不变。
   * @returns {Promise<{text: string, dropped: string[], usedTokens: number, budgetTokens: number}>}
   */
  async supplyTurnContext({
    transcript = '',
    projectId = 'noe',
    systemPrompt = '',
    memoryPolicy = null,
    identity = {},
    whoResult = null,
    vis = null,
    visionMode = '',
    visionQuestion = false,
    correctionQuestion = false,
    sections = null,
    suppressActions = false,
  } = {}) {
    const on = (id) => !Array.isArray(sections) || sections.includes(id);
    const ctx = this.createComposer();
    const providerFailures = [];
    const runProvider = async (id, fn) => {
      const status = this.providerGuard?.canAttempt?.(id);
      if (status && status.ok === false) {
        providerFailures.push({
          id,
          reason: status.reason || 'context_provider_quarantined',
          circuit: status,
        });
        this.logger?.warn?.('[noe-context] 上下文供给段隔离:', id, status.reason || 'context_provider_quarantined', status.lastError || '');
        return undefined;
      }
      try {
        const value = await fn();
        this.providerGuard?.recordSuccess?.(id);
        return value;
      } catch (error) {
        const failure = this.providerGuard?.recordFailure?.(id, error) || null;
        const safeError = sanitizeProviderError(error);
        providerFailures.push({
          id,
          reason: 'context_provider_failed',
          error: safeError,
          circuit: failure,
        });
        this.logger?.warn?.('[noe-context] 上下文供给段降级:', id, safeError);
        return undefined;
      }
    };
    // 自我能力认知:让大脑知道自己真有声纹/视觉/记忆/梦境/多模型等能力,被问到能如实答(而不是说"我没有")。
    // A2：self-knowledge 已统一在 ChatProfileStore.resolve 注入；此处仅为 opts.profile 旁路（未经 resolve）兜底，幂等防重复。
    const selfKnowledge = on('self-knowledge') ? buildNoeSelfKnowledgeBlock() : '';
    if (selfKnowledge && !String(systemPrompt || '').includes('<noe-self-knowledge>')) ctx.add('self-knowledge', selfKnowledge, { keep: 6 });
    // P0.5 注入契约 — persona-pin（稳定人设下沉 system prompt，内容由 P8 注入 personaPinProvider）：
    //   紧随 self-knowledge（人设类聚拢），keep:6。fail-open 走 runProvider（provider 抛错/空 → 不加段、零回归）。
    //   NOE_MEMORY_PERSONA_PIN 默认 OFF（留 owner 拍板）：persona-pin 会把稳定人设注入生产 system prompt，
    //   改的是「记忆里 Noe 的角色定位」，属分量动作（路线图 P0.5 + 项目 CLAUDE.md「分量动作默认 OFF 留 owner kickstart」），
    //   不擅自默认 ON；owner 在场 kickstart（NOE_MEMORY_PERSONA_PIN=1）后再考虑常开。provider 未注入则整段 no-op。
    //   裁剪语义注（NoeContextBudgeter「同级 keep 后加先丢」）：persona-pin 与 self-knowledge 同 keep:6 但后加入，
    //   故极端预算压力下 persona-pin 会先于 self-knowledge 被裁——合理（self-knowledge 是核心身份、persona-pin 是补充人设），
    //   且仍比后续 keep:6 段（tool-bridge 等）更稳。P8 若需更高粘性可上调本段 keep。
    if (on('persona-pin') && this.personaPinProvider
        && ['1', 'true', 'on'].includes(String(process.env.NOE_MEMORY_PERSONA_PIN || '0').trim().toLowerCase())) {
      const block = await runProvider('persona-pin', () => this.personaPinProvider({ transcript, projectId, systemPrompt }));
      if (block) ctx.add('persona-pin', String(block), { keep: 6 });
    }
    // P3 学 owner：owner 偏好常驻注入(NOE_OWNER_PROFILE=1 默认 OFF)——把高 salience 的 owner 偏好(语言/格式/工作方式,
    //   自主沉淀学到的)每轮常驻注入,让 Neo 主动体现「懂主人、记得主人」(不依赖 query 相关召回；治「learning_lesson 是技术认知
    //   修正、owner 日常 chat 不相关」)。排除验证码/代号等非偏好事实；失败不阻断。
    if (on('owner-profile') && process.env.NOE_OWNER_PROFILE === '1' && typeof this.memory?.db === 'function') {
      try {
        // M3 互评(隐私加固+召回率):白名单从宽泛「用户%希望%」(会命中隐私 fact 如「用户希望住上海」)改成「回答方式」关键词
        //   (语言/格式/风格/称呼,不含个人隐私)；黑名单扩到手机/邮箱/住址/身份证/银行/token/关系人/公司,防 owner 敏感 fact
        //   被「主动常驻」注入每轮广播进 systemPrompt(常驻注入攻击面比按需召回大)。白名单不限「用户」前缀,也召回「Noe偏好中文」等。
        // codex 互评:补 project_id(防跨项目事实)+ expires_at(防过期事实)过滤,对齐常规召回抽象;外层 on('owner-profile') 守卫
        //   对齐兄弟段(self-knowledge/people),让 sections 白名单能管控它(否则裸 if 绕过 CHAT_CONTEXT_SECTIONS,'owner-profile' 已加入白名单)。
        const prefs = this.memory.db().prepare(
          "SELECT title FROM noe_memory WHERE scope IN('user','fact') AND hidden=0 AND salience>=4"
          + " AND (project_id='noe' OR project_id IS NULL OR project_id='')"
          + " AND (expires_at IS NULL OR expires_at > ?)"
          + " AND (title LIKE '%中文%' OR title LIKE '%列表%' OR title LIKE '%清单%' OR title LIKE '%简洁%' OR title LIKE '%句%' OR title LIKE '%风格%' OR title LIKE '%口吻%' OR title LIKE '%称呼%' OR title LIKE '%思考过程%' OR title LIKE '%Jarvis%' OR title LIKE '%markdown%' OR title LIKE '%回复%' OR title LIKE '%回答%')"
          + " AND title NOT LIKE '%手机%' AND title NOT LIKE '%电话%' AND title NOT LIKE '%邮箱%' AND title NOT LIKE '%密码%' AND title NOT LIKE '%住址%' AND title NOT LIKE '%地址%' AND title NOT LIKE '%身份证%' AND title NOT LIKE '%银行%' AND title NOT LIKE '%token%' AND title NOT LIKE '%验证码%' AND title NOT LIKE '%代号%' AND title NOT LIKE '%老婆%' AND title NOT LIKE '%老公%' AND title NOT LIKE '%公司%'"
          + " ORDER BY salience DESC, hit_count DESC LIMIT 6",
        ).all(this.now());
        if (prefs.length) ctx.add('owner-profile', `【我已知的主人偏好（自然体现，别生硬复述）】\n${prefs.map((p) => '- ' + String(p.title || '').slice(0, 80)).join('\n')}`, { keep: 5 });
      } catch { /* owner-profile 失败不阻断当轮上下文 */ }
    }
    // 经验教训常驻注入(NOE_LESSON_PIN=1 默认 OFF):learning_lesson/surprise_lesson 写库即沉底(实证 347 产仅 1 召回——
    //   在通用语义召回里竞争失败),给一条专用常驻注入(绕开 query 语义召回,按 salience+时效 top-N),让经验真回流影响每轮
    //   行为、主动避免重蹈。治"产而不用"(六能力里自我完善唯一没转正的一环)。脱敏靠 source_type 限定(教训是技术认知非隐私)
    //   + project_id/expires_at 过滤(防跨项目/过期);keep:5 与 owner-profile 同级。失败不阻断当轮上下文。
    if (on('lesson-pin') && process.env.NOE_LESSON_PIN === '1' && typeof this.memory?.db === 'function') {
      try {
        const lessons = this.memory.db().prepare(
          "SELECT title FROM noe_memory WHERE source_type IN ('learning_lesson','surprise_lesson') AND hidden=0"
          + " AND (project_id='noe' OR project_id IS NULL OR project_id='')"
          + " AND (expires_at IS NULL OR expires_at > ?)"
          + " ORDER BY salience DESC, updated_at DESC LIMIT 5",
        ).all(this.now());
        if (lessons.length) ctx.add('lesson-pin', `【近期经验教训（已学到，主动避免重蹈）】\n${lessons.map((l) => '- ' + String(l.title || '').slice(0, 100)).join('\n')}`, { keep: 5 });
      } catch { /* lesson-pin 失败不阻断当轮上下文 */ }
    }
    // 人物库:把主人认识的人直接注入上下文,问到库里的人立刻答(治"只会说去找却永远给不出")
    const peopleBrief = on('people') ? buildPeopleBrief(this.personStore) : '';
    if (peopleBrief) ctx.add('people', peopleBrief, { keep: 4 });
    // 到期承诺:落入时间窗的未完成承诺 → 注入提醒,让大脑主动想起"你答应过…"(T1 接线;曾参照的 LegacyNoeContextEngine 已废弃,本引擎即唯一活引擎)
    if (on('commitments') && this.commitmentStore?.due) {
      const due = await runProvider('commitments', () => this.commitmentStore.due(this.now()));
      if (Array.isArray(due) && due.length) ctx.add('commitments', `【到期承诺(相关时自然提起,别生硬堆砌)】\n${due.slice(0, 5).map((c) => '- ' + String(c.text || '').slice(0, 160)).join('\n')}`, { keep: 4 });
    }
    // 预取池:未过期的高频环境数据(天气/系统状态等),问到秒答(T1 接线)
    if (on('prefetch') && this.prefetchStore?.toContextBlock) {
      const pf = await runProvider('prefetch', () => this.prefetchStore.toContextBlock(this.now()));
      if (pf) ctx.add('prefetch', pf, { keep: 3 });
    }
    // UI 信号:主人刚在面板上的卡片行为(挂载/点击/停留/关闭/报错)→ 只读注入让大脑知道"你刚看了/点了什么"。
    // 必须走非消费式 peekContextBlock——consume() 是 noeLocalCouncil 议会路径的消费语义(读后清),这里绝不抢消费。
    if (on('ui-signals') && this.uiSignalStore?.peekContextBlock) {
      const block = await runProvider('ui-signals', () => this.uiSignalStore.peekContextBlock());
      if (block) ctx.add('ui-signals', block, { keep: 3 });
    }
    // agent 卡片:面板上可见的任务/计划/证据卡片状态 → 只读注入(contextBlock 本身非消费式且 trust=local-untrusted)。
    if (on('acui-cards') && this.acuiCardStore?.contextBlock) {
      const block = await runProvider('acui-cards', () => this.acuiCardStore.contextBlock());
      if (block) ctx.add('acui-cards', block, { keep: 3 });
    }
    // 人物关系卡:声纹/人脸已识别出对话者时,注入该人关系卡(称呼/关系/偏好)(T1 接线)
    const identifiedName = identity.personVoice?.person?.displayName || identity.personFace?.person?.displayName || '';
    if (on('person-card') && identifiedName && this.personCardStore?.getByAlias) {
      const hint = await runProvider('person-card', () => {
        const card = this.personCardStore.getByAlias(identifiedName);
        return card && this.personCardStore.toContextHint ? this.personCardStore.toContextHint(card) : '';
      });
      if (hint) ctx.add('person-card', hint, { keep: 3 });
    }
    // 对话工具桥:听懂查询意图(记忆/文件/图谱)就后端真跑工具,把结果注入据实回答(治"只会说不会查")
    if (on('tool-bridge') && this.toolRegistry) {
      const toolCtx = await runProvider('tool-bridge', () => this.queryToolsRunner(transcript, { toolRegistry: this.toolRegistry, projectId }));
      if (toolCtx) ctx.add('tool-bridge', toolCtx, { keep: 6 });
    }
    // 动作桥:记住/提醒 → 后端真执行;危险动作(改文件/发消息/控制) → 诚实告知需授权。结果注入让大脑自然确认(治"只会说不会做")
    // 代际栅栏守卫(防连击):被更新一代 superseded 的旧代绝不跑动作桥——actionRun 真写记忆/真建提醒承诺、
    // recordActionSourceEpisode 也真写时间线,旧代连击执行=重复提醒/重复记忆。suppressActions 由对话入口
    // (VoiceSession)按 fence 状态惰性传入,命中即整段跳过(只读上下文照常供给);默认 false ⇒ 旧调用方行为不变。
    const actionsSuppressed = on('action') && resolveSuppressActions(suppressActions);
    const action = (on('action') && !actionsSuppressed) ? await runProvider('action-detect', () => this.actionDetect(transcript)) : null;
    if (action) {
      const sourceEpisodeId = recordActionSourceEpisode(this.episodicTimeline, action);
      const evidenceRefs = sourceEpisodeId ? [`episode:${sourceEpisodeId}`] : [];
      const ar = await runProvider('action-run', () => this.actionRun(action, {
        memory: this.memory,
        memoryWriteGate: this.memoryWriteGate,
        commitmentStore: this.commitmentStore,
        projectId,
        sourceEpisodeId,
        evidenceRefs,
      }));
      if (ar?.reply) ctx.add('action', `【动作结果（${ar.executed ? '已经真的执行完了' : '未执行/需主人授权'}），据此自然回复，绝不要说"我去做/稍等"】${ar.reply}`, { keep: 7 });
    }
    const identityNotes = [];
    if (on('identity')) {
      if (identity.voice?.ok) identityNotes.push(identity.voice.softPassedByFace
        ? `声纹分数 ${identity.voice.score ?? 'unknown'} 未达严格阈值 ${identity.voice.threshold ?? 'unknown'}，但已达到人脸辅助通过底线，且当前人脸验证通过。`
        : `声纹验证通过，分数 ${identity.voice.score ?? 'unknown'}，阈值 ${identity.voice.threshold ?? 'unknown'}。`);
      if (identity.face?.ok) identityNotes.push(`当前摄像头人脸验证通过，分数 ${identity.face.score ?? 'unknown'}，阈值 ${identity.face.threshold ?? 'unknown'}。`);
      if (identity.ownerTrust === 'voice_face') identityNotes.push('本轮可以视为主人本人正在说话。');
      for (const hit of [identity.personFace, identity.personVoice].filter((x) => x?.person)) {
        const p = hit.person;
        const detail = [p.relation ? `关系：${p.relation}` : '', p.notes ? `资料：${String(p.notes).slice(0, 160)}` : '', p.aliases?.length ? `别名：${p.aliases.join('、')}` : ''].filter(Boolean).join('；');
        identityNotes.push(hit.ok ? `本地人物库通过${hit.source === 'voice' ? '声纹' : '人脸'}识别到：${p.displayName}，分数 ${hit.score}。${detail}` : `本地人物库有相近候选 ${p.displayName}，但未达到确认条件（${hit.reason || 'low_confidence'}，分数 ${hit.score}）；不要当成确定身份。`);
      }
    }
    if (identityNotes.length) ctx.add('identity', `【身份验证】${identityNotes.join('')}`, { keep: 7 });
    if (on('who') && whoResult) {
      ctx.add('who', whoResult.recognized
        ? `【人脸认人结果（以此为准）】${whoResult.say}（人物库 1:N 匹配：${whoResult.person?.displayName}，分数 ${whoResult.score}）\n用户问"这是谁"时必须以这条 InsightFace 认人结果回答，不要凭画面描述去猜名字。`
        : `【人脸认人结果（以此为准）】${whoResult.say}\n这是 InsightFace 在已录入人物库里的 1:N 结果；没匹配到就如实说不认识、可问要不要录入，绝不凭画面猜名字。`, { keep: 8 });
    }
    if (on('vision-rule') && visionQuestion) {
      // 「镜头里是谁」会同时命中视觉问题与认人问题：有认人结果时，人名以认人结果为准，避免"必须报人名"与"看不出人名"两条规则对冲。
      const whoExempt = whoResult ? '（但【人脸认人结果】里已给出的人名以认人结果为准，不在此限）' : '';
      const situationLine = formatVisionSituationForContext(vis?.situation);
      ctx.add('vision-rule', vis?.summary
        ? `【视觉回答规则】用户正在问你看到的画面。当前视觉来源：${vis.mode || visionMode || 'unknown'}。视觉证据：${vis.summary}${situationLine}\n只能依据这段视觉证据回答；证据里没有的人名、关系、聊天对象、动作、情绪，一律说看不出来或不确定${whoExempt}。不要沿用历史里的人名、关系、聊天对象或情绪猜测。`
        : `【视觉回答规则】用户正在问你看到的画面，但当前没有可用视觉证据。${whoResult ? '人名以【人脸认人结果】为准；其他' : ''}你必须直接说明现在看不到或没有拿到画面，不能猜用户在干什么、穿什么、和谁聊天。`, { keep: 8 });
    } else if (on('vision-hint') && vis?.summary) {
      ctx.add('vision-hint', `（最近视觉证据：${vis.summary}${formatVisionSituationForContext(vis.situation)}。只有当用户问到画面/状态时才自然结合；证据没有的细节不要猜。）`, { keep: 5 });
    }
    if (on('correction') && correctionQuestion) {
      ctx.add('correction', '【纠错规则】这轮用户很可能在追问或纠正你刚才凭空提到的人、关系、聊天对象或画面细节。不要把历史里的模型回复当事实；除非用户本轮明确给出身份或视觉证据里确实存在，否则先说“刚才我没有可靠依据，可能误说了/看不出来”，再用当前事实简短回答。不要继续编解释，不要列平台或关系清单。', { keep: 8 });
    }

    // 长期记忆召回：从已沉淀记忆里捞与这句话相关的（事实/过往）注入，让 Noe「记得你」（对话历史走入口的短期窗口，这里只取 fact/vision/project 等长期记忆）
    // P0.5 注入契约 — inner-state（当下认知态：心情+在注意什么，内容由 P4 注入 innerStateProvider）：
    //   在 recall 前（先报"此刻状态"再报"记得的事"），keep:1（最易被预算挤掉、挤掉无伤）。fail-open 走 runProvider。
    //   NOE_TURN_INNER_STATE 默认 ON；provider 未注入则整段 no-op。
    if (on('inner-state') && this.innerStateProvider
        && !['0', 'false', 'off'].includes(String(process.env.NOE_TURN_INNER_STATE || '1').trim().toLowerCase())) {
      const block = await runProvider('inner-state', () => this.innerStateProvider({ transcript, projectId }));
      if (block) ctx.add('inner-state', String(block), { keep: 1 });
    }
    if (on('recall') && this.memoryRetriever?.retrieve && memoryPolicy && !visionQuestion && !correctionQuestion) {
      const retrieval = await runProvider('recall', () => this.memoryRetriever.retrieve({ transcript, projectId, routeType: 'chat', memoryPolicy }));
      if (retrieval) {
        const block = formatMemoryContextBlock(retrieval, { maxItems: memoryPolicy.injectLimit || 6 });
        if (block) ctx.add('recall', block, { keep: 2 });
      }
    } else if (on('recall') && this.memory?.recall && memoryPolicy && !visionQuestion && !correctionQuestion) {
      const recalled = await runProvider('recall', async () => {
        // 双路融合召回（波次6 接线）：MemoryCore 配了语义索引则 FTS×向量 RRF 融合，否则等价旧 FTS 召回
        const recallArgs = { q: transcript, projectId, limit: memoryPolicy.recallLimit, bumpHits: false };
        const recalledRaw = this.memory.recallFused ? await this.memory.recallFused(recallArgs) : this.memory.recall(recallArgs);
        return rankProfileMemories(recalledRaw
          .filter((m) => m && m.body && m.scope !== 'voice'), memoryPolicy).slice(0, memoryPolicy.injectLimit);
      });
      if (Array.isArray(recalled) && recalled.length) ctx.add('recall', `（你记得这些相关的事，自然用上、别生硬复述）：\n${recalled.map((m) => '· ' + String(m.body).slice(0, 200)).join('\n')}`, { keep: 2 });
    }
    const composed = ctx.compose();
    if (composed.dropped.length) this.logger?.warn?.('[noe-context] 超预算裁剪注入段:', composed.dropped.join(','), `(${composed.usedTokens}/${composed.budgetTokens}t)`);
    // 脱敏纪律（补齐与 Legacy 引擎的唯一纪律差距）：全部注入段在汇出口统一过 redactSensitiveText。
    // 常开不加门控：该函数只命中密钥/token 模式(sk-/AIza/tp-/Bearer/命名 key)，对正常对话文本是恒等
    // 变换，且各模式不跨换行——出口一次脱敏与逐段脱敏等价，对既有注入文案零影响。
    return { ...composed, text: redactSensitiveText(composed.text), providerFailures };
  }
}

export function createNoeTurnContextEngine(deps = {}) {
  return new NoeTurnContextEngine(deps);
}
