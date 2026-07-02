// AgentStateMachine 单元测试
// 覆盖：状态转换 idle→thinking/running/completed/error、边界输入、history 追踪、reset

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentStateMachine, STATES } from '../../src/state/AgentStateMachine.js';

describe('STATES 常量', () => {
  it('包含 5 种合法状态', () => {
    expect(STATES).toEqual(['idle', 'thinking', 'running', 'completed', 'error']);
  });
});

describe('AgentStateMachine 初始状态', () => {
  it('初始 state 为 idle', () => {
    const sm = new AgentStateMachine();
    expect(sm.current).toBe('idle');
  });

  it('初始 history 为空数组', () => {
    const sm = new AgentStateMachine();
    expect(sm.transitions).toEqual([]);
  });
});

describe('ingest — system init → thinking', () => {
  let sm;
  beforeEach(() => { sm = new AgentStateMachine(); });

  it('system+init 事件将状态从 idle 切换到 thinking', () => {
    const result = sm.ingest({ type: 'system', subtype: 'init' });
    expect(result).not.toBeNull();
    expect(result.from).toBe('idle');
    expect(result.to).toBe('thinking');
    expect(result.reason).toBe('system init');
    expect(sm.current).toBe('thinking');
  });

  it('重复 system+init（相同状态）不产生转换', () => {
    sm.ingest({ type: 'system', subtype: 'init' }); // idle → thinking
    const result = sm.ingest({ type: 'system', subtype: 'init' }); // 已是 thinking
    expect(result).toBeNull();
    expect(sm.current).toBe('thinking');
  });
});

describe('ingest — assistant content → thinking（无 tool_use）', () => {
  let sm;
  beforeEach(() => {
    sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' }); // 先到 thinking
  });

  it('content 为空数组时转换到 thinking（无 tool_use）', () => {
    // 先 reset 到 idle 再看 idle → thinking
    sm.reset(); // 回 idle
    const result = sm.ingest({
      type: 'assistant',
      message: { content: [] },
    });
    expect(result).not.toBeNull();
    expect(result.to).toBe('thinking');
    expect(result.reason).toBe('assistant text only');
  });

  it('content 数组只含 text 类型，转换到 thinking', () => {
    sm.reset();
    const result = sm.ingest({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(result).not.toBeNull();
    expect(result.to).toBe('thinking');
    expect(result.reason).toBe('assistant text only');
  });

  it('已在 thinking 状态时再收到纯文本 assistant，相同状态不产生转换', () => {
    // sm 已是 thinking
    const result = sm.ingest({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'more text' }] },
    });
    expect(result).toBeNull();
    expect(sm.current).toBe('thinking');
  });
});

describe('ingest — assistant content → running（含 tool_use）', () => {
  let sm;
  beforeEach(() => {
    sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' }); // idle → thinking
  });

  it('content 数组含 tool_use，从 thinking 转换到 running', () => {
    const result = sm.ingest({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'tool_use', id: 'x1', name: 'bash', input: {} },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result.from).toBe('thinking');
    expect(result.to).toBe('running');
    expect(result.reason).toBe('tool_use emitted');
    expect(sm.current).toBe('running');
  });

  it('content 数组只含 tool_use（无 text），仍转换到 running', () => {
    const result = sm.ingest({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'x2', name: 'read_file', input: {} }],
      },
    });
    expect(result.to).toBe('running');
  });
});

describe('ingest — result → completed', () => {
  let sm;
  beforeEach(() => {
    sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' }); // → thinking
    sm.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'y1', name: 'bash', input: {} }] },
    }); // → running
  });

  it('result（非 error）从 running 转换到 completed', () => {
    const result = sm.ingest({ type: 'result', is_error: false });
    expect(result).not.toBeNull();
    expect(result.from).toBe('running');
    expect(result.to).toBe('completed');
    expect(result.reason).toBe('result success');
    expect(sm.current).toBe('completed');
  });

  it('result 不带 is_error 字段（falsy）也转换到 completed', () => {
    const result = sm.ingest({ type: 'result' });
    expect(result.to).toBe('completed');
  });
});

