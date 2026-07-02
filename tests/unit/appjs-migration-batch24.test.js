// @ts-check
// 第三波手术 第24批 结构级防回归：cognitive-research.js（501 行）拆出 cognitive-identity-bridge.js
// 刀法（照 /tmp/noe-maps3/webMap.json）：
//   ① cognitive-research.js 保名保 cognitive.html 入口：import 装配头+token/工具+研究/搜索功能+boot 装配
//   ② cognitive-identity-bridge.js：identityModelSettings+window.cog* 身份 API 面单一属主+
//      installOwnerGateUI/installBargeThresholdUI/installOwnerIdentityUI+installIdentityFetchBridge（fetch monkey-patch 唯一属主）
//   msg/stream 单一来源留 ①，boot 期经 initIdentityBridgeUi 注入 ②（避免 ①↔② import 成环）；api/readJson ② 自带副本（家族先例）
// 关键活性契约：installIdentityFetchBridge 必须被 ① boot 调用，否则 fetch 桥静默失效（机制存在≠活着）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const RESEARCH_FILE = 'public/src/web/cognitive-research.js';
const BRIDGE_FILE = 'public/src/web/cognitive-identity-bridge.js';
const HTML_FILE = 'public/cognitive.html';

const BRIDGE_INSTALLS = ['initIdentityBridgeUi', 'installIdentityFetchBridge', 'installOwnerGateUI', 'installBargeThresholdUI', 'installOwnerIdentityUI'];

// window.cog* 跨文件契约（消费者：cognitive-people.js 事件回调期 + cognitive.html setVision/VAD）
const COG_API = [
  'window.cogSetIdentityModels = setIdentityModels;',
  'window.cogCurrentFaceEmbeddingPayload = ',
  'window.cogCurrentFaceEmbedding = ',
  'window.cogFaceEmbeddingFromImageFile = faceEmbeddingFromImageFile;',
  "document.documentElement.dataset.cogFaceBridge = '1';",
];

describe('cognitive 拆分第24批（cognitive-research 身份桥外迁 cognitive-identity-bridge）', () => {
  const researchSrc = read(RESEARCH_FILE);
  const bridgeSrc = read(BRIDGE_FILE);
  const htmlSrc = read(HTML_FILE);

  it('两文件均 <500 行（工程硬规则）', () => {
    expect(researchSrc.split('\n').length, `${RESEARCH_FILE} 行数超标`).toBeLessThan(500);
    expect(bridgeSrc.split('\n').length, `${BRIDGE_FILE} 行数超标`).toBeLessThan(500);
  });

  it('research 经真 import（带 v 参）引入五个 install/init，bridge 全部 export；身份块零残留', () => {
    expect(researchSrc).toContain("from './cognitive-identity-bridge.js?v=identity-bridge-20260611a'");
    for (const fn of BRIDGE_INSTALLS) {
      expect(researchSrc, `research import 缺 ${fn}`).toMatch(new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\}`));
      expect(bridgeSrc, `bridge 缺 export ${fn}`).toMatch(new RegExp(`export function ${fn}\\(`));
      expect(researchSrc, `research 残留 function ${fn}(`).not.toContain(`function ${fn}(`);
    }
    // 身份/人脸声纹桥函数群整体迁出（research 不再持有定义）
    for (const gone of ['applyIdentityModelSettings', 'setIdentityModels', 'faceEmbeddingFromSource', 'faceEmbeddingPayloadFromCamera', 'recordVoiceSample', 'ownerStatusText', 'detectFaceBox', 'insightFaceEmbeddingFromImage', 'let identityModelSettings']) {
      expect(researchSrc, `research 残留 ${gone}`).not.toMatch(new RegExp(`(function |let )?${gone}\\s*[(=]`));
    }
  });

  it('window.cog* 身份 API 面与 fetch 桥守卫单一属主在 bridge（跨文件契约一字不变）', () => {
    for (const pin of COG_API) expect(bridgeSrc, `bridge 缺 ${pin}`).toContain(pin);
    expect(bridgeSrc).toContain('window.cogFaceModelEnabled = true; window.cogVoiceModelEnabled = true; window.cogVoiceEngine = \'campplus\';');
    expect(bridgeSrc).toContain('if (window.__cogIdentityFetchBridge) return;');
    expect(bridgeSrc).toContain("document.documentElement.dataset.cogIdentityFetchBridge = '1';");
    expect(bridgeSrc).toContain("url.includes('/api/noe/voice/chat')");
    // research 端零残留（防双属主双 patch）
    for (const gone of ['__cogIdentityFetchBridge', 'cogFaceBridge', 'window.cogSetIdentityModels =', 'window.cogCurrentFaceEmbedding']) {
      expect(researchSrc, `research 残留 ${gone}`).not.toContain(gone);
    }
  });

  it('boot 活性接线：msg/stream 注入在前，install 顺序原样（fetch 桥最早，抽屉项插入顺序契约不乱）', () => {
    expect(researchSrc).toContain('initIdentityBridgeUi({ msg, stream });');
    const order = ['initIdentityBridgeUi({ msg, stream });', 'installIdentityFetchBridge();', 'installNoeUiSignalLifecycle();', 'installCompactToolbar();', 'installOwnerGateUI();', 'installBargeThresholdUI();', 'installOwnerIdentityUI();'];
    let last = -1;
    for (const call of order) {
      const idx = researchSrc.indexOf(call);
      expect(idx, `boot 缺调用 ${call}`).toBeGreaterThan(last);
      last = idx;
    }
    // bridge 端注入槽：默认 noop，注入仅接受函数
    expect(bridgeSrc).toContain('export function initIdentityBridgeUi(');
    expect(bridgeSrc).toMatch(/let msg = \(\) => \{\};\nlet stream = \(\) => \{\};/);
    // installNoeUiSignalLifecycle named import 关系保住（map 钉）
    expect(researchSrc).toContain("import { installNoeUiSignalLifecycle } from './noe-ui-signals.js?v=ui-signals-20260608a';");
  });

  it('缓存链 bump：cognitive.html 入口 script 带 identity-bridge v 参', () => {
    expect(htmlSrc).toContain('/src/web/cognitive-research.js?v=identity-bridge-20260611a');
  });
});
