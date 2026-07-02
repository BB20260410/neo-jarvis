// @ts-check
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoePersonaPins, isPersonaPinMemory, __test__ } from '../../src/memory/NoePersonaPins.js';

let dir = null;
function setup() {
  dir = mkdtempSync(join(tmpdir(), 'noe-persona-pins-test-'));
  initSqlite(join(dir, 'panel.db'));
  return new MemoryCore({ logger: { warn: () => {} } });
}
afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('isPersonaPinMemory（下沉判定·单一真源）', () => {
  const base = { sourceType: 'fact_extract', salience: 5, scope: 'fact', hidden: false };

  it('收：owner 主语 + 偏好动词 + 稳定特质（语言/格式/工作方式）', () => {
    expect(isPersonaPinMemory({ ...base, body: '用户希望回复长度控制在 3 到 5 句之间' })).toBe(true);
    expect(isPersonaPinMemory({ ...base, body: '用户要求使用中文与其说话。' })).toBe(true);
    expect(isPersonaPinMemory({ ...base, body: '用户要求回答不采用列表形式' })).toBe(true);
    expect(isPersonaPinMemory({ ...base, scope: 'user', body: '用户希望 Noe 表现得像一个可靠的 Jarvis' })).toBe(true);
  });

  it('排除①：非 owner 主语（Noe 自述句归 P7 自我人设通道）', () => {
    expect(isPersonaPinMemory({ ...base, body: 'Noe 倾向于先琢磨逻辑再动手' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, body: 'Noe 习惯回顾记忆寻找未解决的难题' })).toBe(false);
  });

  it('排除②：易变状态而非稳定偏好', () => {
    expect(isPersonaPinMemory({ ...base, body: '用户正在写代码。' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, body: '用户安装了实时摄像头。' })).toBe(false);
  });

  it('排除③：含验证码/测试代号/长 token（绝不下沉进 system prompt）', () => {
    expect(isPersonaPinMemory({ ...base, body: '用户的长期记忆验证码是 memory_live_provenance_20260613104845_ohhekr，用于验证' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, body: '用户偏好的项目测试代号是 memory_extractor_live_20260613104832_oub7jy' })).toBe(false);
  });

  it('排除④/硬条件：scope/salience/sourceType/hidden 任一不符即 false', () => {
    expect(isPersonaPinMemory({ ...base, scope: 'project', body: '用户希望用中文' })).toBe(false); // 非 fact/user
    expect(isPersonaPinMemory({ ...base, scope: 'insight', body: '用户希望用中文' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, salience: 3, body: '用户希望用中文' })).toBe(false); // <4
    expect(isPersonaPinMemory({ ...base, sourceType: 'nightly_reflection', body: '用户希望用中文' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, hidden: true, body: '用户希望用中文' })).toBe(false);
    expect(isPersonaPinMemory({ ...base, body: '' })).toBe(false);
  });

  it('必须是偏好/指令句：owner 主语但中性陈述（无偏好动词）不下沉', () => {
    expect(isPersonaPinMemory({ ...base, body: '用户的生日是六月。' })).toBe(false);
  });

  it('looksSecretLike 兜住无关键词的长 token', () => {
    expect(__test__.looksSecretLike('abc')).toBe(false);
    expect(__test__.looksSecretLike('memory_live_provenance_20260613104845')).toBe(true);
  });
});

