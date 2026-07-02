// @ts-check
// NoeExpectationLedger — 期望账本：预测-误差机制 + 校准闭环（设计文档《AI自我意识实现方案》§7.5 P4，
// 结构性缺口四）。
//
// 问题：Noe 对世界从不"下注"——没有预测就没有落空，没有落空就没有惊奇（surprise），自我认知
//   缺一条被现实硬纠正的反馈回路（confidence 复核只覆盖 insight，不覆盖对未来的预期）。
// 设计：noe_expectations 表（迁移 v7）记 {claim, p, due_at}；到期结算 outcome → surprise =
//   -log2(p_实际结果)；月度 Brier = mean((p-outcome)²) 进"自知之明"。
// 来源（P4）：确定性正则从念头/对话抽"时间词+情态词"型预测（零 LLM，镜像 NoeCommitmentExtractor
//   哲学，宁缺勿滥）；后续 P3 工作区/S2 质询可直接 add() 喂结构化预测。
// 结算（P4）：到期项进内心透视页等人工裁决（应验/落空/判不了）；逾期 7 天没人判自动 unresolvable
//   出账（不计分，防账本淤积）。LLM 自动判证留给工作区阶段。
import { getDb } from '../storage/SqliteStore.js';
import { textSimilarity } from '../memory/NoeMemoryDedup.js';
import { calibrationCurve as computeCalibrationCurve } from './NoeCalibrationCurve.js';
import { clamp } from './_mathUtils.js';

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function parseSmallCount(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (Object.prototype.hasOwnProperty.call(digits, s)) return digits[s];
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? digits[m[1]] : 1) * 10 + (m[2] ? digits[m[2]] : 0);
  return null;
}

