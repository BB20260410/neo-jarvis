// @ts-check
// NoePatchTransaction × NoeFuzzyPatchMatcher 接入（opt-in 容漂移 patch）：
//   精确 from 逐字未命中（occ===0）时，flag 开 + fuzzy 唯一定位 → 把 from 重解析为文件内逐字块后照常走既有
//   精确唯一性/apply occApply/secret 铁律；flag 关或 fuzzy 找不到唯一 → 维持原精确失败（不猜）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { NoePatchTransaction } from '../../src/runtime/mission/NoePatchTransaction.js';

// 盘内容：alpha 实现独特（唯一块），beta 无关。
const DISK = `export function alpha(input) {
  const parsed = parseInput(input);
  const result = transform(parsed);
  return result;
}

export function beta(other) {
  return other * 2;
}
`;

// from 与盘的唯一漂移：第 2 行末尾多两个空格 → 逐字 split 不命中，但 fuzzy 行级 trim 后相似度=1.0。
const DRIFTED_FROM = `export function alpha(input) {
  const parsed = parseInput(input);${'  '}
  const result = transform(parsed);
  return result;
}`;

const TO = `export function alpha(input) {
  return fastPath(input);
}`;

const REL = 'output/fuzzy-fixture/sample.js';

function seedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-patch-fuzzy-'));
  const file = join(root, REL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, DISK, 'utf8');
  return { root, file };
}

function replacePlan(from = DRIFTED_FROM, to = TO) {
  return { kind: 'noe_patch_plan', operations: [{ id: 'op-alpha', op: 'replace', path: REL, from, to }] };
}

const roots = [];
function track(root) { roots.push(root); return root; }
afterEach(() => { while (roots.length) { try { rmSync(roots.pop(), { recursive: true, force: true }); } catch {} } });

describe('NoePatchTransaction fuzzy 容漂移接入（opt-in）', () => {
  it('flag OFF（默认）：from 漂移 → 精确失败 patch_replace_from_not_found（零回归）', () => {
    const { root } = seedRoot(); track(root);
    const tx = new NoePatchTransaction({ root, missionId: 'off', patchPlan: replacePlan() });
    const pre = tx.checkPreconditions();
    expect(pre.ok).toBe(false);
    expect(pre.blockers).toContain('patch_replace_from_not_found:op-alpha');
    // OFF 时 apply 也被挡，且绝不写盘（内容仍是原盘）。
    const applied = tx.apply();
    expect(applied.ok).toBe(false);
    expect(applied.status).toBe('blocked');
    expect(readFileSync(join(root, REL), 'utf8')).toBe(DISK);
  });

  it('flag ON：from 漂移但 fuzzy 唯一命中 → apply 成功，且照常写盘（走既有 occApply 铁律）', () => {
    const { root, file } = seedRoot(); track(root);
    const tx = new NoePatchTransaction({ root, missionId: 'on', patchPlan: replacePlan(), fuzzyEnabled: true });
    const pre = tx.checkPreconditions();
    expect(pre.ok).toBe(true);
    const applied = tx.apply();
    expect(applied.ok).toBe(true);
    expect(applied.status).toBe('applied');
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('return fastPath(input);');
    expect(after).not.toContain('transform(parsed)');
    expect(after).toContain('export function beta(other)'); // 无关块不动
  });

  it('flag ON 但 fuzzy 找不到相似块（低于阈值）→ 仍精确失败（不猜）', () => {
    const { root } = seedRoot(); track(root);
    const nonsense = 'export function gamma() {\n  totallyUnrelated();\n  nope();\n}';
    const tx = new NoePatchTransaction({ root, missionId: 'below', patchPlan: replacePlan(nonsense), fuzzyEnabled: true });
    const pre = tx.checkPreconditions();
    expect(pre.ok).toBe(false);
    expect(pre.blockers).toContain('patch_replace_from_not_found:op-alpha');
  });

  it('flag ON 但 fuzzy 多候选歧义 → 仍精确失败（防改错位置）', () => {
    const root = track(mkdtempSync(join(tmpdir(), 'noe-patch-fuzzy-')));
    const dupFile = join(root, REL);
    mkdirSync(dirname(dupFile), { recursive: true });
    // 两个几乎相同的块（不相干区域等高相似）→ fuzzy ambiguous。
    const dupDisk = `function repeat() {
  doStep();
  finish();
}
const filler = 1;
function repeat2() {
  doStep();
  finish();
}
`;
    writeFileSync(dupFile, dupDisk, 'utf8');
    const from = `function repeatX() {
  doStep();${'  '}
  finish();
}`;
    const tx = new NoePatchTransaction({
      root, missionId: 'ambig',
      patchPlan: { kind: 'noe_patch_plan', operations: [{ id: 'op-dup', op: 'replace', path: REL, from, to: 'x' }] },
      fuzzyEnabled: true, fuzzyOptions: { minSimilarity: 0.8 },
    });
    const pre = tx.checkPreconditions();
    expect(pre.ok).toBe(false);
    expect(pre.blockers).toContain('patch_replace_from_not_found:op-dup');
    expect(readFileSync(dupFile, 'utf8')).toBe(dupDisk); // 绝不写盘
  });

  it('env NOE_FUZZY_PATCH=1 驱动同样的容漂移（flag 名对齐），事后还原', () => {
    const { root } = seedRoot(); track(root);
    const prev = process.env.NOE_FUZZY_PATCH;
    process.env.NOE_FUZZY_PATCH = '1';
    try {
      const tx = new NoePatchTransaction({ root, missionId: 'env', patchPlan: replacePlan() });
      expect(tx.checkPreconditions().ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.NOE_FUZZY_PATCH; else process.env.NOE_FUZZY_PATCH = prev;
    }
  });
});
