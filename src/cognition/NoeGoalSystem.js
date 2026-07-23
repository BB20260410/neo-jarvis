// @ts-check
// NoeGoalSystem — 自主目标系统（设计文档《AI自我意识实现方案》§8 P5）。
//
// 问题：驱力只产生"想要"的感觉（brief 一行字），反刍升华只产生"牵挂"（承诺），Noe 没有
//   "想要什么 → 列为目标 → 排优先级 → 一步步推进 → 完成"的回路——想法永远不落成持续行动。
// 设计：noe_goals 表（迁移 v7）持久化目标 {title, source, why, priority, plan(JSON 步骤数组)}；
//   确定性仲裁公式（零 LLM）每个认知周期重排：
//     priority = 0.5·来源权重 + 0.2·新鲜度 + 0.2·可行性(有步骤) + 0.1·推进动量(最近有步骤完成)
//   同时 active ≤ 2；活跃目标的下一步进工作区当候选（goal_step）——赢得注意力才被推进，
//   推进方式 = 深思审议产出进展笔记（P5 是"思考级执行"，外部工具执行接 act 管线留下阶段）。
// 好奇回路 v1：高惊奇（落空的自信预测，surprise ≥ 2 bit）→ 自动生成"搞明白为什么"的研究目标
//   （NOE_CURIOSITY=1 门控）——被现实打脸的地方就是最该学习的地方。
// 纪律：全注入可测；fail-open；owner 显式目标永远压过自生目标（来源权重 1.0 vs ≤0.6）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/SqliteStore.js';
import { appendGoalCheckpoint, latestGoalCheckpoint, listGoalCheckpoints } from './NoeGoalCheckpoints.js';
import { BLOCKING_STEP_STATUSES, recordGoalStepResult } from './NoeGoalStepRecorder.js';
import { recoverRetriableBlockedGoalSteps, recoverStaleGoalSteps } from './NoeGoalStepRecovery.js';
import { NOE_LEARNING_TOPICS, learningTopicAtCursor, selectLearningTopicForText, collectLearningConcepts } from './NoeLearningTopics.js';
import { createCuriosityDecompose } from './NoeCuriosityDecompose.js';
import { clamp01 } from './_mathUtils.js';

const SOURCE_WEIGHT = Object.freeze({
  owner: 1.0,        // 主人显式交办
  system_repair: 0.95, // Noe 自己检测到系统故障后的自修复目标（低于 owner，高于普通自生）
  self_evolution: 0.9, // 环2：Noe 自发的自我进化目标（改自身代码）；高于普通自生，低于系统自修复
  commitment: 0.8,   // 自生承诺升格
  reflection: 0.6,   // 深思审议提出
  surprise: 0.55,    // 好奇回路（被现实打脸）
  self_learning: 0.65, // 自主学习循环：主动上网 + 读本地证据
  drive: 0.4,        // 驱力压力
  self: 0.5,         // 其他自生
});
const DAY = 86_400_000;
const AUTONOMY_EMPTY_GOAL_RE = /自主|主动|自我|学习|优化|迭代|agi|agent|智能体|noe|neo|贾维斯|jarvis|行动|执行|上网|浏览器|电脑|操控|意识|内心|思考/i;
const BACKLOG_EXEMPT_SOURCES = new Set(['owner', 'system_repair', 'self_learning', 'self_evolution', 'surprise']);
// P1 attend 保底配额：学习类来源——被 system_repair(权重0.95)长期霸占 active 队列时，保底给它们 1 个名额，
//   让 research 步真有机会夺冠 attend（治"system_repair 垄断、research 跑不动"）。
const LEARNING_QUOTA_SOURCES = new Set(['self_learning', 'surprise']);
// 步骤2（多模型安全方案·接真 Goodhart 门）：非噪声 surprise origin 白名单（与 NoeExpectationResolver.isNonNoiseSurpriseOrigin 同口径）——
//   只有外部锚的真负反馈(owner_*/action_failure/world_model_conflict)才算「真该学的认知缺口」；reflection_miss/loosen_fail/
//   expectation_miss(Neo 自评/深思虚构任务/内省念头落空)是噪声。NOE_CURIOSITY_ORIGIN_GATE=1 时 harvestSurprise 只放行白名单。
const NON_NOISE_ORIGIN_RE = /^owner_|^action_failure$|^world_model_conflict$/;

