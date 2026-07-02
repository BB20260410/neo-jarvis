// SkillExtractor — 会话后自动提炼可复用技能（补 Noe「只能手动建 skill」缺口）。
// 设计移植自 Odysseus skill_extractor（MIT, github.com/pewdiepie-archdaemon/odysseus）：
//   触发(轮次≥2 或 工具≥2) → LLM 一次提炼 → 置信度<0.6 丢弃 → 去重 → 写 draft(enabled:false 待用户启用)。
// 异步非阻塞、不污染已有 skill（默认 disabled，用户确认后才生效）。
import { parseNoeLlmJsonValue } from '../runtime/NoeLlmJsonExtractor.js';

const PROMPT = `你是技能提炼器。分析对话，判断是否包含「可复用的技能/工作流」——用户未来可能重复需要、值得固化成操作指南的东西（特定任务步骤、偏好约定、配置方法）。
有则只输出 JSON：{"name":"英文短横线命名如 deploy-cloudflare","displayName":"中文名","description":"一句话说明何时该用(给AI决策)","body":"markdown 操作指南","confidence":0到1之间的小数}
纯闲聊/一次性问答则只输出：null`;

function safeJson(s) {
  return parseNoeLlmJsonValue(s, null);
}

export function createSkillExtractor({ chat, store }) {
  // 触发条件：用户轮次≥2、工具调用≥2，或单个任务里已有多段 assistant 协作输出。
  function shouldExtract(messages, { minRounds = 2, minToolCalls = 2, minAssistantTurns = 4 } = {}) {
    if (!Array.isArray(messages)) return false;
    const rounds = messages.filter((m) => m && m.role === 'user').length;
    const assistantTurns = messages.filter((m) => m && m.role === 'assistant' && String(m.content || '').trim()).length;
    const toolCalls = messages.filter((m) => m && (m.role === 'tool' || m.tool_calls || /tool_call|调用工具|callTool/i.test(String(m.content || '')))).length;
    return rounds >= minRounds || toolCalls >= minToolCalls || assistantTurns >= minAssistantTurns;
  }

  async function extract(messages, { minConfidence = 0.6, dryRun = false } = {}) {
    if (!shouldExtract(messages)) return { extracted: false, reason: '未达触发条件(轮次<2且工具<2)' };
    const recent = messages.slice(-12).map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 500) })).filter((m) => m.content);
    const convo = recent.map((m) => `${m.role}: ${m.content}`).join('\n');
    const r = await chat([{ role: 'system', content: PROMPT }, { role: 'user', content: `对话：\n${convo}\n\n提炼可复用技能或输出 null。` }], { think: false });
    const raw = String(r?.reply || '').trim();
    if (!raw || /^null\b/i.test(raw)) return { extracted: false, reason: 'LLM 判定无可固化技能' };
    const skill = safeJson(raw);
    if (!skill || !skill.name || !skill.description) return { extracted: false, reason: '提炼结果不完整' };
    const confidence = Number(skill.confidence) || 0;
    if (confidence < minConfidence) return { extracted: false, reason: `置信度 ${confidence} < ${minConfidence}`, candidate: { name: skill.name, description: skill.description } };
    // safe name：转小写、非法字符转 -、去首尾 -
    const name = String(skill.name).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill';
    if (store.get(name)) return { extracted: false, reason: `技能 ${name} 已存在`, skipped: true };
    const candidate = { name, displayName: skill.displayName || skill.name, description: String(skill.description).slice(0, 180), body: String(skill.body || '').slice(0, 2500), confidence };
    if (dryRun) return { extracted: false, dryRun: true, candidate };
    try {
      const saved = store.upsert({ name, displayName: candidate.displayName, description: candidate.description, body: candidate.body, enabled: false, extra: { source: 'auto-extract', confidence: String(confidence) } });
      return { extracted: true, skill: { name: saved.name, displayName: saved.displayName, description: saved.description, confidence, enabled: false } };
    } catch (e) { return { extracted: false, reason: `保存失败: ${e.message}`, candidate }; }
  }

  return { extract, shouldExtract };
}
