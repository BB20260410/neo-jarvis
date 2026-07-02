// @ts-check
// NoeEpisodeSublimation — 梦境升华（内在世界·支柱②：久远情景 → 语义记忆）。
//
// 问题：自传体时间线（events 表 kind='noe_episode'）有 180 天保留期硬删（SqliteStore.pruneEvents），
//   久远情景到期即整段蒸发——Noe 会"忘掉三个月前的日子"。人类的解法是睡眠中把情景记忆升华成
//   语义记忆：具体对话忘了，但"那段日子我们在做什么"的印象留下来。本模块模拟这条通路：
//   取水位线之后、now-90 天之前（留 180 天硬删余量）的旧情景 → 按周分组 → （可选 LLM 钩子）
//   升华成第一人称摘要 → MemoryCore.write 沉淀（scope:'episodic_digest'、sourceType:'dream_sublimation'）
//   → 推进水位线（atomicJsonFile 原子持久化）→ 写回一条 type:'dream' 情景"我梦里整理了 N 段往事"。
//
// 纪律（与 NoeDreamConsolidation.createMemoryDreamLoop 同形态）：
//   - 注入式全可 fake：timeline / memoryCore / llmSublimate / phaseOf / now / 水位线文件路径。
//   - 模块不读 env：门控在 server.js 装配点（NOE_DREAM_EPISODES=1 默认 OFF）。
//   - 单组失败不阻断整批（逐组 try/catch，仿 applyConsolidationPlan）；失败组不重试——升华是
//     best-effort 增益，漏一周摘要可接受，绝不为重试制造重复沉淀（水位线只进不退）。
//   - LLM 钩子缺失/抛错/输出空 → 确定性拼接摘要兜底（fail-open，不调模型不烧额度）。
//   - events 表 append-only（无 update API）→ 去重唯一依据是持久化水位线 ts。
//   - 升华产物 salience 钳制 ≤4：永不触及身份级（>=5 受梦境整合 protectedScopes 硬保护）记忆带。
//   - 跑模型不设任何超时（chat 钩子由装配方注入，本模块不包 AbortSignal）。

import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

/** @typedef {{ ts: number, summary: string, type?: string, salience?: number }} Episode */
/** @typedef {{ bucket: number, label: string, episodes: Episode[] }} WeekGroup */
/** @typedef {{ aged: (opts: { sinceTs?: number, untilTs: number, limit?: number, minSalience?: number, types?: string[] }) => Episode[] | undefined, record?: (event: any) => void }} EpisodicTimeline */
/** @typedef {{ write: (memory: any) => void }} MemoryCore */

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
/** 默认升华阈值：90 天前算"久远"（pruneEvents 默认 180 天硬删，留一半余量）。 */
export const DEFAULT_AGED_DAYS = 90;
// 默认不吃 type='dream'（升华自己的写回情景再进摘要是递归噪声）；其余类型都值得化进"那段日子"。
const DEFAULT_TYPES = ['interaction', 'observation', 'milestone', 'inner_monologue'];
const MAX_DIGEST_CHARS = 1000;

/** 时间戳 → 周桶编号（epoch 7 天定宽分桶，确定性纯函数）。 */
export function weekBucketOf(ts) {
  return Math.floor(Number(ts) / WEEK_MS);
}

/** 周桶编号 → 人话标签（桶起始日 ISO 日期）。 */
export function weekLabelOf(bucket) {
  // 强健:导出纯函数被直接以非有限 bucket(NaN/undefined/Infinity)调用时不抛 RangeError——降级占位。
  // 合法数值 bucket 逐字不变(内部 groupEpisodesByWeek 已 guard,此为导出面 defense-in-depth)。
  const ms = Number(bucket) * WEEK_MS;
  if (!Number.isFinite(ms)) return '某一周';
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '某一周';
  return `${d.toISOString().slice(0, 10)} 那一周`;
}

/**
 * 按周分组（桶正序=最老在前）。纯函数。
 * @param {Episode[]} episodes
 * @returns {WeekGroup[]}
 */
export function groupEpisodesByWeek(episodes = []) {
  const byBucket = new Map();
  for (const e of Array.isArray(episodes) ? episodes : []) {
    if (!e || !Number.isFinite(Number(e.ts))) continue;
    const bucket = weekBucketOf(e.ts);
    if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, label: weekLabelOf(bucket), episodes: [] });
    byBucket.get(bucket).episodes.push(e);
  }
  return Array.from(byBucket.values()).sort((a, b) => a.bucket - b.bucket);
}

