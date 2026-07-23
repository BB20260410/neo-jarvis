// @ts-check
// _mathUtils — 认知层共享的纯数值小工具。
//
// 背景：src/cognition/ 下多个模块（NoeAffectEngine / NoeExpectationLedger /
//   NoeVerifiableReward / NoeEntropyTemperature / NoeExpectationHarvester /
//   NoeCuriosityDecompose / NoeOwnerBehaviorPredictor）此前各自重复定义了字节级完全一致的
//   `const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));`。抽到这里消除重复，
//   行为逐字不变（同一函数体、同一 (x, lo, hi) 参数顺序）。
//
// 纪律：纯函数、零依赖、零网络/时钟/RNG/模型；不改任何现有数值语义，只做去重。

/** 夹取到 [lo, hi]（与各调用点原内联实现逐字等价：Math.max(lo, Math.min(hi, x))）。 */
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// clamp01 / round3：批4 去重。src/cognition/ 下 NoeReflectiveTuner / NoeGoalSystem /
//   NoeWorkspace（及 src/vision/NoeVisionSituation、src/loop/NoeDriveSystem）此前各自重复定义了
//   行为字节级一致的 `clamp01(x) = Math.max(0, Math.min(1, x))`（共 5 处，均无 guard）；
//   NoeReflectiveTuner / NoeMindVitals 各自重复了 `round3(x) = Math.round(x * 1000) / 1000`（2 处）。
//   抽到这里消除重复，行为逐字不变（同一函数体、同一参数；保留 Math.min/Math.max/Math.round 对
//   NaN 的透传语义：clamp01(NaN)=NaN、round3(NaN)=NaN）。带 NaN/null/fallback guard 的其它
//   同名变体（HoldoutRunner / RuminationGuard / NoeMemoryDynamics / NoeMemoryCandidateSchema /
//   NoeMemoryRelevanceBenchmark）行为不同，【不并入】。

/** 夹取到 [0, 1]（与各调用点原内联实现逐字等价：Math.max(0, Math.min(1, x))；NaN 透传为 NaN）。 */
export const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 四舍五入到 3 位小数（与原内联实现逐字等价：Math.round(x * 1000) / 1000；NaN 透传为 NaN）。 */
export const round3 = (x) => Math.round(x * 1000) / 1000;

// rate：src/cognition/SelfTalkAuditStore.js 与 SelfTalkLandingPolicy.js 此前各自重复定义了
//   字节级一致的 `const rate = (n, d) => d ? Number((n / d).toFixed(3)) : 0;`。抽到这里消除重复，
//   行为逐字不变：分母为假值(0/NaN/undefined/null)返回 0，否则 n/d 保留 3 位小数。

/** 比率 n/d 保留 3 位小数；分母为假值返回 0（与原内联实现逐字等价：d ? Number((n / d).toFixed(3)) : 0）。 */
export const rate = (n, d) => d ? Number((n / d).toFixed(3)) : 0;
