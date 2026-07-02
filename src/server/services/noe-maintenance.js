// @ts-check
// 第三波手术 第34批：Noe 后台维护循环群（geo-weather / agent-probe / dream / episode-sublimation /
// db-backup / retention / memory-GC，~110 行）从 server.js 原文迁出。
// 7 个互相独立、各自 env 门控的 timer 块，纯启动副作用（除 prefetchStore 写入），无返回值被组合根后文引用。
// 注入约定：memoryCore（MemoryCore 实例）/ prefetchStore（预取池）/ dataDir（~/.noe-panel）单向注入；
// 其余依赖全是无状态模块函数（ESM 单例），模块内直接 import。
// env 求值时机不变：原块在 server.js 模块求值期执行，现在 install() 在同一位置同步调用。
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchGeoWeather, formatGeoWeatherBrief } from '../../context/NoeGeoWeather.js';
import { probeLocalAgents, makeCliDetector } from '../../autopilot/NoeLocalAgentProbe.js';
import { createMemoryDreamLoop } from '../../memory/NoeDreamConsolidation.js';
import { createConsolidateHook, parseModelSpec, buildChat } from '../../memory/NoeDreamM3Hook.js';
import { createEpisodeSublimationLoop, createSublimateHook } from '../../memory/NoeEpisodeSublimation.js';
import { EpisodicTimeline } from '../../memory/EpisodicTimeline.js';
import { defaultCircadian } from '../../loop/NoeCircadian.js';
import { backupPanelDb } from '../../storage/NoeDbBackup.js';
import { pruneEvents, pruneAuditTables, getDb } from '../../storage/SqliteStore.js';
import { withActiveGuard } from '../../runtime/NoeActiveJobGuard.js';
import { runDanglingMergeRefCheck } from '../../memory/NoeMemoryIntegrityCheck.js';

/**
 * 安装全部 Noe 后台维护循环（各块 env 门控，默认行为与迁出前逐字一致）。
 * @param {{ memoryCore: any, prefetchStore: any, dataDir: string }} deps
 * @returns {{ dreamLoop: any, episodeSublimationLoop: any }} 供测试/观测；组合根不依赖返回值
 */
