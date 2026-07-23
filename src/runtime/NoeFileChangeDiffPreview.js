// @ts-check
/**
 * File-change diff preview for product confirm / review surfaces.
 * Wraps squad-diff-preview with path + structured hunks for UI and tests.
 */
import { diff as squadDiff } from '../room/learned/squad-diff-preview.js';

export const FILE_DIFF_PREVIEW_SCHEMA = 'neo.file-change.diff-preview.v1';

/**
 * Parse unified string into simple hunk line objects.
 * @param {string} unified
 */
export function parseUnifiedHunks(unified = '') {
  /** @type {{ type: 'context'|'add'|'remove', text: string }[]} */
  const lines = [];
  for (const raw of String(unified || '').split('\n')) {
    if (!raw && lines.length === 0) continue;
    if (raw.startsWith('+')) lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ type: 'remove', text: raw.slice(1) });
    else if (raw.startsWith(' ')) lines.push({ type: 'context', text: raw.slice(1) });
    else if (raw.length) lines.push({ type: 'context', text: raw });
  }
  return lines;
}

/**
 * Build a file-change diff preview.
 * @param {{ path?: string, before?: string, after?: string, oldContent?: string, newContent?: string }} input
 */
export function buildFileChangeDiffPreview(input = {}) {
  const path = String(input.path || input.filePath || 'unknown').slice(0, 500);
  const before = input.before ?? input.oldContent ?? '';
  const after = input.after ?? input.newContent ?? '';
  const d = squadDiff(before, after);
  const hunks = parseUnifiedHunks(d.unified);
  return {
    schema: FILE_DIFF_PREVIEW_SCHEMA,
    path,
    added: Number(d.added) || 0,
    removed: Number(d.removed) || 0,
    unified: String(d.unified || ''),
    hunks,
    hasChanges: (Number(d.added) || 0) + (Number(d.removed) || 0) > 0,
    emptyStub: false,
  };
}

/**
 * Assert preview is real (not a stub string).
 * @param {ReturnType<typeof buildFileChangeDiffPreview>} preview
 */
export function isRealDiffPreview(preview) {
  if (!preview || preview.emptyStub === true) return false;
  if (!preview.path) return false;
  if (!preview.unified && !(preview.hunks || []).length) return false;
  // stub markers
  if (/^TODO|stub|not implemented/i.test(String(preview.unified || ''))) return false;
  return true;
}
