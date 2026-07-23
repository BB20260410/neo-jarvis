// 生成认知界面科幻视频背景（MiniMax 海螺 Hailuo-2.3 文生视频）→ public/assets/cog-bg.mp4
// 用户已授权烧配额；克制：只生 1 个 6 秒视频。run: node --env-file=.env .gen-cog-video.mjs
import fs from 'node:fs';

const KEY = process.env.MINIMAX_API_KEY;
const GROUP = process.env.MINIMAX_GROUP_ID || '';
const BASE = 'https://api.minimaxi.com/v1';
if (!KEY) { console.error('缺 MINIMAX_API_KEY'); process.exit(1); }

// 立体能量核心氛围（刻意区别 BaiLongma 的二维节点图）；无文字无人物，适合 UI 背景循环
const prompt = process.env.COG_VIDEO_PROMPT || '电影级科幻抽象画面：画面正中悬浮一颗缓缓脉动的发光能量核心，深蓝与品紫色调，核心向外辐射旋转的半透明全息数据圆环与细密金色粒子流光，背景是深邃宇宙与缓缓流动的星云尘埃，神经网络般的光纹向四周缓慢延展，冷青色辉光弥漫，镜头极缓慢向核心推进，氛围深邃神秘高级，无任何文字、无人物、无具体物体，纯抽象科技能量场，画面流畅适合循环。[Push in]';
const MODEL = process.env.COG_VIDEO_MODEL || 'MiniMax-Hailuo-2.3';
const RES = process.env.COG_VIDEO_RES || '768P';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

console.log(`[1/3] 提交生成 model=${MODEL} res=${RES} dur=6 ...`);
const sub = await fetch(`${BASE}/video_generation`, { method: 'POST', headers: H, body: JSON.stringify({ model: MODEL, prompt, duration: 6, resolution: RES }) });
const subd = await sub.json().catch(() => ({}));
if (subd?.base_resp && subd.base_resp.status_code !== 0) { console.error('提交失败:', subd.base_resp.status_code, subd.base_resp.status_msg); process.exit(1); }
const taskId = subd.task_id;
if (!taskId) { console.error('无 task_id:', JSON.stringify(subd).slice(0, 300)); process.exit(1); }
console.log('  task_id =', taskId);

console.log('[2/3] 轮询（每 10s，视频生成约 1-5 分钟，不设超时）...');
let fileId = null, n = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 10000));
  n++;
  const q = await fetch(`${BASE}/query/video_generation?task_id=${taskId}`, { headers: H });
  const qd = await q.json().catch(() => ({}));
  const st = qd.status || '?';
  console.log(`  [${n * 10}s] status=${st}`);
  if (st === 'Success') { fileId = qd.file_id; break; }
  if (st === 'Fail') { console.error('生成失败:', JSON.stringify(qd).slice(0, 300)); process.exit(1); }
}
console.log('  file_id =', fileId);

console.log('[3/3] 取下载地址 + 下载 ...');
const ru = GROUP ? `${BASE}/files/retrieve?GroupId=${GROUP}&file_id=${fileId}` : `${BASE}/files/retrieve?file_id=${fileId}`;
const rr = await fetch(ru, { headers: H });
const rd = await rr.json().catch(() => ({}));
const url = rd?.file?.download_url;
if (!url) { console.error('拿不到 download_url（可能需要 MINIMAX_GROUP_ID）。file_id=' + fileId + ' 已生成，配 GroupId 后可重新 retrieve 不重复扣费。返回:', JSON.stringify(rd).slice(0, 300)); process.exit(2); }
console.log('  download_url ok');
const v = await fetch(url);
const buf = Buffer.from(await v.arrayBuffer());
fs.mkdirSync('public/assets', { recursive: true });
fs.writeFileSync('public/assets/cog-bg.mp4', buf);
console.log(`✅ 已保存 public/assets/cog-bg.mp4 (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