// 时间词 → due 偏移。短期期望优先匹配分钟/小时级，再落到天级。
const TIME_DUE = [
  [/([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*(?:分钟|分)(?:钟)?(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 720) * MINUTE],
  [/半(?:个)?小时(?:后|内)/, 30 * MINUTE],
  [/([1-9]\d{0,2}|[一二两三四五六七八九十]{1,3})\s*(?:个)?小时(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 168) * HOUR],
  [/([1-9]\d?|[一二两三四五六七八九十]{1,3})\s*天(?:后|内)/, (m) => clamp(parseSmallCount(m[1]) || 0, 1, 30) * DAY],
  [/马上|立刻|很快/, 5 * MINUTE],
  [/一会儿|等会儿|待会儿|稍后/, 15 * MINUTE],
  [/今晚|今夜/, 12 * HOUR],
  [/明天|明早|明晚/, 36 * HOUR],
  [/后天/, 60 * HOUR],
  [/这周|本周|周末/, 5 * DAY],
  [/下周/, 8 * DAY],
  [/过几天|这几天|最近几天/, 4 * DAY],
];
// 情态词 → 默认主观概率
const MODAL_P = [
  [/一定|肯定|必然/, 0.9],
  [/会|应该|能|能够|可以|将/, 0.75],
  [/大概|可能|估计|或许|也许/, 0.6],
];

/**
 * 确定性预测抽取（零 LLM）：句中同时含时间词+情态词才算一条预测；疑问句不算；每段最多 2 条。
 * @param {string} text
 * @param {{now?: number}} [opts]
 * @returns {Array<{claim: string, p: number, dueAt: number}>}
 */
export function extractExpectations(text, { now = Date.now() } = {}) {
  const out = [];
  const segs = String(text || '').split(/[。！!\n；;]/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    if (out.length >= 2) break;
    if (/[?？]/.test(seg)) continue; // 疑问不是预测
    if (seg.length < 6 || seg.length > 80) continue;
    const time = TIME_DUE.find(([re]) => re.test(seg));
    if (!time) continue;
    const modal = MODAL_P.find(([re]) => re.test(seg));
    if (!modal) continue;
    const match = seg.match(time[0]);
    const offset = typeof time[1] === 'function' ? time[1](match || []) : time[1];
    if (!Number.isFinite(offset) || offset <= 0) continue;
    out.push({ claim: seg.slice(0, 120), p: modal[1], dueAt: now + offset });
  }
  return out;
}

export function createExpectationLedger({
  db = null,
  now = Date.now,
  expireDays = 7,            // 到期后再过 7 天没人裁决 → unresolvable 出账（不计分）
  similarityThreshold = 0.8, // 与未结算项过似 → 不重复入账
} = {}) {
  const getdb = () => db || getDb();

  /** 入账一条预测。重复（与未结算项过似）返回 null。 */
  function add({ claim, p = 0.7, dueAt = null, source = 'thought', verifiable = null } = {}) {
    const c = String(claim || '').trim().slice(0, 300);
    if (!c) return null;
    const prob = clamp(Number(p) || 0.7, 0.01, 0.99);
    try {
      const opens = open({ limit: 100 });
      if (opens.some((o) => textSimilarity(o.claim, c) >= similarityThreshold)) return null;
      // 步骤3（多模型安全方案）：verifiable 列(schema v14)存在且传了值才写——可检验性供步骤5 安全转 FAILED 的护栏；
      //   旧库无列退化为原 INSERT（沿用 brier 的 hasColumn 退化模式），零破坏。
      const hasVerifiable = verifiable != null && getdb().prepare('PRAGMA table_info(noe_expectations)').all().some((col) => col.name === 'verifiable');
      const r = hasVerifiable
        ? getdb().prepare('INSERT INTO noe_expectations(created_at, source, claim, p, due_at, verifiable) VALUES (?,?,?,?,?,?)')
          .run(now(), String(source).slice(0, 40), c, prob, dueAt ? Number(dueAt) : null, verifiable ? 1 : 0)
        : getdb().prepare('INSERT INTO noe_expectations(created_at, source, claim, p, due_at) VALUES (?,?,?,?,?)')
          .run(now(), String(source).slice(0, 40), c, prob, dueAt ? Number(dueAt) : null);
      return Number(r.lastInsertRowid);
    } catch { return null; }
  }

  /** 从文本（念头/对话）抽预测并入账。@returns {number} 入账条数 */
  function harvestFromText(text, { source = 'thought' } = {}) {
    let added = 0;
    try {
      for (const e of extractExpectations(text, { now: now() })) {
        if (add({ claim: e.claim, p: e.p, dueAt: e.dueAt, source }) != null) added++;
      }
    } catch { /* 抽取失败不阻断 */ }
    return added;
  }

  function open({ limit = 50 } = {}) {
    try {
      return getdb().prepare('SELECT * FROM noe_expectations WHERE resolved_at IS NULL ORDER BY id DESC LIMIT ?')
        .all(Math.max(1, Math.min(500, limit)));
    } catch { return []; }
  }

  /** 已到期待裁决（透视页"等你裁决"区数据源）。 */
  function due(t = now()) {
    try {
      return getdb().prepare('SELECT * FROM noe_expectations WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at ASC LIMIT 50').all(t);
    } catch { return []; }
  }

  /**
   * 结算：outcome=1 应验 / 0 落空 / null 判不了（不计分）。
   * surprise = -log2(p_实际结果)：高自信落空 → 大惊奇（注意力/反思素材的信号源）。
   */
  function resolve(id, outcome, t = now(), resolvedBy = 'auto') {
    try {
      const row = getdb().prepare('SELECT * FROM noe_expectations WHERE id = ? AND resolved_at IS NULL').get(id);
      if (!row) return null;
      let surprise = null;
      let oc = null;
      if (outcome === 1 || outcome === 0 || outcome === true || outcome === false) {
        oc = outcome ? 1 : 0;
        const pActual = oc === 1 ? row.p : 1 - row.p;
        surprise = -Math.log2(clamp(pActual, 0.001, 1));
      }
      // P2-F2：记裁决来源（owner=holdout 旁证 / auto=本地脑自评），供校准看板诚实分层、防把自评当客观校准。
      //   resolved_by 是 v13 新列；隔离/历史库（自建旧 schema 表）可能无此列，检测后退化为不写（不破坏）。
      const by = resolvedBy === 'owner' ? 'owner' : 'auto';
      const hasResolvedBy = Object.prototype.hasOwnProperty.call(row, 'resolved_by');
      if (hasResolvedBy) {
        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ?, resolved_by = ? WHERE id = ?').run(t, oc, surprise, by, id);
      } else {
        getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = ?, surprise = ? WHERE id = ?').run(t, oc, surprise, id);
      }
      return { ...row, resolved_at: t, outcome: oc, surprise, resolved_by: hasResolvedBy ? by : null };
    } catch { return null; }
  }

  /**
   * 步骤5（多模型安全方案）：判证脑「真判不出」时累加判证次数 + 记最近判证时刻。
   * 供 resolver「承诺类反复判不出 → 决定性判 FAILED」护栏用（judge_attempts≥阈值才允许转 FAILED，绝不靠单次定生死）。
   * judge_attempts/last_judged_at 是 schema v14 新列；旧/隔离库无列时退化为 no-op 返回 null（不破坏）。
   * @returns {number|null} 累加后的 judge_attempts；列不存在或失败返回 null
   */
  function bumpAttempts(id, t = now()) {
    try {
      const cols = getdb().prepare('PRAGMA table_info(noe_expectations)').all();
      const has = (n) => cols.some((c) => c.name === n);
      if (!has('judge_attempts')) return null;
      const setLast = has('last_judged_at') ? ', last_judged_at = ?' : '';
      const stmt = getdb().prepare(`UPDATE noe_expectations SET judge_attempts = COALESCE(judge_attempts, 0) + 1${setLast} WHERE id = ? AND resolved_at IS NULL`);
      if (setLast) stmt.run(t, id); else stmt.run(id);
      // 三方审查（维度A MINOR）：SELECT 同带 resolved_at IS NULL，使已 resolved 行返回 null——
      //   契约名实相符（返回非 null = 本次确实累加成功），杜绝"未来仅凭返回值≥阈值就动作"的复用方拿到 stale 高计数误判。
      const row = getdb().prepare('SELECT judge_attempts FROM noe_expectations WHERE id = ? AND resolved_at IS NULL').get(id);
      return row ? Number(row.judge_attempts) : null;
    } catch { return null; }
  }

  /** 扫账（心跳 micro 顺风车）：逾期 expireDays 没人裁决的自动 unresolvable 出账。@returns {number} */
  function sweep(t = now()) {
    try {
      return getdb().prepare('UPDATE noe_expectations SET resolved_at = ?, outcome = NULL, surprise = NULL WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at < ?')
        .run(t, t - expireDays * DAY).changes;
    } catch { return 0; }
  }

  /**
   * A2 前已入账的存量预测可能被旧天级默认值排得过晚。
   * 只在重新解析 claim 得到更早 dueAt 时回填，避免把历史账目往后推或改写已结算项。
   */
  function repairDueAtFromClaim({ dryRun = true, limit = 500 } = {}) {
    const max = Math.max(1, Math.min(2000, Number(limit) || 500));
    try {
      const rows = getdb().prepare('SELECT id, claim, created_at, due_at FROM noe_expectations WHERE resolved_at IS NULL ORDER BY id ASC LIMIT ?').all(max);
      const updates = [];
      for (const row of rows) {
        const createdAt = Number(row.created_at) || now();
        const parsed = extractExpectations(row.claim, { now: createdAt })[0];
        if (!parsed?.dueAt) continue;
        const oldDueAt = Number(row.due_at) || 0;
        if (oldDueAt && parsed.dueAt >= oldDueAt) continue;
        updates.push({
          id: Number(row.id),
          claim: String(row.claim || '').slice(0, 300),
          oldDueAt: oldDueAt || null,
          newDueAt: parsed.dueAt,
        });
      }
      if (!dryRun && updates.length) {
        const stmt = getdb().prepare('UPDATE noe_expectations SET due_at = ? WHERE id = ? AND resolved_at IS NULL');
        const tx = getdb().transaction((items) => {
          for (const item of items) stmt.run(item.newDueAt, item.id);
        });
        tx(updates);
      }
      return { ok: true, dryRun: dryRun !== false, scanned: rows.length, repaired: updates.length, updates };
    } catch (error) {
      return { ok: false, dryRun: dryRun !== false, scanned: 0, repaired: 0, updates: [], error: String(error?.message || error) };
    }
  }

  /** Brier 分（越低越准，0.25=瞎猜基线）+ 高自信命中率。只统计有明确 outcome 的。 */
  function brier({ sinceTs = 0 } = {}) {
    try {
      // CAL-10（三方复盘）：排除 source='step_prediction'——bridge 代填的伪预测（p 非 Neo 下注），不该当预测能力证据污染 Brier/自知之明。
      // P2-C（修三方审查 minor）：source 是后加列，旧/隔离库无此列时 source != 'step_prediction' 会抛错被 catch 吞成 n:0（违"仍出曲线不静默清零"）→ 检测后退化不过滤。
      const hasSource = getdb().prepare("PRAGMA table_info(noe_expectations)").all().some((c) => c.name === 'source');
      const sourceFilter = hasSource ? "AND source != 'step_prediction'" : '';
      const rows = getdb().prepare(`SELECT p, outcome FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL ${sourceFilter} AND created_at >= ?`).all(sinceTs);
      if (!rows.length) return { n: 0, brier: null, confidentN: 0, confidentHit: null };
      const brierSum = rows.reduce((s, r) => s + (r.p - r.outcome) ** 2, 0);
      const confident = rows.filter((r) => Math.max(r.p, 1 - r.p) >= 0.8);
      const confidentHits = confident.filter((r) => (r.p >= 0.5) === (r.outcome === 1)).length;
      return {
        n: rows.length,
        brier: Math.round((brierSum / rows.length) * 1000) / 1000,
        confidentN: confident.length,
        confidentHit: confident.length ? Math.round((confidentHits / confident.length) * 100) / 100 : null,
      };
    } catch { return { n: 0, brier: null, confidentN: 0, confidentHit: null }; }
  }

  /**
   * 校准曲线（P2 觉醒看板）：与 brier 同 resolved 口径，补 ECE/MCE + n-bin reliability。fail-open。
   * P2-F2：附 provenance 分层——owner 裁决是 Neo 改不到的 holdout 旁证，auto 是本地脑自评。
   *   全自评（ownerHoldoutN=0）时 selfEvaluated=true，看板必须警示「此 Brier 是自评、非客观校准」，
   *   否则 owner 会把自评刷出的漂亮分数误读为「Neo 校准好」（违背路线 §4.2 防 Goodhart 第一防线）。
   */
  function calibration({ sinceTs = 0, binCount = 10 } = {}) {
    const emptyProv = { ownerHoldoutN: 0, autoSelfN: 0, ownerBrier: null, selfEvaluated: true };
    try {
      // R3：resolved_by 是 v13 新列；自建/旧库无此列时退化为不分层（仍出曲线，不静默清零成 n:0）。
      // P2-C（修三方审查 minor）：source 同为后加列——缺它时 source != 'step_prediction' 过滤会抛错吞成 n:0，一并检测后退化不过滤。
      const colNames = getdb().prepare("PRAGMA table_info(noe_expectations)").all().map((c) => c.name);
      const hasResolvedBy = colNames.includes('resolved_by');
      const sourceFilter = colNames.includes('source') ? "AND source != 'step_prediction'" : ''; // CAL-10：伪预测排除校准口径
      const sql = hasResolvedBy
        ? `SELECT p, outcome, resolved_by FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL ${sourceFilter} AND created_at >= ?`
        : `SELECT p, outcome FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL ${sourceFilter} AND created_at >= ?`;
      const rows = getdb().prepare(sql).all(sinceTs);
      const curve = computeCalibrationCurve(rows, { binCount });
      if (!hasResolvedBy) {
        return { ...curve, provenance: { ownerHoldoutN: 0, autoSelfN: rows.length, ownerBrier: null, selfEvaluated: true } };
      }
      const ownerRows = rows.filter((r) => r.resolved_by === 'owner');
      const ownerCurve = ownerRows.length ? computeCalibrationCurve(ownerRows, { binCount }) : null;
      return {
        ...curve,
        provenance: {
          ownerHoldoutN: ownerRows.length,
          autoSelfN: rows.length - ownerRows.length,
          ownerBrier: ownerCurve ? ownerCurve.brier : null,
          // P2[1]（修三方审查 minor）：单票漏洞——1 条 owner 裁决不足关掉「自评主导」警示(头条 Brier 仍自评主导)；
          //   holdout 占比 <20% 仍标 selfEvaluated=true 保留前端警示，防 owner 误把自评分当客观校准(防 Goodhart)。
          selfEvaluated: ownerRows.length === 0 || (ownerRows.length / Math.max(1, rows.length)) < 0.2,
        },
      };
    } catch { return { n: 0, brier: null, ece: null, mce: null, bins: [], provenance: emptyProv }; }
  }

  /** 自知之明一行（注入自我状态/夜反思素材用）。无结算数据返回 ''。 */
  function calibrationNote({ sinceTs = now() - 30 * DAY } = {}) {
    const b = brier({ sinceTs });
    if (!b.n) return '';
    const grade = b.brier <= 0.15 ? '相当准' : b.brier <= 0.25 ? '一般' : '偏过度自信';
    return `近 30 天我对世界下过 ${b.n} 个判断，Brier ${b.brier}（${grade}）${b.confidentN ? `；高自信判断命中率 ${Math.round((b.confidentHit ?? 0) * 100)}%` : ''}`;
  }

  /** 最近账目（透视页数据源）。 */
  function history({ limit = 100 } = {}) {
    try {
      return getdb().prepare('SELECT * FROM noe_expectations ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(500, limit)));
    } catch { return []; }
  }

  return { add, harvestFromText, open, due, resolve, bumpAttempts, sweep, repairDueAtFromClaim, brier, calibration, calibrationNote, history };
}
