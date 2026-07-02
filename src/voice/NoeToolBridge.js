// NoeToolBridge — 对话工具桥：把对话大脑接到 Noe 的真工具上。
// 治"只会说不会做"：听懂查询意图 → 后端确定性地真跑只读工具(ToolRegistry.invoke) → 把真实结果
// 注入上下文 → 大脑据实回答，而不是空口"我去查/稍等"。不依赖本地模型的 function calling(gemma 弱)，
// 靠确定性意图路由 + 后端执行，本地模型也可靠。查询类(只读)在这；动作类(改/发/控制)走授权链另接。

// 查询意图 → 对应只读工具（ToolRegistry 已注册 handler，见 builtinReadonlyTools.js）
const QUERY_INTENTS = [
  { tool: 'noe.memory.recall', re: /记得|记忆|我.*(说过|提过|讲过|喜欢|讨厌)|之前.*(说|聊|提)|关于我|我的(习惯|偏好|情况)/, label: '我的记忆' },
  { tool: 'noe.fs.hybrid_search', re: /文件|文档|资料|笔记|代码|图片|哪个(文件|文档)|存(在|到)哪|找.*(文件|文档|资料|图|表|代码)/, label: '本地文件' },
  { tool: 'noe.kg.search', re: /关系|关联|相关|图谱|跟.*有关|和.*的联系/, label: '知识图谱' },
];

// 从一句话里提取检索关键词（去标点 + 常见疑问/虚词噪声）
export function extractQuery(text) {
  const cleaned = String(text || '')
    .replace(/[？?。.！!，,、；;：:~"'「」（）()【】]/g, ' ')
    .replace(/(请帮我|帮我|麻烦你|你能不能|能不能|你知道|知道|告诉我|查一下|找一下|查查|帮忙|一下|是谁|是什么|有没有|有哪些|怎么|为什么|什么|哪些|哪个|在哪|多少|的|了|吗|呢|啊|呀|我|你|他|她|它|请|去|到)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 60);
}

// 跑查询类工具，返回可注入 system 的"真实结果"文本块；没命中/没结果返回空串。
export async function runQueryTools(transcript, { toolRegistry, projectId = 'noe', limit = 5, maxLen = 900 } = {}) {
  if (!toolRegistry?.invoke) return '';
  const text = String(transcript || '');
  const matched = QUERY_INTENTS.filter((it) => it.re.test(text));
  if (!matched.length) return '';
  const q = extractQuery(text) || text.slice(0, 40);
  if (!q) return '';
  const hits = [];
  for (const it of matched) {
    try {
      const r = await toolRegistry.invoke(it.tool, { args: { q, projectId, limit } });
      if (r?.ok && r.result != null) {
        const payload = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
        if (payload && payload !== '[]' && payload !== '{}') hits.push(`· ${it.label}（${it.tool}）：${payload.slice(0, maxLen)}`);
      }
    } catch { /* 单个工具失败不阻断对话 */ }
  }
  if (!hits.length) return '';
  return '【已实时查到（下面是后端工具真执行的结果，必须据此回答；结果已经在这里，绝不要说"我去查/稍等/马上找"）】\n'
    + hits.join('\n');
}
