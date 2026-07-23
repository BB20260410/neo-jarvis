// @ts-check
// spawnWithTimeout — 带超时的 spawn 子进程。治飞轮停摆真凶：post_review/consensus 的裸 spawn 无超时调 codex，
//   codex 没额度/认证卡死时永不 close → Promise 永不 resolve → selfEvolve tick 卡 running 几小时 + NoeLoop 防重入
//   栅栏（if running return skipped）→ 整飞轮停摆到人工介入。超时 SIGTERM 先礼、grace 后 SIGKILL 兜底，快速失败。
//   timeoutMs<=0=不超时（默认零回归，正常推理不误杀——卡死该杀非推理超时）；>0 才超时杀。
//   spawnImpl 注入式（默认 node spawn，测试注入 fake child）。
import { spawn as nodeSpawn } from 'node:child_process';

const SIGKILL_GRACE_MS = 2000;

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} [opts.stdin]
 * @param {string} [opts.cwd]
 * @param {Record<string, string>} [opts.env]
 * @param {number} [opts.timeoutMs] <=0=不超时（默认）；>0 超时 SIGTERM+SIGKILL
 * @param {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [opts.spawnImpl] 注入（测试用）
 * @returns {Promise<{ok:boolean, code?:number, error?:Error, stdout:string, stderr:string, timedOut?:boolean}>}
 */
export function spawnWithTimeout({ command, args = [], stdin = '', cwd, env, timeoutMs = 0, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolveRun) => {
    const child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    let timer = null;
    const finish = (r) => {
      if (settled) return; // 守卫：超时与 close/error 竞争只认第一个，迟到 close 不重复 resolve、不抛
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolveRun(r);
    };
    // 超时杀（codex 没额度/认证卡死永不 close 时）：SIGTERM 先礼、grace 后 SIGKILL 兜底，快速失败 timedOut。
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* 进程已退忽略 */ }
        killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退忽略 */ } }, SIGKILL_GRACE_MS);
        if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
        finish({ ok: false, timedOut: true, error: new Error(`spawn 超时 ${timeoutMs}ms（卡死杀）`), stdout, stderr });
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (error) => finish({ ok: false, error, stdout, stderr }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
    if (child.stdin && typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
    try { if (child.stdin && typeof child.stdin.end === 'function') child.stdin.end(stdin); } catch { /* stdin 已关忽略 */ }
  });
}
