// @ts-check
// 前置 env 装载：必须是 server.js 的【第一个 import】。
// ESM 按 import 文本顺序执行模块体——本模块在所有其他模块之前把项目根 .env 装进
// process.env，治两类死火（2026-06-11 实锤）：
//   ① server.js 体内更早求值的启动开关（NOE_MEMORY_EMBED 语义召回 / NOE_DREAM 梦境 /
//      NOE_DREAM_EPISODES 情景升华）——旧加载点在 1588 行，它们读不到 .env 静默死火；
//   ② 模块顶层常量（FactExtractor 顶层读 NOE_FACT_MODEL 永远拿到代码默认 gemma4:31b，
//      owner 在 .env 配的 9b 从未生效）——import 提升让它们先于任何体内加载执行。
// process.loadEnvFile 实测【不覆盖】已存在的环境变量（launchd plist / shell 注入仍优先），
// 只补缺失项；.env 缺失/不可读时静默跳过（fail-open，与旧行为一致）。

/**
 * 把 envPath 指向的 .env 装进 process.env（不覆盖已有变量）。
 * @param {URL|string} envPath .env 文件位置
 * @returns {boolean} 装载成功返回 true；文件缺失/不可读返回 false（不抛）
 */
export function loadEnvInto(envPath) {
  try {
    process.loadEnvFile(envPath);
    return true;
  } catch {
    return false;
  }
}

// 模块体副作用：import 即装载项目根 .env（本文件在 src/bootstrap/ 下，根在上两级）。
loadEnvInto(new URL('../../.env', import.meta.url));
