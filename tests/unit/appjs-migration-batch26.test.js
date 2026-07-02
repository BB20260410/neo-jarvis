// @ts-check
// 第三波手术 第26批 结构级防回归：governance-ui.js（602 行）拆出 governance-review-ui.js
// 刀法（照 /tmp/noe-maps3/webMap.json）：
//   ① governance-ui.js 保名：状态/常量+modal 开关/刷新/队列推进+看板渲染+主渲染绑定+三个 async 动作
//      （approveAndResumeGovernanceRun gate id/sha 双重校验安全关键路径整体不动）+
//      window.PanelGovernance（open/close/refresh API 面一字不变）
//   ② governance-review-ui.js：Preflight/Resume Review 子域 9 函数+bindReviewEvents（command-jump/
//      coverage-filter 两段 review 区绑定随渲染同属主迁出），挂 window.PanelGovernanceReview
// 跨模块契约：agent-graph-ui openGovernanceCenterForAgentRun 调 window.PanelGovernance.open 后
// 探 #governanceCenterBody [data-gov-center-run=]/[data-gov-center-id=]——data-gov-center-* 属性面一字不能变
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MAIN_FILE = 'public/src/web/governance-ui.js';
const REVIEW_FILE = 'public/src/web/governance-review-ui.js';
const ENTRY_FILE = 'public/main.js';

const REVIEW_FNS = [
  'stagedDiffFileMeta', 'governanceCommandKey', 'governanceCommandChips',
  'governanceRiskReasons', 'governanceCoverageExplanations', 'orderedGovernanceReviewFiles',
  'renderGovernanceCoverageFilter', 'renderGovernanceResumeReview', 'renderGovernanceCenterApprovals',
  'bindReviewEvents',
];

describe('governance 拆分第26批（governance-ui review 子域外迁 governance-review-ui）', () => {
  const mainSrc = read(MAIN_FILE);
  const reviewSrc = read(REVIEW_FILE);
  const entrySrc = read(ENTRY_FILE);

  it('两文件均 <500 行（工程硬规则）', () => {
    expect(mainSrc.split('\n').length, `${MAIN_FILE} 行数超标`).toBeLessThan(500);
    expect(reviewSrc.split('\n').length, `${REVIEW_FILE} 行数超标`).toBeLessThan(500);
  });

  it('window.PanelGovernance API 面一字不变（消费者 agent-graph-ui.open 跳转+e2e #btnGovernance）', () => {
    expect(mainSrc).toContain('window.PanelGovernance = { open: openGovernanceCenterModal, close: closeGovernanceCenterModal, refresh: refreshGovernanceCenter };');
  });

  it('review 文件持有全部 10 个函数定义并整体挂 window.PanelGovernanceReview；主文件零残留', () => {
    for (const fn of REVIEW_FNS) {
      expect(reviewSrc, `review 缺 function ${fn}(`).toContain(`function ${fn}(`);
      expect(reviewSrc, `PanelGovernanceReview 挂载缺 ${fn}`).toMatch(new RegExp(`window\\.PanelGovernanceReview = \\{[\\s\\S]*?\\b${fn},`));
      expect(mainSrc, `主文件残留 function ${fn}(`).not.toContain(`function ${fn}(`);
    }
  });

  it('主文件经 window.PanelGovernanceReview 懒解析接 approvals 渲染与 review 区绑定', () => {
    expect(mainSrc).toContain("window.PanelGovernanceReview?.renderGovernanceCenterApprovals?.(sections.approvals || []) || ''");
    expect(mainSrc).toContain('window.PanelGovernanceReview?.bindReviewEvents?.(root);');
    // 迁出的两段绑定主文件零残留（防双绑定双属主）
    expect(mainSrc).not.toContain('data-gov-center-command-jump');
    expect(mainSrc).not.toContain('data-gov-center-coverage-filter');
  });

  it('安全关键路径整体留主文件：approveAndResumeGovernanceRun gate id/sha 双重校验链不动', () => {
    expect(mainSrc).toContain('async function approveAndResumeGovernanceRun(approvalId, runId, btn = null, options = {})');
    expect(mainSrc).toContain("throw new Error('Preflight review gate missing');");
    expect(mainSrc).toContain("throw new Error('Preflight review is not safe to resume');");
    expect(mainSrc).toContain("throw new Error('Preflight review gate changed; refresh and review again');");
    // 绑定仍在主文件（按钮渲染在 review 文件，root 级 querySelectorAll 拾取）
    expect(mainSrc).toContain("root.querySelectorAll('[data-gov-center-approve-resume]')");
    // 只抓代码级定义/调用（approveAndResumeGovernanceRun(），文件头注释提及不算
    expect(reviewSrc, 'review 文件不得持有/调用 approveAndResumeGovernanceRun').not.toMatch(/approveAndResumeGovernanceRun\s*\(/);
  });

  it('跨模块契约属性面在 review 文件一字不变（agent-graph 跳转探针+e2e 1215-1300 行为钉）', () => {
    for (const pin of [
      'data-gov-center-approve-resume=',
      'data-gov-center-run=',
      'data-gov-center-resume-review=',
      'data-gov-center-review-file=',
      'data-gov-center-command-jump=',
      'data-gov-center-command-id=',
      'data-gov-center-coverage-status="all"',
      'data-gov-center-coverage-empty hidden',
      'data-gov-center-coverage-filter',
    ]) {
      expect(reviewSrc, `review 缺契约钉 ${pin}`).toContain(pin);
    }
    expect(reviewSrc).toContain('>批准并续跑</button>');
    expect(reviewSrc).toContain('<span>Preflight Review</span>');
  });

  it('review 文件零共享状态：不读 governanceCenterState，不碰 modal 壳；唯一监听是 boot 壳与 bindReviewEvents 内部', () => {
    expect(reviewSrc).not.toMatch(/\bgovernanceCenterState\s*[.=[]/);
    expect(reviewSrc).not.toContain('#governanceCenterModal');
    expect(reviewSrc).not.toContain('#btnGovernance');
  });

  it('main.js 双 import 带 batch26 缓存串（防新旧混跑）', () => {
    expect(entrySrc).toContain("import './src/web/governance-ui.js?v=appjs-migration-batch26-20260611';");
    expect(entrySrc).toContain("import './src/web/governance-review-ui.js?v=appjs-migration-batch26-20260611';");
  });
});
