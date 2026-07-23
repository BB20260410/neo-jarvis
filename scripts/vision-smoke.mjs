// 视觉感知烟测：截屏 → 本地 VLM 看懂（全本地零 token）
import { ScreenCapturer } from '../src/vision/ScreenCapturer.js';
import { LocalVlmClient } from '../src/vision/LocalVlmClient.js';

const cap = new ScreenCapturer();
const vlm = new LocalVlmClient();

if (!(await vlm.available())) {
  console.log('⚠ LM Studio 视觉模型不可用（127.0.0.1:1234），先加载 Noe 当前主脑模型');
  process.exit(2);
}
try {
  const t0 = Date.now();
  const frame = await cap.capture();
  console.log(`✓ 截屏成功 ${frame.length} 字节`);
  const desc = await vlm.describe(frame);
  console.log(`🖼️ Noe 看到（${((Date.now() - t0) / 1000).toFixed(1)}s，零 token）:`);
  console.log(desc);
} catch (e) {
  console.log('✗ 失败:', e.message);
  process.exit(1);
}
