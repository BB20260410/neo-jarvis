// skillExtract.js — 会话后自动提炼技能路由（registerSkillExtractRoutes）。
// 移植自 Odysseus skill_extractor 设计(MIT)。调用方(前端会话结束/loop)传最近 messages，
// 提炼出的技能默认 disabled(draft)，需用户启用，避免自动污染技能库。
import { requireOwnerToken } from '../auth/owner-token.js';
import { skillStore } from '../../skills/SkillStore.js';
import { createSkillExtractor } from '../../skills/SkillExtractor.js';
import { createBrainChat } from '../../room/brainChat.js';

export function registerSkillExtractRoutes(app, { getAdapter = null, brainRouter = null } = {}) {
  const chat = createBrainChat({ getAdapter, brainRouter, taskId: 'noe-skill-extract' });
  const extractor = createSkillExtractor({ chat, store: skillStore });

  // 从一段对话提炼可复用技能。body: { messages:[{role,content}], minConfidence?, dryRun? }
  app.post('/api/noe/skills/extract', requireOwnerToken, async (req, res) => {
    try {
      if (JSON.stringify(req.body || {}).length > 80000) return res.status(413).json({ ok: false, error: 'body too large' });
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      if (!messages.length) return res.status(400).json({ ok: false, error: 'messages[] required' });
      const out = await extractor.extract(messages, {
        minConfidence: Number(req.body.minConfidence) || 0.6,
        dryRun: req.body.dryRun === true,
      });
      return res.json({ ok: true, ...out });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  return { extractor };
}
