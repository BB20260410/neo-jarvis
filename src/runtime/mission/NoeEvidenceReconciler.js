// @ts-check
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeResolve(root, ref = '') {
  const file = resolve(root, clean(ref, 1000));
  // L2-L4 修复：startsWith(root) 缺尾分隔符，兄弟同前缀目录（/x-foo vs /x）会误判在沙箱内。
  return (file === root || file.startsWith(root + sep)) ? file : null;
}

function readable(root, ref) {
  const file = safeResolve(root, ref);
  if (!file) return false;
  try { return existsSync(file) && statSync(file).isFile(); } catch { return false; }
}

export class NoeEvidenceReconciler {
  constructor({ root = process.cwd() } = {}) {
    this.root = resolve(root);
  }

  verify({ evidenceRefs = [], requiredEvidenceRefs = [] } = {}) {
    const refs = [...new Set(asArray(evidenceRefs).map((ref) => clean(ref, 1000)).filter(Boolean))];
    const required = asArray(requiredEvidenceRefs).map((ref) => clean(ref, 1000)).filter(Boolean);
    const missingRequired = required.filter((ref) => !refs.includes(ref) || !readable(this.root, ref));
    const readableRefs = refs.filter((ref) => readable(this.root, ref));
    return {
      ok: missingRequired.length === 0 && readableRefs.length > 0,
      evidenceRefs: refs,
      readableRefs,
      missingRequired,
      blockers: [
        ...(readableRefs.length === 0 ? ['no_readable_evidence'] : []),
        ...missingRequired.map((ref) => `required_evidence_missing:${ref}`),
      ],
    };
  }

  compareClaimsToEvidence({ taskOutput = {}, verification = {} } = {}) {
    const blockers = [];
    if (taskOutput.claimedSucceeded === true && !verification.ok) blockers.push('cloud_claimed_success_without_evidence');
    if (taskOutput.provenance === 'cloud' && asArray(taskOutput.evidenceRefs).length === 0) blockers.push('cloud_output_missing_evidence_refs');
    if (taskOutput.truncated === true || taskOutput.finishReason === 'length') blockers.push('cloud_output_truncated');
    return { ok: blockers.length === 0, blockers };
  }

  decideSucceeded({ taskOutput = {}, evidenceRefs = [], requiredEvidenceRefs = [] } = {}) {
    const verification = this.verify({ evidenceRefs, requiredEvidenceRefs });
    const claims = this.compareClaimsToEvidence({ taskOutput, verification });
    const blockers = [...verification.blockers, ...claims.blockers];
    return {
      ok: blockers.length === 0,
      status: blockers.length === 0 ? 'succeeded' : 'blocked',
      blockers: [...new Set(blockers)],
      verification,
      claims,
    };
  }
}
