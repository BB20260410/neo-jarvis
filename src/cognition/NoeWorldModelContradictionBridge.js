// @ts-check
// NoeWorldModelContradictionBridge — 阶段1 P1 根除主线：接通「信息层 epistemic 源」之 worldModel 矛盾。
//
// 三方复盘（M3/codex/Claude）一致最深共识：执行层失败(批次A 净化后)是工具/网络噪声，非该学的源。
//   真正该学的是「读到的内容与已有认知矛盾」——Neo 主动 research/browse 读到新信息，与 memory(belief) 直接
//   冲突 = 被现实打脸 = 最纯的 epistemic 缺口。这是「自主学习空耗」的真根除源。
//
// 解法：research/browse 读到内容 → recall 相关 memory(belief) → 本地脑判【事实矛盾】→ harvestSurprise(world_model_conflict)。
//   无显式 worldModel 基建，用 memory 当 belief（Neo 的认知就存在 memory 里）。无已有认知=初次学非被打脸，不产 surprise。
//
// 纪律：注入式，async fail-open，去重限速，与 learningHook 同坑提醒——recall 必须带 projectId（否则召回恒空）。
//   flag NOE_WORLDMODEL_CONFLICT 默认 OFF。

const PROJECT = 'noe';

// 从主题抽关键词（治 WM-FATAL-1：整条自然语言 topic 做 FTS phrase 子串匹配召回恒 0，Claude probe 坐实）。
//   拆中文连续块+ascii 词；中文无分隔长词(>3字，如「人工智能对齐」)整块仍难命中子串→再按 2 字分段，
//   让短片段能命中 belief 子串。每词分别召回，belief 含任一即命中。
function extractKeywords(topic) {
  const raw = String(topic || '').match(/[一-龥]{2,}|[A-Za-z][A-Za-z0-9+#.]{2,}/g) || []; // ascii≥3(治 WM-OVERRECALL：AI/GC 等 2 字符 ascii 经 LIKE 撞 RAID/GCC 无关 belief)
  const out = new Set();
  for (const w of raw) {
    if (/[一-龥]/.test(w) && w.length > 3) {
      for (let i = 0; i + 2 <= w.length; i += 2) out.add(w.slice(i, i + 2)); // 2 字分段，让长中文词的片段能命中
      out.add(w); // 也保留整块（精确主题命中）
    } else if (w.length >= 2) { out.add(w); }
  }
  return [...out].slice(0, 8);
}

export function createWorldModelContradictionBridge({
  adapter,        // 本地脑：{ chat }
  memory,         // MemoryCore：{ recall }
  goalSystem,     // { harvestSurprise }
  now = Date.now,
  surpriseThreshold = 2,
  conflictSurprise = 2.5, // 矛盾=高 surprise 信号（非概率结算，固定值需 > 阈值才能立好奇目标）
  dedupWindowMs = 6 * 3600 * 1000,
  maxPerHour = 4,
  model = undefined,
} = {}) {
  const recent = new Map(); // topic 指纹 → ts（去重）
  const hourly = [];        // 限速

  const fp = (topic) => String(topic || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);

  /**
   * Neo 读到内容时调用（research 报告 / browse 页面正文）。
   * @returns {Promise<{conflict?:boolean, conflictPoint?:string, curiosityGoalId?:any, skipped?:string}|null>}
   */
  async function onContentObserved({ content, topic, source = 'research' } = {}) {
    if (process.env.NOE_WORLDMODEL_CONFLICT !== '1') return null;
    if (!adapter?.chat || !memory?.recall || !goalSystem?.harvestSurprise) return null;
    const text = String(content || '').trim();
    const subj = String(topic || '').trim();
    if (text.length < 40 || subj.length < 4) return null; // 内容太短无从判矛盾
    try {
      const t = now();
      const key = fp(subj);
      const last = recent.get(key);
      if (last && t - last < dedupWindowMs) return { skipped: 'deduped' };
      // recall 相关 belief（治 WM-FATAL-1：用关键词分别召回，不靠整条 topic 子串；带 projectId 治 D1 同坑）
      const keywords = extractKeywords(subj);
      const related = []; const seenIds = new Set();
      for (const kw of (keywords.length ? keywords : [subj])) {
        let hits = [];
        try { hits = memory.recall({ query: kw, projectId: PROJECT, limit: 4, bumpHits: false }) || []; } catch { /* fail-open */ }
        for (const h of hits) { const id = h?.id; if (id != null && !seenIds.has(id)) { seenIds.add(id); related.push(h); } }
        if (related.length >= 8) break;
      }
      if (!related.length) return { skipped: 'no_belief' }; // 无已有认知=初次学非被打脸，不产 surprise
      // WM-OVERRECALL（Claude 第三轮 probe 坐实）：短/泛关键词召回只共享一个泛词的无关 belief→喂脑刷假矛盾。
      //   相关性过滤：belief body 须命中 ≥2 个关键词，或含 1 个长词(≥4字 / ascii 术语)，才算真相关喂脑。
      const longKw = keywords.filter((k) => k.length >= 4 || /^[A-Za-z]/.test(k));
      const relevant = related.filter((m) => {
        const body = String(m.body || '');
        return keywords.filter((k) => body.includes(k)).length >= 2 || longKw.some((k) => body.includes(k));
      });
      if (!relevant.length) return { skipped: 'no_relevant_belief' }; // 召回的都是只共享泛词的无关 belief
      const beliefText = relevant.map((m) => m.body).filter(Boolean).join('\n').slice(0, 1200);
      // 本地脑判：读到的内容与已有认知有无【事实矛盾】（不是补充/细化，是直接冲突）
      const r = await adapter.chat([
        { role: 'system', content: '我刚读到一段新内容，下面还有我记忆里关于这个主题的已有认知。判断新内容与我的已有认知有没有【事实层面的矛盾】——不是补充、不是细化，是直接冲突：我原以为 A，新内容说非 A。若有矛盾，只输出一行 `CONFLICT: 我原以为X，实际Y`（一句话说清矛盾点）；若无矛盾（一致 / 只是补充新信息）只输出 `NONE`。' },
        { role: 'user', content: `【新读到的内容】\n${text.slice(0, 1500)}\n\n【我的已有认知】\n${beliefText}` },
      ], { budgetContext: { projectId: PROJECT, taskId: 'noe-worldmodel-conflict' }, think: false, model });
      const reply = String(r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
      // codex 复盘漏洞4：未锚定 /CONFLICT:/ 会把「NO CONFLICT: …」误判冲突。改逐行行首锚定——NO CONFLICT/NONE 不匹配。
      const conflictLine = reply.split(/\r?\n/).map((l) => l.trim().replace(/^[>*_\-\s]+/, '')).find((l) => /^CONFLICT\s*[:：]/i.test(l));
      if (!conflictLine) return { conflict: false }; // NONE / NO CONFLICT / 没判出矛盾
      const conflictPoint = conflictLine.replace(/^CONFLICT\s*[:：]\s*/i, '').trim().slice(0, 200);
      if (conflictPoint.length < 6) return { conflict: false };
      // 限速（防一段长内容里反复判出矛盾刷爆）
      while (hourly.length && t - hourly[0] > 3600 * 1000) hourly.shift();
      if (hourly.length >= maxPerHour) return { skipped: 'rate_limited', conflictPoint };
      if (recent.size >= 1000) recent.delete(recent.keys().next().value); // F8：防 recent Map 无界增长
      recent.set(key, t);
      hourly.push(t);
      const claim = `读到与认知矛盾（${source}）：${conflictPoint}`;
      if (conflictSurprise < surpriseThreshold) return { conflict: true, conflictPoint, curiosityGoalId: null };
      const curiosityGoalId = goalSystem.harvestSurprise({ claim, surprise: conflictSurprise, origin: 'world_model_conflict' });
      return { conflict: true, conflictPoint, curiosityGoalId };
    } catch { return null; }
  }

  return { onContentObserved };
}
