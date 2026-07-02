// @ts-check
// NoeResearchSediment — research 报告沉淀器：把 runResearch 产出的 report 沉淀成可召回的语义记忆。
//
// 动机（实测痛点，2026-06-23）：自主学习 research 产出 report 全文，但只有前 400 字 summary 进 goal 步骤
//   + episode 记一句"查了 N 来源"，report 内容未进可召回知识/记忆 → 学了等于没学（下次同主题召回不到）。
//
// 设计（综合多模型 M3∥Codex + Claude 子代理研究）：
//   - **不把 report 全文整体塞进语义记忆**（multimodel Phase0 质疑：长报告的水化叙述会污染向量召回、稀释命中）。
//     而是存「摘要 + 来源清单 + 覆盖评分」的精炼条目——短、可召回、不污染。report 全文留痕由调用方另定（二期 wiki）。
//   - **盐度门槛**：report 太短/无来源不沉淀（避垃圾入库）。
//   - **幂等**：按 goal step 给 sourceId，同一步重复研究走 memoryCore 既有 dedup 刷新而非堆叠。
//   - **注入式**：memoryCore 从参数传入，纯认知层不直接依赖存储（与本仓 runResearch/recordEpisode 注入范式一致）。
//
// flag NOE_RESEARCH_PERSIST=1 门控（server.js 装配处判定，OFF 时不注入 persistResearch → NoeWorkspace 整段跳过、零回归）。

const DEFAULT_MIN_REPORT_CHARS = 800;   // 盐度门槛：短于此不沉淀
const DEFAULT_BODY_CHARS = 1600;        // memory body 摘要上限（避全文污染召回）
const DEFAULT_SALIENCE = 4;             // 与 episode milestone 同档（高于普通 manual 3，低于 owner 直述 5）
const MAX_BODY = 8000;                  // 写入硬上限（远小于 MemoryCore MAX_TEXT 100k）
const DEFAULT_MIN_COVERAGE = 0.3;       // 覆盖门槛：critique.coverageScore 低于此不沉淀（低覆盖=研究没做透，Codex 复审 Finding 4）

export function resolveResearchSedimentConfig(env = process.env) {
  const enabled = env?.NOE_RESEARCH_PERSIST === '1';
  const minReportChars = Math.max(1, Math.floor(Number(env?.NOE_RESEARCH_MIN_CHARS) || DEFAULT_MIN_REPORT_CHARS));
  const ttlMs = Math.max(0, Math.floor(Number(env?.NOE_RESEARCH_TTL_MS) || 0)); // 0=不过期（与现有 lesson 一致）
  const minCoverage = Number.isFinite(Number(env?.NOE_RESEARCH_MIN_COVERAGE)) ? Number(env?.NOE_RESEARCH_MIN_COVERAGE) : DEFAULT_MIN_COVERAGE;
  return { enabled, minReportChars, ttlMs, minCoverage };
}

// 把 report + sources + critique 精炼成 memory body（摘要，非全文）。
function buildSedimentBody(report, sources, critique, bodyChars) {
  const head = String(report || '').replace(/\s+/g, ' ').trim().slice(0, bodyChars);
  const list = Array.isArray(sources) ? sources : [];
  const srcLines = list
    .slice(0, 10)
    .map((s) => `- ${String(s?.title || '').slice(0, 120)}: ${String(s?.url || '').slice(0, 200)}`)
    .join('\n');
  const covNum = critique && typeof critique === 'object' ? Number(critique.coverageScore) : NaN;
  const cov = Number.isFinite(covNum) ? `\n\n覆盖评分: ${covNum.toFixed(2)}` : '';
  return `${head}${cov}\n\n## 来源(${list.length})\n${srcLines}`.slice(0, MAX_BODY);
}

/**
 * 创建 research 沉淀器。
 * @param {{ memoryCore:{write:Function}, config?:{minReportChars?:number, ttlMs?:number} }} deps
 */
export function createResearchSediment({ memoryCore, config = resolveResearchSedimentConfig() } = {}) {
  const minReportChars = config.minReportChars ?? DEFAULT_MIN_REPORT_CHARS;
  const ttlMs = config.ttlMs ?? 0;
  const minCoverage = config.minCoverage ?? DEFAULT_MIN_COVERAGE;

  // 主入口：沉淀一次 research。fail-open（不抛，返回 skip/err，绝不阻断研究闭环）。
  async function sediment({ report, sources = [], topic = '', goalRef = null, critique = null } = {}) {
    const text = String(report || '');
    if (!text || text.length < minReportChars) return { ok: false, skipped: 'too_short' };
    // 无来源不沉淀（兑现文件头注释承诺，Codex 审发现6）：无 grounding 的长报告多是模型臆测，固化进记忆会污染召回。
    if (!Array.isArray(sources) || sources.length === 0) return { ok: false, skipped: 'no_sources' };
    // 低覆盖不沉淀（Codex 复审 Finding 4）：DeepResearcher 到 maxRounds 即使未达 minCoverage 仍返回 report，
    //   低覆盖=研究没做透，固化进召回池会污染。仅当 critique 给了 coverageScore 且低于门槛才拦（无评分不拦、宽松向后兼容）。
    const covGate = critique && typeof critique === 'object' ? Number(critique.coverageScore) : NaN;
    // 仅 covGate > 0 才作质量信号拦截：DeepResearcher 自评 JSON 解析失败/chat 抛错/无报告时 coverageScore 归一为 0（fail-open，
    //   语义=不判停继续研究，非"质量为 0"），本地小模型自评常吐非 JSON——0 视同"无有效自评"放行，否则误杀内容合格但
    //   自评失败的高质 report、反而重新引入"学了等于没学"（子代理复审 F4 副作用 CONFIDENCE 88，主线程亲核 DeepResearcher.js:50/102 坐实）。
    if (Number.isFinite(covGate) && covGate > 0 && covGate < minCoverage) return { ok: false, skipped: 'low_coverage' };
    if (!memoryCore || typeof memoryCore.write !== 'function') return { ok: false, skipped: 'no_memory_core' };
    const body = buildSedimentBody(text, sources, critique, DEFAULT_BODY_CHARS);
    const title = `研究：${String(topic || '未命名研究').slice(0, 80)}`;
    const sourceId = goalRef && goalRef.goalId != null
      ? `research:goal:${goalRef.goalId}:${goalRef.stepIndex}` : null;
    const covNum = critique && typeof critique === 'object' ? Number(critique.coverageScore) : NaN;
    try {
      const res = memoryCore.write({
        projectId: 'noe',
        scope: 'project',                  // 非 'fact'：不触发 conflictPolicy 误合并
        sourceType: 'research_report',      // 纳入 lesson 召回通道（需 server LESSON_TYPES 含此类型）
        title,
        body,
        salience: DEFAULT_SALIENCE,
        confidence: Number.isFinite(covNum) ? covNum : null,
        tags: ['research', 'self_learning'],
        // 幂等：有 goalRef 时把 sourceId 同时作 id → MemoryCore 走 ON CONFLICT(id) 真 upsert（同一 goal step 重复研究刷新而非
        //   堆叠，治审查发现的"传 sourceId 不被 MemoryCore 去重→堆叠污染召回池"）。无 goalRef 则随机 id（不幂等，但罕见）。
        ...(sourceId ? { id: sourceId, sourceId } : {}),
        ...(ttlMs > 0 ? { ttlMs } : {}),
      });
      return { ok: true, memId: res?.id ?? res?.memId ?? null, bodyChars: body.length };
    } catch (e) {
      return { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  return { sediment };
}
