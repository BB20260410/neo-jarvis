// @ts-check
// NoeSelfEvolutionSubstanceGate 单测——盖章点"实质闸"：堵自指/零外部价值 cycle 盖 complete（owner 拍板的假进化最小真拦）。
// 生产实锤(17 cycle)：假进化 complete 的 touchedFiles 全是 docs/skill-cards/*.md(自我表彰技能卡) 或空(啥没改)。
// 引用性闸(NoeSelfEvolutionValueGate)"无源文件就放行"漏了这两类→本闸补：空/纯自指产物→真拦(block complete)。
// flag NOE_SELFEVO_SUBSTANCE_GATE 默认 OFF，与引用性闸互补(它管 src/.js 零引用孤儿，本闸管空/纯自指文档)。
import { describe, expect, it, afterEach } from 'vitest';
import { evaluateNoeSelfEvolutionSubstanceGate } from '../../src/room/NoeSelfEvolutionSubstanceGate.js';

const on = { enabled: true };

describe('evaluateNoeSelfEvolutionSubstanceGate', () => {
  afterEach(() => { delete process.env.NOE_SELFEVO_SUBSTANCE_GATE; });

  it('flag OFF（默认）→ skipped 零回归', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [] } }, { enabled: false });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('空 touchedFiles → no_substantive_change（啥没改还想盖 complete）', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [] } }, on);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('no_substantive_change');
  });

  it('缺 implementation / touchedFiles → no_substantive_change', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({}, on).ok).toBe(false);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: {} }, on).ok).toBe(false);
  });

  it('纯 docs/skill-cards 技能卡 → self_referential_only（自我表彰仪式，生产实锤）', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['docs/skill-cards/voice-link-self-repair.md'] } }, on);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('self_referential_only');
  });

  it('纯临时日志（.log/.tmp 后缀，任何路径）→ self_referential_only（造 ValueError 日志产物）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['/tmp/valueerror.log'] } }, on).ok).toBe(false);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['err.log', 'run.tmp'] } }, on).ok).toBe(false);
  });

  it('真实 src/.js 功能改动 → 放行（有外部价值）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['src/runtime/NoeContentRedaction.js'] } }, on).ok).toBe(true);
  });

  it('真实 docs（非 skill-cards 系统文档）→ 放行（有价值，不误伤）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['docs/RUNBOOK_出事翻这页.md'] } }, on).ok).toBe(true);
  });

  it('混合：skill-card + 真实 src/.js → 放行（有真实改动就不算自指）', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['docs/skill-cards/x.md', 'src/loop/ActPipeline.js'] } }, on);
    expect(r.ok).toBe(true);
  });

  it('反向 probe：null / 非对象 cycle → 安全不抛（判 no_substantive_change）', () => {
    expect(() => evaluateNoeSelfEvolutionSubstanceGate(null, on)).not.toThrow();
    expect(evaluateNoeSelfEvolutionSubstanceGate(null, on).ok).toBe(false);
    expect(evaluateNoeSelfEvolutionSubstanceGate(42, on).ok).toBe(false);
  });

  it('touchedFiles 非数组 → 当空处理 → no_substantive_change', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: 'x' } }, on).ok).toBe(false);
  });

  it('env 门控：opts.enabled 未传 → 读 NOE_SELFEVO_SUBSTANCE_GATE（未设=skip 零回归）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [] } }).skipped).toBe(true);
    process.env.NOE_SELFEVO_SUBSTANCE_GATE = '1';
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [] } }).ok).toBe(false);
  });

  it('checked 字段回填触碰文件（可审计）+ skipped=false', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['docs/skill-cards/x.md'] } }, on);
    expect(r.skipped).toBe(false);
    expect(r.checked).toEqual(['docs/skill-cards/x.md']);
  });

  // 判据审 CRITICAL：touchedFiles 含 null/undefined 元素 → 不能被骗放行（map(String).filter(Boolean) 顺序 bug：String(null)='null' 非空被留下）
  it('判据审 CRITICAL：touchedFiles 全 null/undefined/空白元素 → no_substantive_change（不被骗放行）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [null, undefined] } }, on).ok).toBe(false);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['  ', null] } }, on).ok).toBe(false);
  });

  // 判据审 MEDIUM：TMP_PATH_RE 不能误伤源码里的 cache/temp 目录段（src/cache 是真实模块非临时产物）
  it('判据审 MEDIUM：真实源码 src/cache/ src/runtime/cache → 放行（不误伤含 cache 段的源码）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['src/cache/CacheManager.js'] } }, on).ok).toBe(true);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['src/runtime/cache/Store.js'] } }, on).ok).toBe(true);
  });

  // 判据审 MEDIUM：真实图像资产不靠扩展名误杀（截图靠临时路径拦，不靠 .png 后缀）
  it('判据审 MEDIUM：真实图像资产 public/logo.png assets/x.png → 放行（不误伤真实资产）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['public/logo.png'] } }, on).ok).toBe(true);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['assets/sprite.png'] } }, on).ok).toBe(true);
  });

  // 临时路径下的截图/日志仍拦（造 ValueError 产物特征：/tmp 或 /var/folders 下的日志截图）
  it('临时路径下截图/日志（/tmp//var/folders）→ self_referential_only（造 ValueError 产物）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['/tmp/screenshot.png', '/tmp/err.log'] } }, on).ok).toBe(false);
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['/var/folders/zz/T/valueerror.log'] } }, on).ok).toBe(false);
  });

  // 判据审 MEDIUM：touchedFiles 元素是 {path}/{file} 对象（PostReview 路径可能传对象数组）→ 解包识别不漏判
  it('判据审 MEDIUM：touchedFiles 元素是 {path} 对象 → 解包识别（不漏判 skill-card）', () => {
    expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: [{ path: 'docs/skill-cards/x.md' }] } }, on).ok).toBe(false);
  });

  // 已知局限（备书·整体+判据审）：掺砂绕过——任一非自指文件即放行整批。纯路径判据拿不到 diff 内容，识别不了
  //   空文件/垃圾改动。真根治需 diff-size/外部 outcome 判据。此测试明确记录"已知会放行"作为 reward-hacking 边界备书（非疏忽）。
  it('已知局限（备书）：skill-cards + 1 个真 src 改动 → 放行（掺砂绕过=纯路径判据能力边界，真根治需 diff-size 判据）', () => {
    const r = evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: ['docs/skill-cards/x.md', 'docs/skill-cards/y.md', 'src/util/junk.js'] } }, on);
    expect(r.ok).toBe(true);
  });

  // 已知覆盖面边界（复查子代理实测·备书）：本闸只认 docs/skill-cards/ 为自指文档，非该目录的产物（docs/其它.md /
  //   output/*.json / notes/*.txt / CHANGELOG.md）全放行——假进化把自吹产物写到非 skill-cards 目录即绕过(比掺砂更现实)。
  //   不扩判据拦"纯文档/产物"是有意取舍：会误伤真实文档进化(改 RUNBOOK/CHANGELOG/写 API 文档)。真根治靠 diff-size/外部
  //   outcome 判据(让飞轮产 holdout 证据)，非路径黑名单扩词。此测试明确记录这道逃逸门为能力边界(非疏漏)。
  it('已知覆盖面边界（备书）：非 docs/skill-cards 的文档/产物 → 放行（避免误伤真文档进化；真根治需 diff-size/outcome）', () => {
    for (const tf of [['docs/我进化了.md'], ['output/result.json'], ['CHANGELOG.md']]) {
      expect(evaluateNoeSelfEvolutionSubstanceGate({ implementation: { touchedFiles: tf } }, on).ok).toBe(true);
    }
  });
});