describe('ingest — result → error', () => {
  let sm;
  beforeEach(() => {
    sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' }); // → thinking
  });

  it('result is_error=true 且有 error 字段，转换到 error，reason 含 error 内容', () => {
    const result = sm.ingest({ type: 'result', is_error: true, error: 'timeout' });
    expect(result).not.toBeNull();
    expect(result.to).toBe('error');
    expect(result.reason).toContain('timeout');
    expect(sm.current).toBe('error');
  });

  it('result is_error=true 无 error 字段但有 subtype，reason 含 subtype', () => {
    const result = sm.ingest({ type: 'result', is_error: true, subtype: 'network' });
    expect(result.to).toBe('error');
    expect(result.reason).toContain('network');
  });

  it('result is_error=true 既无 error 也无 subtype，reason 含 unknown', () => {
    const result = sm.ingest({ type: 'result', is_error: true });
    expect(result.to).toBe('error');
    expect(result.reason).toContain('unknown');
  });
});

describe('history 记录', () => {
  it('每次有效转换都追加到 history', () => {
    vi.useFakeTimers();
    const sm = new AgentStateMachine();

    vi.advanceTimersByTime(10);
    sm.ingest({ type: 'system', subtype: 'init' });

    vi.advanceTimersByTime(20);
    sm.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'z1', name: 'bash', input: {} }] },
    });

    vi.advanceTimersByTime(30);
    sm.ingest({ type: 'result', is_error: false });

    const history = sm.transitions;
    expect(history).toHaveLength(3);
    expect(history[0].from).toBe('idle');
    expect(history[0].to).toBe('thinking');
    expect(history[1].from).toBe('thinking');
    expect(history[1].to).toBe('running');
    expect(history[2].from).toBe('running');
    expect(history[2].to).toBe('completed');

    vi.useRealTimers();
  });

  it('transitions 返回拷贝，修改不影响内部 history', () => {
    const sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' });
    const copy = sm.transitions;
    copy.push({ fake: true });
    expect(sm.transitions).toHaveLength(1);
  });

  it('history 超过 100 条时截断为最近 100 条', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const sm = new AgentStateMachine();

    // 产生 150 次 idle→thinking 转换，每次推进 1ms 让 at 可区分，
    // 真正越过 100 条触发源码截断分支（length>100 时 slice(-100)）。
    for (let i = 0; i < 150; i++) {
      sm.state = 'idle';
      vi.advanceTimersByTime(1);
      sm.ingest({ type: 'system', subtype: 'init' }); // idle→thinking，push 一条 history
    }

    const t = sm.transitions;
    // 精确 100：若删掉源码截断逻辑会是 150，此断言能检测回归
    expect(t.length).toBe(100);
    // 保留的是最近 100 条：前 50 条（at 1_000_001..1_000_050）被截掉
    expect(t[0].at).toBe(1_000_051);
    expect(t[99].at).toBe(1_000_150);
    vi.useRealTimers();
  });

  it('history 中每条记录包含 at 时间戳', () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' });
    expect(sm.transitions[0].at).toBe(now);
    vi.useRealTimers();
  });
});

describe('reset', () => {
  it('非 idle 状态调用 reset 后回到 idle，并在 history 中留记录', () => {
    const sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' }); // → thinking
    sm.reset();
    expect(sm.current).toBe('idle');
    const h = sm.transitions;
    expect(h[h.length - 1].to).toBe('idle');
    expect(h[h.length - 1].reason).toBe('manual reset');
  });

  it('已是 idle 时调用 reset 不追加 history', () => {
    const sm = new AgentStateMachine();
    sm.reset(); // 已是 idle
    expect(sm.transitions).toHaveLength(0);
    expect(sm.current).toBe('idle');
  });
});

