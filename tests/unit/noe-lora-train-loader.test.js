// @ts-check
// noe-lora-train 加载器单测（P0-① 三方审：人格/LoRA 训练只吃 persona，project 绝不进权重）。
// 只测纯函数 loadPersonaTrainingPairs（import 不触发 mlx_lm 训练，见脚本尾部 import.meta.url 守卫）。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPersonaTrainingPairs } from '../../scripts/noe-lora-train.mjs';

function pair(text, split) {
  const o = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: text }] };
  if (split) o.split = split;
  return JSON.stringify(o);
}

describe('loadPersonaTrainingPairs（P0-① 人格训练只吃 persona）', () => {
  it('只读 persona 文件，project 文件整体不参与人格训练', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-lora-load-'));
    try {
      writeFileSync(join(dir, 'sft-2026-W24.jsonl'), [pair('主人最爱拿铁', 'persona'), pair('我答应的事都记着', 'persona')].join('\n') + '\n');
      writeFileSync(join(dir, 'sft-project-2026-W24.jsonl'), [pair('重构 server.js 跑通测试', 'project')].join('\n') + '\n');
      const r = loadPersonaTrainingPairs(dir);
      expect(r.valid).toHaveLength(2); // 只有 persona 文件两行
      expect(r.projectFiles).toBe(1);  // project 留档文件被识别但不读入
      expect(r.valid.join('\n')).not.toContain('server.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('行级双保险：persona 文件里混入的 split=project 行被剔除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-lora-load2-'));
    try {
      // 历史/混入：persona 文件里夹了一行 project（比如旧版本未分流时写的）
      writeFileSync(join(dir, 'sft-2026-W24.jsonl'), [
        pair('主人最爱拿铁', 'persona'),
        pair('这次提交把 bug 修了', 'project'), // 必须被剔除，绝不进权重人格
        pair('我想得多说得少'),                  // 无 split 字段 → 当 persona 收
      ].join('\n') + '\n');
      const r = loadPersonaTrainingPairs(dir);
      expect(r.valid).toHaveLength(2);
      expect(r.droppedProject).toBe(1);
      expect(r.valid.join('\n')).not.toContain('修了');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('坏行计入 bad、不进训练集；空目录返回空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-lora-load3-'));
    try {
      writeFileSync(join(dir, 'sft-2026-W24.jsonl'), [pair('正常一行', 'persona'), '{坏 json', '{"messages":[{"role":"u"}]}'].join('\n') + '\n');
      const r = loadPersonaTrainingPairs(dir);
      expect(r.valid).toHaveLength(1);
      expect(r.bad).toBe(2); // 坏 json + messages 不足 3
      const empty = loadPersonaTrainingPairs(mkdtempSync(join(tmpdir(), 'noe-lora-empty-')));
      expect(empty.valid).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
