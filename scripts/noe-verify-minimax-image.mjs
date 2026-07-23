#!/usr/bin/env node
// 真实验证 MiniMaxImageClient 端到端出图（剥壳后首调，确认 API 形状/endpoint 对得上）。
// key 走 resolver、不打印 key；图存 /tmp（临时验证，不放桌面、不进仓）。失败如实报错不伪装。

import { writeFileSync, mkdirSync } from 'node:fs';
import { MiniMaxImageClient } from '../src/media/MiniMaxImageClient.js';
import { resolveNoeProviderSecret } from '../src/secrets/NoeProviderSecrets.js';

const s = resolveNoeProviderSecret('minimax');
if (!s?.ok) { console.log('❌ minimax key 未配'); process.exit(1); }

// 对齐 M3 chat 成功的国内站点（api.minimax.chat）；可用 env 覆盖切国际站
const baseUrl = process.env.MINIMAX_IMAGE_ENDPOINT || 'https://api.minimax.chat/v1/image_generation';
const client = new MiniMaxImageClient({ apiKey: s.value, baseUrl });

const prompt = '一只戴着宇航员头盔的橘猫，扁平插画风格，明亮配色，居中构图';
const t0 = Date.now();
try {
  const r = await client.generate(prompt, { aspectRatio: '1:1', responseFormat: 'base64' });
  const img = r.images?.[0] || {};
  mkdirSync('/tmp/noe-image-test', { recursive: true });
  if (img.base64) {
    const buf = Buffer.from(img.base64, 'base64');
    const p = '/tmp/noe-image-test/astronaut-cat.png';
    writeFileSync(p, buf);
    console.log(`✅ 出图成功(base64): ${p}  ${buf.length} bytes  ${Date.now() - t0}ms  endpoint=${baseUrl}`);
  } else if (img.url) {
    console.log(`✅ 出图成功(url): ${img.url}  ${Date.now() - t0}ms  endpoint=${baseUrl}`);
  } else {
    console.log('⚠️ 返回无图', JSON.stringify(r).slice(0, 200));
  }
} catch (e) {
  console.log(`❌ 出图失败: ${String(e?.message || e).slice(0, 300)}  (${Date.now() - t0}ms, endpoint=${baseUrl})`);
  process.exit(1);
}
