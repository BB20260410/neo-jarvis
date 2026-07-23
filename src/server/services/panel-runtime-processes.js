// @ts-check
// 第三波手术 第28批：collectPanelRuntimeProcesses 自 server.js 迁出（零模块态纯函数）
// 职责：ps 全表扫描 → 构建本进程后代进程树 → 识别 claude/codex/gemini-cli 运行时子进程，
//      并提取 full-access 信号（cluster_full_access / full_auto / observe_only / skip-permissions / bypass-sandbox）。
// 注入：safeSlice（server.js 顶层 surrogate-safe 截断 helper，3 处路由共用故不随迁）。
import { spawnSync } from 'child_process';

export function createPanelRuntimeProcessCollector({ safeSlice }) {
  return function collectPanelRuntimeProcesses() {
    const result = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,stat=,etime=,command='], {
      encoding: 'utf8',
      env: process.env,
    });
    if (result.error || result.status !== 0) {
      return { ok: false, error: result.error?.message || result.stderr || 'ps_failed', processes: [] };
    }
    const rows = String(result.stdout || '').split('\n')
      .map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
        if (!m) return null;
        return {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          stat: m[3],
          elapsed: m[4],
          command: m[5],
        };
      })
      .filter(Boolean);
    const children = new Map();
    for (const row of rows) {
      if (!children.has(row.ppid)) children.set(row.ppid, []);
      children.get(row.ppid).push(row.pid);
    }
    const descendantPids = new Set();
    const stack = [...(children.get(process.pid) || [])];
    while (stack.length) {
      const pid = stack.pop();
      if (descendantPids.has(pid)) continue;
      descendantPids.add(pid);
      stack.push(...(children.get(pid) || []));
    }
    const typeOf = (command = '') => {
      if (command.includes('claude --print') || command.includes('/bin/claude ')) return 'claude';
      if (command.includes('codex exec')) return 'codex';
      if (command.includes('gemini -p') || command.includes('/bin/gemini ')) return 'gemini-cli';
      return '';
    };
    const processes = rows
      .filter((row) => descendantPids.has(row.pid))
      .map((row) => ({ ...row, adapterId: typeOf(row.command) }))
      .filter((row) => row.adapterId)
      .map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        adapterId: row.adapterId,
        status: row.stat,
        elapsed: row.elapsed,
        fullAccessSignals: {
          clusterFullAccess: row.command.includes('cluster_full_access'),
          fullAuto: row.command.includes('approval=full_auto'),
          observeOnly: row.command.includes('guard=observe_only'),
          claudeSkipPermissions: row.command.includes('--dangerously-skip-permissions'),
          codexBypassSandbox: row.command.includes('--dangerously-bypass-approvals-and-sandbox'),
        },
        commandPreview: safeSlice(row.command, 480),
      }));
    return { ok: true, processes };
  };
}
