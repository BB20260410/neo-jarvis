// Electron 主进程
import { app, BrowserWindow, Menu, shell, dialog } from 'electron';
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { resolvePackagedElectronServerRuntime } from './src/runtime/NoeElectronServerRuntime.js';
import { parseUpdateDrainHealthPayload } from './src/runtime/NoeUpdateDrainState.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = String(process.env.PORT || 51835);
const APP_ICON_PATH = join(__dirname, 'public', 'app-icon.png');
const OWNER_TOKEN_PATH = join(homedir(), '.noe-panel', 'owner-token.txt');
const SERVER_START_TIMEOUT_MS = Number(process.env.PANEL_ELECTRON_START_TIMEOUT_MS || 20000);
const SERVER_RESTART_DELAY_MS = Number(process.env.PANEL_ELECTRON_RESTART_DELAY_MS || 1500);
const ELECTRON_SMOKE = process.env.NOE_ELECTRON_SMOKE === '1';
const ELECTRON_SMOKE_LOG = process.env.NOE_ELECTRON_SMOKE_LOG || '';

function clean(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function nodeMajor(version) {
  const match = clean(version).match(/^v?(\d+)\./);
  return match ? Number(match[1]) : 0;
}

function projectNvmVersion() {
  try {
    return clean(readFileSync(join(__dirname, '.nvmrc'), 'utf8')).replace(/^v/, '');
  } catch {
    return '';
  }
}

function whichNode() {
  try {
    const result = spawnSync('which', ['node'], { encoding: 'utf8', timeout: 3000 });
    return result.status === 0 ? clean(result.stdout, 2000) : '';
  } catch {
    return '';
  }
}

function probeNode(bin) {
  const candidate = clean(bin, 2000);
  if (!candidate || !existsSync(candidate)) return null;
  const result = spawnSync(candidate, ['-e', 'process.stdout.write(JSON.stringify({version:process.version,modules:process.versions.modules,execPath:process.execPath}))'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      bin: parsed.execPath || candidate,
      version: parsed.version || '',
      modules: String(parsed.modules || ''),
      major: nodeMajor(parsed.version),
      isElectron: false,
    };
  } catch {
    return null;
  }
}

function resolveServerNode() {
  const packagedRuntime = resolvePackagedElectronServerRuntime({
    isPackaged: app.isPackaged,
    allowExternalNode: process.env.NOE_PACKAGED_EXTERNAL_NODE === '1',
    execPath: process.execPath,
    nodeVersion: process.versions?.node || '',
    moduleAbi: process.versions?.modules || '',
  });
  if (packagedRuntime) return packagedRuntime;

  const nvmVersion = projectNvmVersion();
  const userHome = process.env.USER ? join('/Users', process.env.USER) : '';
  const lognameHome = process.env.LOGNAME ? join('/Users', process.env.LOGNAME) : '';
  const candidates = [
    process.env.NOE_NODE_BIN,
    process.env.NVM_DIR && nvmVersion ? join(process.env.NVM_DIR, 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion ? join(homedir(), '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion && userHome ? join(userHome, '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion && lognameHome ? join(lognameHome, '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    whichNode(),
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const info = probeNode(candidate);
    if (info?.major === 22) return info;
  }
  return {
    bin: process.execPath,
    version: process.versions?.node ? `v${process.versions.node}` : 'electron',
    modules: String(process.versions?.modules || ''),
    major: nodeMajor(process.versions?.node || ''),
    isElectron: true,
  };
}

// v1.0 Task 1.3: electron-updater 自动更新（动态 import 失败时静默 disable）
// S8: install path must drain running tasks + write checkpoint; health window ≤120s.
let autoUpdater = null;
const UPDATE_CHECKPOINT_DIR = join(homedir(), '.noe-panel', 'update-checkpoints');
const UPDATE_MAX_HEALTH_SEC = 120;

async function probeRunningTaskState() {
  return new Promise((resolve) => {
    const token = readOwnerToken();
    const req = http.request(
      {
        host: HOST,
        port: Number(PORT),
        path: '/health',
        method: 'GET',
        timeout: 2000,
        headers: token ? { 'X-Panel-Owner-Token': token } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) return resolve(null);
            resolve(parseUpdateDrainHealthPayload(JSON.parse(body || '{}')));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      try { req.destroy(); } catch { /* ignore */ }
      resolve(null);
    });
    req.end();
  });
}

function writeUpdateCheckpoint(info = {}, taskDrain = null) {
  try {
    mkdirSync(UPDATE_CHECKPOINT_DIR, { recursive: true });
    const path = join(UPDATE_CHECKPOINT_DIR, `checkpoint-${Date.now()}.json`);
    const payload = {
      writtenAt: new Date().toISOString(),
      version: info.version || null,
      path: info.path || null,
      pid: process.pid,
      port: PORT,
      taskDrain,
    };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Fail-closed gate before quitAndInstall: drain running tasks, write checkpoint.
 * Returns { allowed, blockers, checkpoint }.
 */
async function prepareUpdateInstall(info = {}) {
  const blockers = [];
  const taskDrain = await probeRunningTaskState();
  const running = taskDrain?.runningTaskCount;
  if (!taskDrain || !Number.isInteger(running) || running < 0) {
    blockers.push('running_task_state_unavailable');
  } else if (running > 0 || taskDrain.drainComplete !== true) {
    blockers.push('running_tasks_not_drained');
  }
  const checkpoint = blockers.length === 0
    ? writeUpdateCheckpoint(info, taskDrain)
    : { ok: false, skipped: true, reason: 'task_drain_not_verified' };
  if (!checkpoint.ok) blockers.push('checkpoint_missing');
  return {
    allowed: blockers.length === 0,
    blockers,
    checkpoint,
    runningTaskCount: running,
    drainComplete: taskDrain?.drainComplete === true,
    maxHealthWindowSec: UPDATE_MAX_HEALTH_SEC,
  };
}

async function initAutoUpdater() {
  try {
    const m = await import('electron-updater');
    autoUpdater = m.autoUpdater || (m.default && m.default.autoUpdater);
    if (!autoUpdater) return;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.on('error', (err) => console.error('[updater]', err?.message));
    autoUpdater.on('update-available', async (info) => {
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即下载', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: '发现新版本',
        message: `Neo 贾维斯 ${info.version} 已发布`,
        detail: '点击「立即下载」开始更新（下载完成后下次启动自动安装）',
      });
      if (r.response === 0) autoUpdater.downloadUpdate();
    });
    autoUpdater.on('update-downloaded', async (info) => {
      const prep = await prepareUpdateInstall(info);
      if (!prep.allowed) {
        console.warn('[updater] install deferred — drain/checkpoint failed:', prep.blockers.join(','));
        await dialog.showMessageBox({
          type: 'warning',
          buttons: ['知道了'],
          defaultId: 0,
          title: '更新已下载，但有任务未排空',
          message: `Neo 贾维斯 ${info.version} 已下载`,
          detail: `无法安装：${prep.blockers.join(', ')}。请恢复后重新检查更新。`,
        });
        return;
      }
      const r = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        title: '更新已下载',
        message: `Neo 贾维斯 ${info.version} 已下载`,
        detail: '任务已排空并写入 checkpoint；选择稍后不会在退出时自动安装',
      });
      if (r.response === 0) autoUpdater.quitAndInstall();
    });
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  } catch (e) {
    console.warn('[electron-updater] 加载失败，自动更新关闭:', e.message);
  }
}

let serverProcess = null;
let whisperProcess = null;
let mainWindow = null;
let appQuitting = false;
let restartTimer = null;

function writeSmokeEvent(event, details = {}) {
  if (!ELECTRON_SMOKE || !ELECTRON_SMOKE_LOG) return;
  try {
    mkdirSync(dirname(ELECTRON_SMOKE_LOG), { recursive: true });
    appendFileSync(ELECTRON_SMOKE_LOG, JSON.stringify({ ts: Date.now(), event, ...details }) + '\n');
  } catch {}
}

function readOwnerToken() {
  if (!existsSync(OWNER_TOKEN_PATH)) return '';
  try { return readFileSync(OWNER_TOKEN_PATH, 'utf8').trim(); } catch { return ''; }
}

function panelUrl() {
  const token = readOwnerToken();
  const url = new URL(`http://${HOST}:${PORT}/`);
  if (token) url.searchParams.set('t', token);
  url.searchParams.set('electron', '1');
  return url.toString();
}

function panelRequest(pathname, { timeoutMs = 3000 } = {}) {
  const token = readOwnerToken();
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST,
      port: Number(PORT),
      path: pathname,
      method: 'GET',
      timeout: timeoutMs,
      headers: token ? { 'X-Panel-Owner-Token': token } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode }));
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.end();
  });
}

