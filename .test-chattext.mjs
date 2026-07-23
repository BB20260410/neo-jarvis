// 验证 VoiceSession 重构：chatText 文字分支通 + chat 语音分支未破坏 + noTts 不烧 MiniMax 配额
// 全 mock 依赖，不连真实 ollama/MiniMax，不依赖运行中的 panel。
import { VoiceSession } from './src/voice/VoiceSession.js';

const fakeAdapter = { chat: async () => ({ reply: '你好主人，我在听呢。' }) };
const deps = {
  brainRouter: { route: () => ({ adapterId: 'ollama', fallbacks: [], tier: 'local' }) },
  getAdapter: () => fakeAdapter,
  memory: { write: () => {} },
  ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from(''), format: 'mp3' }) },
};

let fail = 0;
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fail++; } };

// 1) 文字分支：跳过 STT，走 _respond
const r1 = await new VoiceSession(deps).chatText('你好', { noTts: true });
console.log('chatText →', JSON.stringify(r1));
check(r1.ok && r1.reply && r1.transcript === '你好', 'chatText 应返回 ok+reply+transcript');
check(!r1.audioBase64, 'noTts 时 chatText 不应合成音频（省配额）');

// 2) 语音分支：mock STT，确认重构后 chat 仍走 _respond
const r2 = await new VoiceSession({ ...deps, sttClient: { transcribe: async () => '今天天气怎么样' } }).chat(Buffer.from('x'), { noTts: true });
console.log('chat →', JSON.stringify(r2));
check(r2.ok && r2.reply && r2.transcript === '今天天气怎么样', 'chat 重构后应仍返回 ok+reply+transcript');

// 3) 空文本守卫
const r3 = await new VoiceSession(deps).chatText('   ', { noTts: true });
check(!r3.ok && r3.error === '空消息', 'chatText 空文本应被守卫');

console.log(fail === 0 ? '\n✅ VoiceSession 重构验证通过（文字通 / 语音未破坏 / noTts 省配额 / 空守卫）' : `\n❌ ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
