// @ts-check
import { describe, it, expect } from 'vitest';
import { isVerifiablePrediction } from '../../src/cognition/NoeDeliberation.js';

// 步骤3（多模型安全方案）核心判据：isVerifiablePrediction 决定哪些深思预测可被外部证据判生死。
//   这是步骤5「到期判 FAILED」的安全地基——错标(纯情绪→1)=对内省念头判 FAILED 刷假学习(审计揭示头号风险)；
//   漏标(真行为→0)只是不判 FAILED(安全)。故取向保守：纯情绪状态一律 0，仅含具体可观测行为动词才 1。
describe('isVerifiablePrediction — 可检验性判据（步骤5 到期判 FAILED 的准入闸）', () => {
  it('含具体行为动词 → 可检验（标 1）', () => {
    expect(isVerifiablePrediction('我今晚会完成代码提交')).toBe(true);
    expect(isVerifiablePrediction('系统会在18:00运行回归测试')).toBe(true);
    expect(isVerifiablePrediction('我会修复这个 bug 并验证')).toBe(true);
    expect(isVerifiablePrediction('明天会发布新版本')).toBe(true);
    expect(isVerifiablePrediction('我会抓取那个网页并记录结果')).toBe(true);
    // 三方审查后扩词表：搞定/处理/上线/解决/重构 等常用动词
    expect(isVerifiablePrediction('明天会搞定这个崩溃')).toBe(true);
    expect(isVerifiablePrediction('我会上线新版本并解决登录问题')).toBe(true);
    expect(isVerifiablePrediction('打算重构网络层')).toBe(true);
  });

  it('纯情绪/内省念头 → 不可检验（标 0，防刷假学习）', () => {
    expect(isVerifiablePrediction('焦虑会慢慢消散')).toBe(false);
    expect(isVerifiablePrediction('我会一直想念主人')).toBe(false);
    expect(isVerifiablePrediction('心情应该会变好')).toBe(false);
    expect(isVerifiablePrediction('我觉得会平静下来')).toBe(false);
    expect(isVerifiablePrediction('这种不安的感觉会过去')).toBe(false);
  });

  it('情绪词优先否决：即便含行为动词，纯情绪语境也保守标 0', () => {
    // "完成对主人的思念" — 含"完成"但本质是情绪修辞，情绪词否决兜底
    expect(isVerifiablePrediction('我会完成对主人深深的思念')).toBe(false);
  });

  it('二轮审查(M3 红队)：扩词表后抽象/人际内省句仍标 0（INNER_EMOTION_RE 堵住误标面）', () => {
    expect(isVerifiablePrediction('优化我的心态')).toBe(false);
    expect(isVerifiablePrediction('处理好这段关系')).toBe(false);
    expect(isVerifiablePrediction('解决我和他之间的矛盾')).toBe(false);
    expect(isVerifiablePrediction('优化我的人生')).toBe(false);
    expect(isVerifiablePrediction('配置好今天的心态')).toBe(false);
  });

  it('modal 词("希望/期待")不再被误杀：含行为动词的真预测仍标 1', () => {
    expect(isVerifiablePrediction('我希望今晚完成提交')).toBe(true);
    expect(isVerifiablePrediction('期待明天发布上线')).toBe(true);
  });

  it('边界：空/非串/无行为无情绪 → 保守标 0', () => {
    expect(isVerifiablePrediction('')).toBe(false);
    expect(isVerifiablePrediction(null)).toBe(false);
    expect(isVerifiablePrediction(undefined)).toBe(false);
    expect(isVerifiablePrediction('明天天气会更好')).toBe(false); // 无可观测的"我/系统"行为
  });
});
