const DEFAULT_EXIT_DELAY_MS = 500;
// P1（2026-07-02）：EADDRINUSE 时占端口者通常不会自己消失，500ms 退出 + launchd ThrottleInterval 15s
//   = 每 15 秒空转 crashloop（重复执行启动副作用）。改为退避 60s 再退出：循环强度降 4 倍，
//   且端口一旦释放，下一轮拉起即自愈（比 exit(0) 永久停摆更适合陪伴型常驻进程）。
const EADDRINUSE_EXIT_DELAY_MS = 60_000;

export function buildServerListenErrorMessage(err, { port } = {}) {
  const code = err?.code || 'UNKNOWN';
  if (code === 'EADDRINUSE') {
    return `❌ 端口 ${port} 被占用。运行: lsof -iTCP:${port} -sTCP:LISTEN -t | xargs kill -KILL  释放后重启（本进程 60s 后退出，launchd 会重试）`;
  }
  if (code === 'EACCES') {
    return `❌ 端口 ${port} 权限不足（>1024 才可用 non-root 监听）`;
  }
  return `❌ server listen 错误: ${err?.message || code}`;
}

export function handleServerListenError(err, {
  port,
  logger = console,
  flushLogs = null,
  exit = process.exit,
  setExitCode = (code) => { process.exitCode = code; },
  setTimeoutFn = setTimeout,
  exitDelayMs = (err?.code === 'EADDRINUSE' ? EADDRINUSE_EXIT_DELAY_MS : DEFAULT_EXIT_DELAY_MS),
} = {}) {
  const message = buildServerListenErrorMessage(err, { port });
  logger?.error?.(message);
  setExitCode(1);
  try { flushLogs?.(); } catch {}
  const timer = setTimeoutFn(() => exit(1), Math.max(0, Number(exitDelayMs) || 0));
  return { message, exitCode: 1, exitDelayMs, timer };
}
