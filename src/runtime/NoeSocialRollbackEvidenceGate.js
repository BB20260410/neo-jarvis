import { existsSync } from 'node:fs';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { NOE_SOCIAL_PLATFORM_PRESETS } from './NoeSocialPublishWorkflow.js';
import {
  readNoeConsensusLedgerFile,
  resolveNoeConsensusRef,
  validateNoeConsensusLedgerArtifact,
} from '../room/NoeConsensusLedger.js';

// Evidence + execution planning for social post rollback (delete / hide / recall / correct).
// The evidence gate remains side-effect-free. Real platform rollback is exposed through the
// separate `noe.freedom.social.rollback.execute` tool, so ledgers can distinguish "gate opened"
// from "Noe actually clicked a destructive platform control".
export const NOE_SOCIAL_ROLLBACK_EVIDENCE_GATE_SCHEMA_VERSION = 1;

export const NOE_SOCIAL_ROLLBACK_ACTIONS = ['delete', 'hide', 'recall', 'correct'];

const ROLLBACK_ACTION_ALIASES = {
  delete: 'delete',
  remove: 'delete',
  trash: 'delete',
  hide: 'hide',
  private: 'hide',
  unlist: 'hide',
  self_only: 'hide',
  recall: 'recall',
  withdraw: 'recall',
  unpublish: 'recall',
  takedown: 'recall',
  correct: 'correct',
  edit: 'correct',
  fix: 'correct',
  amend: 'correct',
};

const ROLLBACK_ACTION_LABELS = {
  delete: '删除帖子',
  hide: '设为仅自己可见 / 隐藏',
  recall: '撤回 / 下架',
  correct: '修正已发布内容',
};

const ROLLBACK_ACTION_HINTS = {
  delete: ['删除', '删除作品', '删除笔记', '移除', 'delete', 'remove'],
  hide: ['仅自己可见', '私密', '隐藏', '设为私密', 'hide', 'private', 'unlist'],
  recall: ['撤回', '下架', '取消发布', 'unpublish', 'withdraw', 'recall'],
  correct: ['编辑', '修改', '保存修改', 'edit', 'correct', 'save'],
};

const ROLLBACK_CONFIRM_HINTS = ['确认', '确定', '继续', '删除', '下架', '撤回', 'confirm', 'ok', 'yes'];

// Post / manager hosts the rollback target URL may legitimately live on, per platform.
const PLATFORM_POST_HOSTS = {
  douyin: ['creator.douyin.com', 'www.douyin.com', 'v.douyin.com'],
  xiaohongshu: ['creator.xiaohongshu.com', 'www.xiaohongshu.com', 'xiaohongshu.com'],
  bilibili: ['member.bilibili.com', 'www.bilibili.com', 'space.bilibili.com'],
  wechat_channels: ['channels.weixin.qq.com'],
  youtube: ['studio.youtube.com', 'www.youtube.com', 'youtube.com'],
};

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    const raw = JSON.stringify(value);
    // Guard against oversized untrusted evidence payloads (consistent with backend body caps).
    if (raw.length > 65_536) return {};
    return JSON.parse(redactSensitiveText(raw));
  } catch {
    return {};
  }
}