async function isPanelAlive() {
  const result = await panelRequest('/api/version', { timeoutMs: 1200 });
  return result.ok === true && result.statusCode === 200;
}

function startServerProcess() {
  if (serverProcess && !serverProcess.killed) return;
  const serverNode = resolveServerNode();
  writeSmokeEvent('server_node_selected', {
    bin: serverNode.bin,
    version: serverNode.version,
    modules: serverNode.modules,
    isElectron: serverNode.isElectron,
  });
  serverProcess = spawn(serverNode.bin, [join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT,
      PANEL_HOST: HOST,
      ...(serverNode.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProcess.stderr.on('data', d => process.stderr.write('[server-err] ' + d));
  serverProcess.once('exit', (code, signal) => {
    const wasManaged = serverProcess !== null;
    serverProcess = null;
    if (!wasManaged || appQuitting) return;
    console.warn(`[server] exited code=${code} signal=${signal}; scheduling restart`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!appQuitting) {
        startServerProcess();
        waitForPanel().then(() => mainWindow?.loadURL(panelUrl())).catch((error) => {
          mainWindow?.loadURL(failurePage(`后端自动重启失败: ${error.message}`));
        });
      }
    }, SERVER_RESTART_DELAY_MS);
  });
}

// 语音用的本地 whisper STT 服务（可选）：仅当用户装了 ~/.noe-voice 才拉起，缺了也不影响 panel / 视觉
function startWhisperProcess() {
  if (whisperProcess && !whisperProcess.killed) return;
  if (process.env.NOE_VOICE === '0') return;
  const py = join(homedir(), '.noe-voice', 'bin', 'python');
  const script = join(__dirname, 'scripts', 'noe-whisper-server.py');
  if (!existsSync(py) || !existsSync(script)) return; // 没装语音依赖就静默跳过
  try {
    whisperProcess = spawn(py, [script], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    whisperProcess.stdout.on('data', (d) => process.stdout.write('[whisper] ' + d));
    whisperProcess.stderr.on('data', (d) => process.stderr.write('[whisper-err] ' + d));
    whisperProcess.once('exit', () => { whisperProcess = null; });
  } catch { whisperProcess = null; }
}

async function waitForPanel() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    if (await isPanelAlive()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`panel start timeout after ${SERVER_START_TIMEOUT_MS}ms`);
}

async function ensureServerReady() {
  if (await isPanelAlive()) {
    writeSmokeEvent('server_ready', { reused: true, port: PORT });
    return { reused: true };
  }
  startServerProcess();
  await waitForPanel();
  writeSmokeEvent('server_ready', { reused: false, port: PORT });
  return { reused: false };
}

function failurePage(message) {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Neo 贾维斯 启动失败</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f1ea;color:#171717;margin:0;display:grid;place-items:center;height:100vh}
main{max-width:760px;background:white;border:1px solid #e7dfd1;border-radius:22px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.12)}
h1{margin:0 0 12px;font-size:26px}
p{line-height:1.7;color:#555}
code{background:#f2eee7;border-radius:8px;padding:2px 6px}
</style>
<main>
  <h1>本地服务没有启动成功</h1>
  <p>${String(message || 'unknown').replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</p>
  <p>可在菜单选择 <code>Neo 贾维斯 -> 重启本地服务</code>，或在终端运行 <code>npm run restart:panel</code>。</p>
</main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function loadPanelWindow() {
  try {
    await ensureServerReady();
    await mainWindow?.loadURL(panelUrl());
  } catch (error) {
    writeSmokeEvent('server_failed', { error: error.message });
    await mainWindow?.loadURL(failurePage(error.message));
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#F4F1EA',
    icon: APP_ICON_PATH,
    webPreferences: { nodeIntegration: false, contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' },
    title: 'Neo 贾维斯',
  });

  loadPanelWindow();
  // 允许面板内麦克风（语音对话用）；仅本机 panel 自身页面，安全。打包时还需 Info.plist 的 NSMicrophoneUsageDescription。
  try {
    mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'audioCapture');
    });
  } catch {}
  mainWindow.webContents.once('did-finish-load', async () => {
    const url = mainWindow?.webContents?.getURL?.() || '';
    let pageTitle = '';
    let neoMarker = false;
    try {
      const page = await mainWindow?.webContents?.executeJavaScript?.(
        `({title:document.title,neoMarker:Boolean(document.body?.innerText?.includes('欢迎使用 Neo 贾维斯'))})`,
        true,
      );
      pageTitle = String(page?.title || '');
      neoMarker = page?.neoMarker === true;
    } catch {
      /* smoke evidence remains false */
    }
    writeSmokeEvent('window_loaded', { url, pageTitle, neoMarker });
  });
  mainWindow.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    writeSmokeEvent('window_load_failed', { errorCode, errorDescription });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function restartManagedServer() {
  clearTimeout(restartTimer);
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill('SIGTERM'); } catch {}
  } else {
    startServerProcess();
  }
  waitForPanel().then(() => mainWindow?.loadURL(panelUrl())).catch((error) => {
    mainWindow?.loadURL(failurePage(`手动重启失败: ${error.message}`));
  });
}

app.whenReady().then(() => {
  writeSmokeEvent('app_ready', { version: app.getVersion(), port: PORT });
  app.dock?.setIcon(APP_ICON_PATH);
  createWindow();
  if (!ELECTRON_SMOKE) startWhisperProcess(); // 异步拉起本地语音服务（容错，不阻塞 panel）
  if (!ELECTRON_SMOKE) initAutoUpdater().catch(() => {});
  const menuTemplate = [
    { label: 'Neo 贾维斯', submenu: [
      { role: 'about' },
      { type: 'separator' },
      { label: '重载面板', click: () => mainWindow?.loadURL(panelUrl()) },
      { label: '重启本地服务', click: () => restartManagedServer() },
      { type: 'separator' },
      { label: '检查更新', click: () => autoUpdater?.checkForUpdates().catch(() => {}) },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  writeSmokeEvent('menu_registered', { labels: menuTemplate.map((item) => item.label || item.role).filter(Boolean) });
  if (ELECTRON_SMOKE) {
    setTimeout(() => {
      writeSmokeEvent('smoke_quit_requested', { windows: BrowserWindow.getAllWindows().length });
      app.quit();
    }, Number(process.env.NOE_ELECTRON_SMOKE_QUIT_MS || 5000));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  appQuitting = true;
  clearTimeout(restartTimer);
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
  }
  if (whisperProcess) {
    try { whisperProcess.kill('SIGTERM'); } catch {}
  }
});
