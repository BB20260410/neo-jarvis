// @ts-check
// 强健工程：gracefulShutdown 停机清理接线防回归（源码文本断言，仿 server-route-wiring）
// 钉死三件易被改回的事：①MCP 断开必须 await（旧版 fire-and-forget+立即 exit→子进程变孤儿）
// ②停机关 WS 三类连接池 ③仍是单一 async gracefulShutdown 挂在 SIGTERM/SIGINT
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
// 只取 gracefulShutdown 函数体（到它自己的 process.exit(0)），避开 uncaughtException 里的同名调用
const fnStart = src.indexOf('async function gracefulShutdown');
const fnBody = src.slice(fnStart, src.indexOf('process.exit(0)', fnStart) + 'process.exit(0)'.length);

describe('gracefulShutdown 停机清理接线', () => {
  it('是 async 函数且挂在 SIGTERM/SIGINT', () => {
    expect(src).toContain('async function gracefulShutdown(signal)');
    expect(src).toContain("process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))");
    expect(src).toContain("process.on('SIGINT', () => gracefulShutdown('SIGINT'))");
  });

  it('MCP 断开 await（防回退成 fire-and-forget 孤儿）', () => {
    expect(fnBody).toMatch(/await\s+Promise\.race\(\[\s*mcpClientManager\.disconnectAll\(\)/);
    // 旧的 fire-and-forget 写法不得在停机函数体内复活
    expect(fnBody).not.toContain('mcpClientManager.disconnectAll().catch(() => {});');
  });

  it('停机关闭三类 WS 连接池', () => {
    expect(fnBody).toContain('globalWsClients');
    expect(fnBody).toContain('roomWsClients');
    expect(fnBody).toMatch(/s\.clients/);
    expect(fnBody).toContain('ws.close()');
  });

  it('救命落盘在 MCP await 之前同步完成（顺序不被打乱）', () => {
    expect(fnBody.indexOf('saveData()')).toBeLessThan(fnBody.indexOf('disconnectAll()'));
    expect(fnBody.indexOf('disconnectAll()')).toBeLessThan(fnBody.indexOf('closeSqliteStore()'));
  });
});
