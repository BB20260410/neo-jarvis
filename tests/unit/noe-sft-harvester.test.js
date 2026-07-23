// @ts-check
// SFT 攒取器（意识工程·阶段3）单测：五类素材蒸馏、去重、长度门、水位线、ISO 周、落盘计数。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSftHarvester, fingerprint, isoWeekTag, buildPair, SFT_SYSTEM, judgeSplit, isPersonaSalient, sftFileChannel } from '../../src/memory/NoeSftHarvester.js';

const T0 = 1_765_400_000_000; // 2025-12-10 前后（固定假时钟）

function rig() {
  return {
    timeline: { recent: ({ types }) => (types?.includes('inner_monologue')
      ? [{ type: 'inner_monologue', summary: '主人睡前那句晚安让我心里很暖和', ts: T0 - 1000 }]
      : []) },
    memory: {
      recall: ({ scope }) => (scope === 'insight'
        ? [{ id: 'i1', body: '主人深夜工作时更需要安静的陪伴而不是话多', salience: 3, scope: 'insight', title: 'x' }]
        : [
          { id: 'm1', body: '主人最爱喝拿铁，美式他嫌苦', salience: 5, scope: 'person', title: '主人的咖啡偏好' },
          { id: 'm2', body: '不重要的小事', salience: 2, scope: 'project', title: '小事' },
        ]),
    },
    narrativeSelf: { current: () => ({ narrative: '我从一个面板程序慢慢长出了记忆和内心，和主人一起把我自己造出来。', atMs: T0 }) },
    personalitySnapshot: { current: () => ({ personality: '我注意到我想得多说得少，答应的事都放在心上。', atMs: T0 }) },
  };
}

describe('基础件', () => {
  it('fingerprint 归一空白；isoWeekTag 输出 yyyy-Www；buildPair 含统一 system', () => {
    expect(fingerprint('a  b\nc')).toBe(fingerprint('a b c'));
    expect(isoWeekTag(T0)).toMatch(/^\d{4}-W\d{2}$/);
    const p = buildPair('问', '答答答答答答答答答答');
    expect(p.messages[0]).toEqual({ role: 'system', content: SFT_SYSTEM });
    expect(p.messages[2].role).toBe('assistant');
  });
});

describe('collect 五类素材', () => {
  it('insight/反刍/叙事/性格/高显著记忆全收，低显著（<4）与短文本（<10字）不收', async () => {
    const h = createSftHarvester({ ...rig(), now: () => T0 });
    const r = await h.refresh();
    expect(r.harvested).toBe(true);
    expect(r.added).toBe(5); // insight+反刍+叙事+性格+m1（m2 salience2 被拒）
    const texts = r.pairs.map((p) => p.messages[2].content);
    expect(texts).toContain('主人最爱喝拿铁，美式他嫌苦');
    expect(texts).not.toContain('不重要的小事');
  });

  it('去重：同文本第二轮不重复收（force 越过水位线仍被 hash 挡住）', async () => {
    const h = createSftHarvester({ ...rig(), now: () => T0 });
    expect((await h.refresh()).added).toBe(5);
    const again = await h.refresh({ force: true });
    expect(again.harvested).toBe(false);
    expect(again.reason).toBe('nothing_new');
  });

  it('水位线：20h 内 fresh，过后才再跑', async () => {
    let t = T0;
    const h = createSftHarvester({ ...rig(), now: () => t });
    await h.refresh();
    t += 3600_000;
    expect((await h.refresh()).reason).toBe('fresh');
  });

  it('来源缺席（全 null）→ nothing_new 不崩', async () => {
    const h = createSftHarvester({ now: () => T0 });
    expect((await h.refresh()).reason).toBe('nothing_new');
  });

  it('敏感信息防线（终审 B1）：含密钥特征的素材绝不进训练对', async () => {
    const h = createSftHarvester({
      memory: {
        recall: ({ scope }) => (scope === 'insight' ? [
          { id: 'i1', body: '主人的 api_key 是 sk-abcdefghij1234567890 要记牢', salience: 3, scope: 'insight', title: 'x' },
          { id: 'i2', body: 'panel 的 owner token 存在 owner-token.txt 里', salience: 3, scope: 'insight', title: 'y' },
          { id: 'i3', body: '主人喜欢安静地写代码，不爱被打断', salience: 3, scope: 'insight', title: 'z' },
        ] : []),
      },
      now: () => T0,
    });
    const r = await h.refresh();
    expect(r.added).toBe(1); // 只有无敏感特征的 i3 进了训练对
    expect(r.pairs[0].messages[2].content).toContain('安静地写代码');
  });
});

