// @ts-check
// NoeSelfDirectionSeed — #54 自主定方向：飞轮用 LLM 反思自身状态/数据，自主生成进化方向目标
//   （跳出预设信号源 test_gap/high_complexity/missing_jsdoc/failure_lesson），自动立项执行。
//
// 背景：当前飞轮的「方向」全部来自人预设的信号源——只能在固定改进类型里被动选，不能自己定义「该往哪进化」。
// owner 决策放开 P5 advisory-only 墙试「完全自主定方向」，接受 reward hacking 风险。本模块用强价值锚替代被移除的墙。
//
// 价值锚（生成阶段，防 LLM 生成「易刷分但无真价值」的方向）：
//   a) 质量闸 classifySelfEvolutionObjectiveQuality（必须有技术着力点，非诗性梦想）
//   b) 可验证（successCriterion + targetFile，拒抽象「变更好」）
//   c) 引用性（targetFile 被全仓引用，非孤儿幽灵需求）
//   d) expectedVerdict ∈ {logic_changed, test_only}（预期产真价值，拒 doc_only/neutral 浅层刷分）
//   e) 去重（recallRejectLessons 近重复被拒）
// 执行阶段走与现有信号源完全相同的 selfEvolve→applyAndVerify 安全网（价值闸/双绿门/27b/P0度量/冷却）——自动复用。
// reward hacking 熔断由 NoeSelfDirectionBudget 在接线层做（自主源连续 neutral → 暂停生成）。
//
// flag NOE_SELF_DIRECTION_SEED 默认 OFF（分量动作：放开方向自主权）。纯 DI + 全程 fail-open。仿 NoeFailureLessonSignal。

import { noeStructuredCall } from '../runtime/NoeStructuredCall.js';
import { classifySelfEvolutionObjectiveQuality } from './NoeSelfEvolutionTrigger.js';

const SIGNAL_SOURCE = 'self_evolution'; // 必须 self_evolution 才被飞轮 openSelfEvolutionGoals 选中
const SIGNAL = 'self_directed_evolution';
const VALID_EXPECTED_VERDICTS = new Set(['logic_changed', 'test_only']);

const DIRECTION_SYSTEM = [
  '你是 Neo 飞轮的自主进化方向规划者。基于飞轮当前状态（已有进化的价值分布、成功/失败模式、能力画像），',
  '自主提出下一个最有价值的、可由「改代码」达成的进化方向。',
  '硬要求：',
  '1. targetFile 必须从用户提供的「可选目标文件」清单里精确选一个（逐字复制完整路径），绝不编造、猜测或缩写文件名；从中挑你判断最有改进价值的真实模块。',
  '2. 必须可验证（successCriterion：一句可客观判定的成功标准，如「parseX 圈复杂度从 28 降到 <12」「为 src/foo.js 补导出函数单测覆盖」）。',
  '3. expectedVerdict 必须是 "logic_changed"（改 src 逻辑）或 "test_only"（补测试）——不接受只补注释或无实质改善的方向。',
  '4. objective 动词开头、具体、含可定位的模块/问题。不要诗性抒情、不要抽象「变得更好」。',
  '5. 优先选你有十足把握「一次改对、且绝不破坏现有 npm test」的小而具体的改进。飞轮的价值在「真正改进自己的逻辑」——首选小范围的逻辑改进（expectedVerdict=logic_changed）：加边界/空值/错误处理、抽出一个小纯函数、简化一段局部逻辑、修一个明显的小 bug；当某文件确实缺测试覆盖时，补单元测试（expectedVerdict=test_only）也是好方向、作为次选。两者都必须「小」：改动越小越能通过双绿门真正落地，避免大规模重构（会被 verify 回滚、白费）。不要默认只补测试——能小幅真改进逻辑就别退回 test_only。',
  '只输出 JSON：{"objective":"...","area":"...","targetFile":"src/...","successCriterion":"...","expectedVerdict":"logic_changed|test_only","reasoning":"..."}',
].join('\n');

const DIRECTION_SCHEMA = {
  type: 'object',
  properties: {
    objective: { type: 'string' },
    area: { type: 'string' },
    targetFile: { type: 'string' },
    successCriterion: { type: 'string' },
    expectedVerdict: { type: 'string', enum: ['logic_changed', 'test_only'] },
    reasoning: { type: 'string' },
  },
  required: ['objective', 'targetFile', 'successCriterion', 'expectedVerdict'],
  additionalProperties: false,
};

