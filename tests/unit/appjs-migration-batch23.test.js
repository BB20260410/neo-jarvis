// @ts-check
// 第三波手术 第23批 结构级防回归：cognitive-people.js（510 行）拆出 cognitive-people-capture.js
// 刀法（照 /tmp/noe-maps3/webMap.json 最小刀 A）：
//   ① cognitive-people.js 保名保入口：状态属主（people/editingId/modelSettings…）+渲染+CRUD+installSheet/installEntry+顶层 boot+setInterval 全留守
//   ② cognitive-people-capture.js：采集/识别无状态部分（installStyle CSS/dataUrlFromFile/cameraDataUrl/
//      fetchInsightFaceEmbedding/pickFaceFromImage/recordVoice）以纯函数 export，ES module 真 import 不走 window 桥
//   模型开关门控（读 modelSettings 状态）留主文件 insightFaceEmbedding 薄包装
// 风格对齐 appjs-migration-batch22.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const PEOPLE_FILE = 'public/src/web/cognitive-people.js';
const CAPTURE_FILE = 'public/src/web/cognitive-people-capture.js';
const RESEARCH_FILE = 'public/src/web/cognitive-research.js';
const HTML_FILE = 'public/cognitive.html';

const CAPTURE_FNS = ['installStyle', 'dataUrlFromFile', 'cameraDataUrl', 'fetchInsightFaceEmbedding', 'pickFaceFromImage', 'recordVoice'];

describe('cognitive 拆分第23批（cognitive-people 采集/识别无状态部分外迁）', () => {
  const peopleSrc = read(PEOPLE_FILE);
  const captureSrc = read(CAPTURE_FILE);
  const researchSrc = read(RESEARCH_FILE);
  const htmlSrc = read(HTML_FILE);

  it('两文件均 <500 行（工程硬规则）', () => {
    expect(peopleSrc.split('\n').length, `${PEOPLE_FILE} 行数超标`).toBeLessThan(500);
    expect(captureSrc.split('\n').length, `${CAPTURE_FILE} 行数超标`).toBeLessThan(500);
  });

  it('主文件经真 import（带 v 参防缓存混跑）引入采集六函数，capture 全部 export', () => {
    expect(peopleSrc).toContain("from './cognitive-people-capture.js?v=people-capture-20260611a'");
    for (const fn of CAPTURE_FNS) {
      expect(peopleSrc, `主文件 import 缺 ${fn}`).toMatch(new RegExp(`import \\{[^}]*\\b${fn}\\b[^}]*\\}`));
      expect(captureSrc, `capture 缺 export ${fn}`).toMatch(new RegExp(`export (async )?function ${fn}\\(`));
    }
    // 主文件不再持有这些函数定义（import 标识符不算）
    for (const fn of CAPTURE_FNS) {
      expect(peopleSrc, `主文件残留 function ${fn}(`).not.toContain(`function ${fn}(`);
    }
  });

  it('模型开关门控留主文件：insightFaceEmbedding 薄包装读 modelSettings 后转调 fetchInsightFaceEmbedding', () => {
    expect(peopleSrc).toContain('async function insightFaceEmbedding(imageDataUrl) {');
    expect(peopleSrc).toContain("if (modelSettings?.face?.enabled === false || window.cogFaceModelEnabled === false) throw new Error('人脸识别模型已关闭');");
    expect(peopleSrc).toContain('return fetchInsightFaceEmbedding(imageDataUrl);');
    // capture 是无状态文件：不读 modelSettings（注释提及不算，抓 `modelSettings?.`/`modelSettings =` 真实取用）、不持有人物库状态、无顶层 boot 副作用
    expect(captureSrc).not.toMatch(/modelSettings\?*\s*[.=]/);
    expect(captureSrc).not.toContain('let people');
    expect(captureSrc).not.toContain('setInterval');
    expect(captureSrc).not.toContain('installSheet');
    expect(captureSrc).not.toContain('installEntry');
    expect(captureSrc).not.toContain('cogReloadPeople');
  });

  it('主文件顶层 boot 原样留守：installStyle/installSheet/installEntry/render/loadPeople + 单一 setInterval + window.cogReloadPeople', () => {
    expect(peopleSrc).toContain('installStyle();\ninstallSheet();\ninstallEntry();\nrender();\nloadPeople();');
    expect(peopleSrc).toContain('window.cogReloadPeople = loadPeople;');
    expect(peopleSrc).toContain('setInterval(autoIdentifyCamera, 6500);');
    expect(peopleSrc.match(/setInterval\(/g)?.length, '主文件应只有一个 setInterval').toBe(1);
    // window.cogLastPersonMatch 写入位置不动（对外 API，历史消费可能在 noe 端）
    expect(peopleSrc.match(/window\.cogLastPersonMatch = /g)?.length).toBe(2);
  });

  it('缓存链全 bump：research import people 带新 v 参，cognitive.html 入口 script 带 v 参且旧参已清', () => {
    expect(researchSrc).toContain("import './cognitive-people.js?v=people-split-20260611a';");
    // html 入口 v 参是移动指针（后续批次会继续 bump），只钉「带 v 参 + 旧参清掉」，精确值由各批次自己的测试钉
    expect(htmlSrc).toMatch(/\/src\/web\/cognitive-research\.js\?v=/);
    expect(htmlSrc).not.toContain('v=safari-camera-20260608a');
  });
});
