// Noe — Skills routes (S18-2f)
// v0.55 Sprint 13-C — Skills 系统
// 从 server.js 3825-3867 提取
//
// Round 4 P1：skills 内容会被 LLM 当 prompt 加载（影响 AI 决策） → 写入必须 owner-token

import { requireOwnerToken } from '../auth/owner-token.js';
import {
  planSkillBatchEnable,
  planSkillBatchPrune,
  applySkillBatchPlan,
} from '../../skills/NoeSkillBatchCurator.js';

export function registerSkillsRoutes(app, deps) {
  const { skillStore } = deps;

  function setSkillEnabled(name, enabled, meta = {}) {
    const cur = skillStore.get(name);
    if (!cur) throw new Error(`skill not found: ${name}`);
    const extra = { ...(cur.extra || {}), ...meta };
    return skillStore.upsert({
      name: cur.name,
      displayName: cur.displayName,
      description: cur.description || 'skill',
      body: cur.body || '',
      enabled: !!enabled,
      extra,
    });
  }

  app.get('/api/skills', (req, res) => {
    try { res.json({ ok: true, skills: skillStore.list() }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/skills/:name', (req, res) => {
    try {
      const s = skillStore.get(req.params.name);
      if (!s) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true, skill: s });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/skills', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (JSON.stringify(body).length > 256 * 1024) return res.status(413).json({ error: 'body 过大' });
      const r = skillStore.upsert(body);
      res.json({ ok: true, skill: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.put('/api/skills/:name', requireOwnerToken, (req, res) => {
    try {
      const body = { ...(req.body || {}), name: req.params.name };
      if (JSON.stringify(body).length > 256 * 1024) return res.status(413).json({ error: 'body 过大' });
      const r = skillStore.upsert(body);
      res.json({ ok: true, skill: r });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/api/skills/:name', requireOwnerToken, (req, res) => {
    try {
      const ok = skillStore.delete(req.params.name);
      if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/skills/reload', requireOwnerToken, (req, res) => {
    try { skillStore.reload(); res.json({ ok: true, count: skillStore.list().length }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  /** Small-batch enable plan for disabled distilled skills. dryRun default true. */
  app.post('/api/skills/batch-enable', requireOwnerToken, (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const batchSize = req.body?.batchSize;
      // Prefer full get() for extra/source when available
      const skills = skillStore.list().map((s) => skillStore.get(s.name) || s);
      const plan = planSkillBatchEnable(skills, { batchSize });
      const applied = applySkillBatchPlan(plan, { setEnabled: setSkillEnabled, dryRun });
      res.json({ ok: true, plan, applied });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Prune trial-batch skills that never helped. dryRun default true. */
  app.post('/api/skills/batch-prune', requireOwnerToken, (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;
      const skills = skillStore.list().map((s) => skillStore.get(s.name) || s);
      const plan = planSkillBatchPrune(skills, {
        minHits: req.body?.minHits,
        trialMs: req.body?.trialMs,
        nowMs: req.body?.nowMs,
      });
      const applied = applySkillBatchPlan(plan, { setEnabled: setSkillEnabled, dryRun });
      res.json({ ok: true, plan, applied });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}
