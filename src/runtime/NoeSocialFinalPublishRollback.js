import { redactSensitiveText } from './NoeContextScrubber.js';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
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

function isUnverifiedPostPublishUrl({ platform = 'generic', url = '' } = {}) {
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

export function validateFinalPublishPostPublishProbe({ platform = 'generic', postPublishProbe = null, publishPerformed = false } = {}) {
  const postUrlRef = redactBrowserUrl(postPublishProbe?.url || '');
  const postTitleRef = clean(postPublishProbe?.title || '', 500);
  const urlUnverified = Boolean(postUrlRef) && isUnverifiedPostPublishUrl({ platform, url: postUrlRef });
  const errors = [
    ...(publishPerformed === true ? [] : ['final_publish_not_confirmed']),
    ...(postUrlRef ? [] : ['post_publish_url_missing']),
    ...(postTitleRef ? [] : ['post_publish_title_missing']),
    ...(urlUnverified ? ['post_publish_url_not_verified'] : []),
  ];
  return {
    ok: errors.length === 0,
    errors,
    postUrlRef,
    postTitleRef,
    secretValuesReturned: false,
  };
}

// Builds rollback evidence after a final-publish attempt. Pure — no I/O, no side effects.
// Rollback evidence is only `verified` when the publish was confirmed AND post-publish URL/title
// were captured; otherwise it stays `pending_probe`. The follow-up actions route through the
// social rollback evidence gate (noe.freedom.social.rollback.evidence_gate), which itself never
// performs a real deletion/hide/recall.
export function buildFinalPublishRollbackEvidence({ platform, postPublishProbe = null, publishPerformed = false, args = {} } = {}) {
  const probeValidation = validateFinalPublishPostPublishProbe({ platform, postPublishProbe, publishPerformed });
  const postUrlRef = probeValidation.postUrlRef;
  const postTitleRef = probeValidation.postTitleRef;
  const missingEvidence = probeValidation.errors;
  return {
    requiredAfterPublish: true,
    strategy: clean(args.rollbackStrategy || 'open platform post manager and delete, hide, or correct the published item if needed', 1200),
    platform,
    publishConfirmed: publishPerformed === true,
    evidenceStatus: missingEvidence.length ? 'pending_probe' : 'verified',
    missingEvidence,
    postUrlRef,
    postTitleRef,
    postPublishProbe: postPublishProbe ? {
      ok: postPublishProbe.ok !== false,
      url: postUrlRef,
      title: postTitleRef,
      capturedBy: 'noe.freedom.social.final_publish.execute',
    } : null,
    verifiedByNoe: missingEvidence.length === 0,
    secretValuesReturned: false,
    nextFreedomActions: [
      { stepId: 'post_publish_state_probe', actionId: 'noe.freedom.browser.state_probe', mode: 'developer_unrestricted', args: { includeAll: true } },
      { stepId: 'rollback_evidence_gate', actionId: 'noe.freedom.social.rollback.evidence_gate', mode: 'developer_unrestricted', args: { platform, requireVerifiedEvidence: true, rollbackEvidenceRef: { evidenceStatus: missingEvidence.length ? 'pending_probe' : 'verified', postUrlRef, postTitleRef, verifiedByNoe: missingEvidence.length === 0 } } },
    ],
  };
}
