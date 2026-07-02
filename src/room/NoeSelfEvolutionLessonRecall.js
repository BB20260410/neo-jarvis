// @ts-check
// 改动3 v1（飞轮闭环·learning 反馈 autoseed）：autoseed 立项前召回近期 reject lesson，
//   只「近重复」才判 similar → hard block；中度/不同放行（owner：别饿死飞轮、少加限制）。
//   判据用 charDice（字符级 2-gram）而非 topic 重叠——实测中文长短语 topic 提取受"的"等分词扰动碎片化
//   （"的并发调度算法"→"发调"/"度算"碎片），topicOverlapScore 精确匹配失效；charDice 对中文近重复鲁棒
//   （实测 近重复 0.889 / 中度 0.244 / 不同 0.140，区分清晰）。blocker 分级 + advisory + topic 辅助留 v2。
//   纯函数 + DI 工厂，fail-open，绝不阻断飞轮 tick。

// 从 reject lesson 的脱敏 summary（"自我进化 cycle 被复核拒绝（OBJECTIVE）。…"）提取被拒 objective。
export function extractObjectiveFromSummary(body = '') {
  const m = String(body || '').match(/被复核拒绝（([\s\S]+?)）。/);
  return m ? m[1].trim().slice(0, 120) : '';
}

// 字符级 2-gram 集合（去空格小写）——对中文长短语近重复鲁棒，不依赖分词。
function charBigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < t.length - 1; i += 1) grams.add(t.slice(i, i + 2));
  return grams;
}
// Sørensen–Dice 系数：2|A∩B|/(|A|+|B|)，0..1。
export function charDiceSimilarity(a, b) {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return (2 * inter) / (ga.size + gb.size);
}

// 纯函数：给当前 objective + 一批 reject lessons，判是否「近重复」（v1 只拦近重复，保守，防完全重复立项浪费）。
export function classifyAgainstRejectLessons(objective, lessons, { diceThreshold = 0.85, minChars = 6 } = {}) {
  const obj = String(objective || '').trim();
  if (obj.replace(/\s+/g, '').length < minChars) return { similar: false, reason: 'objective_too_thin', score: 0, lessonObjective: '' };
  let best = { score: 0, lessonObjective: '' };
  for (const m of (Array.isArray(lessons) ? lessons : [])) {
    const body = String((m && (m.body || m.text)) || '');
    if (!body) continue;
    const lessonObjective = extractObjectiveFromSummary(body);
    const score = charDiceSimilarity(obj, lessonObjective || body);
    if (score > best.score) best = { score, lessonObjective };
  }
  const similar = best.score >= diceThreshold;
  return { similar, reason: similar ? 'near_duplicate_rejected' : 'below_threshold', score: best.score, lessonObjective: best.lessonObjective };
}

// 工厂：包 DB 召回（tags LIKE q='self_evolution_reject'）+ 时间窗过滤 + 近重复判定，给 trigger 注入。
//   召回失败/未注入 → fail-open（similar:false），绝不因记忆系统故障饿死飞轮。
export function createSelfEvolutionLessonRecall({ recall = null, projectId = 'noe', now = () => Date.now(), windowMs = 14 * 24 * 60 * 60_000, limit = 8, ...thresholds } = {}) {
  return function recallRejectLessons(objective) {
    if (typeof recall !== 'function') return { similar: false, reason: 'recall_unavailable', score: 0, lessonObjective: '', lessonsConsidered: 0 };
    let lessons = [];
    try {
      // P1-1（multimodel 重审）：传 sourceTypes 让 MemoryCore SQL 层原生过滤——否则 limit:8 先排序截断，
      //   若前 8 条是含 self_evolution_reject 文本的非 lesson，真 lesson 排第 9 被截、后置 tags filter 看不到 → 漏判。
      //   下方 tags 精确过滤保留作双保险（兼容旧无 sourceType 的 legacy lesson）。
      lessons = recall({ q: 'self_evolution_reject', sourceTypes: ['self_evolution_reject_lesson'], projectId, limit, order: 'hot', bumpHits: false }) || [];
    } catch {
      return { similar: false, reason: 'recall_failed', score: 0, lessonObjective: '', lessonsConsidered: 0 };
    }
    const tNow = Number(typeof now === 'function' ? now() : now) || 0;
    const cutoff = windowMs > 0 ? tNow - windowMs : 0;
    const recent = (Array.isArray(lessons) ? lessons : []).filter((m) => {
      const ts = Number((m && (m.createdAt ?? m.updatedAt)) ?? 0) || 0;
      if (cutoff && ts < cutoff) return false;
      // P2-4：只 reject lesson 参与判定（tags 精确含 self_evolution_reject）——防 FTS/LIKE 误召回的非 lesson 文本被 hard block。
      const tags = m && m.tags;
      return Array.isArray(tags) ? tags.includes('self_evolution_reject') : String(tags || '').includes('self_evolution_reject');
    });
    return { ...classifyAgainstRejectLessons(objective, recent, thresholds), lessonsConsidered: recent.length };
  };
}
