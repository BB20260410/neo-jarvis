// @ts-check
// 第三波手术 第30批：sessions 持久化群（debouncedSave/saveData/loadData）自 server.js 迁出
// 职责（原文迁移，行为零差）：
//   saveData  — sessions Map → data.json 原子写（tmp+rename，0o600），messages 截断 200 条 +
//               starredIndices 同步映射（v0.50 Q-07），runtime 同步 cap 防内存无限增长
//   loadData  — data.json → sessions Map 回灌（>500 条按 createdAt 倒序取最新 500，v0.51 Y-02；
//               损坏时备份 .corrupted-*.bak 防原子写覆盖丢历史，v0.51 B-01）
//   debouncedSave — 500ms 去抖（saveTimer 为工厂闭包内部态）
// 注入：sessions（Map 本体留 server.js，单一属主）、dataFile（DATA_FILE 路径）。
import { writeFileSync, chmodSync, renameSync, existsSync, readFileSync, copyFileSync } from 'fs';

export function createSessionPersistence({ sessions, dataFile }) {
  let saveTimer = null;
  function debouncedSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveData, 500);
  }
  function saveData() {
    try {
      const data = [...sessions.values()].map(s => {
        // v0.50 Q-07 fix: messages 截断 200 条 + starredIndices 同步映射，避免索引越界
        const KEEP = 200;
        const totalMsgs = (s.messages || []).length;
        const offset = Math.max(0, totalMsgs - KEEP);
        const messages = s.messages.slice(-KEEP);
        const starredIndices = Array.isArray(s.starredIndices)
          ? s.starredIndices.filter(i => i >= offset && i < totalMsgs).map(i => i - offset)
          : [];
        // v0.50 Q-07: runtime 也 cap 200，避免内存无限增长 + 二次 saveData 时索引漂移
        if (totalMsgs > KEEP) {
          s.messages = messages;
          s.starredIndices = starredIndices;
        }
        return {
        id: s.id, name: s.name, cwd: s.cwd,
        claudeSessionId: s.claudeSessionId,
        createdAt: s.createdAt,
        messages,
        handoffPrimed: s.handoffPrimed || false,
        projectContextPrimed: s.projectContextPrimed || false,
        projectContextSummary: s.projectContextSummary || null,
        parentSessionId: s.parentSessionId || null,
        chainDepth: s.chainDepth || 0,
        archived: s.archived || false,
        archivedAt: s.archivedAt || null,
        // v0.5 思维镜融合
        mainGoal: s.mainGoal || null,
        runState: s.runState || 'idle',
        guardLevel: s.guardLevel || 'standard',
        model: s.model || null,
        totalUSD: s.costTracker ? s.costTracker.totalUSD() : 0,
        dangerHistory: (s.dangerHistory || []).slice(-50),
        loopGuardHistory: (s.loopGuardHistory || []).slice(-50),
        // v0.36 真测 P1 fix: 补 watcher 字段持久化
        watcherEnabled: !!s.watcherEnabled,
        watcherProviderId: s.watcherProviderId || null,
        watcherHistory: (s.watcherHistory || []).slice(-50),
        // v0.47 hook 事件持久化（限长 100）
        hookEvents: (s.hookEvents || []).slice(-100),
        // v0.50 F5/Q-07: 收藏消息索引（已在上方按 offset 映射）
        starredIndices,
        };
      });
      // v0.51 Y-05 fix: 原子写（tmp + rename），防 panel 崩溃中写入截断丢全部 session
      // v0.51 T-16 fix: 0o600 权限（含 claudeSessionId / cwd / messages 等敏感数据）
      const tmp = dataFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, dataFile);
    } catch (e) {
      console.error('save fail:', e.message);
    }
  }
  function loadData() {
    try {
      if (!existsSync(dataFile)) return;
      let data = JSON.parse(readFileSync(dataFile, 'utf-8'));
      // v0.51 Y-02 fix: 加载时 cap 到 MAX_SESSIONS（按 createdAt 倒序优先最新）
      // 避免 data.json 异常增长导致 load 后内存巨大
      if (Array.isArray(data) && data.length > 500) {
        console.warn(`[loadData] data.json 含 ${data.length} 个 session，超过 500 上限，仅加载最新 500`);
        data = [...data].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 500);
      }
      for (const s of data) {
        sessions.set(s.id, {
          id: s.id, name: s.name, cwd: s.cwd,
          claudeSessionId: s.claudeSessionId,
          createdAt: s.createdAt,
          child: null, pid: null,
          busy: false,
          messages: s.messages || [],
          clients: new Set(),
          handoffPrimed: s.handoffPrimed || false,
          projectContextPrimed: s.projectContextPrimed || false,
          projectContextSummary: s.projectContextSummary || null,
          parentSessionId: s.parentSessionId || null,
          chainDepth: s.chainDepth || 0,
          archived: s.archived || false,
          archivedAt: s.archivedAt || null,
          // v0.5 思维镜融合
          mainGoal: s.mainGoal || null,
          runState: s.runState || 'idle',
          guardLevel: s.guardLevel || 'standard',
          model: s.model || null,
          dangerHistory: s.dangerHistory || [],
          loopGuardHistory: s.loopGuardHistory || [],
          // v0.36 真测 P1 fix: load watcher 字段
          watcherEnabled: !!s.watcherEnabled,
          watcherProviderId: s.watcherProviderId || null,
          watcherHistory: s.watcherHistory || [],
          // v0.47 hook 事件 load
          hookEvents: Array.isArray(s.hookEvents) ? s.hookEvents : [],
          // v0.50 F5: 收藏 load
          starredIndices: Array.isArray(s.starredIndices) ? s.starredIndices : [],
        });
      }
      console.log(`📂 恢复 ${sessions.size} 个 session`);
    } catch (e) {
      // v0.51 B-01 fix: data.json 损坏时备份原文件（避免下次 saveData 原子写覆盖 → 用户 session 历史彻底丢）
      try {
        if (existsSync(dataFile)) {
          const bak = dataFile + '.corrupted-' + Date.now() + '.bak';
          copyFileSync(dataFile, bak);
          console.error(`❌ data.json 损坏，已备份到 ${bak}：${e.message}`);
          console.error('   重启后将以空 session 列表运行，原数据保留在备份文件中');
        } else {
          console.error('load fail:', e.message);
        }
      } catch (bakErr) {
        console.error('load fail (备份也失败):', e.message, '/', bakErr.message);
      }
    }
  }
  return { debouncedSave, saveData, loadData };
}
