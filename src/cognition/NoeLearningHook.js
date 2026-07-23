// @ts-check
// NoeLearningHook — 批次B：接通「立目标→真学到」学习闭环（治三方复盘 LOOP-3 + 批次AB 复盘 G1-G4）。
//
// 三方复盘（M3/codex/Claude）一致：surprise 目标第3步「修正一条认知并记进记忆」(NoeGoalSystem.harvestSurprise
//   硬编码 steps:573) 是死步骤——只是 plan 文字，done 时无机制真执行。本 hook 就是这步的真实执行：
//   surprise 目标 done → 读证据 → 本地脑产【具体认知修正 lesson】→ 写 memory(过生产 gate) → 验证持久化。
//
// 批次AB 复盘整改（codex 读真实代码命中，已逐条 grep 验证属实）：
//   G1: kind 必须是 schema 合法值——'lesson' 不在 ALLOWED_KINDS，会被拒/退化；insight 又需 evidenceRefs，
//       否则生产 gate(candidateNeedsSourceEvidence) 返回 source_evidence_required 直接拒。故 kind:'insight'+evidenceRefs。
//   G2: writeGate.commit() 返回 {ok, candidate, memory}，记忆 id = c.memory.id（非顶层 c.id）；必须先查 c.ok。
//   G3: recall 验证不用「lesson 片段 includes」(写完必中=自证假阳，M3 漏洞 G)，改 memory.get(memId) 按 id 精确命中；
//       且诚实区分 persisted(写入且可取回，学习的必要非充分条件) ↔ 真 learned(行为改变，留 hit_count 长期监控判)。
//   G4: 证据含 goal.why + 相关记忆，lesson 带 evidenceRefs 可溯源。
//   空耗预警: 写入前 baseline——同 topic 已有 surprise_lesson(priorLessons≥1)=同主题反复学没学会=isRelearn 真空耗信号。
//
// 纪律：注入式(adapter/memory/writeGate)，async fail-open，纯增量，flag NOE_LEARNING_HOOK 默认 OFF。

const PROJECT = 'noe'; // 召回/写入必须同项目（治 D1：recall 默认 'default'，lesson 写 'noe'→召回恒空）

export function createLearningHook({
  adapter,        // 本地脑：{ chat: async (msgs, opts) => {reply} }
  memory,         // MemoryCore：{ recall, get }
  writeGate,      // NoeMemoryWriteGate：{ commit }→{ok, candidate, memory}
  model = undefined,
} = {}) {
  /**
   * surprise 目标 done 时调用。@returns {Promise<{persisted:boolean, isRelearn?:boolean, priorLessons?:number, lesson?:string, memId?:any, reason?:string}|null>}
   */
  async function onSurpriseGoalDone(goal) {
    if (process.env.NOE_LEARNING_HOOK !== '1') return null;
    if (goal?.source !== 'surprise') return null; // 只对好奇目标
    if (!adapter?.chat || !memory?.recall || !writeGate?.commit) return null;
    try {
      const topic = String(goal.title || '').replace(/^搞明白为什么没料到[:：]/, '').slice(0, 150).trim();
      if (topic.length < 6) return { persisted: false, reason: 'no_topic' };
      // ① 读证据 + 写入前 baseline：同 topic 已有几条 surprise_lesson？
      let related = [];
      try { related = memory.recall({ query: topic, projectId: PROJECT, limit: 8, bumpHits: false }) || []; } catch { /* fail-open */ }
      const isLessonRow = (m) => String(m.sourceType || m.source || '') === 'surprise_lesson'
        || (Array.isArray(m.tags) ? m.tags : String(m.tags || '').split(',')).includes('lesson');
      const priorLessons = related.filter(isLessonRow).length; // ≥1 = 同主题之前学过还 surprise = 真空耗信号
      const isRelearn = priorLessons >= 1;
      const evidenceText = [goal.why, ...related.map((m) => m.body)].filter(Boolean).join('\n').slice(0, 1500);
      // ② 本地脑产【具体认知修正】lesson（非同质方法论）
      const r = await adapter.chat([
        { role: 'system', content: '我刚因一个预测落空而惊奇并研究了它。把我学到的【具体认知修正】写成一条 lesson：我原以为什么、实际是什么、下次该怎么调整。必须含具体对象/条件/事实/数字，绝不要写「先搜索→再读→再扫描」式空泛方法论。如果这次没有具体新认知，只输出一个词 SKIP。只输出 lesson 内容。' },
        { role: 'user', content: `没料到的事：${topic}\n相关线索：\n${evidenceText || '（无）'}` },
      ], { budgetContext: { projectId: 'noe', taskId: 'noe-learning-hook' }, think: false, model });
      const lesson = String(r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim().slice(0, 400);
      if (/^SKIP\b/i.test(lesson) || /^["「]?SKIP["」]?$/i.test(lesson) || lesson.length < 15) return { persisted: false, isRelearn, priorLessons, reason: 'no_lesson', lesson };
      // ③ 写 memory（G1：insight 合法 kind + evidenceRefs 过 gate；G2：查 c.ok + 用 c.memory.id）
      let memId = null;
      try {
        const evidenceRefs = [goal?.id ? `goal:${goal.id}` : null, ...related.map((m) => (m?.id != null ? `mem:${m.id}` : null))].filter(Boolean).slice(0, 6);
        const c = writeGate.commit({
          kind: 'insight', projectId: PROJECT, scope: 'insight',
          title: `认知修正：${topic.slice(0, 50)}`, body: lesson,
          sourceType: 'surprise_lesson', tags: ['lesson', 'surprise'], salience: 4, confidence: 0.7,
          evidenceRefs,
        });
        if (!c || c.ok === false || !c.memory?.id) return { persisted: false, isRelearn, priorLessons, reason: (c && c.reason) || 'commit_rejected', lesson };
        memId = c.memory.id;
      } catch { return { persisted: false, isRelearn, priorLessons, reason: 'commit_failed', lesson }; }
      // ④ 持久化验证（G3：memory.get(memId) 按 id 精确命中，非片段自证；persisted≠learned，真行为改变留 hit_count 监控）
      let persisted = false;
      try {
        persisted = typeof memory.get === 'function'
          ? Boolean(memory.get(memId))
          : (memory.recall({ query: topic, projectId: PROJECT, limit: 10 }) || []).some((m) => m.id === memId);
      } catch { /* fail-open */ }
      return { persisted, isRelearn, priorLessons, lesson, memId };
    } catch { return { persisted: false, reason: 'error' }; }
  }

  return { onSurpriseGoalDone };
}
