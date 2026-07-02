// @ts-check
// DeepResearcher — 多步研究编排（补 Noe「单 agent 自驱信息收集」缺口，与多 AI 协作 dispatcher 正交）。
// 设计移植自 Odysseus DeepResearcher（MIT, github.com/pewdiepie-archdaemon/odysseus）：
//   plan → [≤maxRounds 轮: 生成查询→并行搜索→并行抓页→证据提取→综合进 evolving report→结构化自评(Reflexion)→针对性判停] → 报告。
// 关键合规：用「轮次上限 + 智能判停」防失控。模型 chat() 不设超时、不 abort、不抢先 fallback；
// 慢模型由 SSE 进度心跳安抚用户，直到完整模型结果返回。搜索/抓页网络 IO 可在各自模块内限时。
//
// === Reflexion 升级（P10）===
// 旧版判停只问「够不够」(enough true/false)，补查只泛泛问「还缺什么」——缺结构化自我批判驱动针对性研究。
// 现在每轮 synthesize 后跑 critique()，对 evolving report 做结构化自评，输出：
//   { gaps[], unsupportedClaims[], contradictions[], coverageScore: 0..1 }
// 这份 critique 同时驱动两件事：
//   1. genQueries 下一轮针对 gaps / unsupportedClaims 精准补查（不再泛泛「还缺什么」）；
//   2. shouldStop 用「gaps 空 + coverageScore 达阈值」判停（不仅 enough），maxRounds 仍是硬上限。
// critique 用 chat(think:false) + safeJson 解析；fail-open——解析失败返回空 gaps（不会因自评抛错卡死研究）。
//
// === 树搜索（MCTS / ToT）决策：不做。理由（诚实判断，非偷懒）===
// 树搜索（在多条研究路径上展开、回溯、按价值选支）对本场景【无净收益，只增复杂度】：
//   1. 研究是「累积」非「择一」：每轮搜到的证据都进同一份 evolving report 共享上下文，不存在「选了 A 路就放弃 B 路」
//      的互斥分支——线性多轮天然把所有有价值的分支都并进来了，没有需要回溯丢弃的死路。
//   2. Reflexion 已提供「定向纠偏」：critique.gaps/unsupportedClaims 让下一轮直接补最薄弱处，等价于树搜索想要的
//      「往高价值节点扩展」，但不需要维护搜索树 / 估值函数 / 回溯栈。
//   3. 同轮已有横向并行：genQueries 一次出 2-3 条互补查询 + Promise.all 并发搜索/抓页，单轮内已是「宽度展开」。
//   4. 成本与可控性：树搜索会成倍放大 LLM 调用（每节点都要估值），与 Neo「chat 不超时 + 轮次上限防失控」的合规
//      取向冲突，且更难解释判停。学术上 ToT/MCTS 的增益集中在「有明确对错、可回溯剪枝」的推理/博弈任务，
//      不是开放式信息收集。
// 结论：线性多轮 ReAct + Reflexion 定向纠偏，对绝大多数研究问题已是更优的复杂度/收益点。若未来出现「互斥假设
//   需分别证伪、且单轮预算受限」的场景，再在此处引入有界 best-first 扩展（注意保留 maxRounds 硬上限）。

function safeJson(s) {
  try { return JSON.parse(s); } catch { /* 继续尝试从文本里抠 JSON */ }
  const m = String(s || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 抠不出就返回 null */ } }
  return null;
}

// critique 的安全归一：保证返回稳定形状（数组字段恒为 string[]、coverageScore 恒为 0..1 数字）。
// fail-open 语义体现在这里——上游解析失败传 null 时，gaps 等返回空数组、coverageScore 返回 0（=不满足判停，继续研究）。
function normalizeCritique(j) {
  // P10-fix(M3+Codex审):净化——critique 来自审查含网页正文的 report,其字符串会被 genQueries 原样拼进下一轮 prompt。
  //   剥控制符/折叠换行(防造假"system:"段)/剥角色与注入标记/单项截断/条数上限,堵 self-poisoning + prompt 注入面。
  const sanitize = (x) => String(x || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(system|user|assistant|human|忽略上文|ignore (?:above|previous|all))\s*[:：]/gi, '·')
    .trim()
    .slice(0, 200);
  const arr = (v) => (Array.isArray(v) ? v.map(sanitize).filter(Boolean).slice(0, 8) : []);
  let score = Number(j && j.coverageScore);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(1, score));
  return {
    gaps: arr(j && j.gaps),
    unsupportedClaims: arr(j && j.unsupportedClaims),
    contradictions: arr(j && j.contradictions),
    coverageScore: score,
  };
}

