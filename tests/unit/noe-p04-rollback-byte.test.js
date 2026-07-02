// @ts-check
// P0.4 反向 probe：self-evolution 自改链「rollback 字节级真恢复」。
//
// 被测真实机制：NoePatchTransaction.apply()/rollback()（src/runtime/mission/NoePatchTransaction.js）。
//   apply() 对【已存在文件】把原始内容存进 this.backups.previous；rollback() 必须把该文件写回到
//   原始字节内容，而不是当成新文件删掉。
//
// 反向 probe 精髓（机制被改坏/移除则本测必红）：
//   ① 故意用「修改类 patch（replace） 命中已存在文件」这条危险路径——若 rollback 退化成只会
//      「删新建文件」（即对 existed 文件也走 rmSync 分支），文件会被删掉 → existsSync 红。
//   ② 原始内容含 CRLF + NUL 字节 + 制表 + 尾部空格且无末尾换行——若 rollback 用了有损捕获/写回
//      （归一化换行、trim、补末尾换行、或根本没存 previous），恢复后字节就不等于原始 → Buffer.compare 红。
//   全程不 mock 被测类，注入式只给 root(mkdtempSync 真隔离) + nowMs，真在磁盘上 apply→rollback。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoePatchTransaction } from '../../src/runtime/mission/NoePatchTransaction.js';

// 字节级「难恢复」原始内容：CRLF、NUL、制表、尾部空格、且无末尾换行。
// 这些都能无损 utf8 往返（已实测），所以真机制能恢复到逐字节一致；任何有损改写都会破坏它。
const ORIGINAL = Buffer.from('alpha\r\nMARK\x00beta\tgamma   ', 'binary');
const REL_PATH = 'src/runtime/_p04_existing_target.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noe-p04-rollback-byte-'));
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** 在隔离 root 内放一个已存在的目标文件，写入精确原始字节。 */
function seedExistingFile() {
  const abs = join(root, REL_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, ORIGINAL); // 写 Buffer，逐字节落盘
  // 自检前提：种子文件确实是我们要的字节，且确实已存在（probe 的「已存在文件」前提成立）。
  expect(existsSync(abs)).toBe(true);
  expect(Buffer.compare(readFileSync(abs), ORIGINAL)).toBe(0);
  return abs;
}

/** 构造一个对【已存在文件】的修改类（replace）事务，注入隔离 root。 */
function modifyTx() {
  return new NoePatchTransaction({
    root,
    missionId: 'p04-rollback-byte',
    nowMs: () => 0,
    patchPlan: {
      kind: 'noe_patch_plan',
      operations: [{
        id: 'op-modify-existing',
        op: 'replace',
        path: REL_PATH,
        from: 'MARK\x00beta\tgamma',
        to: 'TOTALLY_DIFFERENT_PAYLOAD',
      }],
    },
  });
}

describe('NoePatchTransaction rollback 字节级真恢复 (P0.4 反向 probe)', () => {
  it('对已存在文件的修改 patch：rollback 后逐字节恢复原始内容（含 CRLF/NUL/尾空格/无末换行）', () => {
    const abs = seedExistingFile();
    const tx = modifyTx();

    const applied = tx.apply();
    expect(applied).toMatchObject({ ok: true, status: 'applied' });

    // 正向前提：apply 确实改坏了文件（否则下面的恢复断言会是假绿）。
    const afterApply = readFileSync(abs);
    expect(Buffer.compare(afterApply, ORIGINAL)).not.toBe(0);
    expect(afterApply.toString('utf8')).toContain('TOTALLY_DIFFERENT_PAYLOAD');

    const result = tx.rollback();

    // 反向断言①：恢复后文件必须逐字节 == 原始。
    //   若 rollback 机制被改坏（没存 previous / 有损写回 / 走错「删新文件」分支致文件不存在
    //   → readFileSync 直接抛错），这条立刻红。
    const restored = readFileSync(abs);
    expect(Buffer.compare(restored, ORIGINAL)).toBe(0);

    // 反向断言②（区分「恢复已存在文件」与「删除新建文件」两条分支）：
    //   restored 列表里该文件必须以 restore 形态出现，且【绝不能】带 :removed_new_file 后缀。
    //   若回滚把已存在文件误当新文件删除，这里会出现 removed_new_file → 红。
    expect(result).toMatchObject({ ok: true, status: 'rolled_back' });
    expect(result.restored).toContain(REL_PATH);
    expect(result.restored).not.toContain(`${REL_PATH}:removed_new_file`);
  });

  it('反向断言③：rollback 后已存在文件依然存在（绝不被当新文件删除）', () => {
    const abs = seedExistingFile();
    const tx = modifyTx();

    expect(tx.apply()).toMatchObject({ ok: true, status: 'applied' });
    expect(existsSync(abs)).toBe(true); // apply 是修改，不应删除

    tx.rollback();

    // 机制失效会触发红：若 rollback 对 existed 文件错走 rmSync 分支，文件会消失。
    expect(existsSync(abs)).toBe(true);
  });

  it('对照组（防假绿）：新建文件的 patch rollback 走的是「删除」分支，与上面的修改恢复分支不同', () => {
    // 这条用于锁住「两条分支确实不同」：新文件 rollback 应删除并标 removed_new_file，
    // 从而证明上面修改场景里出现的 restore 形态不是巧合/恒真。
    const newRel = 'src/runtime/_p04_brand_new_file.js';
    const abs = join(root, newRel);
    expect(existsSync(abs)).toBe(false); // 前提：原本不存在

    const tx = new NoePatchTransaction({
      root,
      missionId: 'p04-new-file',
      nowMs: () => 0,
      patchPlan: {
        kind: 'noe_patch_plan',
        operations: [{ id: 'op-new', op: 'write_file', path: newRel, content: 'fresh content\n' }],
      },
    });

    expect(tx.apply()).toMatchObject({ ok: true, status: 'applied' });
    expect(existsSync(abs)).toBe(true);

    const result = tx.rollback();
    // 新文件分支：删除 + removed_new_file 标记（与修改恢复分支正交）。
    expect(existsSync(abs)).toBe(false);
    expect(result.restored).toContain(`${newRel}:removed_new_file`);
  });
});