export function createSelfDirectionSeed({
  getAdapter,
  goalSystem,
  outcomeStats = null, // () => {total, docOnly, neutral, logicChanged, testOnly}：P0 进化价值分布
  recallLessons = null, // ({sourceTypes, limit}) => lessons[]：P4 成功/失败模式
  capabilitySnapshot = null, // () => string：能力画像（测试覆盖/复杂度等，简短文本）
  listSourceFiles = null, // () => string[]：真实 src 文件清单（喂 35b 从中选 targetFile，防编造/选孤儿）
  referenceProbe = null, // (rel, root) => {referenced, hits}
  isProtected = null, // (rel) => bool：targetFile 是否飞轮禁改的 protected 文件（自改链/安全门/授权脚本）
  recallRejectLessons = null, // (title) => {similar}
  recentTargets = null, // () => string[]：最近已立方向的 targetFile（软引导拓宽探索、别反复刷少数文件，实测 NoeModelCircuitBreaker 6/15）；不硬拦，免误拒同文件不同角度的真改进
  brainAdapterId = process.env.NOE_REFLECT_HEAVY_BRAIN || 'lmstudio', // Heavy brain tier（可云端做高质方向概括）
  model = null,
  root = process.cwd(),
  structuredCall = noeStructuredCall,
  now = () => Date.now(),
} = {}) {
  // 单坑位：已有 meta.signal='self_directed_evolution' 的 open/active goal 在飞则本轮不立（防刷屏；只看自己的 signal）。
  function hasInFlightDirectionGoal() {
    try {
      const open = goalSystem.list({ status: 'open', limit: 200 }) || [];
      const active = goalSystem.list({ status: 'active', limit: 200 }) || [];
      return [...open, ...active].some((g) => g && g.source === SIGNAL_SOURCE && g.meta && g.meta.signal === SIGNAL);
    } catch { return false; } // fail-open
  }

  // 组装飞轮自我反思的输入 context（P0 价值分布 + 教训模式 + 能力画像）。各源 fail-open。
  function buildContext() {
    const parts = [];
    if (typeof outcomeStats === 'function') {
      try {
        const s = outcomeStats() || {};
        parts.push(`进化价值分布：总 ${s.total || 0}，真改逻辑 ${s.logicChanged || 0}，补测试 ${s.testOnly || 0}，浅层(注释/无改善) ${(s.docOnly || 0) + (s.neutral || 0)}`);
      } catch { /* fail-open */ }
    }
    if (typeof recallLessons === 'function') {
      try {
        const ls = recallLessons({ sourceTypes: ['learning_lesson', 'surprise_lesson'], limit: 5 }) || [];
        const txt = ls.map((l) => String((l && (l.title || l.body)) || '').slice(0, 60)).filter(Boolean).join('；').slice(0, 300);
        if (txt) parts.push(`最近教训/模式：${txt}`);
      } catch { /* fail-open */ }
    }
    if (typeof capabilitySnapshot === 'function') {
      try { const cap = capabilitySnapshot(); if (cap) parts.push(`能力画像：${String(cap).slice(0, 300)}`); } catch { /* fail-open */ }
    }
    // 真实文件清单：让 35b 从真实存在的 src 文件里选 targetFile（防凭空编造文件名/选孤儿被价值锚拦）。均匀取样防 context 过长。
    if (typeof listSourceFiles === 'function') {
      try {
        const files = (listSourceFiles() || [])
          .map((f) => String(f).replace(/^.*\/src\//, 'src/').replace(/\\/g, '/'))
          .filter((f) => {
            if (!/^src\/.+\.[cm]?js$/.test(f) || /\.(test|spec)\./.test(f)) return false;
            // 候选清单排除 protected 文件（自改链/安全门）：飞轮不能自主定「改自己约束」的方向，提前从候选剔除，
            //   省得 M3 选到 protected 再被价值锚 f 拦、白费立项轮次（实测反复 value_anchor_protected_target）。
            if (typeof isProtected === 'function') { try { if (isProtected(f) === true) return false; } catch { /* fail-open */ } }
            return true;
          });
        if (files.length) {
          const step = Math.max(1, Math.floor(files.length / 60));
          let sample = files.filter((_, i) => i % step === 0).slice(0, 60);
          // 预筛被引用的（candidates 含孤儿 → LLM 从中选到孤儿会被引用性价值锚拦，实测 35b/minimax 均如此）。
          //   只给被全仓 import 的文件，让 LLM 选的都过引用性。referenceProbe 注入时启用（取前 25 个被引用的）。
          if (typeof referenceProbe === 'function') {
            const referenced = [];
            for (const f of sample) {
              try { if (referenceProbe(f, root)?.referenced === true) referenced.push(f); } catch { /* fail-open */ }
              if (referenced.length >= 25) break;
            }
            if (referenced.length) sample = referenced;
          }
          parts.push(`可选目标文件（targetFile 必须逐字从这些真实且被引用的文件里选一个，勿编造）：\n${sample.join('、')}`);
        }
      } catch { /* fail-open */ }
    }
    // 探索偏集中软引导(2026-07-01)：飞轮反复刷少数文件(实测 NoeModelCircuitBreaker 6/15)。注入「最近已立方向的
    //   targetFile」引导拓宽覆盖——除非有全新改进角度否则优先选清单里其他文件。软引导(仅提示、不硬拦)，免误拒同文件不同角度真改进。
    if (typeof recentTargets === 'function') {
      try {
        const recent = (recentTargets() || []).map((f) => String(f).replace(/\\/g, '/')).filter(Boolean);
        if (recent.length) parts.push(`最近已立过方向的文件（除非有全新改进角度，否则优先选上面清单里的其他文件、拓宽覆盖，别反复刷这些）：\n${[...new Set(recent)].slice(0, 12).join('、')}`);
      } catch { /* fail-open：软引导缺失不阻断方向生成 */ }
    }
    return parts.join('\n') || '（暂无历史数据，基于代码库通用改进原则提方向）';
  }

  async function runOnce() {
    if (process.env.NOE_SELF_DIRECTION_SEED !== '1') return { ok: false, skipped: 'flag_off' };
    if (!goalSystem || typeof goalSystem.add !== 'function') return { ok: false, skipped: 'no_goalsystem' };
    if (hasInFlightDirectionGoal()) return { ok: false, reason: 'direction_goal_in_flight' };

    const adapter = (() => { try { return getAdapter?.(brainAdapterId); } catch { return null; } })();
    if (!adapter?.chat) return { ok: false, skipped: 'no_brain' };

    const context = buildContext();
    let value;
    try {
      const r = await structuredCall({
        adapter,
        messages: [
          { role: 'system', content: DIRECTION_SYSTEM },
          { role: 'user', content: `飞轮当前状态：\n${context}\n\n提出下一个最有价值的自主进化方向（严格按 schema 输出 JSON）。` },
        ],
        jsonSchema: DIRECTION_SCHEMA,
        opts: { disableMcp: true, budgetContext: { projectId: 'noe', taskId: 'noe-self-direction-seed' }, think: false, maxTokens: 4096, ...(model ? { model } : {}) },
        name: 'noe_self_direction',
      });
      if (!r || r.ok !== true || !r.value || typeof r.value !== 'object') return { ok: false, reason: 'no_direction' };
      value = r.value;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 120) }; // fail-open
    }

    const objective = String(value.objective || '').trim();
    const targetFile = String(value.targetFile || '').trim().replace(/\\/g, '/');
    const successCriterion = String(value.successCriterion || '').trim();
    const expectedVerdict = String(value.expectedVerdict || '').trim();
    const area = String(value.area || '').trim();

    // 价值锚 a) 质量闸：必须有技术着力点（非诗性梦想）。strictPoetic 严格拦诗性。
    const quality = classifySelfEvolutionObjectiveQuality(objective, { strictPoetic: true });
    if (!quality.hasTechnicalTarget) return { ok: false, reason: 'value_anchor_not_technical', detail: quality.reason };
    // 价值锚 b) 可验证：必须有 successCriterion + targetFile（拒抽象「变更好」）。
    if (!successCriterion || !targetFile) return { ok: false, reason: 'value_anchor_unverifiable' };
    // 价值锚 d) 预期真价值：expectedVerdict ∈ {logic_changed, test_only}（拒 doc_only/neutral 浅层刷分）。
    if (!VALID_EXPECTED_VERDICTS.has(expectedVerdict)) return { ok: false, reason: 'value_anchor_shallow_expected' };
    // targetFile 必须是 src/ 下的 .js（非测试、非越界）。
    if (!/^src\/.+\.[cm]?js$/.test(targetFile) || /\.(test|spec)\./.test(targetFile)) return { ok: false, reason: 'value_anchor_bad_target' };
    // 价值锚 f) 非受保护：targetFile 不能是飞轮禁改的 protected 文件（自改链/安全门/授权脚本）。否则 implement 注定被
    //   PolicyFileGuard preflight 拦死，goal 卡 open 反复 preflight_blocked + 占住单坑位让飞轮空转（实测：M3 自主提
    //   「重构 NoeSelfEvolutionActGuard」飞轮自己的安全门被拦）。生成阶段就拦掉——飞轮不能自主定「改自己约束」的方向。
    if (typeof isProtected === 'function') {
      let prot = false;
      try { prot = isProtected(targetFile) === true; } catch { prot = false; }
      if (prot) return { ok: false, reason: 'value_anchor_protected_target' };
    }
    // 价值锚 c) 引用性：targetFile 必须被全仓引用（非孤儿幽灵需求）。
    if (typeof referenceProbe === 'function') {
      let probe = null;
      try { probe = referenceProbe(targetFile, root); } catch { probe = null; }
      if (!probe || probe.referenced !== true) return { ok: false, reason: 'value_anchor_orphan_target' };
    }
    // 价值锚 e) 去重：近重复被拒 → 跳过（防反复撞同方向）。
    if (typeof recallRejectLessons === 'function') {
      let verdict = null;
      try { verdict = recallRejectLessons(objective); } catch { verdict = null; }
      if (verdict && verdict.similar === true) return { ok: false, reason: 'near_duplicate' };
    }

    const goalId = goalSystem.add({
      title: objective.slice(0, 120),
      source: SIGNAL_SOURCE,
      why: `自主定方向（飞轮自生成，非预设信号源）：${successCriterion.slice(0, 80)}`,
      steps: [{ step: objective.slice(0, 100), kind: 'think' }], // feasible 杠杆 + 给 cycle 动作锚
      meta: { signal: SIGNAL, area, file: targetFile, targetFile, successCriterion: successCriterion.slice(0, 200), expectedVerdict, discoveredAt: now() },
    });
    if (!goalId) return { ok: false, reason: 'add_rejected' };
    return { ok: true, goalId, objective, targetFile, expectedVerdict };
  }

  return { runOnce };
}
