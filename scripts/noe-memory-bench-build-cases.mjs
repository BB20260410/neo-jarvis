#!/usr/bin/env node
// @ts-check
/**
 * 生成 P6 记忆召回基准的题集 + fixture 语料（一次性物化到 evals/neo/memory-bench/）。
 *
 * 诚实声明（owner 禁假数据）：这些是「LongMemEval / LOCOMO 体例」的【风格自造】题，
 * 完全本地合成，不是、也绝不冒充原公开题集。每个 case 标 source:'longmem-style-synthetic'。
 *
 * 设计：题型四类均衡（single_hop / multi_hop / temporal / adversarial），中英混合。
 * fixture = 被召回的「对话/笔记历史」；case.bench.query = 提问；expectedIds = 标准答案记忆。
 * 对抗题（adversarial）放高相似的干扰 fixture，要求召回不踩 disallowedIds。
 * 时序题（temporal）配 valid_from/valid_to 双时态（配合 P5），问「现在/最新」该取哪条。
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_DIR = resolve(ROOT, 'evals/neo/memory-bench');
const CASES_DIR = join(BENCH_DIR, 'cases');

const DAY = 86_400_000;
const T0 = 1_700_000_000_000; // 固定基准时刻，保证生成确定可复现

// ─────────────────────────────────────────────────────────────
// fixture 语料：被召回的「历史」。id 用 bench- 前缀，project=noe。
// scope 取真实召回通道之一：fact / user / project / insight。
// ─────────────────────────────────────────────────────────────
const fixtures = [
  // — 单跳偏好 / 事实（中）—
  fx('bench-pref-coffee', 'user', '主人长期偏好喝美式黑咖啡，不加糖不加奶。', ['preference', 'coffee'], 0.92, 4),
  fx('bench-pref-tea-distractor', 'fact', '某次测试日志里偶然出现过"奶茶"这个词，与主人长期口味无关。', ['distractor', 'drink'], 0.34, 1),
  fx('bench-pref-music', 'user', '主人专注工作时偏好听器乐 lo-fi，不要带人声的歌。', ['preference', 'music'], 0.9, 4),
  fx('bench-fact-birthplace', 'fact', '主人出生在沿海城市，从小在海边长大。', ['profile', 'origin'], 0.88, 4),
  fx('bench-fact-pet', 'fact', '主人养了一只叫"豆豆"的橘猫。', ['profile', 'pet'], 0.9, 4),
  fx('bench-fact-allergy', 'fact', '主人对花生过敏，点外卖要避开花生。', ['profile', 'health'], 0.95, 5),

  // — 单跳偏好 / 事实（英）—
  fx('bench-pref-editor', 'user', 'The owner prefers a dark theme editor and two-space indentation.', ['preference', 'editor'], 0.9, 4),
  fx('bench-fact-timezone', 'fact', 'The owner works in the Asia/Shanghai timezone, usually late at night.', ['profile', 'timezone'], 0.9, 4),
  fx('bench-pref-commit-lang', 'user', 'The owner wants all git commit messages written in Simplified Chinese.', ['preference', 'git'], 0.92, 4),

  // — 多跳链 A：项目 → 负责人 → 联系方式（中）—
  fx('bench-mh-proj-owner', 'project', '项目"息刻"的产品负责人是阿哲。', ['multihop', 'xike', 'owner'], 0.88, 3),
  fx('bench-mh-owner-role', 'fact', '阿哲同时负责息刻的语音引导脚本审校。', ['multihop', 'xike', 'role'], 0.85, 3),
  fx('bench-mh-proj-deadline', 'project', '息刻 1.2 版本计划在季度末提交 App Store 审核。', ['multihop', 'xike', 'deadline'], 0.84, 3),

  // — 多跳链 B：会议 → 决定 → 行动项（英）—
  fx('bench-mh-meeting', 'project', 'In the Monday sync the team decided to migrate the memory store to better-sqlite3.', ['multihop', 'meeting', 'memory'], 0.86, 3),
  fx('bench-mh-action', 'project', 'The action item from that decision was assigned to the backend group with a two-week window.', ['multihop', 'meeting', 'action'], 0.84, 3),

  // — 时序题语料：城市搬迁（双时态，配 P5 valid_from/valid_to）—
  temporal('bench-temporal-city-old', 'fact', '主人曾经住在北京。', ['temporal', 'city'], T0 - 400 * DAY, T0 - 60 * DAY, 0.8, 3),
  temporal('bench-temporal-city-new', 'fact', '主人现在住在上海。', ['temporal', 'city'], T0 - 59 * DAY, null, 0.9, 4),

  // — 时序题语料：手机型号（英，双时态）—
  temporal('bench-temporal-phone-old', 'fact', 'The owner used to carry an iPhone 13.', ['temporal', 'device'], T0 - 500 * DAY, T0 - 120 * DAY, 0.8, 3),
  temporal('bench-temporal-phone-new', 'fact', 'The owner now uses an iPhone 16 Pro.', ['temporal', 'device'], T0 - 119 * DAY, null, 0.9, 4),

  // — 时序题语料：当前主力机型（中，双时态）—
  temporal('bench-temporal-laptop-old', 'fact', '主人之前用 MacBook Air 开发。', ['temporal', 'laptop'], T0 - 600 * DAY, T0 - 200 * DAY, 0.78, 3),
  temporal('bench-temporal-laptop-new', 'fact', '主人现在主力开发机是 MacBook Pro M3 Max。', ['temporal', 'laptop'], T0 - 199 * DAY, null, 0.92, 4),

  // — 对抗题语料：高相似但不同实体（频率 / 版本 / 编号）—
  fx('bench-adv-freq-440', 'fact', '疗愈频率素材里 440Hz 那一组用于放松场景。', ['adversarial', 'freq', '440'], 0.8, 3),
  fx('bench-adv-freq-880', 'fact', '疗愈频率素材里 880Hz 那一组用于专注场景。', ['adversarial', 'freq', '880'], 0.8, 3),
  fx('bench-adv-ver-v12', 'project', '玛法史莱姆小游戏 1.1.2 版本是上一个被驳回的包。', ['adversarial', 'version', 'v112'], 0.8, 3),
  fx('bench-adv-ver-v13', 'project', '玛法史莱姆小游戏 1.1.3 版本是当前已提交的包。', ['adversarial', 'version', 'v113'], 0.85, 3),

  // — 对抗题语料：否定 / 误导（"不是偏好"）—
  fx('bench-adv-negation', 'fact', '主人明确说过他【不】喜欢喝可乐，别推荐含糖碳酸饮料。', ['adversarial', 'negation', 'drink'], 0.9, 4),
  fx('bench-adv-hype-distractor', 'fact', '聊天里有人随口夸某咖啡店，但主人没表达过个人偏好。', ['adversarial', 'distractor', 'coffee'], 0.4, 1),

  // — 洞察 / 技能（insight 通道，单跳，中）—
  fx('bench-insight-verify', 'insight', '完成任务后必须自己实测验证无 bug 再汇报，不要让用户当测试员。', ['insight', 'workflow'], 0.9, 4),
  fx('bench-insight-no-fake', 'insight', '涉及钱/配额/限额必须官方溯源，社区估算必须标"估"，未知显示破折号不许编。', ['insight', 'data'], 0.92, 4),
  fx('bench-insight-parallel', 'insight', '多个独立任务能并行且不影响质量就必须并行，默认用线程池或 asyncio。', ['insight', 'parallel'], 0.88, 4),
];

// ─────────────────────────────────────────────────────────────
// 题集：每题给 query / 期望 id / 题型 / 语言 / 干扰项。
// ─────────────────────────────────────────────────────────────
const cases = [
  // ===== single_hop（10）=====
  q('s01', 'single_hop', 'zh', 'chat', '主人喜欢喝什么咖啡？', ['bench-pref-coffee'], ['bench-pref-tea-distractor', 'bench-adv-hype-distractor']),
  q('s02', 'single_hop', 'zh', 'chat', '主人工作时喜欢听什么音乐？', ['bench-pref-music']),
  q('s03', 'single_hop', 'zh', 'chat', '主人养的宠物叫什么？', ['bench-fact-pet']),
  q('s04', 'single_hop', 'zh', 'chat', '主人对什么食物过敏？', ['bench-fact-allergy']),
  q('s05', 'single_hop', 'zh', 'chat', '主人是在哪里长大的？', ['bench-fact-birthplace']),
  q('s06', 'single_hop', 'en', 'chat', 'What editor theme and indentation does the owner prefer?', ['bench-pref-editor']),
  q('s07', 'single_hop', 'en', 'chat', 'What timezone does the owner work in?', ['bench-fact-timezone']),
  q('s08', 'single_hop', 'en', 'chat', 'In what language should git commit messages be written?', ['bench-pref-commit-lang']),
  q('s09', 'single_hop', 'zh', 'reflection', '完成任务后汇报前应该先做什么？', ['bench-insight-verify']),
  q('s10', 'single_hop', 'zh', 'reflection', '涉及钱和配额的数据该怎么处理？', ['bench-insight-no-fake']),

  // ===== multi_hop（8）：答案需要两条 fixture 共同支撑 =====
  q('m01', 'multi_hop', 'zh', 'mission', '息刻的产品负责人是谁，他还负责什么？', ['bench-mh-proj-owner', 'bench-mh-owner-role']),
  q('m02', 'multi_hop', 'zh', 'mission', '息刻项目的负责人和它的上架计划分别是什么？', ['bench-mh-proj-owner', 'bench-mh-proj-deadline']),
  q('m03', 'multi_hop', 'en', 'mission', 'What store migration did the team decide on, and who got the action item?', ['bench-mh-meeting', 'bench-mh-action']),
  q('m04', 'multi_hop', 'zh', 'mission', '关于息刻，负责人是谁、版本几时上架、他还管哪块？', ['bench-mh-proj-owner', 'bench-mh-proj-deadline', 'bench-mh-owner-role'], [], { minRecall: 0.66 }),
  q('m05', 'multi_hop', 'en', 'mission', 'Summarize the memory-store decision and its follow-up action.', ['bench-mh-meeting', 'bench-mh-action']),
  q('m06', 'multi_hop', 'zh', 'mission', '息刻负责人阿哲具体负责哪些事？', ['bench-mh-proj-owner', 'bench-mh-owner-role'], [], { minRecall: 0.5 }),
  q('m07', 'multi_hop', 'zh', 'chat', '主人的口味偏好有哪些（咖啡和音乐）？', ['bench-pref-coffee', 'bench-pref-music'], ['bench-pref-tea-distractor']),
  q('m08', 'multi_hop', 'en', 'chat', 'List the owner workflow rules about verification and parallelism.', ['bench-insight-verify', 'bench-insight-parallel'], [], { minRecall: 0.5 }),

  // ===== temporal（8）：双时态，问"现在/最新"要取 valid_to=null 的当前条，不踩旧条 =====
  q('t01', 'temporal', 'zh', 'chat', '主人现在住在哪个城市？', ['bench-temporal-city-new'], ['bench-temporal-city-old']),
  q('t02', 'temporal', 'en', 'chat', 'What phone does the owner currently use?', ['bench-temporal-phone-new'], ['bench-temporal-phone-old']),
  q('t03', 'temporal', 'zh', 'mission', '主人当前的主力开发电脑是什么？', ['bench-temporal-laptop-new'], ['bench-temporal-laptop-old']),
  q('t04', 'temporal', 'zh', 'chat', '主人现在用的城市是上海吗，确认当前居住地。', ['bench-temporal-city-new'], ['bench-temporal-city-old']),
  q('t05', 'temporal', 'en', 'chat', 'Confirm the owner current laptop for development work.', ['bench-temporal-laptop-new'], ['bench-temporal-laptop-old']),
  // 历史题：明确问"曾经/以前"，应能取到旧条（valid_to 非空那条）
  q('t06', 'temporal', 'zh', 'reflection', '主人以前（更早时候）住在哪个城市？', ['bench-temporal-city-old'], []),
  q('t07', 'temporal', 'en', 'reflection', 'Which phone did the owner use before the current one?', ['bench-temporal-phone-old'], []),
  q('t08', 'temporal', 'zh', 'reflection', '主人之前用的笔记本是哪款（更早的那台）？', ['bench-temporal-laptop-old'], []),

  // ===== adversarial（10）：高相似干扰 / 否定 / 不同编号实体 / 负样本 =====
  q('a01', 'adversarial', 'zh', 'chat', '440Hz 那组疗愈频率用于什么场景？', ['bench-adv-freq-440'], ['bench-adv-freq-880']),
  q('a02', 'adversarial', 'zh', 'chat', '880Hz 那组疗愈频率用于什么场景？', ['bench-adv-freq-880'], ['bench-adv-freq-440']),
  q('a03', 'adversarial', 'zh', 'mission', '玛法史莱姆当前已提交的是哪个版本？', ['bench-adv-ver-v13'], ['bench-adv-ver-v12']),
  q('a04', 'adversarial', 'zh', 'mission', '玛法史莱姆上一个被驳回的是哪个版本？', ['bench-adv-ver-v12'], ['bench-adv-ver-v13']),
  q('a05', 'adversarial', 'zh', 'chat', '主人明确不喜欢喝的饮料是什么？', ['bench-adv-negation'], []),
  // 负样本题：库里没有的偏好，应当一条都不召回（expectEmpty）
  qEmpty('a06', 'adversarial', 'zh', 'chat', '主人对滑雪运动有什么长期偏好？'),
  qEmpty('a07', 'adversarial', 'en', 'chat', 'What is the owner long-term preference about deep-sea fishing?'),
  // 干扰抗性：问咖啡偏好，库里有真偏好 + 两条咖啡相关噪声，必须只取真偏好不踩噪声
  q('a08', 'adversarial', 'zh', 'chat', '主人对咖啡的长期个人偏好到底是什么？', ['bench-pref-coffee'], ['bench-adv-hype-distractor', 'bench-pref-tea-distractor']),
  // 否定 vs 肯定混淆：问"喜欢喝什么"，否定条(不喜欢可乐)是干扰，真答案是黑咖啡
  q('a09', 'adversarial', 'zh', 'chat', '推荐饮料前，主人偏好喝的是什么？', ['bench-pref-coffee'], ['bench-adv-negation']),
  // 版本号精确匹配（literal anchor）
  q('a10', 'adversarial', 'zh', 'mission', '玛法史莱姆 1.1.3 版本是什么状态？', ['bench-adv-ver-v13'], ['bench-adv-ver-v12']),
];

// ─────────────────────────────────────────────────────────────
// 工厂函数
// ─────────────────────────────────────────────────────────────
function fx(id, scope, body, tags, confidence, salience) {
  return { id, scope, body, tags, confidence, salience, evidenceRefs: [`bench-episode:${id}`], sourceEpisodeId: `bench-episode:${id}` };
}
function temporal(id, scope, body, tags, validFrom, validTo, confidence, salience) {
  return { ...fx(id, scope, body, tags, confidence, salience), validFrom, validTo };
}

function q(id, questionType, lang, routeType, query, expectedIds, disallowedIds = [], extra = {}) {
  return buildCase({ id, questionType, lang, routeType, query, expectedIds, disallowedIds, ...extra });
}
function qEmpty(id, questionType, lang, routeType, query) {
  return buildCase({ id, questionType, lang, routeType, query, expectedIds: [], disallowedIds: [], expectEmpty: true });
}

function buildCase({ id, questionType, lang, routeType, query, expectedIds, disallowedIds, expectEmpty = false, minRecall = 1, minPrecision = 0 }) {
  const caseId = `case-memory-bench-${questionType}-${id}`;
  return {
    schemaVersion: 1,
    id: caseId,
    layer: 'dev',
    // 诚实溯源：这是风格自造题，不是原 LongMemEval/LOCOMO 公开题集。
    source: {
      kind: 'memory_retrieval_log',
      provenance: 'longmem-style-synthetic',
      evidenceRefs: ['evals/neo/memory-bench/fixtures.json'],
      redaction: { secretValuesReturned: false, memoryBodyIncluded: false, ownerTokenIncluded: false },
    },
    input: {
      routeType,
      task: `记忆召回基准（风格自造）：${questionType} / ${lang}`,
      contextRefs: [],
      allowedTools: [],
      forbiddenTools: [],
    },
    expectations: {
      mustSelectMemoryIds: expectedIds,
      mustNotSelectMemoryIds: disallowedIds,
      expectedIncludes: [],
      forbiddenIncludes: [],
      requiredEvidenceKinds: ['retrieval_log'],
      safetyInvariants: ['no_secret_output', 'no_memory_v2_write'],
    },
    scoring: { capabilityWeight: 0.5, regressionWeight: 0.2, safetyWeight: 0.2, costLatencyWeight: 0.1 },
    // bench 评分契约（runner 读这块）
    bench: {
      questionType,
      lang,
      query,
      expectedIds,
      disallowedIds,
      expectEmpty,
      minRecall,
      minPrecision,
      matchScope: 'selected',
      k: 5,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 物化
// ─────────────────────────────────────────────────────────────
function main() {
  mkdirSync(CASES_DIR, { recursive: true });
  // 清旧的 bench case（只清本目录，保证可重复生成；不碰其他 evals）
  if (existsSync(CASES_DIR)) {
    for (const f of readdirSync(CASES_DIR)) {
      if (f.startsWith('case-memory-bench-') && f.endsWith('.json')) rmSync(join(CASES_DIR, f));
    }
  }
  const fixturesDoc = {
    schemaVersion: 1,
    kind: 'noe_memory_bench_fixtures',
    provenance: 'longmem-style-synthetic',
    note: 'LongMemEval/LOCOMO 体例的风格自造语料，本地合成，非原公开题集。被召回的"历史"。',
    projectId: 'noe',
    fixtures,
  };
  writeFileSync(join(BENCH_DIR, 'fixtures.json'), `${JSON.stringify(fixturesDoc, null, 2)}\n`);
  let n = 0;
  for (const c of cases) {
    writeFileSync(join(CASES_DIR, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
    n += 1;
  }
  const dist = cases.reduce((m, c) => { m[c.bench.questionType] = (m[c.bench.questionType] || 0) + 1; return m; }, {});
  const langDist = cases.reduce((m, c) => { m[c.bench.lang] = (m[c.bench.lang] || 0) + 1; return m; }, {});
  process.stdout.write(`wrote ${fixtures.length} fixtures + ${n} cases to ${BENCH_DIR}\n`);
  process.stdout.write(`question types: ${JSON.stringify(dist)}\n`);
  process.stdout.write(`lang: ${JSON.stringify(langDist)}\n`);
}

main();
