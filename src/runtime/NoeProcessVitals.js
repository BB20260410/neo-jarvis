// @ts-check
// NoeProcessVitals — 进程死前留痕（A3）。背景：隔离实例曾无声死亡（疑 OOM/SIGKILL），
// 日志无堆栈无遗言，launchd 自愈只管拉起不管为何死，尸检无从下手。
//
// 机制（零侵入既有 uncaught/SIGTERM handler）：
//   ① 启动即写 {status:'running'} 并每 intervalMs 更新心跳（rss/heapUsed/uptime）——
//      SIGKILL/OOM 这类不给任何回调的死法，最后一跳心跳就是唯一尸检线索；
//   ② process.on('exit') 同步写遗言 {status:'exited', code}（任何 process.exit 路径都触发，
//      天然兜底既有 gracefulShutdown/uncaughtException 的 exit，不需要改它们）；
//   ③ 下次启动读上次记录：有遗言→报退出码；只有心跳没遗言→warn 疑似硬死+最后心跳数据。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_FILE = join(homedir(), '.noe-panel', 'last-exit.json');

function readJson(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null; } catch { return null; }
}

function writeJson(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    return true;
  } catch { return false; }
}

function fmtMb(bytes) {
  return `${Math.round((Number(bytes) || 0) / 1024 / 1024)}MB`;
}

/** 分析上次运行的退出方式（导出便于单测）。 */
export function analyzeLastExit(prev) {
  if (!prev || typeof prev !== 'object') return { kind: 'first_run', message: '[noe-vitals] 首次运行（无上次退出记录）' };
  if (prev.status === 'exited') {
    const code = Number(prev.code);
    const kind = code === 0 ? 'clean_exit' : 'error_exit';
    return {
      kind,
      message: `[noe-vitals] 上次${code === 0 ? '正常退出' : `异常退出 code=${code}`}（${prev.at || '时间未知'}）`,
    };
  }
  // status=running 却到了下次启动 = 没机会留遗言的硬死（SIGKILL/OOM/断电）
  const v = prev.lastVitals || {};
  return {
    kind: 'hard_death',
    message: `[noe-vitals] ⚠️ 上次未留遗言即死（疑 OOM/SIGKILL/断电）。最后心跳 ${v.at || '?'}：rss=${fmtMb(v.rss)} heap=${fmtMb(v.heapUsed)} 已运行=${Math.round((v.uptimeSec || 0) / 60)}min`,
    lastVitals: v,
  };
}

/**
 * 安装死前留痕。返回 {report, stop}（stop 供测试清定时器）。
 * @param {{file?: string, intervalMs?: number, proc?: any, log?: Function, warn?: Function, now?: () => number}} [opts]
 */
export function installProcessVitals({
  file = process.env.NOE_VITALS_FILE || DEFAULT_FILE,
  intervalMs = Number(process.env.NOE_VITALS_INTERVAL_MS) || 60_000,
  proc = process,
  log = console.log,
  warn = console.warn,
  now = () => new Date().toISOString(),
} = {}) {
  const report = analyzeLastExit(readJson(file));
  (report.kind === 'hard_death' || report.kind === 'error_exit' ? warn : log)(report.message);

  const vitals = () => {
    const m = proc.memoryUsage?.() || {};
    return { at: now(), rss: m.rss || 0, heapUsed: m.heapUsed || 0, uptimeSec: Math.round(proc.uptime?.() || 0) };
  };
  const running = { status: 'running', pid: proc.pid, startedAt: now(), lastVitals: vitals() };
  writeJson(file, running);

  const timer = setInterval(() => {
    running.lastVitals = vitals();
    writeJson(file, running);
  }, Math.max(5_000, intervalMs));
  timer.unref?.();

  // exit 同步兜底：gracefulShutdown 的 exit(0)、uncaughtException 的 exit(1) 都会路过这里
  proc.on('exit', (code) => {
    writeJson(file, { status: 'exited', code: Number(code) || 0, at: now(), lastVitals: running.lastVitals });
  });

  return { report, stop: () => clearInterval(timer) };
}
