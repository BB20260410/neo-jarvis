// Origin 白名单纯函数 —— 从 server.js 抽出，供 HTTP middleware 和 WS upgrade 共用，
// 并可独立单测（server.js 顶层会 app.listen，无法在测试里直接 import）。
//
// CSRF 防护语义：无 Origin 头（curl / Electron / 内部请求）放行；
// 带 Origin 头时必须命中白名单，否则拒绝。WS 另有 token 兜底（见 server.js _checkWsToken）。

export function buildAllowedOrigins(port = 51835) {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ]);
}

// 返回 true 表示放行，false 表示应拒绝。
export function isOriginAllowed(origin, allowedSet) {
  // 审计 §3.2 M⑤：浏览器跨站请求必带 Origin，缺 Origin 的是非浏览器调用方（Electron 主进程 IPC、
  // 本机 curl/脚本、同源 GET 导航），不构成 CSRF 向量；HTTP 写端点另有 requireOwnerToken 兜底。
  // 故无 Origin 放行安全；但绝不能据此放宽「带 Origin 但不在白名单」的跨站请求。
  if (!origin) return true;
  return allowedSet.has(origin);
}