export function installNoeMaintenanceLoops({ memoryCore, prefetchStore, dataDir }) {
  // geo-weather（波次5 P2 接线）：NOE_GEO_WEATHER=1 才通电（涉及对第三方暴露出口 IP，opt-in）。
  // 定位+天气进预取池 → 聊天上下文注入 → 问"今天天气"秒答。无 API key（ipapi.co + open-meteo）。
  if (process.env.NOE_GEO_WEATHER === '1') {
    const refreshGeoWeather = async () => {
      try {
        const gw = await fetchGeoWeather();
        prefetchStore.set('geo-weather', formatGeoWeatherBrief(gw), 40 * 60000);   // 40min 新鲜度
        console.log(`[noe-geo-weather] 已更新: ${formatGeoWeatherBrief(gw)}`);
      } catch (e) { console.warn('[noe-geo-weather] 抓取失败(下轮再试):', e?.message); }
    };
    setTimeout(refreshGeoWeather, 5000).unref?.();
    const gwTimer = setInterval(refreshGeoWeather, 30 * 60000);   // 每 30min 刷新
    gwTimer.unref?.();
    console.log('[noe-geo-weather] 已启用(每 30 分钟刷新进预取池)');
  }
  // 本机可委托 agent 探测（波次6 接线 NoeLocalAgentProbe）：启动延迟探测 claude/codex/minimax/ollama，
  // 结果进预取池 → 聊天上下文注入（任务2 已接），Noe 被问"你能把活委托给谁"据实秒答。
  setTimeout(() => {
    try {
      const probe = probeLocalAgents(undefined, { detect: makeCliDetector() });
      const brief = `本机可委托 AI agent：${probe.available.join('、') || '无'}（${probe.agents.map((a) => `${a.id}${a.available ? `✅${a.version ? ' ' + a.version : ''}` : '❌'}`).join(' / ')}）`;
      prefetchStore.set('local-agents', brief, 0);   // ttl<=0 = 进程生命周期内不过期
      console.log(`[noe-agent-probe] 本机可委托: ${probe.available.join(', ') || '(无)'}`);
    } catch (e) { console.warn('[noe-agent-probe] 探测失败(不影响其他功能):', e?.message); }
  }, 3000).unref?.();
  // 梦境/睡眠记忆整合循环:默认 OFF。设 NOE_DREAM=1 才开后台(周期性烧 M3 做语义去重 + 合并/降级/晋升)。
  // enabled=false 时 start() 是 no-op,对现有行为零影响。
  const dreamLoop = createMemoryDreamLoop(memoryCore, {
    projectId: 'noe',
    enabled: process.env.NOE_DREAM === '1',
    // 整合大脑模型可选:NOE_DREAM_MODEL=ollama:qwen3.5:2b(本地免费) | minimax:MiniMax-M3 | xiaomi:mimo-v2.5-pro | none(默认,纯确定性不调 LLM 不烧额度)
    llmConsolidate: (process.env.NOE_DREAM === '1' && parseModelSpec(process.env.NOE_DREAM_MODEL))
      ? createConsolidateHook(parseModelSpec(process.env.NOE_DREAM_MODEL)) : null,
    firstDelayMs: Number(process.env.NOE_DREAM_FIRST_MS) || undefined,   // 默认 5min;调试可短设
    intervalMs: Number(process.env.NOE_DREAM_INTERVAL_MS) || undefined,  // 默认 30min
    log: (m) => console.log(`[noe-dream] ${m}`),
  });
  if (dreamLoop.start()) console.log(`[noe-dream] 梦境整合循环已启用(首跑 ${Number(process.env.NOE_DREAM_FIRST_MS) || 300000}ms 后)`);
  // 内在世界·支柱②（梦境升华）:把 90 天前的久远情景按周升华成语义记忆沉淀进 MemoryCore(赶在 events 表
  // 180 天保留期硬删之前),完成后写回一条 type:'dream' 情景。默认 OFF,NOE_DREAM_EPISODES=1 才开;
  // 升华大脑复用 NOE_DREAM_MODEL(默认 none → 确定性拼接摘要,不调 LLM 不烧额度);
  // NOE_CIRCADIAN=1 时只在 night phase 执行(贴合"梦"的语义;未开节律门控不受限)。
  // 此处在 noeEpisodicTimeline 构造(脊椎装配区)之前 → new 独立实例(多实例共享同一 SQLite events 表,数据互通)。
  const epiSublimateSpec = process.env.NOE_DREAM_EPISODES === '1' ? parseModelSpec(process.env.NOE_DREAM_MODEL) : null;
  const episodeSublimationLoop = createEpisodeSublimationLoop({
    timeline: new EpisodicTimeline(),
    memoryCore,
    projectId: 'noe',
    enabled: process.env.NOE_DREAM_EPISODES === '1',
    llmSublimate: epiSublimateSpec ? createSublimateHook({ chat: buildChat(epiSublimateSpec.provider, epiSublimateSpec.model) }) : null,
    watermarkFile: join(dataDir, 'episode-sublimation.json'),
    phaseOf: process.env.NOE_CIRCADIAN === '1' ? defaultCircadian.phaseOf : null,
    firstDelayMs: Number(process.env.NOE_DREAM_EPISODES_FIRST_MS) || undefined,   // 默认 10min
    intervalMs: Number(process.env.NOE_DREAM_EPISODES_INTERVAL_MS) || undefined,  // 默认 6h(低频整理)
    log: (m) => console.log(`[noe-dream-episodes] ${m}`),
  });
  if (episodeSublimationLoop.start()) console.log('[noe-dream-episodes] 梦境升华循环已启用(久远情景→语义记忆)');
  // panel.db 自动备份（强健②，2026-06-10）：库是 Noe 的记忆全部家当，默认开（NOE_DB_BACKUP=0 可关）。
  // 启动 90s 后做当日快照（同日覆盖为最新）+ 每 24h 一次；轮转保留 7 份在 ~/.noe-panel/backups/。
  if (process.env.NOE_DB_BACKUP !== '0') {
    const runDbBackup = () => backupPanelDb()
      .then((r) => console.log(`[noe-db-backup] 已快照 ${r.path}（${Math.round(r.sizeBytes / 1024)}KB，含 ${r.copiedFiles?.length ?? 0} 个状态文件）${r.pruned.length ? `，轮转删除 ${r.pruned.join(', ')}` : ''}`))
      .catch((e) => console.warn('[noe-db-backup] 备份失败(不影响运行):', e?.message));
    setTimeout(runDbBackup, 90_000).unref?.();
    const dbBackupTimer = setInterval(runDbBackup, 24 * 3600000);
    dbBackupTimer.unref?.();
    console.log('[noe-db-backup] 已启用（启动 90s 后 + 每 24h 快照，保留 7 份）');
  }
  // 保留期维护（强健补遗 A+D，2026-06-10）：events 表(默认180天) + 旧按天日志(90天)。
  // 与备份开关解耦（关备份≠不要清理）；NOE_MAINTENANCE=0 可单独关。
  if (process.env.NOE_MAINTENANCE !== '0') {
    let vacuumDone = false; // SQLite-2：VACUUM 进程内只跑一次（防每 24h 重复锁库；需再瘦身重启进程）
    const runRetentionMaintenance = () => {
      try {
        // 自传情景(noe_episode)受更长保留期保护，默认 3650 天(10 年)，对称 env 可调；默认值即正确行为(非靠开关藏 bug)。
        const n = pruneEvents({
          retentionDays: Number(process.env.NOE_EVENTS_RETENTION_DAYS) || 180,
          episodeRetentionDays: Number(process.env.NOE_EPISODE_RETENTION_DAYS) || 3650,
        });
        if (n > 0) console.log(`[noe-maintenance] events 表清理 ${n} 行(保留期外)`);
      } catch (e) { console.warn('[noe-maintenance] events 清理失败:', e?.message); }
      try {
        const logDir = join(homedir(), '.noe-panel', 'logs');
        const cutoff = Date.now() - 90 * 86400000;
        let removed = 0;
        for (const f of (existsSync(logDir) ? readdirSync(logDir) : [])) {
          if (!/^panel-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;   // 只清按天日志，不碰其他产物
          const full = join(logDir, f);
          try { if (statSync(full).mtimeMs < cutoff) { rmSync(full); removed += 1; } } catch { /* 单文件失败跳过 */ }
        }
        if (removed > 0) console.log(`[noe-maintenance] 旧日志清理 ${removed} 个文件(90 天前)`);
      } catch (e) { console.warn('[noe-maintenance] 日志清理失败:', e?.message); }
      // PRAGMA optimize（5 项目研究 SQLite high）：SQLite 官方推荐周期跑，更新查询计划统计、提升索引选择。
      try { getDb().pragma('optimize'); } catch (e) { console.warn('[noe-maintenance] PRAGMA optimize 失败:', e?.message); }
      // SQLite-2 审计大表保留期（flag NOE_DB_AUDIT_RETENTION=1 默认 OFF）：清 noe_ticks(~60万)/agent_runs(~31万)
      //   旧行（agent_runs 经 ON DELETE CASCADE 自动级联删 agent_messages/tool_results）。各保留期 env 可调
      //   （默认 30/90 天），<7 天护栏在 pruneAuditTables 内。只删审计噪音，不碰记忆/目标/自改/自传/语义。
      if (process.env.NOE_DB_AUDIT_RETENTION === '1') {
        try {
          const r = pruneAuditTables({
            tickRetentionDays: Number(process.env.NOE_TICKS_RETENTION_DAYS) || 14,
            agentRunRetentionDays: Number(process.env.NOE_AGENT_RUNS_RETENTION_DAYS) || 30,
          });
          if (r.ticks || r.runs) console.log(`[noe-maintenance] 审计清理 noe_ticks ${r.ticks} 行 / agent_runs ${r.runs} 行(+级联子表)`);
        } catch (e) { console.warn('[noe-maintenance] 审计清理失败:', e?.message); }
      }
      // SQLite-2 VACUUM（flag NOE_DB_VACUUM=1 默认 OFF）：prune 后回收磁盘（panel.db 1.3G→缩）。VACUUM 重写整库、
      //   期间锁库阻塞读写（1.3G 数十秒），故默认 OFF——owner 低峰点火、瘦身后建议关 flag（避免每 24h 重复锁）。
      if (process.env.NOE_DB_VACUUM === '1' && !vacuumDone) {
        try { const t = Date.now(); getDb().exec('VACUUM'); vacuumDone = true; console.log(`[noe-maintenance] VACUUM 完成(${Date.now() - t}ms)，本进程不再重复（避免每 24h 锁库；需再瘦身重启进程）`); } catch (e) { console.warn('[noe-maintenance] VACUUM 失败:', e?.message); }
      }
    };
    setTimeout(runRetentionMaintenance, 120_000).unref?.();
    const maintenanceTimer = setInterval(runRetentionMaintenance, 24 * 3600000);
    maintenanceTimer.unref?.();
    console.log('[noe-maintenance] 保留期维护已启用（events 180天 / 日志 90天，每 24h）');
  }
  // 记忆库 GC（波次6 接线）：NoeMemoryCurator 定时打扫过期/陈旧低价值记忆。与梦境同款 env 开关，默认 OFF 零影响：
  // NOE_MEMORY_GC=1 真清(hide 软删可 unhide 恢复,身份级 salience>=5 铁律保护) | =dry 只记日志不动库。
  const memGcMode = process.env.NOE_MEMORY_GC;
  if (memGcMode === '1' || memGcMode === 'dry') {
    const gcIntervalMs = Number(process.env.NOE_MEMORY_GC_INTERVAL_MS) || 6 * 3600000;
    const gcTimer = setInterval(() => {
      // T32 withActiveGuard（波次6 接线）：上一轮 GC 还在跑就跳过本轮，防周期任务重叠
      withActiveGuard('noe-memory-gc', async () => {
        const r = memoryCore.runGc({ apply: memGcMode === '1', reason: 'gc_curator_scheduled' });
        const n = memGcMode === '1' ? r.hidden.length : r.plan.gcCandidates.length;
        console.log(`[noe-memory-gc] ${memGcMode === '1' ? '已隐藏' : 'dry-run 候选'} ${n} 条(expired=${r.plan.counts.expired} stale=${r.plan.counts.stale} lowconf=${r.plan.counts.low_confidence})${r.truncated ? ' [超扫描上限,下轮继续]' : ''}`);
      }, { onSkip: () => console.warn('[noe-memory-gc] 上一轮还在跑，跳过本轮(withActiveGuard)') })
        .catch((e) => console.warn('[noe-memory-gc] 失败:', e?.message));
    }, gcIntervalMs);
    gcTimer.unref?.();
    console.log(`[noe-memory-gc] 已启用(${memGcMode === '1' ? 'apply' : 'dry-run'},每 ${Math.round(gcIntervalMs / 60000)} 分钟)`);
  }

  // P3-5 记忆一致性自检（启动时一次，只读 SELECT，零写零风险）：检测 merge 目标悬挂引用（指向已删 id）。
  //   常开诊断；发现悬挂只告警（不自动修，符合「可逆 + 不擅动数据」）。
  try {
    const integ = runDanglingMergeRefCheck({ db: memoryCore?.db?.() });
    if (integ?.danglingCount > 0) {
      console.warn(`[noe-memory-integrity] 检出 ${integ.danglingCount} 条 merge 悬挂引用（指向已删目标），样例: ${integ.dangling.slice(0, 3).map((d) => `${d.id}→${d.missingTarget}`).join(', ')}`);
    } else if (integ?.ok) {
      console.log(`[noe-memory-integrity] 一致性自检通过（扫 ${integ.scanned} 条，无悬挂 merge 引用）`);
    }
  } catch (e) { console.warn('[noe-memory-integrity] 自检跳过:', e?.message); }

  return { dreamLoop, episodeSublimationLoop };
}
