// @ts-check
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { redactSensitiveText } from '../NoeContextScrubber.js';

const DEFAULT_MAX_BYTES = 32_000;
const SECRET_PATH_RE = /(^|\/)(\.env|\.npmrc|\.netrc|.*token.*|.*cookie.*|.*oauth.*|.*secret.*|owner-token\.txt|room-adapters\.json)$/i;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function safeResolve(root, ref = '') {
  const file = resolve(root, String(ref || ''));
  // L2-L4 修复：startsWith(root) 缺尾分隔符，兄弟同前缀目录（/x-foo vs /x）会误判在沙箱内。
  return (file === root || file.startsWith(root + sep)) ? file : null;
}

function blockedPath(ref = '') {
  const normalized = String(ref || '').replace(/\\/g, '/');
  return SECRET_PATH_RE.test(normalized);
}

function readSafeFile(root, ref, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const file = safeResolve(root, ref);
  const relativeRef = file ? rel(root, file) : clean(ref, 1000);
  if (!file || blockedPath(relativeRef)) return { ref: relativeRef, included: false, reason: 'blocked_secret_or_outside_path' };
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return { ref: relativeRef, included: false, reason: 'not_readable_file' };
    const raw = readFileSync(file, 'utf8');
    const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes;
    const slice = truncated ? raw.slice(0, maxBytes) : raw;
    const redacted = redactSensitiveText(slice);
    return {
      ref: relativeRef,
      included: true,
      sha256: sha256(raw),
      bytes: Buffer.byteLength(raw, 'utf8'),
      truncated,
      text: redacted,
      redacted: redacted !== slice,
    };
  } catch (error) {
    return { ref: relativeRef, included: false, reason: clean(error?.message || error, 500) };
  }
}

export function assembleEvidencePack({
  root = process.cwd(),
  mission = {},
  state = {},
  files = [],
  snippets = [],
  testOutputs = [],
  failureLogs = [],
  gitDiff = '',
  constraints = [],
  evidenceRefs = [],
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const resolvedRoot = resolve(root);
  const fileEntries = asArray(files).map((ref) => readSafeFile(resolvedRoot, ref, { maxBytes }));
  const syntheticSections = {
    snippets: asArray(snippets).map((item) => clean(typeof item === 'string' ? item : JSON.stringify(item), 4000)),
    testOutputs: asArray(testOutputs).map((item) => clean(typeof item === 'string' ? item : JSON.stringify(item), 4000)),
    failureLogs: asArray(failureLogs).map((item) => clean(typeof item === 'string' ? item : JSON.stringify(item), 4000)),
    gitDiff: clean(gitDiff, 20_000),
    constraints: asArray(constraints).map((item) => clean(item, 1000)),
  };
  const redactionHits = [
    ...fileEntries.filter((entry) => entry.redacted).map((entry) => entry.ref),
    ...Object.entries(syntheticSections)
      .filter(([, value]) => JSON.stringify(value).includes('[redacted'))
      .map(([key]) => key),
  ];
  return {
    schemaVersion: 1,
    kind: 'noe_evidence_pack',
    missionId: clean(mission.missionId || state.missionId || 'unknown', 160),
    objective: clean(mission.objective, 4000),
    leader: clean(mission.leader || 'local', 80),
    cloudContextPolicy: clean(mission.cloudContextPolicy || 'redacted_brief', 80),
    files: fileEntries,
    ...syntheticSections,
    evidenceRefs: [...new Set([...asArray(evidenceRefs), ...asArray(state.evidenceRefs)].map((ref) => clean(ref, 1000)).filter(Boolean))],
    redactionReport: {
      policy: 'strict',
      secretValuesReturned: false,
      redactedSections: [...new Set(redactionHits)],
      blockedFiles: fileEntries.filter((entry) => !entry.included).map((entry) => ({ ref: entry.ref, reason: entry.reason })),
    },
  };
}

export function validateEvidencePack(pack = {}) {
  const errors = [];
  if (pack.kind !== 'noe_evidence_pack') errors.push('evidence_pack_kind_invalid');
  if (!clean(pack.missionId, 160)) errors.push('evidence_pack_mission_id_required');
  if (pack.redactionReport?.secretValuesReturned !== false) errors.push('evidence_pack_secret_values_returned');
  const serialized = JSON.stringify(pack);
  if (/sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|Authorization:\s*Bearer\s+(?!\[redacted\])\S+/i.test(serialized)) {
    errors.push('evidence_pack_contains_secret_like_value');
  }
  return { ok: errors.length === 0, errors };
}

export function serializeEvidencePack(pack = {}) {
  const validation = validateEvidencePack(pack);
  return { ok: validation.ok, validation, text: `${JSON.stringify(pack, null, 2)}\n` };
}
