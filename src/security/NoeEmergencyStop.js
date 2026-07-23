// @ts-check
// P0.5 emergency stop —— owner 一键停 Neo 的所有自主活动（self-evolution 自改 / 主动联系 / 自主认知 tick）。
//
// 设计原则（ROADMAP v3 安全命脉「停得住才敢放开」）：
//   - **always-armed，不是默认 OFF 的功能开关**：机制始终在岗。默认「信号不存在 = 不停」（零回归，
//     正常自主照跑）；owner 激活信号即停。这与项目「新功能 .env flag 默认 OFF」相反——安全兜底必须
//     永远在岗，不能等点火。
//   - **两个独立信号源（任一即停，OR）**：① 文件 ~/.noe-panel/EMERGENCY_STOP 存在（owner `touch` 一键，
//     重启持久）② env NOE_EMERGENCY_STOP=1（plist 强停，stat 不可达时的可靠后备）。
//   - **fail 模式 = 不误停**：文件 stat 抛错（文件系统异常）→ 视为「未停」，避免正常运行被偶发 IO 误杀；
//     env 是不依赖 IO 的可靠强停后备，owner 要绝对停就设 env。
//   - **停自主、不停基础设施**：emergency stop 针对 Neo 的「自主行为」（自改/认知/对外），保留心跳的
//     基础设施维护 kind（台账维护 / 墙钟守卫 / md 镜像 / 集成），否则停机期间连健康监控都瘫。
//   - 纯函数 + 注入式（env/stopFile 可注入），全可测。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const EMERGENCY_STOP_FILE = join(homedir(), '.noe-panel', 'EMERGENCY_STOP');

// 基础设施 kind：emergency stop 时仍允许运行（停的是 Neo 的自主行为，不是基础设施健康）。
// 其余一切 kind（selfEvolve 自改 / proactive 对外 / innerReflect 等认知 / expectation / learning…）全停。
export const EMERGENCY_STOP_INFRA_KINDS = Object.freeze(['maintenance', 'wallGuard', 'mdMirrorTick', 'integration']);

/**
 * 读取 emergency stop 状态（env OR 文件，任一即停）。
 * @param {{ env?: Record<string, string|undefined>, stopFile?: string }} [opts]
 * @returns {{ stopped: boolean, source: 'env'|'file'|'', reason: string }}
 */
export function readEmergencyStop({ env = process.env, stopFile = EMERGENCY_STOP_FILE } = {}) {
  // env 优先（不依赖 IO，stat 不可达时仍可靠强停）。
  if (String((env && env.NOE_EMERGENCY_STOP) || '').trim() === '1') {
    return { stopped: true, source: 'env', reason: 'NOE_EMERGENCY_STOP=1' };
  }
  try {
    if (existsSync(stopFile)) {
      let note = '';
      try { note = String(readFileSync(stopFile, 'utf8') || '').trim().slice(0, 200); } catch { /* 文件存在即停，读因失败不影响判定 */ }
      return { stopped: true, source: 'file', reason: note || `存在停机信号文件 ${stopFile}` };
    }
  } catch {
    // fail 模式：stat 异常不误停（正常运行优先）；要绝对停用 env。
    return { stopped: false, source: '', reason: '' };
  }
  return { stopped: false, source: '', reason: '' };
}

/**
 * 给心跳泵用：在 emergency stop 下，该 kind 是否应被跳过（自主 kind 跳过，基础设施 kind 保留）。
 * @param {string} kind
 * @param {{ stopped?: boolean }|null|undefined} stopState readEmergencyStop() 的结果
 * @param {{ infraKinds?: readonly string[] }} [opts]
 * @returns {boolean}
 */
export function emergencyStopShouldSkip(kind, stopState, { infraKinds = EMERGENCY_STOP_INFRA_KINDS } = {}) {
  if (!stopState || stopState.stopped !== true) return false;
  return !infraKinds.includes(String(kind));
}