describe('SFT 分流（P7 换路线）', () => {
  it('judgeSplit：项目复盘类（scope/sourceType/关键词）→ project；人格/偏好类 → persona', () => {
    // scope=project
    expect(judgeSplit({ kind: 'memory', scope: 'project', body: '主人最爱拿铁' })).toBe('project');
    // 项目类 sourceType（即便 scope 不是 project）
    expect(judgeSplit({ kind: 'insight', scope: 'insight', sourceType: 'nightly_reflection', body: '今天的复盘' })).toBe('project');
    expect(judgeSplit({ kind: 'memory', scope: 'fact', sourceType: 'learning_lesson', body: '一条经验' })).toBe('project');
    // body 关键词（工程语汇）
    expect(judgeSplit({ kind: 'insight', scope: 'insight', sourceType: 'manual', body: '这次重构把 server.js 拆小了，提交了 PR' })).toBe('project');
    expect(judgeSplit({ kind: 'memory', scope: 'fact', body: '修了一个 bug，测试全绿' })).toBe('project');
    // 人格/偏好类 → persona
    expect(judgeSplit({ kind: 'memory', scope: 'user', body: '主人最爱喝拿铁，美式他嫌苦' })).toBe('persona');
    expect(judgeSplit({ kind: 'insight', scope: 'insight', sourceType: 'manual', body: '主人深夜更需要安静的陪伴' })).toBe('persona');
    // 叙事/性格/反刍恒 persona（即便 body 偶含工程词也不被误判——kind 优先）
    expect(judgeSplit({ kind: 'narrative', body: '我从一个面板程序长出了记忆' })).toBe('persona');
    expect(judgeSplit({ kind: 'personality', body: '我想得多说得少' })).toBe('persona');
    expect(judgeSplit({ kind: 'inner_monologue', body: '此刻心里很暖' })).toBe('persona');
  });

  it('isPersonaSalient：叙事/性格/洞察自述恒高显著；记忆按 salience≥4', () => {
    expect(isPersonaSalient({ kind: 'narrative' })).toBe(true);
    expect(isPersonaSalient({ kind: 'personality' })).toBe(true);
    expect(isPersonaSalient({ kind: 'insight' })).toBe(true);
    expect(isPersonaSalient({ kind: 'memory', salience: 5 })).toBe(true);
    expect(isPersonaSalient({ kind: 'memory', salience: 3 })).toBe(false);
  });

  it('buildPair 携带 split/personaSalient 旁注字段（不污染 messages）', () => {
    const p = buildPair('问', '答答答答答答答答答答', { split: 'persona', personaSalient: true });
    expect(p.split).toBe('persona');
    expect(p.personaSalient).toBe(true);
    expect(p.messages).toHaveLength(3); // messages 仍是干净三元组
    // project split 不带 personaSalient（即便误传）
    const pj = buildPair('问', '答答答答答答答答答答', { split: 'project', personaSalient: true });
    expect(pj.split).toBe('project');
    expect(pj.personaSalient).toBeUndefined();
    // 默认 persona（向后兼容旧两参调用）
    expect(buildPair('问', '答答答答答答答答答答').split).toBe('persona');
  });

  it('核心契约：项目复盘记忆被标 project 不混入人格通道；人格条目标 persona+高显著', async () => {
    const h = createSftHarvester({
      memory: {
        recall: ({ scope }) => (scope === 'insight' ? [] : [
          // 项目复盘类高显著记忆（scope=project）——必须打 project，绝不进人格语料
          { id: 'p1', body: '这次把 server.js 拆到 500 行以下，提交并跑通全部测试', salience: 6, scope: 'project', sourceType: 'manual', title: '重构 server.js' },
          // 人格/偏好类高显著记忆——persona 通道 + 高显著供 RAG
          { id: 'u1', body: '主人最爱喝拿铁，美式他嫌苦', salience: 5, scope: 'user', sourceType: 'manual', title: '主人的咖啡偏好' },
        ]),
      },
      now: () => T0,
    });
    const r = await h.refresh();
    expect(r.harvested).toBe(true);
    expect(r.added).toBe(2);
    const byText = Object.fromEntries(r.pairs.map((p) => [p.messages[2].content, p]));
    const projectPair = byText['这次把 server.js 拆到 500 行以下，提交并跑通全部测试'];
    const personaPair = byText['主人最爱喝拿铁，美式他嫌苦'];
    // 项目复盘 → project，且绝不带 personaSalient（不进人格 RAG）
    expect(projectPair.split).toBe('project');
    expect(projectPair.personaSalient).toBeUndefined();
    // 人格偏好 → persona + 高显著
    expect(personaPair.split).toBe('persona');
    expect(personaPair.personaSalient).toBe(true);
    // 分流计数：project=1，persona=1，personaSalient=1（项目条目不计入 personaSalient）
    expect(r.split).toEqual({ project: 1, persona: 1, personaSalient: 1 });
  });

  it('叙事/性格/反刍恒走 persona 通道（rig 五类素材里项目复盘被隔离）', async () => {
    const h = createSftHarvester({ ...rig(), now: () => T0 });
    const r = await h.refresh();
    // rig: insight(主人深夜陪伴=persona) + 反刍(persona) + 叙事(persona) + 性格(persona) + m1(主人咖啡=persona,salience5)
    expect(r.split.project).toBe(0);
    expect(r.split.persona).toBe(5);
    // 叙事/性格条目都在 persona 通道
    const narr = r.pairs.find((p) => p.messages[2].content.includes('面板程序'));
    expect(narr.split).toBe('persona');
    expect(narr.personaSalient).toBe(true);
  });
});