describe('边界：malformed / 无关 obj', () => {
  let sm;
  beforeEach(() => { sm = new AgentStateMachine(); });

  it('null 输入会抛错（ingest 访问 null.type）', () => {
    expect(() => sm.ingest(null)).toThrow();
  });

  it('空对象不产生转换', () => {
    const result = sm.ingest({});
    expect(result).toBeNull();
    expect(sm.current).toBe('idle');
  });

  it('type 未知字段不产生转换', () => {
    const result = sm.ingest({ type: 'unknown_event', data: 123 });
    expect(result).toBeNull();
  });

  it('assistant 消息 message 无 content 字段不产生转换', () => {
    const result = sm.ingest({ type: 'assistant', message: {} });
    expect(result).toBeNull();
  });

  it('assistant 消息 message 为 null 不产生转换', () => {
    const result = sm.ingest({ type: 'assistant', message: null });
    expect(result).toBeNull();
  });

  it('assistant content 非数组（字符串）不产生转换', () => {
    const result = sm.ingest({ type: 'assistant', message: { content: 'text string' } });
    expect(result).toBeNull();
  });

  it('assistant content 为数组但元素含 null，不产生 TypeError，正常按无 tool_use 处理', () => {
    const result = sm.ingest({
      type: 'assistant',
      message: { content: [null, { type: 'text' }] },
    });
    expect(result).not.toBeNull();
    expect(result.to).toBe('thinking'); // 无有效 tool_use
  });
});

describe('边界：双重 result（completed 后再收 result）', () => {
  it('已 completed 再收 result success，相同状态无转换返回 null', () => {
    const sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' });
    sm.ingest({ type: 'result', is_error: false }); // → completed
    const result = sm.ingest({ type: 'result', is_error: false }); // 已在 completed
    expect(result).toBeNull();
    expect(sm.current).toBe('completed');
  });

  it('已 completed 再收 result error，从 completed 转换到 error', () => {
    const sm = new AgentStateMachine();
    sm.ingest({ type: 'system', subtype: 'init' });
    sm.ingest({ type: 'result', is_error: false }); // → completed
    const result = sm.ingest({ type: 'result', is_error: true, error: 'late error' });
    expect(result).not.toBeNull();
    expect(result.from).toBe('completed');
    expect(result.to).toBe('error');
    expect(sm.current).toBe('error');
  });
});

describe('边界：content 数组无 tool_use（各种非 tool_use 类型）', () => {
  it('content 只含 text + image 类型，转换到 thinking', () => {
    const sm = new AgentStateMachine();
    const result = sm.ingest({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: {} },
        ],
      },
    });
    expect(result.to).toBe('thinking');
    expect(result.reason).toBe('assistant text only');
  });

  it('content 含 tool_result 类型但无 tool_use，转换到 thinking', () => {
    const sm = new AgentStateMachine();
    const result = sm.ingest({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
      },
    });
    expect(result.to).toBe('thinking');
  });
});

describe('完整典型流程：idle→thinking→running→completed', () => {
  it('四步完整流程状态依序正确', () => {
    vi.useFakeTimers();
    const sm = new AgentStateMachine();

    vi.advanceTimersByTime(100);
    const r1 = sm.ingest({ type: 'system', subtype: 'init' });
    expect(r1.to).toBe('thinking');

    vi.advanceTimersByTime(100);
    const r2 = sm.ingest({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'a', name: 'bash', input: {} }] },
    });
    expect(r2.to).toBe('running');

    vi.advanceTimersByTime(100);
    const r3 = sm.ingest({ type: 'result', is_error: false });
    expect(r3.to).toBe('completed');

    expect(sm.transitions).toHaveLength(3);
    // at 时间戳单调递增
    const [t0, t1, t2] = sm.transitions;
    expect(t1.at).toBeGreaterThanOrEqual(t0.at);
    expect(t2.at).toBeGreaterThanOrEqual(t1.at);

    vi.useRealTimers();
  });
});
