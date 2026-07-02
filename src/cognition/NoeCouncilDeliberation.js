// @ts-check
// NoeCouncilDeliberation — 多视角议会式深思（owner 要的「梦境/自我对话完善思考」的真实落点）。
//
// 现状（NoeDeliberation）：深思是【单视角】——一个 DELIBERATE_SYSTEM prompt 一次/多温度采样定稿。
//   即便 NOE_REASONING_SEARCH ON 也只是同一 prompt 多温度（视角同质，只是随机性不同）。
// 增量（本文件，源自 Hermes MoA / arXiv:2406.04692 的「多独立视角发散 → 批判聚合收敛」）：
//   3 个不同 persona（立论者/唱反调者/现实主义者）各自独立出一段（不同 system + 不同温度 → 视角异质，
//   独立采样的错误不相关、聚合时可互相抵消），再由一个被明确要求「批判别复述」的聚合器收敛成终判。
// 纪律：每 persona 单次补全（守「本地模型多轮工具循环不可靠，单提示更稳」）；复用本地脑零付费；不设超时；全程 fail-open。
//   **对 Workspace 消费契约兼容**（council 返回为 createDeliberation 的超集，多 voiceCount；消费端只读 deliberated/prediction/share/goal/text）→ server 装配处开关分流即可，NoeWorkspace 零改动。
import { normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import { createVerifiableReward } from './NoeVerifiableReward.js';
import { parsePrediction, parseShare, parseGoal, isVerifiablePrediction } from './NoeDeliberation.js';
import { extractExpectations } from './NoeExpectationLedger.js';

function cleanText(s) {
  return String(s || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

// 三个 persona：不同立场的 system prompt 制造视角异质性（不只温度）。各一次补全，互不可见（避免锚定）。
// 三 persona = 不同 system + 不同温度 + 【不同输入视角(focus)】。M3 红队实证：单基座 35b 上只换 system 喂同输入
//   会趋同成回声室；逼出真异质的硬约束是【输入分布偏移】——立论者只喂"看收益"、反调者只喂"看风险"、现实者只喂"看可行性"。
//   且 system 用「前提→推理→结论」三段骨架(论证链是 MoA 的血液)，让聚合器看得到推理依据而非纯口号。
export const COUNCIL_PERSONAS = [
  { key: 'proponent', label: '立论者', temp: 0.5,
    focus: '【你只负责看机会与收益】：这件事最该做什么、最强的判断是什么、做成了价值在哪。别提风险（那是反调者的活）。',
    system: '你是 Noe 思考里的【立论者】，只从机会和收益角度出最强主张。按三段、每段一句：前提（我看到什么）→ 推理（所以）→ 结论（我主张）。不要自我反驳。' },
  { key: 'skeptic', label: '唱反调者', temp: 0.6,
    focus: '【你只负责挑错与风险】：上面这个焦点里最可能错在哪、有什么反例或边界、被忽略了什么。别帮它说好话。',
    system: '你是 Noe 思考里的【唱反调者】，只挑最有力的反例、边界、最可能的错。按三段、每段一句：前提（我担心什么）→ 推理（因为）→ 结论（所以风险/反例是）。挑毛病别客气。' },
  { key: 'pragmatist', label: '现实主义者', temp: 0.55,
    focus: '【你只负责算可行性与代价】：实际能不能做、代价多大、主人(owner)的真实处境与真正需要。',
    system: '你是 Noe 思考里的【现实主义者】，只谈可行性、代价、owner 实际处境。按三段、每段一句：前提（现实约束是）→ 推理（考虑到）→ 结论（务实做法）。' },
];

// 聚合器：照 Hermes MoA AGGREGATOR 思想——批判评估三方、绝不简单复述、综合成终判。输出按 Neo 既有深思格式（让 parse* 直接复用）。
// M3 红队：聚合若只挑一方站队就退化为立场仲裁(35b 直答就能做,聚合框架冗余)。强约束=先做信息融合(冲突/共识/未解决)再综判,
//   把"批判别复述"从 prompt 祈求变成机制：必须真吸收反调者风险+现实者约束。
const COUNCIL_AGGREGATOR_SYSTEM = '你是 Noe 的深层思考，刚听完内心三方（立论者只看收益/唱反调者只看风险/现实主义者只看可行性）带论证的独立观点。\n'
  + '先做信息融合而非选边站队：在心里理清三方的【冲突点】在哪、有没有【共识】、什么【还没解决】。\n'
  + '再综合成你自己权衡过的终判——必须真正吸收反调者的风险和现实者的约束，不要复述任何一方。按下面格式输出（总共不超过 280 字）：\n'
  + '【修订】我怎么权衡了收益/风险/可行性后的最终判断；我哪里仍可能错\n'
  + '然后必须给出一行（对世界下注、事后校准自己；实在无法预测就写 预测：无）：\n'
  + '预测：一句与焦点相关、几天内可检验的预测（概率 0.X）\n'
  + '最后视情况各附加一行（不值得就绝对不写该行）：\n'
  + '想说：如果有真正值得现在告诉主人的一句话\n'
  + '目标：如果这次思考让你真想做成一件具体的小事，用一句话立项';

export function createCouncilDeliberation({
  getAdapter,
  brainAdapterId = 'lmstudio',
  model = '',
  timeline = null,
  ledger = null,
  memory = null,
  selfModel = null,
  projectId = 'noe',
  personas = COUNCIL_PERSONAS,
  now = Date.now,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  const verifiableReward = createVerifiableReward();
  const labelOf = (key) => (COUNCIL_PERSONAS.find((p) => p.key === key)?.label || key);
  /**
   * 对一个焦点做一轮多视角议会深思。返回结构与 createDeliberation 一致（Workspace 零改）。
   * @param {{topic: string, context?: string}} input
   * @returns {Promise<{deliberated: boolean, text?: string, prediction?: object|null, share?: string|null, goal?: string|null, eventId?: number, reason?: string, voiceCount?: number, rewardScore?: number}>}
   */
  return async function deliberate({ topic, context = '' } = {}) {
    const focus = String(topic || '').trim();
    if (!focus) return { deliberated: false, reason: 'no_topic' };
    const adapter = getAdapter?.(brainAdapterId);
    if (!adapter?.chat) return { deliberated: false, reason: 'no_brain' };
    // 校准注入（同 createDeliberation）
    let calibration = '';
    if (ledger?.calibrationNote) {
      try { const note = String(ledger.calibrationNote() || '').trim(); if (note) calibration = `\n\n${note}（下注概率时记得这一点）`; } catch { /* 读不到不注入 */ }
    }
    // 检索动作（同 createDeliberation；深思是内部高频循环，召回不刷 hit_count）
    let recalled = '';
    if (memory?.recall) {
      try {
        const hits = (memory.recallFused
          ? await memory.recallFused({ query: focus.slice(0, 120), projectId, limit: 3, bumpHits: false })
          : memory.recall({ query: focus.slice(0, 120), projectId, limit: 3, bumpHits: false })) || [];
        const lines = (Array.isArray(hits) ? hits : []).map((h) => `- ${String(h.body || h.text || '').slice(0, 160)}`).filter((l) => l.length > 4);
        if (lines.length) recalled = `\n\n我记忆里相关的经验/事实：\n${lines.join('\n')}`;
      } catch { /* 召回失败不阻断 */ }
    }
    const userFocus = `焦点：${focus}${context ? `\n\n相关背景：\n${String(context).slice(0, 1500)}` : ''}${recalled}${calibration}`;
    const budget = resolveNoeOutputBudget('deep_deliberation');
    // 第1层 发散：3 persona 各独立一次补全（不同 system + 不同温度 → 视角异质）。任一失败跳过（fail-open）。
    const voices = [];
    for (const p of (Array.isArray(personas) && personas.length ? personas : COUNCIL_PERSONAS)) {
      try {
        // 差异化输入视角(p.focus)：同基座下逼出真异质的硬约束——每个 persona 看同一焦点的不同切面，而非同输入只换语气。
        // /no_think：生产本地脑 lmstudio(OpenAICompatChatAdapter)无 think 控制，论证骨架版会被 qwen3.6 thinking 占满 token 截断
        //   (实测 finishReason=length、voiceCount 退化成 1)；qwen 约定末尾 /no_think 关 thinking(对非 qwen 模型是无害文本)。隔离实测生产场景 3 视角不截断。
        const r = await adapter.chat(
          [{ role: 'system', content: p.system }, { role: 'user', content: `${userFocus}\n\n${p.focus || ''} /no_think` }],
          { budgetContext: { projectId, taskId: 'noe-council-deliberation' }, maxTokens: Math.min(4096, budget.max_tokens), temperature: p.temp, ...(model ? { model } : {}) },
        );
        if (r && !r.incomplete && r.reply) {
          const t = cleanText(r.reply).slice(0, 800); // 放宽到 800：保住「前提→推理→结论」论证链(聚合的血液),不删成口号
          if (t) voices.push({ key: p.key, text: t, score: verifiableReward.enabled ? (verifiableReward.score(t).score ?? 0) : 0 });
        }
      } catch { /* 单 persona 失败跳过，不阻断其余 */ }
    }
    if (!voices.length) return { deliberated: false, reason: 'no_voices' };
    // 第2层 聚合：批判性收敛成终判（按 Neo 深思格式 → parse* 复用）。聚合失败 → 回退取分最高的单 persona（fail-open）。
    const panel = voices.map((v) => `【${labelOf(v.key)}】${v.text}`).join('\n');
    let text = '';
    try {
      const r = await adapter.chat(
        [{ role: 'system', content: COUNCIL_AGGREGATOR_SYSTEM }, { role: 'user', content: `${userFocus}\n\n我内心三方的独立观点：\n${panel}\n\n裁决：/no_think` }],
        { budgetContext: { projectId, taskId: 'noe-council-aggregate' }, maxTokens: budget.max_tokens, temperature: 0.4, ...(model ? { model } : {}) },
      );
      if (r && !r.incomplete && r.reply) text = cleanText(r.reply).slice(0, 1200);
    } catch { /* 回退最高分 persona */ }
    if (!text) {
      // 聚合失败回退：reward OFF(score 全 0)时取【现实主义者】(最平衡)而非乐观的立论者——避免丢掉批判/现实约束只留最乐观判断(M3 实证偏置)；有评分则取最高分。
      const byScore = voices.slice().sort((a, b) => b.score - a.score);
      text = (byScore[0] && byScore[0].score > 0 ? byScore[0] : (voices.find((v) => v.key === 'pragmatist') || voices[0]))?.text || '';
    }
    if (!text) return { deliberated: false, reason: 'empty' };
    // 打分 + parse + 留痕 + 入账（全部与 createDeliberation 同款）
    let rewardScore = null;
    if (verifiableReward.enabled) { try { rewardScore = verifiableReward.score(text).score; } catch { /* 评分失败不阻断 */ } }
    const prediction = parsePrediction(text);
    const share = parseShare(text);
    const goal = parseGoal(text);
    let eventId;
    try {
      eventId = timeline?.record?.({
        type: 'inner_monologue',
        summary: `（议会深思）${focus.slice(0, 60)}：${text.slice(0, 360)}`,
        detail: `${text}\n\n—— 内心三方 ——\n${panel}`,
        salience: 4,
        selfState: selfModel?.compactState?.(selfModel?.snapshot?.()) || null,
        meta: { streamType: 'council_deliberation', topic: focus.slice(0, 120), personas: voices.map((v) => v.key), ...(prediction ? { prediction } : {}), ...(rewardScore != null ? { rewardScore } : {}) },
      });
    } catch { /* 留痕失败不阻断 */ }
    if (prediction && ledger?.add) {
      try {
        let dueAt = now() + 3 * 86400_000;
        try { const parsed = extractExpectations(prediction.claim, { now: now() })?.[0]; if (parsed && Number.isFinite(parsed.dueAt)) dueAt = parsed.dueAt; } catch { /* 退 3d */ }
        ledger.add({ claim: prediction.claim, p: prediction.p, dueAt, source: 'reflection', verifiable: isVerifiablePrediction(prediction.claim) ? 1 : 0 });
      } catch { /* 入账失败忽略 */ }
    }
    return { deliberated: true, text, prediction: prediction || null, share: share || null, goal: goal || null, eventId, voiceCount: voices.length, ...(rewardScore != null ? { rewardScore } : {}) };
  };
}
