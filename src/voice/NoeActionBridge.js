// NoeActionBridge — 对话动作桥：把"说"变成"真做"。
// 安全动作(写自己数据：记记忆、建提醒)→ 后端确定性真执行，再让大脑自然确认；
// 危险动作(改文件 / 发消息 / 控制 app，有外部副作用、碰红线)→ 只识别 + 明确告知"需要你授权/可委托强 AI"，
//   绝不裸执行、也绝不让大脑空口假装已做。

const REMIND_RE = /(提醒我|别让我忘|到(点|时)(叫|提醒)我|定个?(提醒|待办|闹钟)|记得(提醒|叫)我|帮我(记|设)个?(提醒|待办))/;
const REMEMBER_RE = /(记住|记一笔|记下来?|记录下来?|帮我记|存一下|记到(记忆|本子)|你要记得)/;
// 危险动作意图（外部副作用）——识别但不执行
// 危险动作：动词与对象都出现即算（不限中文语序，如"把文件删掉"动词在后）
const DANGER_RES = [
  { kind: '改写/删除文件', test: (s) => /(改|修改|删除|删掉|覆盖|重命名|移动|清空)/.test(s) && /(文件|文档|代码|目录|文件夹)/.test(s) },
  { kind: '发送消息', test: (s) => (/(发|发送|回复|群发|转发)/.test(s) && /(消息|微信|邮件|短信|message|邮箱)/.test(s)) || /发给/.test(s) },
  { kind: '控制应用/系统', test: (s) => (/(打开|关闭|启动|退出|控制|操作)/.test(s) && /(应用|程序|软件|app|浏览器|窗口|网页)/.test(s)) || /帮我(点|操作)/.test(s) },
];

function cleanPayload(s, re) {
  return String(s || '').replace(re, '').replace(/^[，,：:。.、\s的]+/, '').replace(/[？?。.！!~\s]+$/, '').trim().slice(0, 300);
}

// 返回 { type:'remember'|'remind'|'danger', ... } 或 null
export function detectAction(text) {
  const s = String(text || '');
  if (REMIND_RE.test(s)) return { type: 'remind', text: cleanPayload(s, REMIND_RE) };
  if (REMEMBER_RE.test(s)) return { type: 'remember', text: cleanPayload(s, REMEMBER_RE) };
  for (const d of DANGER_RES) if (d.test(s)) return { type: 'danger', kind: d.kind };
  return null;
}

// 执行动作；返回 { ok, reply, executed } 供注入大脑自然回复。危险动作返回 executed:false + 引导。
function cleanRef(value, max = 240) {
  return String(value || '').trim().slice(0, max);
}

function memoryWrite(input, { memory, memoryWriteGate } = {}) {
  if (memoryWriteGate?.commit) return memoryWriteGate.commit(input);
  const written = memory?.write?.(input);
  return written ? { ok: true, memory: written } : { ok: false, memory: null };
}

export async function runAction(action, {
  memory,
  memoryWriteGate = null,
  commitmentStore,
  projectId = 'noe',
  sourceEpisodeId = null,
  evidenceRefs = [],
} = {}) {
  if (!action?.type) return null;

  if (action.type === 'remember') {
    if (!action.text) return { ok: false, executed: false, reply: '你想让我记住什么呀？把内容说清楚我就记下来。' };
    try {
      const source = cleanRef(sourceEpisodeId);
      const refs = Array.isArray(evidenceRefs) ? evidenceRefs.map((ref) => cleanRef(ref)).filter(Boolean) : [];
      const written = memoryWrite({
        projectId,
        scope: 'user',
        sourceType: 'voice_note',
        body: action.text,
        tags: ['user-note'],
        confidence: 0.9,
        ...(source ? { sourceEpisodeId: source } : {}),
        ...(refs.length ? { evidenceRefs: refs } : {}),
      }, { memory, memoryWriteGate });
      if (written?.ok === false) return { ok: false, executed: false, reply: '刚才没记成功，你再说一遍我重记。' };
      return { ok: true, executed: true, reply: `已经真的记到记忆库了：「${action.text}」` };
    } catch { return { ok: false, executed: false, reply: '刚才没记成功，你再说一遍我重记。' }; }
  }

  if (action.type === 'remind') {
    if (!action.text) return { ok: false, executed: false, reply: '要提醒你什么呢？' };
    if (commitmentStore?.add) {
      try { commitmentStore.add({ text: action.text }); return { ok: true, executed: true, reply: `提醒已经真的建好了：「${action.text}」，到点我会主动叫你。` }; }
      catch { /* 落空则退到记忆兜底 */ }
    }
    try {
      const source = cleanRef(sourceEpisodeId);
      const refs = Array.isArray(evidenceRefs) ? evidenceRefs.map((ref) => cleanRef(ref)).filter(Boolean) : [];
      const written = memoryWrite({
        projectId,
        scope: 'user',
        sourceType: 'todo',
        body: `待办：${action.text}`,
        tags: ['todo'],
        ...(source ? { sourceEpisodeId: source } : {}),
        ...(refs.length ? { evidenceRefs: refs } : {}),
      }, { memory, memoryWriteGate });
      if (written?.ok === false) return { ok: false, executed: false, reply: '提醒没设成功，再说一遍。' };
      return { ok: true, executed: true, reply: `这件事我真记进待办了：「${action.text}」。` };
    }
    catch { return { ok: false, executed: false, reply: '提醒没设成功，再说一遍。' }; }
  }

  if (action.type === 'danger') {
    // 不执行、不假装。诚实告知需要授权或委托强 AI。
    return { ok: true, executed: false, reply: `这件事（${action.kind}）会真的动到外部，属于需要主人明确授权的动作。我不会偷偷做、也不会假装做完。你确认要做，我可以走授权流程，或者派 codex/claude 这类有工具权限的 AI 去真执行。` };
  }
  return null;
}
