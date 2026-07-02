#!/usr/bin/env node
// @ts-check
// 向量索引孤儿 / 废维清理 CLI（P8）。
//
// 删 embeddings(kind='noe_memory') 里：① 孤儿（ref_id 指向 hidden=1 的 noe_memory 行）
// ② 废维（dim != 库内主导维度，如 hash-128 残留 vs ollama-1024）。复用 VectorIndex.deleteEmbedding。
//
// 默认 **dry-run**（只报将删数，不动库）。--apply 才真删。
// 默认目标库 = ~/.noe-panel/panel.db（或 $PANEL_DB_PATH）；--db <path> 指定其他库（如副本演练）。
//
// 用法：
//   node scripts/noe-vector-orphan-cleanup.mjs                 # dry-run 默认库
//   node scripts/noe-vector-orphan-cleanup.mjs --db /tmp/p8b.db          # dry-run 副本
//   node scripts/noe-vector-orphan-cleanup.mjs --db /tmp/p8b.db --apply  # 副本真删（演练）
//   node scripts/noe-vector-orphan-cleanup.mjs --apply        # live 点火（留 owner/主线，先备份 .backup）
//   --kind <k>        默认 noe_memory
//   --expected-dim N  显式当维（默认按主导维度自适应）
//   --json            只输出 JSON
//
// 安全：--apply 真删前会打印目标库路径与将删数；演练务必用副本（脚本不替你 .backup live，由调用方先备份）。

import { close, getDb, initSqlite } from '../src/storage/SqliteStore.js';
import { deleteEmbedding } from '../src/embeddings/VectorIndex.js';
import { cleanupVectorOrphans } from '../src/memory/NoeVectorOrphanCleanup.js';

function parseArgs(argv) {
  const a = { apply: false, kind: 'noe_memory', db: undefined, expectedDim: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--apply') a.apply = true;
    else if (t === '--json') a.json = true;
    else if (t === '--kind') a.kind = String(argv[++i]);
    else if (t === '--db') a.db = String(argv[++i]);
    else if (t === '--expected-dim') a.expectedDim = Number(argv[++i]);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // initSqlite(path) 显式切库——deleteEmbedding 内部 getDb() 随之命中该库（见 SqliteStore 切库语义），
  //   保证 --db 副本演练绝不误删 live。无 --db 时走默认库（dry-run 安全；--apply 才是 live 点火）。
  if (args.db) initSqlite(args.db);
  else initSqlite();
  const db = getDb();

  // 单次复用同一句柄：扫描 + （apply 时）删除。deleteFn 注入真 deleteEmbedding。
  const res = cleanupVectorOrphans({
    db,
    kind: args.kind,
    apply: args.apply,
    expectedDim: Number.isFinite(args.expectedDim) ? args.expectedDim : undefined,
    deleteFn: deleteEmbedding,
  });

  const targetDb = args.db || process.env.PANEL_DB_PATH || '~/.noe-panel/panel.db (默认)';
  const out = {
    ok: true,
    targetDb,
    mode: args.apply ? 'apply' : 'dry-run',
    kind: res.scan.kind,
    expectedDim: res.scan.expectedDim,
    expectedDimSource: res.scan.expectedDimSource,
    dimDistribution: res.scan.dimDistribution,
    counts: res.scan.counts,
    applied: res.applied,
    attempted: res.attempted,
    deleted: res.deleted,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`[向量孤儿清理] 目标库=${targetDb}  kind=${res.scan.kind}  当维=${res.scan.expectedDim}(${res.scan.expectedDimSource})`);
    console.log(`  维度分布: ${res.scan.dimDistribution.map((d) => `${d.dim}:${d.c}`).join(', ')}`);
    if (res.scan.expectedDimSource === 'skipped-multidim') {
      console.log('  ⚠ 多维分布且未指定 --expected-dim:已跳过废维清理(防 auto 误删当维),仅清孤儿。清废维请加 --expected-dim <当维>。');
    }
    const c = res.scan.counts;
    console.log(`  总向量=${c.total}  孤儿=${c.orphan}  废维=${c.dead_dim}  重叠=${c.overlap}  将删(去重)=${c.to_delete}  删后留存=${c.keep}`);
    console.log(`  注: 废维里指向 visible 行=${c.dead_dim_pointing_visible}（删后由 backfill 以当维重嵌，可逆）`);
    if (args.apply) {
      console.log(`  [APPLY] 已尝试删 ${res.attempted} 条，实删 ${res.deleted} 行。`);
    } else {
      console.log('  [DRY-RUN] 未删任何向量。加 --apply 才真删（live 点火留 owner/主线，先 .backup）。');
    }
  }

  close();
  return out;
}

main().catch((e) => { console.error('[向量孤儿清理] 失败:', e?.message || e); process.exitCode = 1; });