export function createDeepResearcher({ webSearch, chat }) {
  // chat: async (messages, opts) => ({ reply }) —— 由调用方注入(包 BrainRouter/adapter，永不超时)

  // genQueries 现在消费 critique：若上一轮有 gaps/unsupportedClaims，下一轮针对它们精准补查；否则退回泛泛「还缺什么」。
  async function genQueries(question, report, usedQueries, critique) {
    const targeted = critique && (critique.gaps.length || critique.unsupportedClaims.length);
    const sys = '你是研究助手。根据研究问题、已有发现与「待补清单」，生成 2-3 个互补的网络搜索查询(中文或英文，精准、避免与已用查询重复)。优先精准命中待补清单里的缺口与无引用断言。只输出 JSON 数组，如 ["查询1","查询2"]，不要解释。';
    let usr = `研究问题：${question}\n\n已用查询：${[...usedQueries].join(' | ') || '无'}\n\n`;
    if (report) usr += `当前发现摘要：\n${report.slice(0, 1500)}\n\n`;
    if (targeted) {
      // Reflexion 驱动：把结构化缺口喂给 genQueries，让补查命中薄弱处而非泛泛重复。
      const lines = [];
      if (critique.gaps.length) lines.push(`未覆盖的子问题/薄弱点：\n- ${critique.gaps.slice(0, 6).join('\n- ')}`);
      if (critique.unsupportedClaims.length) lines.push(`无引用支撑、需要找证据核实的断言：\n- ${critique.unsupportedClaims.slice(0, 6).join('\n- ')}`);
      usr += `${lines.join('\n\n')}\n\n请针对上面的待补清单出新查询。`;
    } else {
      usr += report ? '还缺什么？据此出新查询。' : '这是第一轮。';
    }
    const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { think: false });
    const arr = safeJson(r?.reply);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean).slice(0, 3) : [question];
  }

  async function synthesize(question, report, evidence) {
    const sys = '你是研究综合专家。把新证据整合进现有报告：保留已有要点、补充新信息、用 [n] 标注来源。输出整合后的【完整】中文 markdown 报告(不是增量)。';
    const usr = `研究问题：${question}\n\n现有报告：\n${report || '(空)'}\n\n新证据：\n${evidence}\n\n输出整合后的完整报告。`;
    const r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { think: false });
    return r?.reply || report || '';
  }

  // Reflexion 核心：对 evolving report 做结构化自我批判。fail-open——解析失败返回空 gaps（continue 研究，不卡死）。
  async function critique(question, report) {
    if (!report) return normalizeCritique(null); // 还没报告无从自评：空 critique（coverageScore 0 → 不会早停）
    const sys = '你是严格的研究审稿人。审查报告是否充分、可信地回答了研究问题，做结构化自我批判。只输出 JSON，键固定为：'
      + '{"gaps":["未覆盖的子问题或论证薄弱处"],"unsupportedClaims":["报告里没有 [n] 引用支撑的断言"],"contradictions":["报告内部或与常识矛盾之处"],"coverageScore":0到1的小数(对问题的覆盖与可信度,1=完全充分)}。'
      + '如实评判，不要客套；没有就给空数组。不要输出 JSON 以外的任何内容。';
    const usr = `研究问题：${question}\n\n待审查报告：\n${String(report).slice(0, 3000)}\n\n请输出结构化批判 JSON。`;
    let r;
    try {
      r = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { think: false });
    } catch {
      // chat 抛错（模型/网络）：fail-open，返回空 critique，让研究继续（由 maxRounds / emptyStreak 兜底防失控）。
      return normalizeCritique(null);
    }
    return normalizeCritique(safeJson(r?.reply));
  }

  // shouldStop 用 critique 判「研究充分」；maxRounds 永远是硬上限。
  // P10-fix(M3+Codex审):① 最小轮数 minRounds 防首轮宽松打分就停(覆盖不足);② critique 既然算了 unsupportedClaims/
  //   contradictions,判停就须一并清空——否则 gaps 空但有未支撑断言/矛盾时带病早停(Codex 实测 gaps[]+unsupported→rounds1)。
  function shouldStop(round, maxRounds, critiqueResult, minCoverage) {
    if (round >= maxRounds) return true; // 硬上限优先,防失控
    if (!critiqueResult) return false;
    // P10-fix(Codex审):gaps/unsupportedClaims/contradictions 全清空 + coverageScore 达阈值才算充分——
    //   critique 既然算了这三项,判停就须一并满足,否则 gaps 空但有未支撑断言/矛盾时带病早停。
    //   不另设最小轮数:这三项全空已是严格门槛(覆盖不足时 critique 必报 gaps/unsupported→自然不停),
    //   对真窄问题"首轮就干净"允许高效早停(与 Codex"早停≠失败"一致,避免强制空跑)。
    return critiqueResult.gaps.length === 0
      && critiqueResult.unsupportedClaims.length === 0
      && critiqueResult.contradictions.length === 0
      && critiqueResult.coverageScore >= minCoverage;
  }

  function dedupeSources(arr) { const seen = new Set(); return arr.filter((s) => s.url && !seen.has(s.url) && seen.add(s.url)); }

  // 主流程：question → { report, rounds, sources, critique }
  // minCoverage: 判停所需的最低 coverageScore（与 gaps 空二者同时满足才停）；可由调用方覆盖，默认 0.7。
  /**
   * @param {string} question
   * @param {{ maxRounds?: number, perQuery?: number, fetchTop?: number, minCoverage?: number, onProgress?: (p: Record<string, any>) => void }} [opts]
   */
  async function research(question, { maxRounds = 6, perQuery = 5, fetchTop = 6, minCoverage = 0.7, onProgress = () => {} } = {}) {
    const q = String(question || '').trim();
    if (!q) throw new Error('research: question required');
    const usedQueries = new Set(); const usedUrls = new Set(); const sources = [];
    let report = ''; let round = 0; let emptyStreak = 0;
    let lastCritique = null; // 上一轮 Reflexion 结果：驱动本轮 genQueries 的针对性补查
    while (round < maxRounds) {
      round++;
      onProgress({ phase: 'plan', round });
      const queries = (await genQueries(q, report, usedQueries, lastCritique)).filter((x) => !usedQueries.has(x));
      if (!queries.length) break;
      queries.forEach((x) => usedQueries.add(x));
      onProgress({ phase: 'search', round, queries });
      const hitGroups = await Promise.all(queries.map((qq) => webSearch.search(qq, { count: perQuery }).catch(() => [])));
      const hits = hitGroups.flat().filter((h) => h.url && !usedUrls.has(h.url));
      if (!hits.length) { emptyStreak++; if (emptyStreak >= 2) break; continue; }
      emptyStreak = 0;
      const toFetch = hits.slice(0, fetchTop);
      toFetch.forEach((h) => usedUrls.add(h.url));
      onProgress({ phase: 'fetch', round, count: toFetch.length });
      const pages = await Promise.all(toFetch.map((h) => webSearch.fetchContent(h.url, { maxChars: 3000 }).then((p) => ({ ...h, ...p }))));
      const good = pages.filter((p) => p.ok && p.text);
      // 抓到正文用正文，否则退用 snippet（保证每轮都有证据喂给综合）
      const evidence = good.length
        ? good.map((p) => `## ${p.title}\n来源: ${p.url}\n${p.text}`).join('\n\n---\n\n')
        : hits.slice(0, 8).map((h) => `- ${h.title}: ${h.snippet} (${h.url})`).join('\n');
      (good.length ? good : hits.slice(0, 8)).forEach((p) => sources.push({ title: p.title, url: p.url }));
      onProgress({ phase: 'synthesize', round });
      report = await synthesize(q, report, evidence);
      // Reflexion：结构化自评 → 既驱动下一轮针对性补查，也作为判停依据。
      onProgress({ phase: 'critique', round });
      lastCritique = await critique(q, report);
      onProgress({ phase: 'critique', round, gaps: lastCritique.gaps.length, coverageScore: lastCritique.coverageScore });
      if (shouldStop(round, maxRounds, lastCritique, minCoverage)) break;
    }
    onProgress({ phase: 'done', round });
    return { question: q, report, rounds: round, sources: dedupeSources(sources), critique: lastCritique };
  }

  return { research };
}