function parsePlan(s) {
  try { const p = JSON.parse(s || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

// 解析 goal.meta 列（JSON object）。空/损坏 → null（fail-open：脏元信息绝不污染目标读取）。
function parseMeta(s) {
  if (s == null) return null;
  try { const m = JSON.parse(s); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : null; } catch { return null; }
}

// 默认 pragmatic 信号源：claim 与当前 open/active 目标（排除 surprise 自身源）标题+why 的关键词重叠度 → [0,1]。
// 含义=「这条惊奇有多贴我此刻正在做/在意的事」。诚实地说这是个弱信号（活跃目标稀疏、可能为空），
// 但确定性、自包含、零新依赖；装配方可经 pragmaticSignal 注入更强源（owner 近期话题 / person 偏好）替换。
const CURIOSITY_STOPWORDS = new Set(['的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '这', '那', '为', '会', '要', '到', '把', '被', '让', '没', '不', '也', '都', '就', 'the', 'a', 'an', 'is', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'why', 'how', 'what']);
function extractKeywords(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  // 英文/数字词
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) if (!CURIOSITY_STOPWORDS.has(w)) out.add(w);
  // 中文：取连续 2 字 bigram（无分词器下最稳的重叠粒度），跳停用字
  const cjk = s.match(/[一-龥]+/g) || [];
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!CURIOSITY_STOPWORDS.has(bg[0]) && !CURIOSITY_STOPWORDS.has(bg[1])) out.add(bg);
    }
  }
  return out;
}
function keywordOverlap(aText, bText) {
  const a = extractKeywords(aText);
  if (!a.size) return 0;
  const b = extractKeywords(bText);
  if (!b.size) return 0;
  let hit = 0;
  for (const k of a) if (b.has(k)) hit++;
  return Math.min(1, hit / a.size); // 以 claim 关键词为分母：claim 中多少比例命中当前目标语境
}

export function createGoalSystem({
  db = null,
  now = Date.now,
  maxActive = 2,
  maxBacklog = 8,    // open+active 总数上限：自生目标（非 owner）超限不再收——实机教训：深思立项会上瘾
  staleDays = 14,    // 两周无推进的自生目标自动 paused（防目标库淤积）
  staleStepMs = 6 * 3600_000, // doing 超过该窗口自动释放为 recovered，防目标永久卡死；不会重放动作
  staleResearchStepMs = 90_000, // 后台研究常见由进程重启/请求丢失导致 orphan doing，不能长时间挡住自主行动链
  staleActStepMs = 5 * 60_000,       // 真实 act 执行器多数有 30s 超时；几分钟无 evidence 就该释放后续步骤
  driveLevel = null, // M15（Active Inference 方向第一步）：()=>0..1 最强驱力强度——drive 源目标的权重随"想要的程度"浮动
  // 行动步开关（意识工程 Phase3，2026-06-11）：kind:'act' 步骤（目标长出"安全的手"，经 ActPipeline
  // 完整门控执行）。默认随 NOE_GOAL_ACT；关闭时 act 解析回落 think（想而不动，行为零差异）。
  // 只认显式 {kind:'act'} 对象——文本推断永不产 act（自然语言不该意外变成执行）。
  allowActKind = process.env.NOE_GOAL_ACT === '1',
  autonomousLearning = process.env.NOE_AUTONOMOUS_LEARNING === '1',
  learningIntervalMs = Math.max(60_000, Number(process.env.NOE_AUTONOMOUS_LEARNING_INTERVAL_MS) || 30 * 60_000),
  continuousLearning = process.env.NOE_AUTONOMOUS_LEARNING_CONTINUOUS === '1',
  // 好奇二分解（NoeCuriosityDecompose 接入，env NOE_EFE_CURIOSITY，默认 OFF）：注入 createCuriosityDecompose()
  //   实例；未注入则惰性按 env 建。enabled=false 时 harvestSurprise 与改造前逐字等价（不写 meta，零回归）。
  curiosity = null,
  // pragmatic 信号源（DI）：(claim) => { value:[0,1], source:string }。默认 = 与当前 open/active 目标关键词重叠。
  //   装配方可换更强源（owner 近期话题 / person 偏好）。返回非法/抛异常 → 退化 value=0（fail-open）。
  pragmaticSignal = null,
  // S0.7（GEPA 可优化对象）：好奇回路立项的 surprise 阈值（bit）抽成注入式参数。
  //   opts 缺省读 env NOE_WS_SALIENCE_SURPRISE_BIT，env 也无则用原硬编码默认 2（surprise≥2bit 才立研究目标）。
  //   不配置时与改造前逐字等价（门槛仍为 2，零行为变化）。本步只抽参不改默认。
  curiositySurpriseThreshold = Number.isFinite(Number(process.env.NOE_WS_SALIENCE_SURPRISE_BIT))
    ? Number(process.env.NOE_WS_SALIENCE_SURPRISE_BIT)
    : 2,
  // 阶段3 动态选题（治 cursor%6 循环）：注入 NoeTopicCurator 实例。NOE_DYNAMIC_TOPICS=1 且注入时启用
  //   饱和冷却 + round-robin 跳过已学够的；OFF 或未注入则逐字回退 learningTopicAtCursor(cursor%6) 零回归。
  topicCurator = null,
  // P1.2 P10：动态发现的研究主题（NoeTopicDiscovery，带 evidence/source/score）注入点——
  //   callable () => Array<{title,url,query,source,evidence,score}>。server.js 装配 createTopicDiscovery
  //   (kg/goalSystem/commitment 三源)并以闭包注入(避循环依赖)；默认 null=只静态 seed(零回归)。
  discoverDynamicTopics = null,
  // P1 attend 保底配额（NOE_ATTEND_LEARNING_QUOTA，默认 OFF）：arbitrate 选 active 时保底给学习类 1 个名额，
  //   防 system_repair 长期霸占 maxActive 饿死 self_learning/research。注入式以便单测，默认读 env。
  attendLearningQuota = process.env.NOE_ATTEND_LEARNING_QUOTA === '1',
  // P1-A system_repair 冷却去重（NOE_SYSTEM_REPAIR_COOLDOWN_MS，默认 0=关）：同 title system_repair 冷却窗内(含已 done)不重立。
  repairCooldownMs = Math.max(0, Number(process.env.NOE_SYSTEM_REPAIR_COOLDOWN_MS) || 0),
} = {}) {
  const getdb = () => db || getDb();
  const rowOut = (r) => r ? { ...r, plan: parsePlan(r.plan), meta: parseMeta(r.meta) } : null;
  // 惰性建好奇二分解实例（按 env 门控）；显式注入优先。
  const curiosityDecompose = curiosity || createCuriosityDecompose();

  // 默认 pragmatic 信号：claim 与当前 open/active 目标（剔除 surprise 自身源，避免自指）语境的关键词重叠。
  function defaultPragmaticSignal(claim) {
    try {
      const rows = getdb().prepare("SELECT title, why, source FROM noe_goals WHERE status IN ('open','active')").all();
      // 价值对齐（D）：owner 交办的目标(source='owner')最反映 owner 当下价值，权重 1.0；其他 open 目标次之(0.5)；
      //   surprise 自身源剔除避免自指。取加权 max → owner 在意的研究主题 pragmatic 分更高、优先被有限学习预算选中。
      const ownerCorpus = rows.filter((r) => r.source === 'owner').map((r) => `${r.title || ''} ${r.why || ''}`).join(' ');
      const otherCorpus = rows.filter((r) => r.source !== 'surprise' && r.source !== 'owner').map((r) => `${r.title || ''} ${r.why || ''}`).join(' ');
      const ownerVal = ownerCorpus ? keywordOverlap(claim, ownerCorpus) : 0;
      const otherVal = otherCorpus ? keywordOverlap(claim, otherCorpus) * 0.5 : 0;
      const value = Math.max(ownerVal, otherVal);
      return { value, source: ownerVal >= otherVal && ownerVal > 0 ? 'owner-goals' : 'active-goals' };
    } catch { return { value: 0, source: 'active-goals' }; }
  }

  function shortGoalTitle(g) {
    return String(g?.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function selectLearningTopicForGoal(g) {
    return selectLearningTopicForText(`${g?.title || ''} ${g?.why || ''}`);
  }

  function buildEmptyAutonomyGoalPlan(g) {
    const titleText = String(g?.title || '');
    const whyText = String(g?.why || '');
    const source = String(g?.source || '');
    // P1[1]（修三方审查 serious）：owner 交办的空计划目标仅当 why 明确授权自主才走上网 act 链；只凭 title 含
    //   "学习/优化/思考"等普通词不触发——否则 owner 普通交办(如"学习英语")被语义篡改成"上网研究 AI-agent"并真发起联网研究。
    //   纯缩窄正则无法区分 owner"学习英语"vs Neo"自主学习"(都含"学习")，故用 source 守卫；Neo 自主源
    //   (reflection/self_learning/drive/self_evolution 等)立的空计划仍按原宽口径自主拆解，零回归。
    const titleTriggers = AUTONOMY_EMPTY_GOAL_RE.test(titleText) && source !== 'owner';
    const whyIsExplicitAutonomyAsk = /主人|owner|授权|交办|要求|目标/i.test(whyText) && AUTONOMY_EMPTY_GOAL_RE.test(whyText);
    if (!titleTriggers && !whyIsExplicitAutonomyAsk) return null;
    const title = shortGoalTitle(g);
    const topic = selectLearningTopicForGoal(g);
    const scanArgs = ['-n', '-i', '--max-count', '100', '--glob', '!games/cartoon-apocalypse/**', topic.localPattern, ...topic.localPaths];
    return [
      { step: `上网搜索并学习：${topic.query}`, kind: 'research' },
      {
        step: '把 Google Chrome 拉到前台，给后续网页学习和 DOM 观察一个真实电脑上下文',
        kind: 'act',
        action: 'macos.app.activate',
        payload: { app: 'Google Chrome', timeoutMs: 10000 },
      },
      {
        step: `打开低风险资料页，获得真实网页上下文：${topic.url}`,
        kind: 'act',
        action: 'browser.open_url',
        payload: { url: topic.url, timeoutMs: 30000 },
      },
      {
        step: '读取浏览器前台 URL/title，确认外部学习页面已打开',
        kind: 'act',
        action: 'browser.state_probe',
        payload: { includeAll: false },
      },
      {
        step: '只读观察当前网页：读标题 + 提取正文，把页面内容变成可学习证据',
        kind: 'act',
        action: 'browser.observe_page',
        payload: {
          browserApp: 'Google Chrome',
          url: topic.url,
          expectedHost: new URL(topic.url).host,
          expectedHosts: [new URL(topic.url).host],
          // L3：read_title + read_body——不再"只开不读"，真提取正文供深思学习（治 owner 实证的浏览器空转）。
          actions: [{ type: 'read_title' }, { type: 'read_body' }],
        },
      },
      {
        step: `只读扫描本项目代码，找出阻碍「${title}」落地的限制点`,
        kind: 'act',
        action: 'shell.exec',
        payload: {
          command: 'rg',
          args: scanArgs,
          readonly: true,
          diagnosticDomains: ['empty_goal_bootstrap', 'autonomy'],
          timeoutMs: 30000,
        },
      },
      {
        step: `写入本地自治笔记，记录「${title}」已从愿望变成行动链`,
        kind: 'act',
        action: 'noe.note.write',
        payload: {
          path: 'output/noe-autonomy/goal-bootstrap.md',
          content: `空计划目标自动拆解：${title}\n学习主题：${topic.title}\n资料入口：${topic.url}\n本地诊断：${['rg', ...scanArgs].join(' ')}\n下一步：结合网页、浏览器状态和本地扫描结果，继续推进真实改进。`,
        },
      },
      { step: '结合外部学习和本地证据，决定下一处要改进的代码或配置并继续执行', kind: 'think' },
    ];
  }

  function buildGenericEmptyGoalPlan(g) {
    const title = shortGoalTitle(g) || '这个目标';
    return [
      { step: `明确「${title}」的成功判据：完成后必须能看到什么证据`, kind: 'think' },
      { step: `整理「${title}」的已知事实、未知缺口和现实约束`, kind: 'think' },
      { step: `选出推进「${title}」的最小下一步，并说明如何验证`, kind: 'think' },
      { step: `复盘「${title}」是否已推进，必要时把下一轮动作重新拆成步骤`, kind: 'think' },
    ];
  }

  function stepOutputFromGoal(g, idx) {
    const st = g.plan[idx];
    const priorNotes = g.plan.slice(0, idx)
      .filter((s) => s.note)
      .slice(-3)
      .map((s) => `${String(s.step || '').slice(0, 60)}：${String(s.note || '').slice(0, 220)}`);
    return {
      goalId: g.id,
      title: g.title,
      stepIndex: idx,
      step: st.step,
      kind: st.kind || 'think',
      priority: g.priority,
      ...(priorNotes.length ? { priorNotes } : {}),
      ...(st.kind === 'act' ? { actionSpec: { action: st.action || null, payload: st.payload || null } } : {}),
    };
  }

  function bootstrapEmptyGoalPlan(g) {
    const newSteps = buildEmptyAutonomyGoalPlan(g) || buildGenericEmptyGoalPlan(g);
    if (!newSteps?.length) return null;
    const isAutonomyPlan = newSteps.some((s) => s?.kind === 'act' || s?.kind === 'research');
    const res = recordStepResult(g.id, -1, {
      note: isAutonomyPlan
        ? '空计划自主目标自动拆解：避免长期停在“想清楚第一步”，直接长出 research/browser/shell/note/think 行动链。'
        : '空计划目标自动拆解：避免长期停在“想清楚第一步”，先长出保守 think 计划。',
      newSteps,
    });
    if (!res.ok) return null;
    return get(g.id);
  }

  /**
   * 立一个目标。steps 元素可为字符串（默认 kind=think）或 {step, kind}；
   * kind: 'think'（深思推进）| 'research'（真上网研究——M6 的"手"）。
   * @returns {string|null} goalId
   */
  function add({ title, source = 'self', why = '', steps = [], budget = null, meta = null } = {}) {
    const t = String(title || '').trim().slice(0, 200);
    if (!t) return null;
    try {
      // 同名未关目标去重（防好奇回路重复立项）
      const dup = getdb().prepare("SELECT id FROM noe_goals WHERE title = ? AND status IN ('open','active')").get(t);
      if (dup) return null;
      // P1-A system_repair 冷却去重（repairCooldownMs，默认 0=关）：同 title system_repair 在冷却窗内(含已 done)不重立，
      //   治 IncidentEscalator 反复检测同一故障→诊断 done→去重不挡→重立的刷量(实证 92/24h)。冷却窗过后真故障复发仍能立。
      if (repairCooldownMs > 0 && source === 'system_repair') {
        const since = now() - repairCooldownMs;
        const recent = getdb().prepare("SELECT 1 FROM noe_goals WHERE title = ? AND source = 'system_repair' AND created_at >= ? LIMIT 1").get(t, since);
        if (recent) return null;
      }
      // 防立项上瘾（实机教训）：普通自生目标在积压达上限后不再收；豁免源保留关键 owner/repair/learning/surprise 燃料。
      if (!BACKLOG_EXEMPT_SOURCES.has(source)) {
        const cnt = getdb().prepare("SELECT COUNT(*) n FROM noe_goals WHERE status IN ('open','active')").get();
        if ((cnt?.n || 0) >= maxBacklog) return null;
      }
      const id = randomUUID();
      const plan = (Array.isArray(steps) ? steps : []).filter(Boolean).slice(0, 12)
        .map((s) => {
          if (s && typeof s === 'object') {
            const kind = s.kind === 'research' ? 'research' : (s.kind === 'act' && allowActKind) ? 'act' : 'think';
            return {
              step: String(s.step || '').slice(0, 200),
              kind,
              status: 'open',
              note: '',
              updatedAt: now(),
              // act 步可带 ActPipeline 动作规格（action 名 + payload）；无规格的 act 步由装配方给默认动作
              ...(kind === 'act' && s.action ? { action: String(s.action).slice(0, 160) } : {}),
              ...(kind === 'act' && s.payload && typeof s.payload === 'object' ? { payload: s.payload } : {}),
            };
          }
          return { step: String(s).slice(0, 200), kind: /搜|查资料|研究|调研|search|research/i.test(String(s)) ? 'research' : 'think', status: 'open', note: '', updatedAt: now() };
        })
        .filter((s) => s.step);
      // meta：可解释元信息（如 meta.curiosity）。仅 object 时序列化，否则存 NULL（OFF 路径不传 → 列保持 NULL，零回归）。
      let metaJson = null;
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        try { metaJson = JSON.stringify(meta); } catch { metaJson = null; }
      }
      getdb().prepare('INSERT INTO noe_goals(id, created_at, source, title, why, priority, status, plan, budget, updated_at, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, now(), String(source).slice(0, 30), t, String(why || '').slice(0, 500), 0, 'open', JSON.stringify(plan), budget ? JSON.stringify(budget) : null, now(), metaJson);
      appendGoalCheckpoint(getdb(), { now, goalId: id, stepIndex: -1, phase: 'goal_created', status: 'open', step: t, note: why, payload: { source, stepCount: plan.length }, replaySafe: true });
      return id;
    } catch { return null; }
  }

  function get(id) {
    try { return rowOut(getdb().prepare('SELECT * FROM noe_goals WHERE id = ?').get(id)); } catch { return null; }
  }

  function list({ status = null, limit = 100 } = {}) {
    try {
      const lim = Math.max(1, Math.min(500, limit));
      const rows = status
        ? getdb().prepare('SELECT * FROM noe_goals WHERE status = ? ORDER BY priority DESC, updated_at DESC LIMIT ?').all(status, lim)
        : getdb().prepare('SELECT * FROM noe_goals ORDER BY priority DESC, updated_at DESC LIMIT ?').all(lim);
      return rows.map(rowOut);
    } catch { return []; }
  }

  // P1-C 整改 F3：surprise 来源运行时分桶（验收门 b 消费端）——区分 owner+action 非噪声 vs loosen_fail/expectation_miss 等噪声。
  function surpriseOriginBreakdown({ limit = 500 } = {}) {
    try {
      const lim = Math.max(1, Math.min(2000, limit));
      const rows = getdb().prepare("SELECT meta FROM noe_goals WHERE source = 'surprise' ORDER BY created_at DESC LIMIT ?").all(lim);
      const byOrigin = {};
      let nonNoise = 0;
      const isNonNoise = (o) => /^owner_|^action_failure$|^world_model_conflict$/.test(String(o || ''));
      for (const r of rows) {
        const origin = parseMeta(r.meta)?.origin || 'unspecified';
        byOrigin[origin] = (byOrigin[origin] || 0) + 1;
        if (isNonNoise(origin)) nonNoise += 1;
      }
      return { total: rows.length, nonNoise, noise: rows.length - nonNoise, byOrigin };
    } catch { return { total: 0, nonNoise: 0, noise: 0, byOrigin: {} }; }
  }

  function setStatus(id, status) {
    if (!['open', 'active', 'paused', 'done', 'dropped'].includes(status)) return false;
    try { return getdb().prepare('UPDATE noe_goals SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id).changes > 0; } catch { return false; }
  }

  function latestGoalBySource(source) {
    try {
      return rowOut(getdb().prepare('SELECT * FROM noe_goals WHERE source = ? ORDER BY created_at DESC LIMIT 1').get(source));
    } catch { return null; }
  }

  function activeCountBySource(source) {
    try {
      return Number(getdb().prepare("SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND status IN ('open','active')").get(source)?.n || 0);
    } catch { return 0; }
  }

  // 滚动窗口内某来源立的目标数（每日研究预算闸用）。sinceMs = 窗口起点时间戳。
  function recentCountBySource(source, sinceMs) {
    try {
      return Number(getdb().prepare("SELECT COUNT(*) n FROM noe_goals WHERE source = ? AND created_at >= ?").get(source, sinceMs)?.n || 0);
    } catch { return 0; }
  }

  function goalCountBySource(source) {
    try {
      return Number(getdb().prepare('SELECT COUNT(*) n FROM noe_goals WHERE source = ?').get(source)?.n || 0);
    } catch { return 0; }
  }

  /**
   * 自主学习种子：让 Noe 在没有 owner 追问、也没有惊奇结算时，仍会周期性主动上网学习
   * 与自己短板有关的社区经验，并用只读本地诊断把外部学习落回代码事实。
   */
  function maybeSeedAutonomousLearning(t = now()) {
    if (!autonomousLearning) return null;
    try {
      if (activeCountBySource('self_learning') > 0) return null;
      // 每日研究预算闸（治 self_learning 失控：实证 7天230次 / 历史累积357次）：滚动 24h 内已立 self_learning ≥ 预算则不立，
      //   把有限学习配额留给好奇/发现驱动的真自主学习。NOE_LEARNING_DAILY_BUDGET 未设(0)=不限、逐字零回归。
      const dailyBudget = Math.max(0, Math.floor(Number(process.env.NOE_LEARNING_DAILY_BUDGET) || 0));
      if (dailyBudget > 0 && recentCountBySource('self_learning', t - 24 * 3600 * 1000) >= dailyBudget) return null;
      const last = latestGoalBySource('self_learning');
      // continuousLearning：上一轮 self_learning 已完成且没有活跃学习目标时，立即接下一轮。
      // 这让自主学习变成“完成判据驱动的连续链”，而不是被创建时间间隔硬卡住；仍由 activeCount 防重入。
      const lastDone = last?.status === 'done';
      if (last && !(continuousLearning && lastDone) && t - Number(last.created_at || 0) < learningIntervalMs) return null;
      const topicCursor = continuousLearning ? goalCountBySource('self_learning') : Math.abs(Math.floor(t / Math.max(1, learningIntervalMs)));
      // 阶段3：动态选题器在场则用它（饱和冷却 + 跳过已学够的，治 6 主题死循环）；否则逐字回退 cursor%6。
      let topic;
      let shouldRecordVisit = false;
      if (process.env.NOE_DYNAMIC_TOPICS === '1' && topicCurator?.getNextTopic) {
        try {
          // 喂 dynamicConcepts（24 个具体项目）治「一直搜那几个总览页」：选题从 6 种子扩到种子+具体项目，
          //   getNextTopic 饱和冷却在其中轮转，优先没学过的→搜的网页真正多样化（owner 2026-06-18 实证根因）。
          // P1.2 P10：静态 seed + 动态发现(NoeTopicDiscovery，带 evidence/source/score)并入；
          //   getNextTopic 整对象透传不剥 evidence；动态源抛错不阻断选题(fail-open 回退纯静态)。
          const dynamicTopics = (() => { try { return (typeof discoverDynamicTopics === 'function' ? discoverDynamicTopics() : []) || []; } catch { return []; } })();
          // TopicDiscovery 真发现的种子排在静态 48 concepts 之前（Codex P0#2：curator pool = [seeds, ...dynamicConcepts].slice(poolCap)
          //   会截断尾部，静态 concepts 在前会把动态发现种子挤出候选池→点了发现器也选不到真自主发现的主题）。
          const picked = topicCurator.getNextTopic({ dynamicConcepts: [...dynamicTopics, ...collectLearningConcepts()], dynamicPriority: process.env.NOE_TOPIC_DYNAMIC_PRIORITY === '1' });
          topic = picked?.topic || learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS);
          shouldRecordVisit = true; // recordVisit 延后到 add 成功后（Codex P0：先 record 会把建 goal 失败的动态 topic 污染进访问账本）
        } catch { topic = learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS); }
      } else {
        topic = learningTopicAtCursor(topicCursor, NOE_LEARNING_TOPICS);
      }
      const _learningGoalId = add({
        title: `自主学习：${topic.title}`,
        source: 'self_learning',
        why: '自主学习循环：即使主人没有追问，我也要主动搜索社区经验，并读本地代码证据，把学习变成下一步行动。',
        steps: [
          { step: `上网搜索并学习：${topic.query}`, kind: 'research' },
          {
            step: '把 Google Chrome 拉到前台，确认我能主动操控本机应用，而不只是写计划',
            kind: 'act',
            action: 'macos.app.activate',
            payload: {
              app: 'Google Chrome',
              timeoutMs: 10000,
            },
          },
          {
            step: `打开一个低风险资料页继续观察：${topic.url}`,
            kind: 'act',
            action: 'browser.open_url',
            payload: {
              url: topic.url,
              timeoutMs: 30000,
            },
          },
          {
            step: '读取浏览器前台 URL/title 元数据，确认资料页是否已经打开',
            kind: 'act',
            action: 'browser.state_probe',
            payload: {
              includeAll: false,
            },
          },
          {
            step: '用 DOM 只读观察当前页面：读标题 + 提取正文，确认真读到内容而非只打开',
            kind: 'act',
            action: 'browser.observe_page',
            payload: {
              browserApp: 'Google Chrome',
              url: topic.url,
              expectedHost: new URL(topic.url).host,
              expectedHosts: [new URL(topic.url).host],
              // L3：read_title + read_body——真提取正文供深思学习（治浏览器空转）。
              actions: [{ type: 'read_title' }, { type: 'read_body' }],
            },
          },
          {
            step: `为「${topic.title}」生成下一步浏览器/GUI 操作预演计划`,
            kind: 'act',
            action: 'visual.action.plan',
            payload: {
              goal: `基于已打开的资料页，规划下一步如何查找与「${topic.title}」相关的工程证据`,
              surface: 'browser',
              domSummary: 'unknown until browser state / DOM evidence is provided',
            },
          },
          {
            step: `只读扫描本项目相关代码，找出与「${topic.title}」有关的真实限制点`,
            kind: 'act',
            action: 'shell.exec',
            payload: {
              command: 'rg',
              // localPattern/localPaths 安全兜底（Codex P0：动态 topic 只有 {title,url,query} 无这俩字段，
              //   原 `...topic.localPaths`(undefined) 直接 TypeError → self_learning 静默立项失败）。动态主题用 title 当扫描词、默认扫 src。
              args: ['-n', '-i', '--max-count', '80', '--glob', '!**/.env*', '--glob', '!**/*token*', '--glob', '!**/*cookie*', '--glob', '!**/room-adapters.json', '--glob', '!games/cartoon-apocalypse/**', topic.localPattern || String(topic.title || '').slice(0, 40), ...(Array.isArray(topic.localPaths) ? topic.localPaths : ['src'])],
              readonly: true,
              diagnosticDomains: ['autonomous_learning'],
              timeoutMs: 30000,
            },
          },
          {
            step: `把「${topic.title}」的自主学习进展写入本地自治笔记`,
            kind: 'act',
            action: 'noe.note.write',
            payload: {
              path: 'output/noe-autonomy/learning.md',
              content: `自主学习主题：${topic.title}\n学习查询：${topic.query}\n资料入口：${topic.url}\n下一步：结合前序 research 和只读诊断结果，在目标思考步里形成可执行改进。`,
            },
          },
          { step: '结合外部学习和本地证据，写出一个可执行的下一步改进方案', kind: 'think' },
        ],
      });
      // recordVisit 延后到 add 成功后（Codex P0：先 record 会把建 goal 失败的动态 topic 污染进访问账本）。
      if (_learningGoalId && shouldRecordVisit) { try { topicCurator.recordVisit(topic); } catch { /* 记访问失败不阻断 */ } }
      return _learningGoalId;
    } catch { return null; }
  }

  /** 确定性仲裁：重算 open/active 优先级 → 激活 top-N、降级出局者、stale 自动 paused。 */
  function arbitrate(t = now()) {
    try {
      maybeSeedAutonomousLearning(t);
      closeResolvedGoals(t);
      const rows = getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
      const upd = getdb().prepare('UPDATE noe_goals SET priority = ?, status = ?, updated_at = ? WHERE id = ?');
      const scored = rows.map((g) => {
        // M15：drive 源权重随当下驱力强度浮动（0.25..0.55）——"多想要"决定"多优先"；探针炸了用静态档
        let sw = SOURCE_WEIGHT[g.source] ?? 0.5;
        if (g.source === 'drive' && typeof driveLevel === 'function') {
          try { sw = 0.25 + 0.3 * clamp01(Number(driveLevel()) || 0); } catch { /* 静态档兜底 */ }
        }
        const ageDays = (t - g.created_at) / DAY;
        const fresh = clamp01(1 / (1 + ageDays / 7));
        const feasible = g.plan.length ? 1 : 0.5;
        const lastTouchDays = (t - g.updated_at) / DAY;
        const momentum = g.plan.some((s) => s.status === 'done') && lastTouchDays < 3 ? 1 : 0;
        const stale = g.source !== 'owner' && lastTouchDays > staleDays;
        const priority = Math.round((0.5 * sw + 0.2 * fresh + 0.2 * feasible + 0.1 * momentum) * 1000) / 1000;
        return { g, priority, stale };
      }).sort((a, b) => b.priority - a.priority);
      // P1 attend 保底配额：flag ON 时先把最高优先的学习类(self_learning/surprise)保底放进 active(占 1 名额)，
      //   再按优先级填满其余；防 system_repair 长期霸占 maxActive 饿死 research。flag OFF 时 activeIds 初始为空，
      //   纯按优先级填满 → 与原"top maxActive 设 active"逐字等价（零回归）。
      const eligible = scored.filter((s) => !s.stale);
      const activeIds = new Set();
      if (attendLearningQuota && maxActive >= 2) {
        const topLearning = eligible.find((s) => LEARNING_QUOTA_SOURCES.has(s.g.source));
        if (topLearning) activeIds.add(topLearning.g.id);
      }
      for (const s of eligible) {
        if (activeIds.size >= maxActive) break;
        activeIds.add(s.g.id);
      }
      for (const s of scored) {
        let status = s.g.status;
        if (s.stale) status = 'paused'; // 两周没动的自生目标先放一放
        else if (activeIds.has(s.g.id)) status = 'active';
        else status = 'open';
        if (status !== s.g.status || s.priority !== s.g.priority) upd.run(s.priority, status, t, s.g.id);
      }
      recoverStaleGoalSteps({ getdb, rowOut, t, staleStepMs, staleResearchStepMs, staleActStepMs });
      recoverRetriableBlockedGoalSteps({ getdb, rowOut, t });
      return scored.length;
    } catch { return 0; }
  }

  function closeResolvedGoals(t = now()) {
    try {
      const rows = getdb().prepare("SELECT * FROM noe_goals WHERE status IN ('open','active')").all().map(rowOut);
      const upd = getdb().prepare("UPDATE noe_goals SET status = 'done', updated_at = ? WHERE id = ?");
      let changed = 0;
      for (const g of rows) {
        // self_evolution goal 的生命周期由 self-evolution cycle 主导(consensus→implementation→verify→complete)；
        //   不被通用 goal 系统按 plan.allDone 收口——否则 goal planner 填的 research/think 步先 done 会把 goal
        //   刷成 done、切断 selfEvolve 心跳对该 goal 的 cycle 推进(实证: Stripe 目标被填上网搜索步→done→断链)。
        if (g.source === 'self_evolution') continue;
        const plan = Array.isArray(g.plan) ? g.plan : [];
        if (!plan.length) continue;
        const resolved = plan.every((s) => ['done', 'recovered'].includes(String(s.status || 'open')));
        if (!resolved) continue;
        upd.run(t, g.id);
        appendGoalCheckpoint(getdb(), {
          now: () => t,
          goal: { ...g, status: 'done' },
          goalId: g.id,
          stepIndex: plan.length - 1,
          phase: 'step_done',
          status: 'done',
          note: '自动收口：所有步骤已进入 done/recovered 终态，目标状态同步为 done。',
          replaySafe: true,
        });
        changed += 1;
      }
      return changed;
    } catch { return 0; }
  }

  /** 取最高优先级活跃目标的下一个未完成步骤（工作区候选源）；doing（执行中，如后台研究）跳过。 */
  function nextStep() {
    try {
      const act = list({ status: 'active', limit: maxActive });
      for (const g of act) {
        // self_evolution goal 由 selfEvolve cycle 独占其生命周期；通用工作区不推进、不 bootstrap 填 plan——
        //   否则填的 research/think 步会被执行→allDone→把 goal 刷成 done→切断 selfEvolve 对它的 cycle 推进。
        if (g.source === 'self_evolution') continue;
        if (g.plan.some((s) => BLOCKING_STEP_STATUSES.has(s.status))) continue; // 有步骤在后台执行/等审批：别并行抢
        const idx = g.plan.findIndex((s) => s.status === 'open');
        if (idx >= 0) {
          return stepOutputFromGoal(g, idx);
        }
        if (!g.plan.length) {
          const bootstrapped = bootstrapEmptyGoalPlan(g);
          if (bootstrapped?.plan?.length) return stepOutputFromGoal(bootstrapped, 0);
          return { goalId: g.id, title: g.title, stepIndex: -1, step: `想清楚「${g.title}」的第一步是什么`, kind: 'think', priority: g.priority };
        }
      }
      return null;
    } catch { return null; }
  }

  /**
   * 记一步推进（深思/研究产出）：note 落进步骤；status 可标 'doing'（后台执行中）或 done；
   * 全部完成 → 目标 done。stepIndex=-1（无计划目标）时 newSteps 长出计划。
   * @returns {{ok: boolean, goalDone: boolean, goal?: object}} goalDone=true 时调用方可做技能蒸馏（M7）
   */
  function recordStepResult(goalId, stepIndex, { note = '', done = false, doing = false, status = null, newSteps = null } = {}) {
    return recordGoalStepResult({ getdb, getGoal: get, now, allowActKind, goalId, stepIndex, input: { note, done, doing, status, newSteps } });
  }

  function recordStepCheckpoint(goalId, stepIndex, input = {}) {
    try {
      const g = get(goalId);
      if (!g) return null;
      return appendGoalCheckpoint(getdb(), { now, goal: g, goalId, stepIndex, ...input });
    } catch { return null; }
  }

  function checkpoints({ goalId, stepIndex = null, limit = 100 } = {}) {
    try { return listGoalCheckpoints(getdb(), { goalId, stepIndex, limit }); } catch { return []; }
  }

  function latestCheckpoint({ goalId, stepIndex = null } = {}) {
    try { return latestGoalCheckpoint(getdb(), { goalId, stepIndex }); } catch { return null; }
  }

  /**
   * 好奇回路 v1：高惊奇的落空预测 → 研究目标（被现实打脸的地方就是该学习的地方）。
   * 好奇二分解接入（NOE_EFE_CURIOSITY=1）：在不改「surprise≥2bit 才立项」门槛、不改 title/旧 why 主体的前提下，
   *   用 curiosityScore(epistemic=surprise, pragmatic=pragmaticSignal(claim)) 把这条好奇拆成可解释双因子，
   *   存进 goal.meta.curiosity 并把主导 label 追加进 why（供透视页/反思读「为什么值得好奇」）。
   *   门控 OFF 时走 else 分支——与改造前逐字等价（不算分、不写 meta、why 不变），零回归。
   */
  function harvestSurprise({ claim, surprise, origin } = {}) {
    if (!(Number(surprise) >= curiositySurpriseThreshold) || !claim) return null;
    // 步骤2（多模型安全方案·接真 Goodhart 门，治"isNonNoise 零调用形同虚设"）：ON 时只放行非噪声 origin
    //   （owner_*/action_failure/world_model_conflict 外部锚真负反馈），拒 Neo 自评/深思虚构任务/内省念头落空，
    //   防 self_evolution（生产已开 EXECUTORS=1）被优化成"刷假落空凑 surprise"。OFF 逐字零回归。
    if (process.env.NOE_CURIOSITY_ORIGIN_GATE === '1' && !NON_NOISE_ORIGIN_RE.test(String(origin || ''))) return null;
    // P1-D（三方审查 minor，经 node 复现判定为误报/过度修复，不改）：
    //   ① 相同 claim 重复膨胀已被 add() 层去重（相同 open 目标不重复立、closed 后可正当重立）；
    //   ② owner_correction(事实判断错) 与 owner_prediction(行为预测错) 对同一 owner 交互的双 surprise 是两个
    //      不同认知维度、分别立项合理，非冗余；强行按 claim 指纹/短窗合并会误挡 closed 目标重立(regression)，故不做。
    const surpriseBit = Number(surprise);
    // P1-C：surprise 来源分桶（action_failure/owner_followup/…），让 surprise-learning-audit 验收门 b 区分非噪声 surprise。
    const safeOrigin = (typeof origin === 'string' && origin) ? origin.slice(0, 40) : 'unspecified';
    const baseWhy = `这条预测落空带来 ${Math.round(surpriseBit * 10) / 10} bit 惊奇——我的世界模型在这里有缺口`;
    const steps = ['回看相关记忆与时间线，找我当时的依据', '列出 2-3 个可能的解释', '修正一条认知并记进记忆'];
    const title = `搞明白为什么没料到：${String(claim).slice(0, 120)}`;

    if (!curiosityDecompose?.enabled) {
      // P1-C：传入了 origin 才写 meta（保持「无 origin + decompose off = meta null」的零回归基线；生产两调用点总传 origin）
      return add(safeOrigin !== 'unspecified'
        ? { title, source: 'surprise', why: baseWhy, steps, meta: { origin: safeOrigin } }
        : { title, source: 'surprise', why: baseWhy, steps });
    }

    // ON：算 pragmatic 信号（注入优先，默认=当前目标关键词重叠）；信号炸了退化 value=0、source='none'（fail-open）。
    let prag = { value: 0, source: 'none' };
    try {
      const sig = (typeof pragmaticSignal === 'function' ? pragmaticSignal : defaultPragmaticSignal)(String(claim));
      const v = Number(sig?.value);
      prag = { value: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0, source: String(sig?.source || 'unknown').slice(0, 40) };
    } catch { prag = { value: 0, source: 'none' }; }

    // epistemic = surprise(bit)（落空越狠 = 不确定性缺口越大）；pragmatic 已在 [0,1]，故 pragmaticScale=1。
    const cs = curiosityDecompose.score({ epistemicValue: surpriseBit, pragmaticValue: prag.value, pragmaticScale: 1 });
    const meta = {
      ...(safeOrigin !== 'unspecified' ? { origin: safeOrigin } : {}),
      curiosity: {
        score: cs.score,
        epistemic: cs.epistemic,
        pragmatic: cs.pragmatic,
        label: cs.label,
        pragmaticSource: prag.source,
      },
    };
    const why = `${baseWhy}；好奇画像：${cs.label}（认识价值 ${Math.round(cs.epistemic * 100) / 100} · 实用价值 ${Math.round(cs.pragmatic * 100) / 100}）`;
    return add({ title, source: 'surprise', why, steps, meta });
  }

  /** 概览统计（透视页数据源）。 */
  function stats() {
    try {
      const byStatus = getdb().prepare('SELECT status, COUNT(*) AS n FROM noe_goals GROUP BY status').all()
        .reduce((acc, r) => { acc[r.status] = r.n; return acc; }, /** @type {Record<string, number>} */({}));
      // P1-C 整改 F3：surprise 来源分桶接进 stats——透视页/mind route 是 stats 的生产消费方(noeMind.js:365/383/619)，
      // 由此门 b 的「owner+action 非噪声 surprise」计数进入真实运行时输出（不再只活在单测）。
      return { ...byStatus, surpriseOrigins: surpriseOriginBreakdown() };
    } catch { return {}; }
  }

  return { add, get, list, setStatus, arbitrate, nextStep, recordStepResult, recordStepCheckpoint, checkpoints, latestCheckpoint, harvestSurprise, surpriseOriginBreakdown, maybeSeedAutonomousLearning, recentCountBySource, stats };
}
