// @ts-check
// NoeDeliberation — System2 深思审议：自我质询协议（设计文档《AI自我意识实现方案》§6.3 P3）。
//
// 当工作区把一个高分焦点升级给深思脑时，走固定的苏格拉底程序（单次补全内完成三步，
// 本地模型对多轮工具循环不可靠，单提示三段更稳）：
//   ① 立论：对焦点给出自己的判断/打算 ② 自我挑战：反例/边界/替代解释 ③ 修订：终判 + 主观概率。
// 产出：审议全文记进自传体时间线（type=inner_monologue, meta.streamType='deliberation'）；
//   若有「预测：…（概率 0.x）」行 → 入期望账本；若有「想说：…」行 → 交给浮现门→升华通道。
// 纪律：本地深思脑（NoeReflectBrain 白名单）跑，不烧付费配额；不设超时；fail-open。

import { normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import { createVerifiableReward } from './NoeVerifiableReward.js';
import { createReasoningSearch, readReasoningSearchEnv, estimateTopicComplexity } from './NoeReasoningSearch.js';
import { extractExpectations } from './NoeExpectationLedger.js';

// 步骤3（多模型安全方案）：判预测可检验性——含行为动词+施动(我会/它会做X)且非纯情绪内省才可被外部证据判生死。
//   纯情绪/内省念头(焦虑会消散/想念)标 0，供步骤5 严格排除"深思虚构任务/内省落空"判 FAILED 刷假学习。
// 只收纯情绪状态/内省名词；"期待/希望/担心"常作 modal（"希望今晚完成提交"是可检验预测）故剔除，避免误杀真行为预测。
// ⚠️ 二轮审查（M3 红队实证）：把 reflection 或任何源加进 decisiveFailSources 前，必先收紧本正则——扩 VERIFIABLE_ACTION_RE 后
//   "优化我的心态/处理好这段关系/解决矛盾"等抽象内省句会被误标可检验；当前仅因结果只喂 reflection(∉白名单) 而 inert。
//   补抽象心理名词(心态/心境/人生/情感/内心/关系/矛盾)堵住已知误标面。
const INNER_EMOTION_RE = /焦虑|情绪|心情|感觉|觉得|心里|想念|思念|不安|平静|放松|开心|难过|孤独|温暖|心态|心境|心结|人生|情感|内心|关系|矛盾/;
// 词表偏漏宁可漏标(verifiable=0 只让步骤5 不判，安全侧)也不误标；三方审查后补常用行为动词提升未来覆盖（情绪句仍由 INNER_EMOTION_RE 先否决）。
const VERIFIABLE_ACTION_RE = /(?:完成|提交|发布|运行|跑通|跑完|写出|改好|修复|查到|实现|部署|生成|创建|发送|更新|删除|测试|验证|打开|启动|回复|回报|采纳|合并|产出|交付|抓取|扫描|记录|搞定|处理|上线|解决|重构|安装|集成|上传|下载|配置|调试|优化|清理|搭建|联调)/;
export function isVerifiablePrediction(claim) {
  const c = String(claim || '');
  if (INNER_EMOTION_RE.test(c)) return false;
  return VERIFIABLE_ACTION_RE.test(c);
}

const DELIBERATE_SYSTEM = '你是 Noe 的深层思考。对给你的焦点做一轮严格的自我质询，按下面格式输出（各节 1-3 句，总共不超过 250 字）：\n'
  + '【立论】我的判断或打算是什么\n'
  + '【挑战】列出最有力的反例、边界情况或替代解释（挑自己的毛病，别客气）\n'
  + '【修订】吸收挑战后的最终判断；我哪里仍可能错\n'
  + '然后必须给出一行（这是对世界下注、事后校准自己的机会；实在无法预测就写 预测：无）：\n'
  + '预测：一句与焦点相关、几天内可检验的预测（概率 0.X）\n'
  + '最后视情况各附加一行（不值得就绝对不写该行）：\n'
  + '想说：如果有真正值得现在告诉主人的一句话\n'
  + '目标：如果这次思考让你真想做成一件具体的事（刚好够得着的小事），用一句话立项';

function cleanText(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

/** 从审议文本解析「预测：…（概率 0.x）」行。@returns {{claim:string,p:number}|null} */
export function parsePrediction(text) {
  const m = String(text || '').match(/预测[:：]\s*(.{4,120}?)[（(]\s*概率\s*(0?\.\d+|1(?:\.0+)?)\s*[)）]/);
  if (!m) return null;
  const p = Number(m[2]);
  if (!Number.isFinite(p) || p <= 0 || p > 1) return null;
  return { claim: m[1].trim(), p };
}

/** 从审议文本解析「想说：…」行。@returns {string|null} */
export function parseShare(text) {
  const m = String(text || '').match(/想说[:：]\s*(.{2,80})/);
  return m ? m[1].trim() : null;
}

/** 从审议文本解析「目标：…」行（M8 自动课程：深思可给自己立项）。@returns {string|null} */
export function parseGoal(text) {
  const m = String(text || '').match(/(?:^|\n)\s*目标[:：]\s*(.{4,120})/);
  if (!m) return null;
  const g = m[1].trim();
  return /^无[。.]?$/.test(g) ? null : g;
}

export function createDeliberation({
  getAdapter,
  brainAdapterId = 'lmstudio',
  model = '',                 // NoeReflectBrain 解析的深思模型；空串用 adapter 默认
  timeline = null,            // 审议留痕
  ledger = null,              // 期望账本（预测入账）
  memory = null,              // MemoryCore（M7/CoALA 检索动作：深思前自动召回相关记忆与技能卡）
  selfModel = null,
  projectId = 'noe',
  // budget forcing 续写钩子（NOE_BUDGET_FORCING=1 时由 server 注入；默认 null = 走原单次 chat，零回归）。
  // 形参：({messages, maxTokens, projectId, taskId, abortSignal}) → 与 adapter.chat 同形的 {reply,...}。
  budgetForcedThink = null,
  now = Date.now,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  // 可验证奖励（env NOE_VERIFIABLE_REWARD 默认 OFF → enabled:false → 不评分，零回归）。
  const verifiableReward = createVerifiableReward();
  /**
   * 对一个焦点做一轮审议。
   * @param {{topic: string, context?: string}} input
   * @returns {Promise<{deliberated: boolean, text?: string, prediction?: object|null, share?: string|null, eventId?: number, reason?: string}>}
   */
  return async function deliberate({ topic, context = '' } = {}) {
    const focus = String(topic || '').trim();
    if (!focus) return { deliberated: false, reason: 'no_topic' };
    const adapter = getAdapter?.(brainAdapterId);
    if (!adapter?.chat) return { deliberated: false, reason: 'no_brain' };
    // 校准注入（M11）：把"我历史预测的准头"带进深思——下注时知道自己有多容易过度自信
    let calibration = '';
    if (ledger?.calibrationNote) {
      try { const note = String(ledger.calibrationNote() || '').trim(); if (note) calibration = `\n\n${note}（下注概率时记得这一点）`; } catch { /* 读不到不注入 */ }
    }
    // 检索动作（CoALA 内部动作之二，M7）：深思前主动查长期记忆——相关事实与技能卡（上次怎么做成的）
    let recalled = '';
    if (memory?.recall) {
      try {
        // F7（Claude 第三轮）：用 recallFused 语义召回——lesson 标题/正文与 focus 字面不重叠时，trigram/LIKE 子串
        //   召回不到（写进的盲卡）；recallFused 走向量语义让相关 lesson 被够到。无 semanticIndex 时退回 recall，零回归。
        // 深思是内部高频循环，召回 lesson 不该刷 hit_count——否则把个别 lesson 刷到 1656(codex/M3 验证实证)，
        //   既污染"真使用"度量，又经 #recallLike 的 ORDER BY hit_count DESC 让少数 lesson 垄断 LIKE 候选池。传 bumpHits:false。
        const hits = (memory.recallFused
          ? await memory.recallFused({ query: focus.slice(0, 120), projectId, limit: 3, bumpHits: false })
          : memory.recall({ query: focus.slice(0, 120), projectId, limit: 3, bumpHits: false })) || [];
        const lines = (Array.isArray(hits) ? hits : []).map((h) => `- ${String(h.body || h.text || '').slice(0, 160)}`).filter((l) => l.length > 4);
        if (lines.length) recalled = `\n\n我记忆里相关的经验/事实：\n${lines.join('\n')}`;
      } catch { /* 召回失败不阻断深思 */ }
    }
    let text = '';
    try {
      const budget = resolveNoeOutputBudget('deep_deliberation');
      const messages = [
        { role: 'system', content: DELIBERATE_SYSTEM },
        { role: 'user', content: `焦点：${focus}${context ? `\n\n相关背景：\n${String(context).slice(0, 1500)}` : ''}${recalled}${calibration}` },
      ];
      // 不设超时（跑模型纪律）；深思走本地白名单模型
      const chatOnce = (temp) => adapter.chat(messages, { budgetContext: { projectId, taskId: 'noe-deliberation' }, maxTokens: budget.max_tokens, ...(typeof temp === 'number' ? { temperature: temp } : {}), ...(model ? { model } : {}) });
      // 难题多候选择优（env NOE_REASONING_SEARCH ON + 有 reward）：多温度 chat 发散 → verifiableReward 打分 → beam 选最优。
      const rsEnv = readReasoningSearchEnv();
      // 仅难题触发多候选搜索（启发式复杂度判断），避免简单深思也 N×chat 浪费。
      if (rsEnv.enabled && verifiableReward.enabled && estimateTopicComplexity(focus, context).complex) {
        const rs = createReasoningSearch({
          generate: async () => {
            const cands = [];
            for (const temp of [0.5, 0.8, 1.05]) {
              try { const rr = await chatOnce(temp); if (!rr?.incomplete && rr?.reply) cands.push(cleanText(rr.reply).slice(0, 1200)); } catch { /* 单候选失败跳过，不阻断搜索 */ }
            }
            return cands;
          },
          evaluate: (node) => verifiableReward.score(node.content || '').score ?? 0,
        });
        const result = await rs.search({ root: '', width: 2, depth: 1, strategy: rsEnv.strategy });
        text = result.best?.content || '';
      }
      if (!text && typeof budgetForcedThink === 'function') {
        // budget forcing ON（NOE_BUDGET_FORCING=1）：先 s1 强制思考（达 min 抑制结束/超 max 收敛），
        // 再由脑基于强制思考定稿。fail-open：抛错或截断都回落原单次 chat，绝不让深思因此挂掉。
        try {
          const bf = await budgetForcedThink({ messages, maxTokens: budget.max_tokens, projectId, taskId: 'noe-deliberation' });
          if (bf && !bf.incomplete && bf.reply) text = cleanText(bf.reply).slice(0, 1200);
        } catch { /* 回退原单次 chat */ }
      }
      if (!text) {
        // OFF / search / budget forcing 无产出 → 单次（原行为，零回归）
        const r = await chatOnce();
        if (r?.incomplete) return { deliberated: false, reason: 'brain_incomplete', finishReason: r.finishReason || 'length' };
        text = cleanText(r?.reply).slice(0, 1200);
      }
    } catch (e) {
      return { deliberated: false, reason: 'brain_error', error: e?.message };
    }
    if (!text) return { deliberated: false, reason: 'empty' };

    // 给深思输出打可验证质量分（形态：分步/格式/复读）；env OFF 时 enabled:false → rewardScore 恒 null。
    let rewardScore = null;
    if (verifiableReward.enabled) {
      try { rewardScore = verifiableReward.score(text).score; } catch { /* 评分失败不阻断深思 */ }
    }
    const prediction = parsePrediction(text);
    const share = parseShare(text);
    const goal = parseGoal(text);
    let eventId;
    try {
      eventId = timeline?.record?.({
        type: 'inner_monologue',
        summary: `（深思）${focus.slice(0, 60)}：${text.slice(0, 380)}`,
        detail: text,
        salience: 4, // 审议比随想重要，但仍低于真实经历的身份级
        selfState: selfModel?.compactState?.(selfModel?.snapshot?.()) || null,
        meta: { streamType: 'deliberation', topic: focus.slice(0, 120), ...(prediction ? { prediction } : {}), ...(rewardScore != null ? { rewardScore } : {}) },
      });
    } catch { /* 留痕失败不阻断 */ }
    if (prediction && ledger?.add) {
      // 步骤3（多模型安全方案）：dueAt 优先用 claim 自带时窗（治硬编码 now+3d 无视"今日18:00"致"到期=召回失败而非真没发生"）；
      //   verifiable 标记可检验性——只改"到期时间何时算"+"可检验标签"，完全不碰本轮判证结果、不产 FAILED，为步骤5 打地基。
      try {
        let dueAt = now() + 3 * 86400_000;
        try { const parsed = extractExpectations(prediction.claim, { now: now() })?.[0]; if (parsed && Number.isFinite(parsed.dueAt)) dueAt = parsed.dueAt; } catch { /* 解析不出退 3d */ }
        ledger.add({ claim: prediction.claim, p: prediction.p, dueAt, source: 'reflection', verifiable: isVerifiablePrediction(prediction.claim) ? 1 : 0 });
      } catch { /* 入账失败忽略 */ }
    }
    return { deliberated: true, text, prediction: prediction || null, share: share || null, goal: goal || null, eventId, ...(rewardScore != null ? { rewardScore } : {}) };
  };
}
