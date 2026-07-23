// @ts-check
// NoeAwakeningSignals — 觉醒候选信号 4 维采样（纯函数，P2 觉醒看板）。
//
// 从 scripts/noe-awakening-monitor.mjs 抽出的纯采样逻辑，供 CLI（手动/cron）与 server 心跳
//   （NOE_AWAKENING_SAMPLE 自动调度）共用，避免 server 反向依赖 scripts。
//
// 4 维「Neo 改不到的外部旁证」：
//   D1 预测-学习活性：surprise 目标数 + 研究完成率（学了改没改的漏斗末端代理）
//   D2 整合度 TC      ：kv noe.integration.reading（子系统耦合度，越高越整合）
//   D3 校准 Brier     ：全量 resolved 期望的 Brier（自知之明，越低越准）
//   D4 自发性         ：近 24h 内心独白条数 + 自主 active 目标数（source≠owner）
//
// 纪律：纯函数注入式（吃 readonly db handle + now，零 IO/零 process），可确定性单测。

const DAY = 86_400_000;
const SURPRISE_BIT_GATE = 2; // 与 NoeGoalSystem harvestSurprise 同源常量

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}
function columnExists(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
  catch { return false; }
}
function num(v) { return Math.max(0, Number(v) || 0); }
function round(v, p = 3) { const m = 10 ** p; return Math.round((Number(v) || 0) * m) / m; }

// events.ts 单位检测（毫秒 vs 秒）：>1e12 判毫秒，否则秒。让 24h 窗口在两种历史库上都准。
function detectTsUnitMs(db) {
  try {
    const maxTs = Number(db.prepare('SELECT MAX(ts) t FROM events').get()?.t || 0);
    return maxTs > 1e12;
  } catch { return true; }
}

// 读 kv（panel kv 表列名 k/v，v 为 JSON 字符串）。
function readKv(db, key) {
  try {
    const row = db.prepare('SELECT v FROM kv WHERE k=?').get(key);
    return row?.v ? JSON.parse(row.v) : null;
  } catch { return null; }
}

// D3 Brier：对齐 NoeExpectationLedger CAL-10 口径（readonly）。
function brierAll(db) {
  if (!tableExists(db, 'noe_expectations')) return { n: 0, brier: null, ownerN: 0, ownerBrier: null };
  try {
    // P2-A（修三方审查 serious，三方共识）：排除 source='step_prediction' 伪预测——bridge 代填、p 非 Neo 下注，
    //   计入会污染自知之明 Brier，与 NoeExpectationLedger.brier/calibration 的 CAL-10 口径对齐。
    //   P2-C：旧库无 source 列时退化不过滤（仍出 Brier，不因 SQL 抛错静默清零成 n:0）。
    const sourceFilter = columnExists(db, 'noe_expectations', 'source') ? "AND source != 'step_prediction'" : '';
    // 防 Goodhart（对齐 P2 校准看板）：resolved_by='owner' 的 holdout 子集是 Neo 改不到的旁证，单列防自评虚高。
    const hasResolvedBy = columnExists(db, 'noe_expectations', 'resolved_by');
    const cols = hasResolvedBy ? 'p, outcome, resolved_by' : 'p, outcome';
    const rows = db.prepare(`SELECT ${cols} FROM noe_expectations WHERE resolved_at IS NOT NULL AND outcome IS NOT NULL ${sourceFilter}`).all();
    if (!rows.length) return { n: 0, brier: null, ownerN: 0, ownerBrier: null };
    const brierOf = (rs) => round(rs.reduce((a, r) => a + (r.p - r.outcome) ** 2, 0) / rs.length);
    const ownerRows = hasResolvedBy ? rows.filter((r) => r.resolved_by === 'owner') : [];
    return {
      n: rows.length,
      brier: brierOf(rows),
      ownerN: ownerRows.length,
      ownerBrier: ownerRows.length ? brierOf(ownerRows) : null,
    };
  } catch { return { n: 0, brier: null, ownerN: 0, ownerBrier: null }; }
}

/**
 * 采一拍 4 维觉醒候选信号。注入式（db handle + now），便于单测。
 * @param {{ prepare: Function }} db readonly 句柄
 * @param {{ now?: number }} [opts]
 */
export function sampleAwakening(db, { now = Date.now() } = {}) {
  const sinceTs = now - 7 * DAY;
  const hasExpect = tableExists(db, 'noe_expectations');
  const hasGoals = tableExists(db, 'noe_goals');
  const hasEvents = tableExists(db, 'events');
  const c = (sql, ...a) => { try { return num(db.prepare(sql).get(...a)?.n); } catch { return 0; } };

  // D1 预测-学习活性（漏斗末端：够格落空 → 立研究 → 完成）
  // P2[0]（修三方审查 minor）：failedSurpriseEligible 排除 source='step_prediction' 伪预测，与同文件 D3 brierAll/账本 CAL-10
  //   同口径，否则 bridge 桥接的动作失败伪预测混进"预测-学习活性"虚高(同文件 D1/D3 口径自相矛盾)。旧库无 source 列退化不过滤。
  const failedSourceFilter = columnExists(db, 'noe_expectations', 'source') ? "AND source != 'step_prediction'" : '';
  const failedSurpriseEligible = hasExpect
    ? c(`SELECT COUNT(*) n FROM noe_expectations WHERE created_at >= ? AND outcome=0 AND surprise IS NOT NULL AND surprise >= ? ${failedSourceFilter}`, sinceTs, SURPRISE_BIT_GATE) : 0;
  const surpriseGoals = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND created_at >= ?", sinceTs) : 0;
  const surpriseGoalsDone = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE source='surprise' AND status='done' AND created_at >= ?", sinceTs) : 0;
  const d1 = {
    failedSurpriseEligible,
    surpriseGoals,
    surpriseGoalsDone,
    researchCompletionRate: surpriseGoals > 0 ? round(surpriseGoalsDone / surpriseGoals) : null,
  };

  // D2 整合度（kv 最新读数）
  const integ = readKv(db, 'noe.integration.reading');
  const d2 = integ && typeof integ === 'object'
    ? { integration: round(integ.integration), totalCorrelation: round(integ.totalCorrelation), samples: num(integ.samples), label: String(integ.label || '') }
    : { integration: null, totalCorrelation: null, samples: 0, label: '未采样' };

  // D3 校准
  const d3 = brierAll(db);

  // D4 自发性（内心独白活跃 + 自主目标；非 owner 塞的才算自发）
  const tsMs = detectTsUnitMs(db);
  const dayAgo = tsMs ? now - DAY : Math.floor((now - DAY) / 1000);
  const monologue24h = hasEvents ? c("SELECT COUNT(*) n FROM events WHERE kind='noe_self_talk_audit' AND ts >= ?", dayAgo) : 0;
  const episode24h = hasEvents ? c("SELECT COUNT(*) n FROM events WHERE kind='noe_episode' AND ts >= ?", dayAgo) : 0;
  const activeSelfGoals = hasGoals ? c("SELECT COUNT(*) n FROM noe_goals WHERE status IN ('open','active') AND source != 'owner'") : 0;
  const d4 = { monologue24h, episode24h, activeSelfGoals };

  return {
    schemaVersion: 1,
    ts: now,
    iso: new Date(now).toISOString(),
    liveDbMutated: false,
    dimensions: {
      d1_predictionLearning: d1,
      d2_integration: d2,
      d3_calibration: d3,
      d4_spontaneity: d4,
    },
    source: { policy: 'read-only SELECT on live panel.db (readonly handle); no writes, no model calls, no network' },
  };
}