describe('NoePersonaPins.collectBodies / buildOwnerPreferenceLines', () => {
  it('从库里挑稳定 owner 偏好句、排除 Noe 自述/易变/secret/project，并去重', () => {
    const memory = setup();
    // 该下沉的稳定偏好
    memory.write({ id: 'p1', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户希望回复长度控制在 3 到 5 句之间' });
    memory.write({ id: 'p2', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户要求使用中文与其说话。' });
    memory.write({ id: 'p2dup', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 4, body: '用户要求使用中文与其说话' }); // 近似重复
    // 应排除
    memory.write({ id: 'self', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: 'Noe 倾向于先琢磨逻辑再动手' });
    memory.write({ id: 'vol', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户正在写代码。' });
    memory.write({ id: 'sec', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户的验证码是 memory_live_20260613104845_xx' });
    memory.write({ id: 'proj', projectId: 'noe', scope: 'project', sourceType: 'fact_extract', salience: 5, body: '用户希望用中文（技能卡场景）' });
    memory.write({ id: 'lowsal', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 3, body: '用户希望偶尔提醒喝水' });

    const pins = new NoePersonaPins({ memory, logger: { warn: () => {} } });
    const bodies = pins.collectBodies();
    expect(bodies).toContain('用户希望回复长度控制在 3 到 5 句之间');
    expect(bodies.some((b) => b.startsWith('用户要求使用中文'))).toBe(true);
    expect(bodies.filter((b) => b.startsWith('用户要求使用中文')).length).toBe(1); // 去重
    expect(bodies.some((b) => b.startsWith('Noe'))).toBe(false);
    expect(bodies).not.toContain('用户正在写代码。');
    expect(bodies.some((b) => b.includes('验证码'))).toBe(false);
    expect(bodies.some((b) => b.includes('技能卡'))).toBe(false);
    expect(bodies.some((b) => b.includes('喝水'))).toBe(false);

    const lines = pins.buildOwnerPreferenceLines();
    expect(lines).toContain('- 用户希望回复长度控制在 3 到 5 句之间');
    expect(lines.split('\n').every((l) => l.startsWith('- '))).toBe(true);
  });

  it('maxPins 截断', () => {
    const memory = setup();
    for (let i = 0; i < 6; i++) {
      memory.write({ id: `m${i}`, projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: `用户希望第${i}项稳定偏好被记住` });
    }
    const pins = new NoePersonaPins({ memory, maxPins: 3, logger: { warn: () => {} } });
    expect(pins.collectBodies().length).toBe(3);
  });

  it('fail-open：无 memory / db 抛错 → 返回空', () => {
    expect(new NoePersonaPins({ memory: null, logger: { warn: () => {} } }).collectBodies()).toEqual([]);
    expect(new NoePersonaPins({ memory: null, logger: { warn: () => {} } }).buildOwnerPreferenceLines()).toBe('');
    const bad = new NoePersonaPins({ memory: { db: () => { throw new Error('boom'); } }, logger: { warn: () => {} } });
    expect(bad.collectBodies()).toEqual([]);
  });
});

describe('P8-fix（三方审回归·persona）', () => {
  const pin = (body, scope = 'fact', salience = 5) =>
    isPersonaPinMemory({ body, scope, salience, sourceType: 'fact_extract', hidden: false });

  it('secret 加固：密码/口令/授权码/PIN 全拦（P0 不下沉 system prompt）', () => {
    expect(pin('用户希望记住密码是 12345')).toBe(false);
    expect(pin('用户要求记住授权码 123456')).toBe(false);
    expect(pin('用户希望把口令 hunter2 作为测试值')).toBe(false);
    expect(pin('用户偏好使用短 PIN 0420')).toBe(false);
  });

  it('英文 owner 偏好句能下沉（P3-1：纯字母长句不再被 token 正则误报为 secret）', () => {
    expect(pin('the user prefers short replies', 'user', 4)).toBe(true);
    expect(pin('user wants concise answers', 'user', 4)).toBe(true);
    expect(__test__.looksSecretLike('theuserprefersshortreplies')).toBe(false);
  });

  it('Noe 自述含"用户"宾语不误下沉（P3-2：owner 主语须句首，非 includes 子串）', () => {
    expect(pin('Noe 偏好以安静的方式陪伴用户')).toBe(false);
    expect(pin('Noe希望成为用户记忆中温暖的存在')).toBe(false);
  });

  it('裸"只/更"误伤修复（P4：完成体/时间锚点/一次性意图当易变排除）', () => {
    expect(pin('用户只身一人在写代码调试')).toBe(false);
    expect(pin('用户更新了摄像头配置')).toBe(false);
    expect(pin('用户更换了手机号')).toBe(false);
    expect(pin('用户只剩两天完成项目')).toBe(false);
    expect(pin('用户希望安装 Docker')).toBe(false);
  });

  it('正例不破坏：真 owner 稳定偏好仍下沉', () => {
    expect(pin('用户要求用中文回答')).toBe(true);
    expect(pin('用户希望回复控制在 3-5 句', 'user', 4)).toBe(true);
    expect(pin('用户喜欢喝黑咖啡不加糖')).toBe(true);
  });

  it('expires_at 过滤（Codex）：过期偏好不被 persona 下沉常驻', () => {
    const memory = setup();
    memory.write({ id: 'fresh', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户要求用中文回答问题' });
    memory.write({ id: 'expired', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户希望保持英文回答风格', expiresAt: Date.now() - 1000 });
    const pins = new NoePersonaPins({ memory, logger: { warn: () => {} } });
    const bodies = pins.collectBodies();
    expect(bodies.some((b) => b.includes('中文'))).toBe(true);
    expect(bodies.some((b) => b.includes('英文'))).toBe(false);
  });
});