/**
 * 确定性拼接摘要（LLM 钩子缺失/失败时的兜底，零模型零额度）。纯函数。
 * @param {WeekGroup} group
 */
export function buildDeterministicDigest(group) {
  const parts = (group?.episodes || []).map((e) => String(e?.summary || '').trim()).filter(Boolean);
  return `我回想起${group?.label || '那段日子'}：${parts.join('；')}`.slice(0, MAX_DIGEST_CHARS);
}

const SUBLIMATE_PROMPT = [
  '你是 Noe 的梦境整理器。下面是我（Noe）某一周经历的一批往事情景。',
  '请把它们升华成一段第一人称的长期记忆摘要（中文，≤200 字）：只保留值得长期记住的脉络、事实与感受，不编造细节，不逐条复述。',
  '只输出摘要正文，不要任何前后缀或解释。',
].join('\n');

/**
 * 建一个 llmSublimate(group)=>Promise<string> 钩子。chat 注入式（(prompt)=>Promise<reply>，
 * 生产由装配方用 NoeDreamM3Hook.buildChat 构造；测试注入 fake）。失败/空输出返回 ''（调用方走确定性兜底）。
 * @param {object} [opts]
 * @param {(prompt:string)=>Promise<string>} [opts.chat]
 * @param {number} [opts.maxItems] 单组最多喂多少条情景（控上下文）
 * @param {number} [opts.maxChars] 摘要截断长度
 */
export function createSublimateHook({ chat, maxItems = 60, maxChars = 800 } = {}) {
  /** @type {(group: WeekGroup) => Promise<string>} */
  return async function llmSublimate(group) {
    if (typeof chat !== 'function' || !group?.episodes?.length) return '';
    const list = group.episodes.slice(0, maxItems).map((e) => `- [${e.type || 'interaction'}] ${String(e.summary || '').slice(0, 200)}`).join('\n');
    let reply = '';
    try { reply = String(await chat(`${SUBLIMATE_PROMPT}\n\n时段：${group.label}\n情景列表：\n${list}`) || ''); } catch { return ''; }
    return reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, maxChars);
  };
}

/**
 * 建「梦境升华」循环。**默认 enabled=false**（门控在装配点，本模块不读 env）。
 * @param {object} [opts]
 * @param {EpisodicTimeline|null} [opts.timeline] EpisodicTimeline（需 aged()；record() 用于写回 dream 情景）
 * @param {MemoryCore|null} [opts.memoryCore] MemoryCore（只用 write，绝不 merge/downgrade/setSalience）
 * @param {(group: WeekGroup) => Promise<string>|null} [opts.llmSublimate] LLM 摘要钩子（null → 纯确定性拼接）
 * @param {string|null} [opts.watermarkFile] 水位线持久化文件（null → 仅进程内存，测试用）
 * @param {((ts?:number)=>string)|null} [opts.phaseOf] 节律注入（NoeCircadian.phaseOf）；注入后只在 'night' 执行，null 不受限
 * @param {number} [opts.agedDays] 几天前算"久远"（默认 90，必须 <180 留硬删余量）
 * @param {number} [opts.minSalience] 低于此显著度的情景不升华
 * @param {string[]} [opts.types] 参与升华的情景类型（默认排除 'dream' 防递归噪声）
 * @param {number} [opts.batchLimit] 单轮最多取多少条
 * @param {string} [opts.projectId]
 * @param {boolean} [opts.enabled]
 * @param {number} [opts.intervalMs] 默认 6h（升华是低频整理）
 * @param {number} [opts.firstDelayMs] 默认 10min
 * @param {() => number} [opts.now]
 * @param {(msg:string)=>void} [opts.log]
 */
