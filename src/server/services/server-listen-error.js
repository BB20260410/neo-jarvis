const DEFAULT_EXIT_DELAY_MS = 500;

export function buildServerListenErrorMessage(err, { port } = {}) {
  const code = err?.code || 'UNKNOWN';
  if (code === 'EADDRINUSE') {
    return `❌ 端口 ${port} 被占用。运行: lsof -iTCP:${port} -sTCP:LISTEN -t | xargs kill -KILL  释放后重启`;
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
  exitDelayMs = DEFAULT_EXIT_DELAY_MS,
} = {}) {
  const message = buildServerListenErrorMessage(err, { port });
  logger?.error?.(message);
  setExitCode(1);
  try { flushLogs?.(); } catch {}
  const timer = setTimeoutFn(() => exit(1), Math.max(0, Number(exitDelayMs) || 0));
  return { message, exitCode: 1, exitDelayMs, timer };
}
