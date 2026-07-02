// @ts-check
// NoeCuaDriver（P4-2 computer-use 绑定）——把本机 cua-driver（0.5.x, com.trycua.driver）的计算机使用工具
// 接成 Neo 可调的客户端：spawns `cua-driver call <tool> [json]`，解析 JSON 结果。
//
// 权限现实：只读工具（get_screen_size / get_cursor_position / get_window_state…）免 TCC 即可跑（已实测）；
//   真控 GUI（click/type/drag/hotkey…）需 Accessibility + Screen Recording 授权给 com.trycua.driver，由 owner
//   一次性 `cua-driver permissions grant`（GUI 弹窗，AI 点不了）。故本模块默认对「写类」要求显式 ackGuiAction，
//   且高危（提交/支付/登录类）仍受 P4-1 红线5 分类约束（调用方传 actionText 时叠加判定）。
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyBrowserActionRisk } from './NoeBrowserActPolicy.js';

const DEFAULT_BIN = join(homedir(), '.local/bin/cua-driver');
// 只读工具（不改 GUI 状态，免 ack）。
const READ_ONLY_TOOLS = new Set([
  'get_screen_size', 'get_cursor_position', 'get_accessibility_tree', 'get_window_state',
  'check_permissions', 'get_config', 'get_recording_state', 'get_agent_cursor_state', 'list_tools',
  // 实测补全（红队自查）：list_apps / list_windows 是只读枚举（CLI 实测返回数据，原误归写类需 ack）。
  'list_apps', 'list_windows', 'check_for_update',
]);

// 工具风险分级：只读免 ack；写类（改 GUI 状态）需 ackGuiAction；叠加 P4-1 红线5（actionText 含发布/支付/登录→高危）。
export function classifyCuaToolRisk(tool = '', actionText = '') {
  const t = String(tool || '').trim();
  const readOnly = READ_ONLY_TOOLS.has(t);
  const red5 = classifyBrowserActionRisk(`${t} ${actionText}`).highRisk; // 复用红线5 词表（支付/发布/Merge/登录提交）
  if (readOnly && !red5) return { tier: 'read', requiresAck: false, highRisk: false };
  return { tier: red5 ? 'destructive' : 'write', requiresAck: true, highRisk: red5 };
}

function defaultSpawn(bin, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = timeoutMs ? setTimeout(() => { try { child.kill(); } catch { /* */ } reject(new Error('cua_timeout')); }, timeoutMs) : null;
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolvePromise({ exitCode: Number(code) || 0, stdout, stderr }); });
  });
}

/**
 * @param {{ bin?: string, spawnFn?: Function, timeoutMs?: number }} deps
 */
export function createNoeCuaDriver({ bin = DEFAULT_BIN, spawnFn = null, timeoutMs = 30000 } = {}) {
  const run = typeof spawnFn === 'function' ? spawnFn : defaultSpawn;

  async function callTool(tool, params = null, { ackGuiAction = false, actionText = '' } = {}) {
    const t = String(tool || '').trim();
    if (!t) return { ok: false, reason: 'tool_required' };
    const risk = classifyCuaToolRisk(t, actionText);
    // 写类 GUI 操作需显式 ack（防误点/误输入）；高危（红线5）即便 ack 也标 requiresOwnerConfirm 供上层停下确认。
    if (risk.requiresAck && !ackGuiAction) return { ok: false, reason: 'gui_write_requires_ack', tier: risk.tier, highRisk: risk.highRisk };
    const args = ['call', t, ...(params && typeof params === 'object' ? [JSON.stringify(params)] : [])];
    try {
      const res = await run(bin, args, { timeoutMs });
      if (Number(res.exitCode) !== 0) {
        const stderr = String(res.stderr || '');
        const permBlocked = /permission|accessibility|screen recording|tcc|not authorized/i.test(stderr);
        return { ok: false, reason: permBlocked ? 'permission_not_granted' : 'cua_error', exitCode: res.exitCode, stderr: stderr.slice(0, 300) };
      }
      let value; try { value = JSON.parse(res.stdout); } catch { value = String(res.stdout || '').trim(); }
      return { ok: true, tool: t, value, tier: risk.tier, ...(risk.highRisk ? { requiresOwnerConfirm: true } : {}) };
    } catch (e) { return { ok: false, reason: 'spawn_failed', error: String(e?.message || e).slice(0, 200) }; }
  }

  // 读 TCC 权限状态（cua-driver permissions status --json）：daemon 未起时 status=unknown，需 owner grant。
  async function checkPermissions() {
    try {
      const res = await run(bin, ['permissions', 'status', '--json'], { timeoutMs });
      let value; try { value = JSON.parse(res.stdout); } catch { value = { status: 'unknown', raw: String(res.stdout || '').slice(0, 200) }; }
      return { ok: Number(res.exitCode) === 0, ...value };
    } catch (e) { return { ok: false, status: 'error', error: String(e?.message || e).slice(0, 200) }; }
  }

  async function listTools() {
    try { const res = await run(bin, ['list-tools'], { timeoutMs }); return { ok: Number(res.exitCode) === 0, tools: String(res.stdout || '').split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean) }; }
    catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  }

  return { callTool, checkPermissions, listTools, classifyCuaToolRisk };
}