function redactBrowserUrl(value = '') {
  const text = clean(value, 2000);
  if (!text) return '';
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    if (/token|key|secret|password|auth|session|credential|jwt/i.test(url.hash)) {
      url.hash = '#[redacted]';
    }
    return clean(url.toString(), 2000);
  } catch {
    return text.replace(/([?&#][^=]*?(?:token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  }
}

function normalizePlatform(value = '') {
  return clean(value || 'generic', 80).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_') || 'generic';
}

function normalizeAction(value = '') {
  const key = clean(value, 60).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return ROLLBACK_ACTION_ALIASES[key] || key || '';
}

function platformPreset(platform = '') {
  return NOE_SOCIAL_PLATFORM_PRESETS[normalizePlatform(platform)] || {
    label: 'Generic Social Platform',
    creatorUrl: '',
    expectedHosts: [],
    tags: ['generic', 'social'],
  };
}

function hostFromUrl(value = '') {
  try {
    return new URL(clean(value, 2000)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isUnverifiedRollbackTargetUrl({ platform = 'generic', url = '' } = {}) {
  const text = clean(url, 2000);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (normalizePlatform(platform) === 'xiaohongshu') {
      return host === 'creator.xiaohongshu.com' && /^\/publish(?:\/|$)/.test(path);
    }
  } catch {
    return true;
  }
  return false;
}

function comparablePostUrl(value = '') {
  try {
    const parsed = new URL(clean(value, 2000));
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return clean(value, 2000);
  }
}

function evidenceObject(value) {
  const evidence = safeJson(value);
  return evidence && Object.keys(evidence).length ? evidence : null;
}

function normalizeHints(value, fallback = []) {
  const source = Array.isArray(value) ? value : clean(value, 2000) ? [value] : fallback;
  return [...new Set(source.map((item) => clean(item, 120)).filter(Boolean))].slice(0, 20);
}

function postHostsFor(platform = '') {
  const preset = platformPreset(platform);
  return PLATFORM_POST_HOSTS[normalizePlatform(platform)]
    || (Array.isArray(preset.expectedHosts) ? preset.expectedHosts : []);
}

// Evidence required before any destructive platform rollback may be considered.
export function evaluateRollbackEvidenceGate({ args = {} } = {}) {
  const platform = normalizePlatform(args.platform || 'generic');
  const postHosts = postHostsFor(platform);
  const action = normalizeAction(args.rollbackAction || args.action || args.intent || 'delete');

  const targetSource = args.targetPostUrl || args.targetUrl || args.postUrl || '';
  const targetUrlRef = redactBrowserUrl(targetSource);
  const targetHost = hostFromUrl(targetSource);
  const hostAllowed = postHosts.length ? postHosts.includes(targetHost) : Boolean(targetHost);
  const targetLooksPublished = Boolean(targetUrlRef) && !isUnverifiedRollbackTargetUrl({ platform, url: targetUrlRef });

  // postPublishEvidence may also arrive as the prior final-publish rollbackEvidence ref.
  const evidenceRef = evidenceObject(args.rollbackEvidenceRef);
  const postPublish = evidenceObject(args.postPublishEvidence || args.postPublishProbe) || (evidenceRef ? {
    url: evidenceRef.postUrlRef,
    title: evidenceRef.postTitleRef,
    capturedBy: 'social_publish_rollback_evidence',
  } : null);
  const postPublishUrlRef = redactBrowserUrl(postPublish?.url || '');
  const postPublishTitleRef = clean(postPublish?.title || '', 500);
  const postPublishLooksPublished = Boolean(postPublishUrlRef) && !isUnverifiedRollbackTargetUrl({ platform, url: postPublishUrlRef });
  const targetMatchesPostPublish = !targetUrlRef
    || !postPublishUrlRef
    || comparablePostUrl(targetUrlRef) === comparablePostUrl(postPublishUrlRef);
  const evidenceStatus = clean(evidenceRef?.evidenceStatus || args.evidenceStatus || '', 80);
  const verifiedByNoe = evidenceRef?.verifiedByNoe === true || args.verifiedByNoe === true;
  const requireVerified = args.requireVerifiedEvidence === true;

  const beforeAction = evidenceObject(args.beforeActionEvidence || args.preActionEvidence);
  const beforeCapturedBy = clean(beforeAction?.capturedBy || beforeAction?.source || '', 200);
  // Strong proof = a captured DOM digest or screenshot ref; url/title alone are weak (easily forged).
  const beforeStrongProof = clean(beforeAction?.domDigest || beforeAction?.screenshotRef || '', 2000);
  const beforeWeakProof = clean(beforeAction?.url || beforeAction?.title || '', 2000);

  const errors = [
    ...(NOE_SOCIAL_ROLLBACK_ACTIONS.includes(action) ? [] : [`rollback_unsupported_action:${action || 'none'}`]),
    ...(targetUrlRef ? [] : ['rollback_target_post_url_required']),
    ...(targetUrlRef && !hostAllowed ? ['rollback_target_host_mismatch'] : []),
    ...(targetUrlRef && hostAllowed && !targetLooksPublished ? ['rollback_target_not_published_post_url'] : []),
    ...(postPublish ? [] : ['rollback_post_publish_evidence_required']),
    ...(postPublish && !postPublishUrlRef ? ['rollback_post_publish_url_missing'] : []),
    ...(postPublish && !postPublishTitleRef ? ['rollback_post_publish_title_missing'] : []),
    ...(postPublish && postPublishUrlRef && !postPublishLooksPublished ? ['rollback_post_publish_url_not_published_post'] : []),
    ...(postPublish && postPublishUrlRef && targetUrlRef && !targetMatchesPostPublish ? ['rollback_target_post_publish_url_mismatch'] : []),
    ...(requireVerified && evidenceStatus !== 'verified' && verifiedByNoe !== true ? ['rollback_evidence_not_verified'] : []),
    ...(beforeAction ? [] : ['rollback_before_action_evidence_required']),
    ...(beforeAction && !(beforeCapturedBy && beforeStrongProof) ? ['rollback_before_action_evidence_incomplete'] : []),
  ];

  // Advisory warnings (do not block) — surfaced to the UI for human review.
  const warnings = [
    ...(beforeAction && beforeCapturedBy && !beforeStrongProof && beforeWeakProof ? ['rollback_before_action_evidence_weak'] : []),
    ...(postPublish && evidenceStatus === 'pending_probe' && !requireVerified ? ['rollback_post_publish_evidence_pending_probe'] : []),
  ];

  return {
    required: true,
    ok: errors.length === 0,
    action,
    platform,
    target: { url: targetUrlRef, host: targetHost, hostAllowed, allowedHosts: postHosts },
    postPublishEvidence: postPublish ? {
      url: postPublishUrlRef,
      title: postPublishTitleRef,
      capturedBy: clean(postPublish.capturedBy || '', 200),
      evidenceStatus,
      verifiedByNoe,
    } : null,
    beforeActionEvidence: beforeAction ? {
      capturedBy: beforeCapturedBy,
      hasStrongProof: Boolean(beforeStrongProof),
      hasProof: Boolean(beforeStrongProof || beforeWeakProof),
      url: redactBrowserUrl(beforeAction.url || ''),
      title: clean(beforeAction.title || '', 500),
    } : null,
    errors,
    warnings,
    secretValuesReturned: false,
  };
}

// Destructive authorization may ONLY come from trusted deps injected by the backend
// (permission result / consensus ledger) — never from the untrusted args payload.
//
// NOTE (P3 stage, intentional safe default): the freedom adapter execute path does NOT inject
// Destructive approval must come from trusted route/session authorization, trusted deps, or a
// consensus ledger ref. Untrusted args payloads are deliberately ignored here, so a caller cannot
// authorize a delete/hide/recall by smuggling flags inside tool args.
// Task 0.2 Step5: a consensus ledger ref only counts as destructive authorization when it points at
// a REAL ledger file inside the repo that exists, parses, validates and passed (quorum reached).
// An arbitrary non-empty string, a path escaping the repo, a missing file, or a ledger that fails
// validation must NOT authorize a destructive rollback.
function verifyConsensusLedgerRef(ref = '', root = process.cwd()) {
  const text = clean(ref, 1000);
  if (!text) return { valid: false, reason: 'consensus_ledger_ref_missing' };
  let file = '';
  try {
    file = resolveNoeConsensusRef(root, text);
  } catch {
    return { valid: false, reason: 'consensus_ledger_ref_escapes_repo' };
  }
  if (!existsSync(file)) return { valid: false, reason: 'consensus_ledger_file_not_found' };
  let ledger = null;
  try {
    ledger = readNoeConsensusLedgerFile(file);
  } catch {
    return { valid: false, reason: 'consensus_ledger_file_unreadable' };
  }
  let validation = null;
  try {
    validation = validateNoeConsensusLedgerArtifact(ledger, { root });
  } catch {
    return { valid: false, reason: 'consensus_ledger_validation_threw' };
  }
  const passed = validation?.ok === true && validation?.consensus?.ok === true;
  return { valid: passed, reason: passed ? '' : 'consensus_ledger_not_passed' };
}

export function evaluateDestructiveAuthorization({ authorization = {}, deps = {} } = {}) {
  const trusted = (authorization && typeof authorization === 'object' ? authorization : {});
  const fromDeps = (deps && typeof deps.destructiveAuthorization === 'object' ? deps.destructiveAuthorization : {});
  const approvedFromUser = trusted.destructiveActionApproved === true || fromDeps.destructiveActionApproved === true;
  const developerUnrestricted = trusted.mode === 'developer_unrestricted' && trusted.ownerPresent === true;
  const consensusLedgerRef = clean(trusted.consensusLedgerRef || fromDeps.consensusLedgerRef || '', 1000);
  const ledgerRoot = clean(deps.root || trusted.root || fromDeps.root || '', 4000) || process.cwd();
  const consensusLedgerValid = consensusLedgerRef
    ? verifyConsensusLedgerRef(consensusLedgerRef, ledgerRoot).valid
    : false;
  const approved = approvedFromUser || developerUnrestricted || consensusLedgerValid;
  const source = approvedFromUser
    ? clean(trusted.source || fromDeps.source || 'permission_result', 120)
    : developerUnrestricted
    ? 'developer_unrestricted'
    : (consensusLedgerValid ? 'consensus_ledger' : '');
  return {
    approved,
    source,
    // Reflect a *trusted* ledger ref, not merely a non-empty string.
    consensusLedgerRefPresent: consensusLedgerValid,
    errors: approved ? [] : ['rollback_destructive_authorization_required'],
  };
}

function rollbackClickJavascript({ expectedHosts = [], hints = [], action = 'delete' } = {}) {
  return `
(() => {
  const expectedHosts = ${JSON.stringify(expectedHosts)};
  const hints = ${JSON.stringify(hints)};
  const action = ${JSON.stringify(action)};
  const safeString = (value) => { try { return String(value || ''); } catch (_) { return ''; } };
  const host = safeString(location.hostname).toLowerCase();
  const matchesHost = !expectedHosts.length || expectedHosts.some((expected) => host === expected || host.endsWith('.' + expected));
  const textOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.value, el.textContent].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const cssPath = (el) => {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      const tag = safeString(node.tagName).toLowerCase();
      const parent = node.parentElement;
      const siblings = parent ? Array.from(parent.children).filter((item) => item.tagName === node.tagName) : [];
      const index = siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '';
      parts.unshift(tag + index);
      node = parent;
    }
    return parts.join(' > ');
  };
  if (!matchesHost) return { ok: false, error: 'rollback_target_host_mismatch', host, expectedHosts, clicked: false, action };
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], input[type="button"], input[type="submit"], [tabindex], [class*="btn"], [class*="button"]'));
  const target = controls.find((el) => visible(el) && hints.some((hint) => textOf(el).toLowerCase().includes(safeString(hint).toLowerCase())));
  if (!target) return { ok: false, error: 'rollback_control_not_found', host, expectedHosts, clicked: false, action };
  target.click();
  return { ok: true, host, expectedHosts, clicked: true, action, clickedLabel: textOf(target).slice(0, 120), selector: cssPath(target), pageContentReadByNoe: false };
})()
  `.trim();
}

export function buildNoeSocialRollbackExecuteScript({ args = {} } = {}) {
  const platform = normalizePlatform(args.platform || 'generic');
  const action = normalizeAction(args.rollbackAction || args.action || args.intent || 'delete');
  const browserApp = clean(args.browserApp || args.app || 'Google Chrome', 120) || 'Google Chrome';
  const targetUrl = clean(args.targetPostUrl || args.targetUrl || args.postUrl || '', 2000);
  const expectedHosts = postHostsFor(platform);
  const primaryHints = normalizeHints(args.clickHints || args.hints, ROLLBACK_ACTION_HINTS[action] || [action]);
  const confirmHints = normalizeHints(args.confirmHints, ROLLBACK_CONFIRM_HINTS);
  const clickConfirm = args.clickConfirm !== false && action !== 'correct';
  const openWaitSeconds = Math.max(0.1, Math.min(10, Number(args.openWaitSeconds || args.openWaitSec) || 1.2));
  const confirmWaitSeconds = Math.max(0.1, Math.min(10, Number(args.confirmWaitSeconds || args.confirmWaitSec) || 0.8));
  const primaryJs = rollbackClickJavascript({ expectedHosts, hints: primaryHints, action });
  const confirmJs = rollbackClickJavascript({ expectedHosts, hints: confirmHints, action: `${action}:confirm` });
  return `
function parseJson(value) {
  try { return typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { return { ok: false, error: 'json_parse_failed' }; }
}
const appName = ${JSON.stringify(browserApp)};
const targetUrl = ${JSON.stringify(targetUrl)};
const action = ${JSON.stringify(action)};
const app = Application(appName);
app.activate();
const windows = app.windows();
if (!windows.length) throw new Error('browser_window_required');
const tab = windows[0].activeTab();
if (!tab) throw new Error('browser_active_tab_required');
if (targetUrl) {
  try {
    const currentUrl = String(tab.url ? tab.url() : '');
    if (currentUrl !== targetUrl) {
      tab.url = targetUrl;
      delay(${openWaitSeconds});
    }
  } catch (_) {
    tab.url = targetUrl;
    delay(${openWaitSeconds});
  }
}
const beforeRaw = tab.execute({ javascript: "(() => ({ ok: true, url: String(location.href || ''), title: String(document.title || '') }))()" });
const before = parseJson(beforeRaw);
const primary = parseJson(tab.execute({ javascript: ${JSON.stringify(primaryJs)} }));
let confirmation = null;
if (${JSON.stringify(clickConfirm)} && primary && primary.clicked === true) {
  delay(${confirmWaitSeconds});
  confirmation = parseJson(tab.execute({ javascript: ${JSON.stringify(confirmJs)} }));
}
delay(0.4);
const afterRaw = tab.execute({ javascript: "(() => ({ ok: true, url: String(location.href || ''), title: String(document.title || '') }))()" });
const after = parseJson(afterRaw);
JSON.stringify({
  ok: primary && primary.ok !== false && primary.clicked === true,
  app: appName,
  action,
  targetUrl,
  before,
  primary,
  confirmation,
  after,
  rollbackClicked: primary && primary.clicked === true,
  confirmationClicked: confirmation && confirmation.clicked === true,
  pageContentReadByNoe: false,
  cookiesReadByNoe: false,
  passwordReadByNoe: false,
  secretValuesReturned: false
});
  `.trim();
}

export function parseNoeSocialRollbackExecuteOutput(stdout = '') {
  let parsed = null;
  try {
    parsed = JSON.parse(clean(stdout, 50_000));
  } catch {
    return { ok: false, error: 'rollback_execute_output_parse_failed', stdoutReturned: false };
  }
  const action = normalizeAction(parsed.action || '');
  const before = safeJson(parsed.before || {});
  const after = safeJson(parsed.after || {});
  const primary = safeJson(parsed.primary || {});
  const confirmation = parsed.confirmation ? safeJson(parsed.confirmation) : null;
  const rollbackClicked = parsed.rollbackClicked === true || primary.clicked === true;
  const confirmationClicked = parsed.confirmationClicked === true || confirmation?.clicked === true;
  const rollbackVerified = parsed.rollbackVerified === true;
  return {
    ok: parsed.ok === true && rollbackClicked,
    rollbackAction: action,
    targetUrl: redactBrowserUrl(parsed.targetUrl || ''),
    before: { url: redactBrowserUrl(before.url || ''), title: clean(before.title || '', 500) },
    after: { url: redactBrowserUrl(after.url || ''), title: clean(after.title || '', 500) },
    primary: {
      ok: primary.ok !== false,
      clicked: primary.clicked === true,
      clickedLabel: clean(primary.clickedLabel || '', 120),
      selector: clean(primary.selector || '', 1000),
      ...(primary.error ? { error: clean(primary.error, 300) } : {}),
    },
    confirmation: confirmation ? {
      ok: confirmation.ok !== false,
      clicked: confirmation.clicked === true,
      clickedLabel: clean(confirmation.clickedLabel || '', 120),
      selector: clean(confirmation.selector || '', 1000),
      ...(confirmation.error ? { error: clean(confirmation.error, 300) } : {}),
    } : null,
    rollbackClicked,
    confirmationClicked,
    rollbackVerified,
    destructionPerformed: action === 'delete' && rollbackClicked && rollbackVerified,
    externalSideEffectPerformed: rollbackClicked,
    pageContentReadByNoe: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    secretValuesReturned: false,
    stdoutReturned: false,
  };
}

export function buildNoeSocialRollbackInstruction({ platform = 'generic', action = 'delete', targetUrlRef = '', reason = '' } = {}) {
  const preset = platformPreset(platform);
  const actionLabel = ROLLBACK_ACTION_LABELS[action] || action || '操作';
  const reasonText = reason ? `（原因：${clean(reason, 400)}）` : '';
  // Re-redact defensively in case a caller passes a raw (un-redacted) URL.
  const safeTargetUrl = redactBrowserUrl(targetUrlRef);
  return clean(
    `进入 ${preset.label} 创作者中心 → 人工核对已发布帖子 ${safeTargetUrl || '[缺少目标 URL]'} → 由主人确认后执行「${actionLabel}」${reasonText}。`
    + ' Noe 仅生成此指引与证据门控，绝不自动执行删除/隐藏/撤回/修正。',
    1600,
  );
}

// Top-level pure planner. realExecute is intentionally ignored for execution purposes:
// this gate NEVER performs a real rollback. It only reports whether a future, separately
// authorized rollback would be allowed, and surfaces the manual instruction.
export function planNoeSocialRollbackEvidenceGate({ args = {}, authorization = {}, deps = {} } = {}) {
  const gate = evaluateRollbackEvidenceGate({ args });
  const auth = evaluateDestructiveAuthorization({ authorization, deps });
  const blockers = [...gate.errors, ...auth.errors];
  const gateStatus = blockers.length === 0 ? 'open' : 'blocked';
  const reason = clean(args.rollbackReason || args.reason || '', 400);
  const instruction = buildNoeSocialRollbackInstruction({
    platform: gate.platform,
    action: gate.action,
    targetUrlRef: gate.target.url,
    reason,
  });

  return {
    ok: blockers.length === 0,
    schemaVersion: NOE_SOCIAL_ROLLBACK_EVIDENCE_GATE_SCHEMA_VERSION,
    adapter: 'social-rollback-evidence-gate',
    plannedOnly: true,
    dryRunOnly: true,
    executesRealRollback: false,
    gateStatus,
    rollbackAction: gate.action,
    platform: gate.platform,
    platformLabel: platformPreset(gate.platform).label,
    target: gate.target,
    evidenceGate: {
      required: gate.required,
      ok: gate.ok,
      missingEvidence: gate.errors,
      postPublishEvidence: gate.postPublishEvidence,
      beforeActionEvidence: gate.beforeActionEvidence,
    },
    authorization: {
      destructiveActionApproved: auth.approved,
      source: auth.source,
      consensusLedgerRefPresent: auth.consensusLedgerRefPresent,
    },
    rollbackInstructionGenerated: gateStatus === 'open',
    rollbackInstruction: instruction,
    blockers,
    warnings: gate.warnings || [],
    externalSideEffectPerformed: false,
    destructionPerformed: false,
    secretValuesReturned: false,
    authority: {
      canModifyPublishedContent: false,
      canDeleteExternally: false,
      canHideExternally: false,
      canReadSecrets: false,
      bypassesNoeGovernance: false,
    },
    nextFreedomActions: [
      {
        stepId: 'rollback_after_action_state_probe',
        actionId: 'noe.freedom.browser.state_probe',
        mode: 'developer_unrestricted',
        args: { includeAll: true },
      },
      ...(gateStatus === 'open' ? [{
        stepId: 'rollback_execute',
        actionId: 'noe.freedom.social.rollback.execute',
        mode: 'developer_unrestricted',
        args: {
          platform: gate.platform,
          rollbackAction: gate.action,
          targetPostUrl: gate.target.url,
          postPublishEvidence: gate.postPublishEvidence,
          beforeActionEvidence: args.beforeActionEvidence || args.preActionEvidence,
          requireVerifiedEvidence: args.requireVerifiedEvidence === true,
          evidenceStatus: gate.postPublishEvidence?.evidenceStatus || '',
          rollbackReason: reason,
        },
      }] : []),
    ],
  };
}
