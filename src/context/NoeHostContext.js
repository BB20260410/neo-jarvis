// NoeHostContext — 本地感知三件套：把宿主机的「自有资源」摘要注入 system prompt，
//   让 Noe 收到模糊指令（"上服务器"、"我桌面有啥"、"还剩多少电"）时无需现场探、无需先问凭据。
//
// 借鉴 BaiLongma 的 local-resources-scanner / desktop-scanner / system-info（信任本机哲学），
//   但严守 m3 评审红线：**只采集元数据，绝不读密钥内容**——SSH 只读 config 的 Host 别名/用户/端口，
//   不读私钥；Git 只读 ~/.gitconfig 的 user.name/email；桌面只读文件名不读内容；系统只读硬件/电量。
//
// PII 出境门控（2026-07-02 P0）：git 姓名/邮箱、桌面文件名、SSH 主机清单会随聊天上下文送云端模型，
//   属身份/基础设施暴露面 → 三块各自 env flag **默认 OFF**（NOE_HOST_CONTEXT_GIT_IDENTITY /
//   NOE_HOST_CONTEXT_DESKTOP / NOE_HOST_CONTEXT_SSH = '1' 才采集）；system 块（芯片/内存/电量）无 PII 常开。
//
// format* 是纯函数（可独立单测）；collectHostContext 做真实 I/O，readers 全可注入（测试零文件系统依赖）。

import { homedir } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspectNoeSshInventory } from '../runtime/NoeSshInventory.js';

const MAX_HOSTS = 30;
const MAX_DESKTOP = 40;

/** 把 SSH host 元数据渲染成「可直接用」的 prompt 段。 */
export function formatSshInventoryBlock(hosts = []) {
  const list = Array.isArray(hosts) ? hosts.filter((h) => h && (h.alias || h.host || h.hostName)) : [];
  if (!list.length) return '';
  const lines = list.slice(0, MAX_HOSTS).map((h) => {
    const alias = h.alias || h.host || h.hostName;
    const host = h.hostName || h.host || '';
    const user = h.user ? `${h.user}@` : '';
    const port = h.port && Number(h.port) !== 22 ? `:${h.port}` : '';
    const target = host && host !== alias ? ` → ${user}${host}${port}` : (user ? ` → ${user}${alias}${port}` : '');
    return `  - ${alias}${target}`;
  });
  return `已配置的 SSH 主机（免密登录的可直接 ssh，无需先问凭据）：\n${lines.join('\n')}`;
}

/** Git 身份（元数据），用于 commit 时无需问 name/email。 */
export function formatGitIdentityBlock(gitUser) {
  if (!gitUser || (!gitUser.name && !gitUser.email)) return '';
  return `Git 身份：${gitUser.name || ''}${gitUser.email ? ` <${gitUser.email}>` : ''}`.trim();
}

/** 桌面应用与文件名（不读内容）。 */
export function formatDesktopBlock(entries = []) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.name) : [];
  if (!list.length) return '';
  const apps = list.filter((e) => e.kind === 'app').map((e) => e.name).slice(0, MAX_DESKTOP);
  const files = list.filter((e) => e.kind !== 'app').map((e) => e.name).slice(0, MAX_DESKTOP);
  const parts = [];
  if (apps.length) parts.push(`桌面应用：${apps.join('、')}`);
  if (files.length) parts.push(`桌面文件：${files.join('、')}`);
  return parts.join('\n');
}

/** 系统硬件 + 电量。 */
export function formatSystemInfoBlock(hw, battery) {
  const parts = [];
  if (hw?.chip) parts.push(`芯片：${hw.chip}`);
  if (hw?.memGB || hw?.memoryGB) parts.push(`内存：${hw.memGB || hw.memoryGB}GB`);
  if (battery && battery.percent != null) {
    parts.push(`电量：${battery.percent}%${battery.charging ? '（充电中）' : '（使用电池）'}`);
  }
  if (!parts.length) return '';
  return `本机环境：${parts.join('，')}`;
}

/** 把四个 block 拼成一段（空块自动略过）。 */
export function buildHostContextBlock({ ssh = '', git = '', desktop = '', system = '' } = {}) {
  return [ssh, git, desktop, system].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
}

// ── 启动缓存（波次6 接线）:server 启动采集一次,聊天链路(ChatProfileStore.resolve)零成本注入。──
let cachedHostContextBlock = '';
/** server 启动时调用,缓存采集好的感知块;传空串可清除。 */
export function setCachedHostContextBlock(block) { cachedHostContextBlock = String(block || '').trim(); }
/** 聊天链路读取;未采集时返回 ''(注入方应视为 no-op)。 */
export function getCachedHostContextBlock() { return cachedHostContextBlock; }

// ── 默认 I/O readers（真实采集，只读元数据）。collectHostContext 可全部注入覆盖。──

function defaultGitReader() {
  try {
    const text = readFileSync(join(homedir(), '.gitconfig'), 'utf8');
    const section = /\[user\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] || '';
    const name = /name\s*=\s*(.+)/.exec(section)?.[1]?.trim();
    const email = /email\s*=\s*(.+)/.exec(section)?.[1]?.trim();
    return { name: name || '', email: email || '' };
  } catch { return null; }
}

function defaultDesktopReader() {
  try {
    const dir = join(homedir(), 'Desktop');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name.endsWith('.app') ? e.name.slice(0, -4) : e.name, kind: e.name.endsWith('.app') ? 'app' : 'file' }));
  } catch { return []; }
}

function defaultSshReader() {
  try { return inspectNoeSshInventory({}).hosts || []; } catch { return []; }
}

/**
 * 采集本机感知三件套并格式化为 prompt 段。所有 reader 可注入（测试用）。
 * PII 门控：git/desktop/ssh 三块默认不采集（对应 env flag = '1' 才放行，见文件头说明）。
 * @returns {Promise<{ssh:string, git:string, desktop:string, system:string, combined:string}>}
 */
export async function collectHostContext(deps = {}) {
  const env = deps.env || process.env;
  const sshEnabled = String(env.NOE_HOST_CONTEXT_SSH || '') === '1';
  const gitEnabled = String(env.NOE_HOST_CONTEXT_GIT_IDENTITY || '') === '1';
  const desktopEnabled = String(env.NOE_HOST_CONTEXT_DESKTOP || '') === '1';
  const sshHosts = sshEnabled ? (deps.sshReader || defaultSshReader)() : [];
  const gitUser = gitEnabled ? (deps.gitReader || defaultGitReader)() : null;
  const desktop = desktopEnabled ? (deps.desktopReader || defaultDesktopReader)() : [];
  const hw = deps.hwDetector ? await deps.hwDetector() : null;
  const battery = deps.batteryReader ? await deps.batteryReader() : null;

  const ssh = formatSshInventoryBlock(sshHosts);
  const git = formatGitIdentityBlock(gitUser);
  const desktopBlock = formatDesktopBlock(desktop);
  const system = formatSystemInfoBlock(hw, battery);
  return { ssh, git, desktop: desktopBlock, system, combined: buildHostContextBlock({ ssh, git, desktop: desktopBlock, system }) };
}
