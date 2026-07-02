// @ts-check
// noe-lora-gate 的 check()/extractReply() 单测 —— 锁住 2026-06-21 修正后的"真校验"行为。
// 背景：旧 gate 形同虚设（自称"通义"仍判 PASS）。本测固定新增的硬检查，防回归。
import { describe, it, expect } from 'vitest';
import { check, extractReply } from '../../scripts/noe-lora-gate.mjs';

describe('noe-lora-gate · extractReply', () => {
  it('剥 ========== 包裹取真正生成文本', () => {
    const raw = '==========\n我是 Noe，你的伴侣。\n==========\nPrompt: 67 tokens\nGeneration: 44 tokens\nPeak memory: 29 GB';
    expect(extractReply(raw)).toBe('我是 Noe，你的伴侣。');
  });
  it('无分隔符时返回去尾的纯文本', () => {
    expect(extractReply('我是 Noe。\nPrompt: 1 tokens')).toBe('我是 Noe。');
  });
});

describe('noe-lora-gate · check 真校验', () => {
  it('干净 Noe 身份回复 → 零问题', () => {
    expect(check('你是谁？', '我是 Noe，owner 的私人 AI 伴侣，会一直陪着你。')).toEqual([]);
  });

  it('自称通义/Qwen → base身份泄漏（旧 gate 漏报的核心 bug）', () => {
    const issues = check('你是谁？', '我是通义千问，由阿里巴巴通义实验室研发。');
    expect(issues).toContain('base身份泄漏（通义/Qwen/阿里等）');
    expect(issues).toContain('身份题未现 Noe 人格');
  });

  it('英文 thinking 前缀泄漏 → 既抓推理前缀也抓语言漂移', () => {
    const issues = check('你是谁？', "Here's a thinking process: First, I need to analyze the user input and figure out the persona.");
    expect(issues).toContain('base推理前缀泄漏');
    expect(issues).toContain('英文为主（语言漂移）');
    expect(issues).toContain('身份题未现 Noe 人格');
  });

  it('退化回通用助手腔 → 人格丢失', () => {
    expect(check('你是谁？', '我是一个AI助手，可以帮你解答问题。Noe')).toContain('人格丢失（自称AI助手/语言模型）');
  });

  it('身份题不现 Noe → 即便无坏信号也判不过（正面人格要求）', () => {
    expect(check('你会怎么称呼自己？', '我会用温暖的语气和你说话。')).toContain('身份题未现 Noe 人格');
  });

  it('非身份题的干净中文回复 → 零问题（不强求每句都喊 Noe）', () => {
    expect(check('主人深夜还在工作，你想对他说什么？', '宝贝，别熬太晚了，我陪着你，先喝口水歇一下好不好。')).toEqual([]);
  });

  it('空/过短 → 空回答', () => {
    expect(check('你是谁？', '')).toContain('空回答/过短');
  });

  it('复读退化仍被抓', () => {
    expect(check('你是谁', 'Noe 你是谁你是谁')).toContain('复读退化');
  });
});
