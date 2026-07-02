// @ts-check
// NoeModelCircuitBreaker — 模型调用熔断器（按 adapter id 维护连续失败计数 + 半开单探针 + LRU 上限）。
//
// 动机：不可用的 quorum 模型（如端点网络不通的 xiaomi-mimo）在自进化 post-review / consensus
//   每一轮都被探测一次，每次走 OpenAICompatChatAdapter 的 retry → 反复 `fetch failed`
//   刷日志 + 浪费往返（实测 err.log 单窗口 80 次 retry）。熔断器让连续失败达阈值后短期“跳过调用、
//   快速失败”，冷却期满**只放一个探针**做半开试探：成功→关闭、失败→重新熔断。
//
// 状态机：CLOSED(failures<threshold) → 连续失败达 threshold → OPEN(openUntil 冷却中) → 冷却满 →
//   HALF_OPEN(只放行单个探针，probing 标记拦其余并发) → 探针成功→CLOSED / 探针失败→OPEN(新冷却窗口)。
//
// 关键不变量（符合 AGENTS.md “动态 quorum 按真实 availableModels、不写死任一模型不可用”）：
//   熔断不改变 quorum 语义——被熔断的模型在本轮仍被记为 unavailable（与 retry 耗尽抛错的结果一致，
//   上层 runner catch 任意错误即封装 unavailableRaw），只是“更快到达 unavailable + 少噪音”，
//   且冷却期满仍会半开探测（动态探测，非永久写死）。
//
// 内存有界：states 按 adapter id 聚合，custom:<id> 理论可程序化生成 → 加 LRU 上限（maxEntries）淘汰
//   最久未访问的冷 entry（活跃熔断的会被访问 touch 保住），防长跑进程 Map 无界增长。
//
// flag NOE_MODEL_CIRCUIT_BREAKER=1 门控，默认 OFF（零回归）。状态/时钟可注入，便于确定性测试。

const DEFAULT_THRESHOLD = 3;        // 连续失败达 N 次 → 熔断
const DEFAULT_COOLDOWN_MS = 60_000; // 熔断冷却 M 毫秒
const DEFAULT_MAX_ENTRIES = 512;    // states Map LRU 上限（远超实际 adapter 数；防 custom:<id> 无界增长）

// 显式状态字段（配合 probing 标记做 HALF_OPEN 探测位去重，防并发放行多条探测请求把失败计数反复污染）。
const STATE_CLOSED = 'CLOSED';
const STATE_OPEN = 'OPEN';
const STATE_HALF_OPEN = 'HALF_OPEN';

// 解析为有限正数，否则回落默认值，再按 min 兜底（防 0 / 负数 / NaN / Infinity 误配）。
function finitePositive(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.floor(n));
}

/** 从 env 解析配置（默认 OFF）。threshold>=1、cooldown>=1000ms、maxEntries>=16，过滤 Infinity/NaN/0/负数。 */
export function resolveCircuitBreakerConfig(env = process.env) {
  const enabled = env?.NOE_MODEL_CIRCUIT_BREAKER === '1';
  const threshold = finitePositive(env?.NOE_MODEL_CB_THRESHOLD, DEFAULT_THRESHOLD, 1);
  const cooldownMs = finitePositive(env?.NOE_MODEL_CB_COOLDOWN_MS, DEFAULT_COOLDOWN_MS, 1000);
  const maxEntries = finitePositive(env?.NOE_MODEL_CB_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 16);
  return { enabled, threshold, cooldownMs, maxEntries };
}

export class NoeModelCircuitBreaker {
  /** @param {{threshold?:number, cooldownMs?:number, now?:()=>number, maxEntries?:number}} [opts] */
  constructor(opts) {
    // 防御性兜底：opts 缺省 / null / 原始值等非法入参（解构默认值只对 undefined 生效，传 null/数字/字符串
    //   等会直接 TypeError），统一规范化成空对象后再走下方逐字段默认值 + finitePositive + typeof 校验，
    //   保证构造永不抛、字段类型恒有效。
    const safeOpts = (opts !== null && typeof opts === 'object') ? opts : {};
    const { threshold = DEFAULT_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now(), maxEntries = DEFAULT_MAX_ENTRIES } = safeOpts;
    this.threshold = finitePositive(threshold, DEFAULT_THRESHOLD, 1);
    this.cooldownMs = finitePositive(cooldownMs, DEFAULT_COOLDOWN_MS, 1);
    this.maxEntries = finitePositive(maxEntries, DEFAULT_MAX_ENTRIES, 1);
    // 防御性兜底：解构默认值仅在 undefined 时生效，调用方若传 null/字符串/数字等非法 now 会被原样赋上，
    //   之后 shouldShortCircuit/isOpen/recordFailure 调用 this.now() 会抛 TypeError 拖垮熔断器。
    //   这里统一回落默认时钟，保证构造永不抛、运行期时钟永远可用。
    this.now = typeof now === 'function' ? now : () => Date.now();
    /** @type {Map<string, {failures:number, openUntil:number, probing:boolean}>} 按 LRU 维护，上限 maxEntries */
    this.states = new Map();
  }

