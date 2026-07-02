// @ts-check
// NoeExpectationHarvester — 期望抽取强化（长期规划 M2：期望账本通血）。
//
// 自审实证：确定性正则（时间词+情态词）对生产的诗意念头**零命中**（账本 0 条）——
// 预测-误差回路没有燃料，"被现实纠正"的反思闭环死火。
// 强化 = 两级：①确定性正则保底（零成本，命中即收）②未命中时一次 Main Brain 小判断
// （Qwen 主脑，think:false），JSON 输出可检验预测。fail-open：LLM 炸了/答非所问
// 一律静默放弃，绝不阻断反刍；零付费配额。

import { resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import { clamp } from './_mathUtils.js';

const HARVEST_SYSTEM = '判断给你的这句话里有没有「对未来几天内可检验的预测」（关于会发生什么/谁会做什么）。'
  + '有就只输出 JSON：{"claim":"预测内容一句话","p":0.6,"days":2}（p=主观概率 0.05-0.95，days=几天内可验证 1-14）。'
  + '没有就只输出 {"none":true}。不要解释、不要 markdown。';

export function createExpectationHarvester({
  ledger,
  getAdapter,
  brainAdapterId = 'lmstudio',
  model = '',
  now = Date.now,
} = {}) {
  if (!ledger?.harvestFromText || !ledger?.add) throw new Error('createExpectationHarvester: ledger required');

  /**
   * 从一段文本收预测：确定性优先，LLM 兜底。
   * @returns {Promise<{added: number, via: string}>}
   */
  async function harvest(text, { source = 'thought' } = {}) {
    const t = String(text || '').trim();
    if (!t || t.length < 8) return { added: 0, via: 'skip' };
    let det = 0;
    try { det = ledger.harvestFromText(t, { source }); } catch { det = 0; }
    if (det > 0) return { added: det, via: 'deterministic' };

    const adapter = getAdapter?.(brainAdapterId);
    if (!adapter?.chat) return { added: 0, via: 'no_brain' };
    try {
      const budget = resolveNoeOutputBudget('fact_extract');
      const r = await adapter.chat(
        [{ role: 'system', content: HARVEST_SYSTEM }, { role: 'user', content: t.slice(0, 400) }],
        // 不设超时（跑模型纪律）；本地小脑判断不思考（要么 JSON 要么没有）
        { budgetContext: { projectId: 'noe', taskId: 'noe-expectation-harvest' }, think: false, temperature: 0, top_p: 1, maxTokens: budget.max_tokens, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) return { added: 0, via: 'llm_incomplete', finishReason: r.finishReason || 'length' };
      const raw = String(r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '');
      const m = raw.match(/\{[\s\S]*?\}/);
      if (!m) return { added: 0, via: 'llm_no_json' };
      const j = JSON.parse(m[0]);
      if (j.none === true || !j.claim) return { added: 0, via: 'llm_none' };
      const days = clamp(Math.round(Number(j.days) || 2), 1, 14);
      const id = ledger.add({
        claim: String(j.claim).slice(0, 200),
        p: clamp(Number(j.p) || 0.6, 0.05, 0.95),
        dueAt: now() + days * 86_400_000,
        source,
      });
      return { added: id != null ? 1 : 0, via: 'llm' };
    } catch { return { added: 0, via: 'llm_error' }; }
  }

  return { harvest };
}
