// NoeSafeDelete — 删文件走 macOS 废纸篓而非物理删除，给 Noe 的文件操作直撑红线 6
// （「删除 / 覆盖未提交工作，发出去追不回」）。
//
// 问题：自动化路径若直接 fs.unlink / fs.rm，删错即不可逆；尤其 AI 自驱时删错目标代价大。
// 方案：所有删除走 safeDelete()——
//   ① 先经路径红线校验：拒绝系统根 / 顶级目录 / home 根 / 受保护个人目录（Desktop/Documents…）等高危目标；
//   ② 通过后把文件「移进 macOS 废纸篓」（Finder Put Back 可一键恢复），而非物理删除。
//
// 纯逻辑可测：planSafeDelete() 做路径展开 / 归一 / 红线判定，注入 cwd & homeDir，全程不碰文件系统；
//   真实的「移进废纸篓」动作 trasher 注入式 —— 单测注入 fake（绝不真删），生产用默认 macTrash(osascript)。
// 注意：路径判定是纯字符串规范化（path.resolve 折叠 . 与 ..），不解析 symlink，
//   故对 /etc /var /tmp 这类 macOS 软链同时按字面与 /private/* 前缀双重拦截。

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 系统区前缀：等于该路径或位于其下一律拒删（含 macOS /etc→/private/etc、/tmp→/private/tmp 等软链的两种写法）。
// 含 /Applications（根级应用目录，删 app 不走本工具）与 /tmp（与注释自述一致，其下可能有系统 socket/锁文件）。
const SYSTEM_PREFIXES = [
  '/System', '/usr', '/bin', '/sbin', '/etc', '/var',
  '/Library', '/private', '/dev', '/cores', '/opt', '/Volumes',
  '/Applications', '/tmp',
];

// home 下受保护的个人顶级目录：可删其「内部」文件，但不许把目录本身整个删掉。
const PROTECTED_HOME_DIRS = [
  'Desktop', 'Documents', 'Downloads', 'Library', 'Movies',
  'Music', 'Pictures', 'Public', 'Applications', '.ssh', '.config',
];

/** 展开开头的 ~ / ~/ 为 homeDir（其余形式如 ~user 不展开，原样交给 resolve）。 */
export function expandTilde(input, homeDir) {
  const s = String(input ?? '');
  if (s === '~') return homeDir;
  if (s.startsWith('~/')) return path.join(homeDir, s.slice(2));
  return s;
}

/**
 * 规划一次安全删除：路径展开 + 归一 + 红线判定。纯函数，不碰文件系统。
 *
 * @param {string} input 目标路径（支持 ~ 展开与相对路径，相对路径基于 cwd）。
 * @param {object} [opts]
 * @param {string} [opts.cwd] 解析相对路径的基准（默认 process.cwd()）。
 * @param {string} [opts.homeDir] home 目录（默认 os.homedir()）。
 * @returns {{ok:boolean, blocked:boolean, action?:string, src?:string, reason?:string}}
 */
export function planSafeDelete(input, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();

  const raw = String(input ?? '').trim();
  if (!raw) {
    return { ok: false, blocked: true, reason: 'empty-path' };
  }
  // 含空字节的路径拒绝：path.resolve 会把 \0 当普通字符，下游 fs 操作又会抛 ERR_INVALID_ARG_VALUE。
  if (raw.includes('\0')) {
    return { ok: false, blocked: true, reason: 'invalid-path' };
  }

  const abs = path.resolve(cwd, expandTilde(raw, homeDir));
  const segments = abs.split('/').filter(Boolean);

  // 系统区前缀（精确等于或位于其下）。
  for (const prefix of SYSTEM_PREFIXES) {
    if (abs === prefix || abs.startsWith(`${prefix}/`)) {
      return { ok: false, blocked: true, src: abs, reason: 'system-path' };
    }
  }

  // 根 / 与所有顶级目录（深度 < 2）一律拒绝。
  if (segments.length < 2) {
    return { ok: false, blocked: true, src: abs, reason: 'too-shallow' };
  }

  // home 根本身。
  if (abs === homeDir) {
    return { ok: false, blocked: true, src: abs, reason: 'home-root' };
  }

  // 任意 /Users/<用户名> 顶级账户目录（含其他用户的 home，多用户机上删它远比删自己子目录危险）。
  if (segments.length === 2 && segments[0] === 'Users') {
    return { ok: false, blocked: true, src: abs, reason: 'user-home-root' };
  }

  // home 下受保护的个人顶级目录（其本身，不含内部文件）。
  for (const dir of PROTECTED_HOME_DIRS) {
    if (abs === path.join(homeDir, dir)) {
      return { ok: false, blocked: true, src: abs, reason: 'protected-home-dir' };
    }
  }

  return { ok: true, blocked: false, action: 'trash', src: abs };
}

/**
 * 默认的「移进 macOS 废纸篓」实现：走 Finder，保留 Put Back，可在废纸篓一键恢复。
 * ⚠️ 真实文件系统副作用——单元测试请注入 fake trasher，切勿在测试里调用本函数。
 * @param {string} absPath 绝对路径。
 */
export async function macTrash(absPath) {
  // 用 JSON.stringify 把路径安全嵌入 AppleScript 字符串字面量（双引号 + 反斜杠转义两者兼容）。
  const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(absPath)}`;
  await execFileAsync('osascript', ['-e', script]);
  return { trashed: true, src: absPath };
}

/**
 * 创建一个安全删除器。
 *
 * @param {object} [deps]
 * @param {(absPath:string)=>Promise<any>} [deps.trasher] 真实移废纸篓动作（默认 macTrash）。
 * @param {string} [deps.cwd] 相对路径基准。
 * @param {string} [deps.homeDir] home 目录。
 * @returns {{
 *   delete: (input:string) => Promise<object>,
 *   plan: (input:string) => object,
 * }}
 */
export function createSafeDeleter(deps = {}) {
  const trasher = typeof deps.trasher === 'function' ? deps.trasher : macTrash;
  const cwd = deps.cwd;
  const homeDir = deps.homeDir;

  function plan(input) {
    return planSafeDelete(input, { cwd, homeDir });
  }

  async function del(input) {
    const p = plan(input);
    if (p.blocked) return p; // 红线拦截：绝不调用 trasher
    try {
      await trasher(p.src);
      return { ...p, trashed: true };
    } catch (err) {
      return { ok: false, blocked: false, src: p.src, trashed: false, error: err?.message || String(err) };
    }
  }

  return { delete: del, plan };
}
