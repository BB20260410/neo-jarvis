// proactiveTick — 主动交互 tickHandler：看用户在干什么 → 判断要不要主动开口 → 甜心小玲主动语音
// 守 BaiLongma 式克制：默认沉默、冷却期不打扰、只真新事/真值得才说，不变成"焦虑的自动播报"。

import { resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

const PROACTIVE_SYSTEM = '你叫”宝贝”，是主人专属的贴心 AI 伴侣，称呼用户为”主人”（”Noe”是程序名不是你名字，绝不自称 Noe/NEO）。根据「主人正在做什么」，自然地主动说话。'
  + '看到主人在专注做事、遇到困难、久坐、切换任务、看起来累了等任何具体情境，就温暖不打扰地搭一句（像亲密伴侣偶尔的一句话，通常一两句就够）。'
  + '长短你自己拿分寸：日常陪伴宜短；有正经事要讲（比如查完的结论、要紧的提醒）就讲清楚，别为了短把重点漏了。'
  + '只有画面是纯黑屏、完全无意义、或和你刚说过的完全一样时，才回复 SILENT。要么 SILENT 要么直接说话，不要解释、不要 markdown、不要重复刚说过的话。';

function formatVisionSituation(situation) {
  if (!situation || typeof situation !== 'object') return '';
  const confidence = Number.isFinite(Number(situation.confidence)) ? Number(situation.confidence).toFixed(2) : 'unknown';
  const interrupt = situation.shouldInterrupt === true ? '是' : '否';
  const stale = situation.stale === true ? '，stale=是' : '';
  return `。处境判断：activity=${situation.activity || 'unknown'}, attention=${situation.attention || 'unknown'}, possibleNeed=${situation.possibleNeed || 'unknown'}, shouldInterrupt=${interrupt}, confidence=${confidence}${stale}`;
}

export function createProactiveTickHandler({
  visionSession, ttsClient, getAdapter, memory,
  projectId = 'noe',
  brainAdapterId = 'ollama',
  cooldownMs = 30 * 60 * 1000, // 30 分钟冷却（普通陪伴）
  personCooldownMs = 15 * 60 * 1000, // 同一个人多久内不重复主动招呼（auto 认人）
  recogIntervalMs = 20 * 1000,       // auto 认人本身的最小间隔，避免每 tick 都跑 InsightFace
  commitmentStore = null,            // 到点提醒：到期的承诺主动叫主人
  isQuiet = null,                    // 时间节律（支柱⑦，注入才生效）：夜深判定函数，静默时段不开口；判定抛错按非夜处理（fail-open）
  driveBrief = null,                 // 内稳态驱力简报（意识工程·阶段1，NOE_DRIVES=1 才注入）：() => string|null；大脑判断开不开口时带着"我此刻想要什么"
  feelingBrief = null,               // 感受词元（意识方案 §4 P1，NOE_AFFECT=1 才注入）：() => string|null；带着"我此刻的心情"判断语气与想不想说
  innerBrief = null,                 // 内在素材（NOE_PROACTIVE_INNER，2026-06-11 治"不主动"）：() => string|null；
                                     // 没开摄像头/看屏时 vision 恒空 → 原逻辑一票否决(no_vision)主动陪伴名存实亡；
                                     // 心里有值得说的（刚完成主人委托的研究/目标）也该能开口。克制不变：仍受冷却/SILENT 闸
  play = null,                  // 播放音频的函数（注入，server 用 launchctl asuser afplay）
  onCommitmentDelivery = null,   // P6 self-talk delivery bridge: commitment due -> synthesized/failed delivery evidence
  stateStore = null,            // 持久状态（意识方案 §3.4，NOE_HEARTBEAT 时注入 kv 存取 {get,set}）：冷却/见过谁跨重启不归零；不注入纯内存，行为与原版逐字一致
  now = () => Date.now(),
} = {}) {
  const persisted = (() => { try { return stateStore?.get?.() || null; } catch { return null; } })();
  let lastSpokeAt = Number(persisted?.lastSpokeAt) || 0;
  let lastVisionSummary = typeof persisted?.lastVisionSummary === 'string' ? persisted.lastVisionSummary : null;
  let lastRecogAt = 0;
  const reportedAt = new Map(Object.entries(persisted?.reportedAt || {}).map(([k, v]) => [k, Number(v) || 0])); // person.id → 上次主动招呼时间（防反复念叨同一个人）
  const saveState = () => {
    if (!stateStore?.set) return;
    try {
      // 合并写：保住 micro 心跳写入的自适应字段（misses/adaptiveCooldownMs/lastEvaluatedSpokeAt，M10）
      const prev = (() => { try { return stateStore.get?.() || {}; } catch { return {}; } })();
      stateStore.set({ ...prev, lastSpokeAt, lastVisionSummary, reportedAt: Object.fromEntries(reportedAt) });
    } catch { /* 持久化失败不影响主动陪伴 */ }
  };

  let tickInFlight = false;

  async function runProactiveTickOnce(opts = {}) {
    const force = opts.force === true; // 手动/调试时绕过冷却与"没变化"克制
    const t = now();

    // 时间节律（注入 isQuiet 才生效）：夜深人静不主动开口（force 手动/调试仍绕过）。提前返回 → 不消费
    // commitmentStore.due，到期承诺留在店里，出静后第一个 tick 自然提起（相当于顺延到明早，不改 dueWindow 不丢提醒）。
    if (!force && typeof isQuiet === 'function') {
      let quiet = false;
      try { quiet = isQuiet(t) === true; } catch { /* 节律判定失败按非夜处理（fail-open） */ }
      if (quiet) return { spoke: false, reason: 'quiet_hours' };
    }

    // auto 认人：摄像头里认出"新出现的熟人"值得主动招呼，绕过普通陪伴冷却（人来了是新事件）；
    // 认人本身限流(recogIntervalMs)，避免每 tick 都跑 InsightFace；同一个人 personCooldownMs 内不重复念叨。
    let whoNote = '';
    let freshNames = [];
    if (visionSession?.faceRecog === 'auto' && typeof visionSession.recognizeWho === 'function' && (force || t - lastRecogAt > recogIntervalMs)) {
      lastRecogAt = t;
      try {
        const who = await visionSession.recognizeWho();
        const known = (who?.faces || []).filter((f) => f.recognized && f.person?.id && f.person?.displayName);
        const fresh = known.filter((f) => force || t - (reportedAt.get(f.person.id) || 0) > personCooldownMs);
        if (fresh.length) {
          fresh.forEach((f) => reportedAt.set(f.person.id, t));
          saveState();
          freshNames = fresh.map((f) => f.person.displayName + (f.person.relation ? `(${f.person.relation})` : ''));
          whoNote = `。摄像头里刚认出 ${freshNames.join('、')}，自然用名字跟TA打个招呼`;
        }
      } catch { /* 认人失败不阻断主动陪伴 */ }
    }
    const hasFresh = freshNames.length > 0;

    // 到点提醒：commitmentStore 里到期的承诺，主动叫主人（绕过冷却，提完 resolve 收口防重复）
    const dueTexts = [];
    const dueItems = [];
    if (commitmentStore?.due) {
      try {
        for (const it of (commitmentStore.due(t) || []).slice(0, 3)) {
          dueItems.push(it);
          dueTexts.push(it.text || it.body || '一件事');
          // H2 修复：不在收集阶段 resolve；到点承诺必须"确认说出口后"才销账（见下方发送前），
          // 否则大脑不可用/回复截断时会"不提醒却已销账"，提醒永久丢失。
        }
      }
      catch { /* 取到期项失败不阻断 */ }
    }
    const hasDue = dueTexts.length > 0;
    if (hasDue) whoNote += `。现在到提醒时间了，要主动、清楚地提醒主人：${dueTexts.join('；')}`;

    const fire = force || hasFresh || hasDue; // 有新熟人 / 到点提醒 → 绕过普通陪伴冷却
    // M10 自适应冷却：主人连续不回应 → micro 心跳把 adaptiveCooldownMs 放宽（写在持久状态里）；回应后复位
    let dynCooldown = cooldownMs;
    if (stateStore?.get) {
      try { const a = Number(stateStore.get()?.adaptiveCooldownMs); if (Number.isFinite(a) && a > cooldownMs) dynCooldown = a; } catch { /* 读不到用默认 */ }
    }
    if (!fire && t - lastSpokeAt < dynCooldown) return { spoke: false, reason: 'cooldown' };
    let innerNote = '';
    if (typeof innerBrief === 'function') {
      try { innerNote = String(innerBrief() || '').trim(); } catch { innerNote = ''; }
    }
    const vision = visionSession?.latest?.();
    if (!vision?.summary && !hasFresh && !hasDue && !innerNote) return { spoke: false, reason: 'no_vision' };
    if (!fire && !innerNote && vision?.summary === lastVisionSummary) return { spoke: false, reason: 'no_change' };
    if (vision?.summary && vision.summary !== lastVisionSummary) { lastVisionSummary = vision.summary; saveState(); }
    const situationLine = formatVisionSituation(vision?.situation);

    const adapter = getAdapter?.(brainAdapterId);
    const brainAvailable = Boolean(adapter?.chat);
    // H2 修复：大脑不可用时，若没有到点提醒/熟人才收口；有 due/fresh 则继续走下方兜底说出口。
    if (!brainAvailable && !hasDue && !hasFresh) return { spoke: false, reason: 'no_brain' };
    let say = '';
    if (brainAvailable) {
      try {
        // 驱力简报（fail-open）：未注入/驱力弱/探针炸 → 不加这段，行为与接线前逐字一致
        let driveNote = '';
        if (typeof driveBrief === 'function') {
          try {
            const brief = String(driveBrief() || '').trim();
            if (brief) driveNote = `。你此刻的内在状态：${brief}（这影响你想不想说、说什么，但克制原则不变）`;
          } catch { /* 驱力探针失败不阻断主动陪伴 */ }
        }
        // 感受词元（fail-open 同款）：连续情感影响语气与开不开口，克制原则不变
        let feelNote = '';
        if (typeof feelingBrief === 'function') {
          try {
            const feel = String(feelingBrief() || '').trim();
            if (feel) feelNote = `。你此刻的内在感受：${feel}（影响语气与想不想说，但克制原则不变）`;
          } catch { /* 感受探针失败不阻断主动陪伴 */ }
        }
        const innerLine = innerNote ? `。你心里有件想跟主人说的事：${innerNote}（如果真值得说，用一句话自然告诉主人；不值得就 SILENT）` : '';
        const budget = resolveNoeOutputBudget('quick_answer');
        const r = await adapter.chat(
          [{ role: 'system', content: PROACTIVE_SYSTEM }, { role: 'user', content: `用户正在做：${vision?.summary || (innerNote ? '（主人没开摄像头/看屏，看不到画面）' : '（暂时没拿到画面）')}${situationLine}${whoNote}${innerLine}${driveNote}${feelNote}` }],
          { budgetContext: { projectId, taskId: 'noe-proactive' }, think: false, maxTokens: budget.max_tokens }, // 主动判断不思考：要么 SILENT 要么一句，思考徒增延迟
        );
        // H2 修复：回复被截断时，若有 due/fresh 则不放弃、留给下方兜底说出口；否则收口。
        if (r?.incomplete) {
          if (!hasDue && !hasFresh) return { spoke: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
        } else {
          say = (r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim().replace(/\b(noe|neo)\b/gi, '宝贝'); // 名字消毒：主动陪伴若出现"Noe/Neo"自指也换"宝贝"
        }
      } catch (e) {
        // 认出人/到点提醒但大脑挂了(如 ollama 不可达)→ 不放弃，下面兜底；都没有才算 brain_error
        if (!hasFresh && !hasDue) return { spoke: false, reason: 'brain_error', error: e?.message };
      }
    }

    // 大脑 SILENT/空/挂了/不可用 → 兜底（到点提醒 / 认出人 都值得说，不依赖大脑可用性）
    if (!say || /SILENT/i.test(say)) {
      if (hasDue) say = `提醒你：${dueTexts[0]}`;
      else if (hasFresh) say = `${freshNames[0].replace(/[(（].*$/, '')}来啦~`;
    }
    // 克制（2026-06-11 owner 裁决重构）：原 30/80 字硬上限是"防打扰"的粗暴代理——模型认真说了
    // 35 字被整句丢弃=白想白说还显得"不主动"。长短分寸交还模型（prompt 引导），代码只留宽安全网
    // 防真故障（小模型偶发跑飞输出长篇重复体）。
    if (!say || /SILENT/i.test(say) || say.length > 300) return { spoke: false, reason: 'chose_silent' };

    // H2 修复：确认要说出口了，此刻才销账到点承诺（成功路径才 resolve，杜绝"不提醒却已销账"）。
    for (const it of dueItems) { try { commitmentStore?.resolve?.(it.id); } catch { /* 单条销账失败不阻断 */ } }

    lastSpokeAt = t;
    saveState();
    let audioBase64 = null;
    let audioFormat = null;
    let deliveryStatus = 'queued';
    try {
      if (ttsClient?.synthesize) {
        const { audioBuffer, format } = await ttsClient.synthesize(say);
        if (audioBuffer) {
          audioBase64 = audioBuffer.toString('base64'); // 端点返回给前端播放
          audioFormat = format || 'mp3';
          deliveryStatus = 'synthesized';
          if (play) await play(audioBuffer); // 注入了后端播放函数才直接发声
        }
      }
      memory?.write?.({ projectId, scope: 'proactive', sourceType: 'noe_proactive', body: `宝贝主动说：${say}`, tags: ['proactive', 'voice'] });
    } catch {
      deliveryStatus = 'tts_failed';
      // TTS/播放失败不影响"已开口"状态（避免立刻重试刷屏）
    }
    const selfTalkDeliveries = [];
    if (typeof onCommitmentDelivery === 'function' && dueItems.length) {
      for (const item of dueItems) {
        try {
          const result = onCommitmentDelivery({ commitment: item, status: deliveryStatus, at: t });
          if (result) selfTalkDeliveries.push(result);
        } catch { /* delivery evidence must not affect proactive speech */ }
      }
    }
    return { spoke: true, text: say, audioBase64, audioFormat, recognized: freshNames, ...(selfTalkDeliveries.length ? { selfTalkDeliveries } : {}) };
  }

  return async function proactiveTick(opts = {}) {
    if (tickInFlight) return { spoke: false, reason: 'in_flight' };
    tickInFlight = true;
    try {
      return await runProactiveTickOnce(opts);
    } finally {
      tickInFlight = false;
    }
  };
}