export function createEpisodeSublimationLoop({
  timeline = null, memoryCore = null, llmSublimate = null,
  watermarkFile = null, phaseOf = null,
  agedDays = DEFAULT_AGED_DAYS, minSalience = 0, types = DEFAULT_TYPES, batchLimit = 200,
  projectId = 'noe', enabled = false,
  intervalMs = 6 * 3600000, firstDelayMs = 10 * 60000,
  now = Date.now, log = () => {},
} = {}) {
  // 水位线：已升华到哪个 ts（只进不退）。文件损坏/缺失 → 0（从头来，靠 untilTs 仍只动久远段）。
  let watermark = 0;
  if (watermarkFile) {
    try {
      const j = readJsonWithCorruptBackup(watermarkFile, { label: 'noe-episode-sublimation' });
      const v = Number(j?.lastTs);
      if (Number.isFinite(v) && v > 0) watermark = v;
    } catch { /* 读失败按 0 处理（fail-open） */ }
  }
  const saveWatermark = (ts) => {
    if (!watermarkFile) return;
    try { atomicWriteJson(watermarkFile, { version: 1, lastTs: ts }); } catch { /* 持久化失败不阻断（下轮可能重复升华，可接受） */ }
  };

  let timer = null; let started = false; let running = false;

  /** @type {() => Promise<{ ok?: boolean, skipped?: string, phase?: string, error?: string, processed?: number, digests?: number, errors?: number, watermark?: number }>} */
  async function tick() {
    if (running) return { skipped: 'overlap' };
    running = true;
    try {
      if (typeof timeline?.aged !== 'function' || typeof memoryCore?.write !== 'function') return { skipped: 'deps_missing' };
      const t = now();
      // 节律门控（注入 phaseOf 才生效）：梦只在夜里做；判定抛错按夜里照常跑（fail-open）。
      if (typeof phaseOf === 'function') {
        let phase = 'night';
        try { phase = phaseOf(t); } catch { /* 节律判定失败 → 不限制 */ }
        if (phase !== 'night') return { skipped: 'not_night', phase };
      }
      const untilTs = t - agedDays * DAY_MS;
      /** @type {Episode[]} */
      let episodes = [];
      try {
        episodes = timeline.aged({ sinceTs: watermark > 0 ? watermark + 1 : undefined, untilTs, limit: batchLimit, minSalience, types }) || [];
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
      if (!episodes.length) return { ok: true, processed: 0, digests: 0, errors: 0, watermark };

      const groups = groupEpisodesByWeek(episodes);
      let processed = 0; let digests = 0; let errors = 0; let maxTs = watermark;
      for (const g of groups) {
        try {
          let digest = '';
          if (typeof llmSublimate === 'function') {
            try { digest = String((await llmSublimate(g)) || '').trim(); } catch { digest = ''; }
          }
          if (!digest) digest = buildDeterministicDigest(g);
          // salience 跟随该周最高显著度但钳制 ≤4：升华产物永不进身份级（>=5）保护带。
          const sal = Math.max(1, Math.min(4, Math.max(...g.episodes.map((e) => Number(e?.salience) || 0), 1)));
          // 跨批次去重健壮性（B1.6①）：水位线（持久化 ts）是首要去重依据，但文件丢失/损坏会回落 0，
          // 同一周可能被再次升华。给每周一个确定性 id（projectId+周桶）作第二道兜底——MemoryCore.write
          // 走 ON CONFLICT(id) DO UPDATE 的精确 upsert（显式 id 不参与模糊合并/冲突策略），所以水位线
          // 即便丢失，重复升华也只 UPDATE 同一条摘要而非堆新，绝不出现同周重复 episodic_digest。
          const weekId = `epiweek-${projectId}-${g.bucket}`;
          memoryCore.write({
            id: weekId,
            projectId,
            scope: 'episodic_digest',
            sourceType: 'dream_sublimation',
            sourceId: `epiweek-${g.bucket}`,
            title: `往事整理：${g.label}`,
            body: digest,
            tags: ['dream_sublimation', 'episodic'],
            confidence: 0.7,
            salience: sal,
          });
          digests += 1;
          processed += g.episodes.length;
        } catch { errors += 1; }
        // 水位线覆盖"已尝试"的组（含失败组）：失败不重试，绝不重复沉淀。
        for (const e of g.episodes) { const ts = Number(e?.ts); if (ts > maxTs) maxTs = ts; }
      }
      if (maxTs > watermark) { watermark = maxTs; saveWatermark(maxTs); }
      if (processed > 0) {
        try {
          timeline.record?.({ type: 'dream', summary: `我梦里整理了 ${processed} 段往事，沉淀成 ${digests} 条长期记忆`, salience: 2 });
        } catch { /* 写回失败不阻断（摘要已沉淀） */ }
      }
      log(`processed=${processed} digests=${digests} errors=${errors} watermark=${watermark}`);
      return { ok: true, processed, digests, errors, watermark };
    } finally {
      running = false;
    }
  }

  return {
    tick, // 手动触发（测试/调试/owner 手动整理）
    isEnabled: () => enabled,
    isRunning: () => started,
    currentWatermark: () => watermark,
    start() {
      if (started || !enabled) return false; // 默认 OFF：enabled 才会真跑后台循环
      started = true;
      timer = setTimeout(() => { tick(); timer = setInterval(tick, intervalMs); }, firstDelayMs);
      if (timer?.unref) timer.unref(); // 不阻塞进程退出
      return true;
    },
    stop() { if (timer) { clearTimeout(timer); clearInterval(timer); } timer = null; started = false; },
  };
}
