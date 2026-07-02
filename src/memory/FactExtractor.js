// FactExtractor — 从对话提炼「值得长期记住的事实」沉淀进记忆（mem0 思路），本地 LLM 零成本零外发。
// 自动事实抽取属于后台认知路径：默认跟随主脑 Qwen 35B A3B 6bit。
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';

const OLLAMA_URL = process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434';
const FACT_MODEL = normalizeNoeAutoModel(process.env.NOE_FACT_MODEL || NOE_MAIN_BRAIN_MODEL);

const EXTRACT_PROMPT = `从下面对话提炼「用户值得长期记住的事实」（偏好/计划/身份/长期状态/重要决定）。
严格规则：
1. 只提炼这段对话里【明确说出】的信息，必须逐字有据
2. 绝对禁止推断、联想、补充对话中没有的任何内容
3. 每条一行，简洁第三人称陈述
4. 闲聊、一次性指令、临时情绪状态不要
5. 没有值得长期记的，只回一个词 NONE
对话：
{conv}
只输出提炼结果：`;

export class FactExtractor {
  /**
   * @param {{complete?: (prompt: string) => string | Promise<string>, baseUrl?: string, model?: string, timeoutMs?: number}} [opts]
   */
  constructor({ complete, baseUrl = OLLAMA_URL, model = FACT_MODEL, timeoutMs = 90000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = normalizeNoeAutoModel(model);
    this.timeoutMs = timeoutMs;
    // complete(prompt) → text；默认走本地 ollama，单测可注入 mock
    this.complete = complete || ((prompt) => this._ollamaComplete(prompt));
  }

  async _ollamaComplete(prompt) {
    const ctrl = new AbortController();
    const budget = resolveNoeOutputBudget('fact_extract');
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt, stream: false, think: false, options: { temperature: 0, num_predict: budget.max_tokens } }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await resp.json().catch(() => ({}));
      return (data.response || '').trim();
    } catch { clearTimeout(t); return ''; }
  }

  /**
   * 从一段对话提炼值得长期记住的事实。
   * @param {string} conversation
   * @returns {Promise<string[]>} 事实列表（无则空数组）
   */
  async extract(conversation) {
    const conv = String(conversation || '').trim().slice(0, 4000);
    if (!conv) return [];
    let reply = '';
    try { reply = String(await this.complete(EXTRACT_PROMPT.replace('{conv}', conv)) || '').trim(); }
    catch { return []; }
    // 双保险：剥离 thinking 模型的 <think> 块，防思考链被行分割器当事实污染记忆。
    reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!reply || /^NONE\b/i.test(reply)) return [];
    return reply.split('\n')
      .map((l) => l.replace(/^[-*\d.、\s]+/, '').trim())
      .filter((l) => l.length >= 4 && !/^NONE\b/i.test(l))
      .slice(0, 10); // 单次最多 10 条，防模型异常输出刷屏
  }

  /**
   * 结构化事实抽取：保持 extract() 字符串数组兼容，同时给写入层可选时间/来源字段。
   * @param {string} conversation
   * @param {{now?:number, sourceEpisodeId?:string|null, confidence?:number}} [opts]
   * @returns {Promise<Array<{text:string, body:string, validFrom:number, validTo:null, sourceEpisodeId:string|null, confidence:number}>>}
   */
  async extractRecords(conversation, { now = Date.now(), sourceEpisodeId = null, confidence = 0.7 } = {}) {
    const validFrom = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const c = Number.isFinite(Number(confidence)) ? Math.max(0, Math.min(1, Number(confidence))) : 0.7;
    const episode = sourceEpisodeId == null ? null : String(sourceEpisodeId).trim().slice(0, 240) || null;
    const facts = await this.extract(conversation);
    return facts.map((text) => ({
      text,
      body: text,
      validFrom,
      validTo: null,
      sourceEpisodeId: episode,
      confidence: c,
    }));
  }
}
