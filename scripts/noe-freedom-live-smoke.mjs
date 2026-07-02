#!/usr/bin/env node
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../src/runtime/NoeSocialPublishQueue.js';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || process.env.PANEL_PORT || 51835);
const REPORT_DIR = join(process.cwd(), 'output', 'noe-freedom-live');
const REPORT = join(REPORT_DIR, `freedom-live-${Date.now()}.json`);
const LATEST_REPORT = join(REPORT_DIR, 'latest.json');

function clean(value = '', max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1' };
  for (const arg of argv) {
    if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'freedom-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  return out;
}

function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: String(process.env.NOE_OWNER_TOKEN).trim(), source: 'env', policyBlocked: false, reason: '' };
  const tokenPath = join(homedir(), '.noe-panel', 'owner-token.txt');
  if (!existsSync(tokenPath)) return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  try { return { token: readFileSync(tokenPath, 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' }; } catch { return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not readable' }; }
}

function requestJson(path, { method = 'GET', body = null, token = '' } = {}) {
  return new Promise((resolve) => {
    const headers = body ? { 'Content-Type': 'application/json' } : {};
    if (token) headers['X-Panel-Owner-Token'] = token;
    const req = http.request({
      host: HOST,
      port: PORT,
      path,
      method,
      headers,
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode, bodyPrefix: clean(text, 500) });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', (error) => resolve({ error: clean(error?.message || error, 500) }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function hasAll(source = [], expected = []) {
  return expected.every((item) => source.includes(item));
}

function summarizeFinalPublish(result = {}) {
  const runtimeEvidence = result.json?.runtime?.priorStageEvidence || {};
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    priorStageEvidence: {
      required: runtimeEvidence.required === true,
      ok: runtimeEvidence.ok === true,
      requiredStages: Array.isArray(runtimeEvidence.requiredStages) ? runtimeEvidence.requiredStages : [],
      completedStages: Array.isArray(runtimeEvidence.completedStages) ? runtimeEvidence.completedStages : [],
      missingStages: Array.isArray(runtimeEvidence.missingStages) ? runtimeEvidence.missingStages : [],
    },
    error: result.error || '',
  };
}

function summarizeDomRecipe(result = {}) {
  const domRecipe = result.json?.runtime?.checks?.domRecipe || null;
  const actions = result.json?.runtime?.nextFreedomActions || [];
  const probe = actions.find((item) => item.stepId === 'probe_dom_recipe_targets');
  const fill = actions.find((item) => item.stepId === 'execute_dom_recipe_fields');
  return {
    status: result.status,
    ok: result.json?.ok === true,
    blockers: Array.isArray(result.json?.blockers) ? result.json.blockers : [],
    domRecipe: domRecipe ? {
      platform: domRecipe.platform,
      actionRoles: domRecipe.actionRoles || [],
      requiredProbeRoles: domRecipe.requiredProbeRoles || [],
      pageProbe: domRecipe.pageProbe || null,
    } : null,
    probePageProbe: probe?.args?.pageProbe ? {
      targetSurface: probe.args.pageProbe.targetSurface || '',
      requiresLoginSession: probe.args.pageProbe.requiresLoginSession === true,
      requiredProbeRoles: Array.isArray(probe.args.pageProbe.requiredProbeRoles) ? probe.args.pageProbe.requiredProbeRoles : [],
      expectedHosts: Array.isArray(probe.args.pageProbe.expectedHosts) ? probe.args.pageProbe.expectedHosts : [],
    } : null,
    probeHasTags: Boolean(probe?.args?.actions?.some((item) => item.role === 'tags' && item.type === 'probe_by_hints')),
    fillTagsValue: clean(fill?.args?.actions?.find((item) => item.role === 'tags')?.value || '', 200),
    secretLeaked: JSON.stringify(result.json || {}).includes('secret-value'),
    error: result.error || '',
  };
}

export async function runNoeFreedomLiveSmoke() {
  const args = parseArgs();
  const tokenPolicy = ownerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  if (tokenPolicy.policyBlocked) {
    const checks = [{
      id: 'owner_token_loaded',
      ok: false,
      evidence: { source: tokenPolicy.source, policyBlocked: true, reason: tokenPolicy.reason },
    }];
    mkdirSync(REPORT_DIR, { recursive: true });
    const report = {
      ok: false,
      host: HOST,
      port: PORT,
      tokenPolicy: {
        source: tokenPolicy.source,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: true,
        reason: tokenPolicy.reason,
        secretValueReturned: false,
      },
      checks,
      passed: 0,
      failed: checks.length,
      note: 'Live freedom smoke did not read owner-token or call protected live APIs because neither explicit ack nor standing autonomy grant authorized it.',
    };
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    writeFileSync(LATEST_REPORT, JSON.stringify(report, null, 2));
    return {
      ok: false,
      checks,
      passed: 0,
      failed: checks.length,
      report: REPORT,
      tokenPolicy: {
        source: tokenPolicy.source,
        ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
        authorization: args.ownerTokenAuthorization,
        policyBlocked: true,
        reason: tokenPolicy.reason,
        secretValueReturned: false,
      },
    };
  }
  const token = tokenPolicy.token;
  const checks = [];
  const draftDir = mkdtempSync(join(tmpdir(), 'noe-live-freedom-smoke-'));
  try {
    checks.push({
      id: 'owner_token_loaded',
      ok: Boolean(token),
      evidence: { source: tokenPolicy.source, policyBlocked: false, reason: tokenPolicy.reason || '' },
    });
    const root = await requestJson('/', { token });
    checks.push({
      id: 'root_reachable',
      ok: root.status === 200,
      evidence: { status: root.status, error: root.error || '' },
    });

    const draft = createNoeSocialDraft({
      dir: draftDir,
      draft: {
        id: 'live-final-publish-smoke',
        platform: 'douyin',
        content: 'hello from live smoke',
        metadata: {
          title: 'live smoke title',
          mediaFiles: ['clips/demo.mp4'],
        },
      },
    });
    const commonArgs = {
      draftId: draft.id,
      draftDir,
      platform: 'douyin',
      requirePriorStageEvidence: true,
      browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
    };

    const missing = await requestJson('/api/noe/freedom/dry-run', {
      method: 'POST',
      token,
      body: {
        action: 'noe.freedom.social.final_publish.execute',
        args: commonArgs,
      },
    });
    const missingSummary = summarizeFinalPublish(missing);
    checks.push({
      id: 'final_publish_blocks_missing_prior_stage_evidence',
      ok: missing.status === 409
        && missingSummary.ok === false
        && hasAll(missingSummary.blockers, [
          'final_publish_prior_stage_evidence_required',
          'final_publish_prior_stage_missing:form_fill_execute',
          'final_publish_prior_stage_missing:media_upload_execute',
        ]),
      evidence: missingSummary,
    });

    const passing = await requestJson('/api/noe/freedom/dry-run', {
      method: 'POST',
      token,
      body: {
        action: 'noe.freedom.social.final_publish.execute',
        args: {
          ...commonArgs,
          priorStageEvidence: {
            ok: true,
            kind: 'social_publish_stage_summary',
            completedStages: ['form_fill_execute', 'media_upload_execute'],
            failedStages: [],
            secretValuesReturned: false,
          },
        },
      },
    });
    const passingSummary = summarizeFinalPublish(passing);
    checks.push({
      id: 'final_publish_accepts_valid_prior_stage_evidence',
      ok: passing.status === 200
        && passingSummary.ok === true
        && passingSummary.priorStageEvidence.ok === true
        && hasAll(passingSummary.priorStageEvidence.completedStages, ['form_fill_execute', 'media_upload_execute']),
      evidence: passingSummary,
    });

    const tags = await requestJson('/api/noe/freedom/dry-run', {
      method: 'POST',
      token,
      body: {
        action: 'noe.freedom.social.publish_orchestrate',
        args: {
          id: 'live-xhs-tags-smoke',
          platform: 'xiaohongshu',
          content: 'hello live smoke',
          tags: ['旅行', 'AI'],
          includeFinalPublish: false,
          browserState: {
            activeBrowser: {
              url: 'https://creator.xiaohongshu.com/publish/post?token=secret-value',
              title: 'XHS Creator',
            },
          },
        },
      },
    });
    const tagsSummary = summarizeDomRecipe(tags);
    checks.push({
      id: 'social_dom_recipe_exposes_tags_probe_without_secret_leak',
      ok: tags.status === 200
        && tagsSummary.ok === true
        && hasAll(tagsSummary.domRecipe?.actionRoles || [], ['content', 'tags'])
        && hasAll(tagsSummary.domRecipe?.requiredProbeRoles || [], ['content', 'tags'])
        && tagsSummary.probePageProbe?.targetSurface === 'creator_publish_editor'
        && tagsSummary.probePageProbe?.requiresLoginSession === true
        && hasAll(tagsSummary.probePageProbe?.requiredProbeRoles || [], ['content', 'tags'])
        && tagsSummary.probeHasTags === true
        && tagsSummary.fillTagsValue === '旅行 AI'
        && tagsSummary.secretLeaked === false,
      evidence: tagsSummary,
    });
  } finally {
    rmSync(draftDir, { recursive: true, force: true });
  }

  const failed = checks.filter((item) => !item.ok);
  const report = {
    ok: failed.length === 0,
    host: HOST,
    port: PORT,
    checked: checks.length,
    failed: failed.length,
    checks,
    report: REPORT,
    latest: LATEST_REPORT,
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: false,
      secretValueReturned: false,
    },
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  writeFileSync(LATEST_REPORT, JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const out = await runNoeFreedomLiveSmoke();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.ok ? 0 : out.tokenPolicy?.policyBlocked ? 2 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('noe-freedom-live-smoke.mjs')) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
