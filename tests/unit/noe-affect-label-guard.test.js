// 强健加固测试:NoeAffectEngine.affectLabel 入参防御。
// 覆盖:①affectLabel(null)/affectLabel(undefined)/affectLabel() 不再 TypeError,返回中性'平静';
//      ②所有合法 {v,a} 象限映射与加固前逐字等价(零回归)。
// 纯函数,确定性,不触网/不依赖时钟。
import { describe, expect, it } from 'vitest';
import { affectLabel } from '../../src/cognition/NoeAffectEngine.js';

describe('affectLabel 入参防御(导出纯助手)', () => {
  it('null / undefined / 缺参 → 返回中性"平静",不抛错', () => {
    expect(() => affectLabel(null)).not.toThrow();
    expect(() => affectLabel(undefined)).not.toThrow();
    expect(() => affectLabel()).not.toThrow();
    // 空对象语义 = v,a 皆 undefined → 落到 a>=0.6 之外的 else 分支 → '平静'
    expect(affectLabel(null)).toBe('平静');
    expect(affectLabel(undefined)).toBe('平静');
    expect(affectLabel()).toBe('平静');
    expect(affectLabel({})).toBe('平静');
  });

  it('合法 {v,a} 象限映射逐字等价(零回归)', () => {
    // v>=0.25:a>=0.55→振奋 / 否则→安暖
    expect(affectLabel({ v: 0.5, a: 0.7 })).toBe('振奋');
    expect(affectLabel({ v: 0.5, a: 0.3 })).toBe('安暖');
    // v<=-0.25:a>=0.55→烦躁 / 否则→低落
    expect(affectLabel({ v: -0.5, a: 0.7 })).toBe('烦躁');
    expect(affectLabel({ v: -0.5, a: 0.2 })).toBe('低落');
    // 中间带:a>=0.6→警醒 / 否则→平静
    expect(affectLabel({ v: 0, a: 0.8 })).toBe('警醒');
    expect(affectLabel({ v: 0, a: 0.3 })).toBe('平静');
    // 边界值锚定(>=0.25 取等)
    expect(affectLabel({ v: 0.25, a: 0.55 })).toBe('振奋');
    expect(affectLabel({ v: -0.25, a: 0.55 })).toBe('烦躁');
  });
});
