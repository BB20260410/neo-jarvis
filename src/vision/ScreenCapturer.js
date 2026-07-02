// ScreenCapturer — macOS 屏幕捕获（screencapture 命令截一帧 png）
// 注意：首次需用户授权"屏幕录制"系统权限。截图只在本地处理、不外发。
import { execFile } from 'node:child_process';
import { readFile, unlink, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class ScreenCapturer {
  constructor({ tmpDir = os.tmpdir(), displayIndex = null } = {}) {
    this.tmpDir = tmpDir;
    this.displayIndex = displayIndex; // null=主屏
    this._seq = 0;
    // 帧文件名前缀（含本进程 PID）。命名与清理共用此前缀，保证只认/只删本实例的帧——
    // 同机多实例（如 51835 live + 51999 隔离自测）各自只清自己 PID 的残留帧，绝不互删对方的帧。
    // 末尾的 '-' 是分隔符，避免 PID 前缀粘连误删（如 PID 999 不会命中另一实例 PID 9991 的帧）。
    this._framePrefix = `noe-frame-${process.pid}-`;
    // 审计 §3.4 P0-4：启动时清掉上次异常退出残留的陈旧帧（>60s），防 24/7 占满 /tmp
    this.cleanupStaleFrames().catch(() => {});
  }

  /** 截一帧屏幕，返回 png Buffer。-x 静音、-C 含光标关闭。 */
  async capture() {
    const out = path.join(this.tmpDir, `${this._framePrefix}${this._seq = (this._seq || 0) + 1}.png`);
    try {
      const args = ['-x', '-t', 'png'];
      if (this.displayIndex != null) args.push('-D', String(this.displayIndex));
      args.push(out);
      await new Promise((resolve, reject) => {
        execFile('screencapture', args, { timeout: 8000 }, (err) => (err ? reject(new Error(`screencapture 失败（需屏幕录制权限？）: ${err.message}`)) : resolve()));
      });
      // 降到最大边 1280px：全屏原图视觉 token 太多→VLM 极慢；降分辨率后大幅提速（失败则用原图，不阻断）
      await new Promise((resolve) => execFile('sips', ['-Z', '1280', out], { timeout: 5000 }, () => resolve()));
      return await readFile(out);
    } finally {
      // 审计 §3.4 P0-4：finally 保证临时帧被清，即使 screencapture/sips/readFile 中途抛错也不残留
      await unlink(out).catch(() => {});
    }
  }

  /** 审计 §3.4 P0-4：清理陈旧残留帧（崩溃/异常未清的）。只删【本进程 PID】命名、且早于 olderThanMs 的帧；
   *  绝不碰正在用的新帧，也绝不碰其他实例（其他 PID）的帧——防同机多实例互删。 */
  async cleanupStaleFrames({ olderThanMs = 60_000 } = {}) {
    try {
      const now = Date.now();
      const files = await readdir(this.tmpDir);
      await Promise.all(files
        .filter((f) => f.startsWith(this._framePrefix) && f.endsWith('.png'))
        .map(async (f) => {
          const fp = path.join(this.tmpDir, f);
          try {
            const s = await stat(fp);
            if (now - s.mtimeMs > olderThanMs) await unlink(fp);
          } catch { /* 单文件失败不阻断整体清理 */ }
        }));
    } catch { /* tmpDir 读不了就算了 */ }
  }
}