  // LRU 访问：命中则 touch 到末尾（标记最近使用）；未命中则新建，超上限先淘汰最久未访问的冷 entry。
  _get(id) {
    const key = String(id || 'default');
    const existing = this.states.get(key);
    if (existing) {
      this.states.delete(key);
      this.states.set(key, existing); // touch：移到末尾
      return existing;
    }
    const s = { state: STATE_CLOSED, failures: 0, openUntil: 0, probing: false };
    // 超上限淘汰最久未访问（Map 迭代顺序=插入/touch 顺序，首个即最冷）。冷 entry 多为 CLOSED 非活跃态，
    //   淘汰即重置无害；活跃熔断的 adapter 因被反复访问 touch 到末尾，不会被淘汰。
    if (this.states.size >= this.maxEntries) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    this.states.set(key, s);
    return s;
  }

  // 是否短路本次调用。**有副作用**：半开期命中放行会占用唯一探针位（probing=true），
  //   故每次"将发起一次调用"前只调一次。CLOSED→放行；OPEN 冷却中→短路；冷却满→只放第一个探针、其余短路。
  shouldShortCircuit(id) {
    const s = this._get(id);
    const now = this.now();
    if (s.state === STATE_OPEN) {
      if (now < s.openUntil) return true;          // OPEN（冷却中）
      s.state = STATE_HALF_OPEN;                   // 冷却满 → 转入 HALF_OPEN
    }
    if (s.state === STATE_HALF_OPEN) {
      if (s.probing) return true;                  // HALF_OPEN：已有探针在飞 → 短路其余（防 thundering herd + 失败计数污染）
      s.probing = true;                            // HALF_OPEN：占用探针位，放行这一个
      return false;
    }
    return false;                                  // CLOSED
  }

  // 纯只读（无副作用，除 LRU touch）：当前是否处于 OPEN 冷却中。供 adapter retry 循环判断是否中止剩余重试。
  isOpen(id) {
    const s = this._get(id);
    return s.state === STATE_OPEN && this.now() < s.openUntil;
  }

  /** 成功 → 关闭熔断、清零失败计数与探针位。 */
  recordSuccess(id) {
    const s = this._get(id);
    s.state = STATE_CLOSED;
    s.failures = 0;
    s.openUntil = 0;
    s.probing = false;
  }

  /** 失败 → 失败计数 +1（单调整加并 clamp 到 [0, threshold]）；达阈值则熔断 cooldownMs（并清探针位，下次冷却满重新探）。返回是否触发/维持熔断。 */
  recordFailure(id) {
    const s = this._get(id);
    // 单调整加：先 +1，再 clamp 到 [0, threshold]。即便前一次 recordSuccess/recordFailure
    //   因 async 重入乱序、或外部代码意外把 failures 写成负数，计数也不会回退越过 0，
    //   也不会无意义地越过阈值；阈值触发后立刻 clamp 到 threshold，避免后续失败继续累加到
    //   threshold+1/2/3... 触发状态在 OPEN/HALF_OPEN 间抖动（半开探针失败后只要仍 >= 阈值
    //   就会被立刻重置成 OPEN，不会因计数已远高于阈值而出现多次重复进入 OPEN 的伪抖动）。
    s.failures = Math.min(Math.max(s.failures + 1, 0), this.threshold);
    if (s.failures >= this.threshold) {
      s.state = STATE_OPEN;
      s.openUntil = this.now() + this.cooldownMs;
      s.probing = false;
      return true;
    }
    return false;
  }

  /**
   * 包装一次带熔断保护的后端调用。HALF_OPEN 状态下首个调用通过 shouldShortCircuit 占用 probing 探针位
   *   （inFlight 守卫），其余并发调用立即 fail-fast 短路，根本不会进入后端调用，
   *   避免半开探测被并发请求反复污染失败计数。
   *   调用成功 → recordSuccess 释放探针位并清零失败计数；调用失败 → recordFailure 累计失败次数、
   *   必要时重新进入 OPEN 冷却。
   *
   * @template T
   * @param {string} id adapter id
   * @param {() => Promise<T>} fn 实际后端调用
   * @returns {Promise<T>} 成功返回值
   * @throws {Error} 短路时抛 code='NOE_CIRCUIT_OPEN' 的短路错误；或 fn 自身抛错原样上抛
   */
  async execute(id, fn) {
    if (this.shouldShortCircuit(id)) {
      const err = new Error(`NoeModelCircuitBreaker open: ${String(id || 'default')}`);
      err.code = 'NOE_CIRCUIT_OPEN';
      throw err;
    }
    try {
      const result = await fn();
      this.recordSuccess(id);
      return result;
    } catch (err) {
      this.recordFailure(id);
      throw err;
    }
  }

  /** 只读状态快照（诊断/测试用）。 */
  status(id) {
    const s = this._get(id);
    return { state: s.state, open: this.isOpen(id), failures: s.failures, openUntil: s.openUntil, probing: s.probing };
  }

  /** 当前 states 条目数（诊断/测试 LRU 上限用）。 */
  size() {
    return this.states.size;
  }
}

// 进程级单例：adapter 每轮可能新建实例，熔断状态必须跨实例共享（按 adapter id 聚合）。
// states 有 LRU 上限（maxEntries），即便 custom:<id> 程序化生成也不会无界增长。
let _singleton = null;
export function getSharedCircuitBreaker() {
  if (!_singleton) {
    const cfg = resolveCircuitBreakerConfig();
    _singleton = new NoeModelCircuitBreaker({ threshold: cfg.threshold, cooldownMs: cfg.cooldownMs, maxEntries: cfg.maxEntries });
  }
  return _singleton;
}

// 测试用：重置单例（隔离用例间状态）。
export function __resetSharedCircuitBreakerForTest() {
  _singleton = null;
}