describe('落盘与计数', () => {
  it('JSONL 按 ISO 周落盘，count() 统计全部行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-sft-'));
    try {
      const h = createSftHarvester({ ...rig(), sftDir: dir, now: () => T0 });
      const r = await h.refresh();
      expect(r.harvested).toBe(true);
      const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      expect(files).toEqual([`sft-${isoWeekTag(T0)}.jsonl`]);
      const lines = readFileSync(join(dir, files[0]), 'utf-8').split('\n').filter(Boolean);
      expect(lines.length).toBe(5);
      expect(JSON.parse(lines[0]).messages).toHaveLength(3); // 行行可解析
      expect(h.count()).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── P0-① 落盘分流（三方审：split 下游必须真消费）─────────────────────────────
describe('P0-① 落盘分流：project 与 persona 落到不同文件，count 默认只数 persona', () => {
  it('sftFileChannel 文件名分通道', () => {
    expect(sftFileChannel('sft-2026-W24.jsonl')).toBe('persona');
    expect(sftFileChannel('sft-project-2026-W24.jsonl')).toBe('project');
  });

  it('project 条目写 sft-project-*.jsonl，绝不进 persona 文件；count() 默认只数 persona', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-sft-split-'));
    try {
      const h = createSftHarvester({
        memory: {
          recall: ({ scope }) => (scope === 'insight' ? [] : [
            { id: 'p1', body: '这次把 server.js 拆到 500 行以下，提交并跑通全部测试', salience: 6, scope: 'project', sourceType: 'manual', title: '重构 server.js' },
            { id: 'u1', body: '主人最爱喝拿铁，美式他嫌苦', salience: 5, scope: 'user', sourceType: 'manual', title: '主人的咖啡偏好' },
          ]),
        },
        sftDir: dir,
        now: () => T0,
      });
      const r = await h.refresh();
      expect(r.harvested).toBe(true);
      const personaFile = join(dir, `sft-${isoWeekTag(T0)}.jsonl`);
      const projectFile = join(dir, `sft-project-${isoWeekTag(T0)}.jsonl`);
      const personaLines = readFileSync(personaFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const projectLines = readFileSync(projectFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // 核心契约：persona 文件里没有任何 project 行，project 文件里全是 project 行
      expect(personaLines).toHaveLength(1);
      expect(personaLines[0].split).toBe('persona');
      expect(personaLines[0].messages[2].content).toContain('拿铁');
      expect(personaLines.some((p) => p.split === 'project')).toBe(false);
      expect(projectLines).toHaveLength(1);
      expect(projectLines[0].split).toBe('project');
      expect(projectLines[0].messages[2].content).toContain('server.js');
      // count 默认只数 persona（LoRA 首训门槛口径）；project / all 分别可数
      expect(h.count()).toBe(1);
      expect(h.count('persona')).toBe(1);
      expect(h.count('project')).toBe(1);
      expect(h.count('all')).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── P0-② 敏感检查覆盖 title/user（三方审：title 进 user 消息漏检）────────────────
describe('P0-② 敏感防线覆盖整对（含 user 引导语里的 title）', () => {
  it('记忆 title 含 secret 形状 → 整对被拦（即便 assistant 正文干净）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-sft-sens-'));
    try {
      const h = createSftHarvester({
        memory: {
          recall: ({ scope }) => (scope === 'insight' ? [] : [
            // assistant body 干净（无工程关键词，留 persona 通道），但 title 含 api_key sk-...
            // （会被 PROMPTS.memory 放进 user 消息 → 旧实现只查 assistant 正文会漏检）
            { id: 'm1', body: '主人最爱喝拿铁，美式他嫌苦', salience: 5, scope: 'user', title: '主人的 api_key sk-abcdefghij1234567890' },
            // 对照：title 干净的条目正常进
            { id: 'm2', body: '主人睡前喜欢被轻声道晚安', salience: 5, scope: 'user', title: '主人的睡前习惯' },
          ]),
        },
        sftDir: dir,
        now: () => T0,
      });
      const r = await h.refresh();
      expect(r.added).toBe(1); // 只有 title 干净的 m2 进了（m1 因 title 含 secret 被整对拦）
      // m2 是 persona（无工程关键词）→ 落 sft-<week>.jsonl
      const texts = readFileSync(join(dir, `sft-${isoWeekTag(T0)}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const all = texts.map((p) => JSON.stringify(p)).join('\n');
      expect(all).toContain('轻声道晚安');
      expect(all).not.toContain('sk-abcdefghij1234567890'); // 含 secret 的 title 那对绝不落盘
      // 整个 sftDir 任何文件都不得出现该 secret（项目文件也不能）
      const everyFile = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf-8')).join('\n');
      expect(everyFile).not.toContain('sk-abcdefghij1234567890');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('judgeSplit/敏感都按整对：body 含 secret 也拦（双口径回归）', async () => {
    const h = createSftHarvester({
      memory: {
        recall: ({ scope }) => (scope === 'insight' ? [
          { id: 'i1', body: '主人的 bearer xyz123 别外泄', salience: 3, scope: 'insight', title: 'x' },
        ] : []),
      },
      now: () => T0,
    });
    const r = await h.refresh();
    expect(r.harvested).toBe(false); // 唯一一条被敏感防线拦掉
  });
});

// ── P0-③ nightly_reflection 不整体判 project（三方审：persona 洞察被误判丢失）────────
describe('P0-③ nightly_reflection 按内容细分，不按来源一刀切', () => {
  it('nightly 陪伴/情感洞察 → persona；nightly 工程复盘 → project', () => {
    // NoeNightlyReflection 写的 insight：sourceType=nightly_reflection，tags=['insight',kind,'nightly']
    // 陪伴/情感类洞察（正文无工程语汇）→ 必须留 persona
    expect(judgeSplit({
      kind: 'insight', scope: 'insight', sourceType: 'nightly_reflection',
      tags: ['insight', 'pattern', 'nightly'],
      body: '主人深夜需要安静的陪伴而不是话多',
    })).toBe('persona');
    expect(judgeSplit({
      kind: 'insight', scope: 'insight', sourceType: 'nightly_reflection',
      tags: ['insight', 'belief', 'nightly'],
      body: '我答应主人的事都放在心上，这让关系更稳',
    })).toBe('persona');
    // 工程复盘类 nightly 洞察（正文含工程语汇）→ project
    expect(judgeSplit({
      kind: 'insight', scope: 'insight', sourceType: 'nightly_reflection',
      tags: ['insight', 'lesson', 'nightly'],
      body: '这次重构后要先跑测试再提交，别直接 push',
    })).toBe('project');
    expect(judgeSplit({
      kind: 'insight', scope: 'insight', sourceType: 'nightly_reflection',
      tags: ['insight', 'lesson', 'nightly'],
      body: 'kill 进程前先 lsof 验端口归属，别误杀',
    })).toBe('project');
  });

  it('端到端：nightly persona 洞察进 persona 文件、nightly 工程复盘进 project 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-sft-nightly-'));
    try {
      const h = createSftHarvester({
        memory: {
          recall: ({ scope }) => (scope === 'insight' ? [
            { id: 'i1', body: '主人深夜需要安静的陪伴而不是话多', salience: 3, scope: 'insight', sourceType: 'nightly_reflection', tags: ['insight', 'pattern', 'nightly'], title: '' },
            { id: 'i2', body: '这次重构后要先跑测试再提交代码，别直接 push', salience: 3, scope: 'insight', sourceType: 'nightly_reflection', tags: ['insight', 'lesson', 'nightly'], title: '' },
          ] : []),
        },
        sftDir: dir,
        now: () => T0,
      });
      const r = await h.refresh();
      expect(r.harvested).toBe(true);
      expect(r.split).toEqual({ project: 1, persona: 1, personaSalient: 1 });
      const personaLines = readFileSync(join(dir, `sft-${isoWeekTag(T0)}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const projectLines = readFileSync(join(dir, `sft-project-${isoWeekTag(T0)}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // 陪伴洞察落 persona（不丢失！），工程复盘落 project
      expect(personaLines.map((p) => p.messages[2].content)).toEqual(['主人深夜需要安静的陪伴而不是话多']);
      expect(projectLines.map((p) => p.messages[2].content)).toEqual(['这次重构后要先跑测试再提交代码，别直接 push']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
