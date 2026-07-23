import { spawn } from 'node:child_process';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { DEFAULT_NOE_SOCIAL_DRAFT_DIR } from './NoeSocialPublishQueue.js';
import { buildNoeSocialFormFillPlan } from './NoeSocialFormFillPlan.js';

export const NOE_SOCIAL_FORM_FILL_EXECUTOR_SCHEMA_VERSION = 1;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function parseJson(value = '') {
  try {
    return JSON.parse(clean(value, 20_000));
  } catch {
    return null;
  }
}

export function scriptContainsFinalPublishAction(script = '') {
  const text = String(script || '');
  return /(\.click\s*\(|\.submit\s*\(|requestSubmit\s*\(|MouseEvent\s*\(\s*['"]click|KeyboardEvent\s*\(\s*['"]keydown|key\s*:\s*['"]Enter['"])/i.test(text);
}

async function runProcess(command, args = [], { cwd = process.cwd(), spawnImpl = spawn } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawnImpl(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk); if (stdout.length > 20_000) stdout = stdout.slice(-20_000); });
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on?.('error', rejectProcess);
    child.on?.('close', (code, signal) => {
      resolveProcess({
        ok: Number(code) === 0,
        exitCode: code,
        signal: signal || null,
        stdout: clean(stdout, 20_000),
        stderr: clean(stderr, 20_000),
      });
    });
  });
}

function processPreview(processResult = {}) {
  return {
    ok: processResult.ok === true,
    exitCode: Number.isFinite(Number(processResult.exitCode)) ? Number(processResult.exitCode) : null,
    signal: processResult.signal || null,
    stderrPreview: clean(processResult.stderr, 1000),
    stdoutReturned: false,
  };
}

function parsedBrowserResult(stdout = '') {
  const parsed = parseJson(stdout);
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'form_fill_execution_output_parse_failed' };
  const nested = typeof parsed.result === 'string' ? parseJson(parsed.result) : parsed.result;
  return {
    ok: parsed.ok !== false && (!nested || nested.ok !== false),
    app: clean(parsed.app, 120),
    result: nested && typeof nested === 'object' ? {
      ok: nested.ok !== false,
      host: clean(nested.host, 200),
      titleFilled: nested.titleFilled === true,
      contentFilled: nested.contentFilled === true,
      titleEchoMatched: nested.titleEchoMatched === true,
      contentEchoMatched: nested.contentEchoMatched === true,
      titleSelector: clean(nested.titleSelector || '', 500),
      contentSelector: clean(nested.contentSelector || '', 500),
      titleTag: clean(nested.titleTag || '', 80),
      contentTag: clean(nested.contentTag || '', 80),
      sameField: nested.sameField === true,
      mediaHandled: nested.mediaHandled === true,
      finalButtonClicked: false,
      formSubmitted: false,
      error: clean(nested.error || '', 500),
    } : {},
    finalButtonClicked: false,
    formSubmitted: false,
  };
}

export async function executeNoeSocialFormFill({
  args = {},
  draftDir = DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  root = process.cwd(),
  realExecute = false,
  deps = {},
} = {}) {
  const plan = buildNoeSocialFormFillPlan({ args, draftDir, realExecute });
  const script = plan.automation?.script || '';
  const base = {
    ...plan,
    schemaVersion: NOE_SOCIAL_FORM_FILL_EXECUTOR_SCHEMA_VERSION,
    adapter: 'social-form-fill-execute',
    plannedOnly: realExecute !== true,
    executionAttempted: false,
    execution: null,
    externalSideEffectPerformed: false,
    publishPerformed: false,
  };
  if (!plan.ok) return base;
  if (scriptContainsFinalPublishAction(script)) {
    return {
      ...base,
      ok: false,
      blockers: [...(plan.blockers || []), 'form_fill_script_contains_final_publish_action'],
    };
  }
  if (realExecute !== true) {
    return {
      ...base,
      nextFreedomActions: [
        {
          stepId: 'execute_controlled_form_fill',
          actionId: 'noe.freedom.social.form_fill.execute',
          mode: 'developer_unrestricted',
          args,
        },
      ],
    };
  }

  const processResult = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: root,
    spawnImpl: deps.spawn || spawn,
  });
  const browser = processResult.ok ? parsedBrowserResult(processResult.stdout) : { ok: false, error: 'form_fill_osascript_failed' };
  const blockers = [
    ...(plan.blockers || []),
    ...(processResult.ok ? [] : ['form_fill_osascript_failed']),
    ...(browser.ok ? [] : [browser.error || browser.result?.error || 'form_fill_browser_result_failed']),
    ...(plan.previews?.title && browser.result?.titleFilled !== true ? ['form_fill_title_field_not_filled'] : []),
    ...(plan.previews?.content && browser.result?.contentFilled !== true ? ['form_fill_content_field_not_filled'] : []),
    ...(plan.previews?.title && browser.result?.titleEchoMatched !== true ? ['form_fill_title_echo_mismatch'] : []),
    ...(plan.previews?.content && browser.result?.contentEchoMatched !== true ? ['form_fill_content_echo_mismatch'] : []),
    ...(browser.result?.sameField === true ? ['form_fill_fields_collapsed_to_same_element'] : []),
  ].filter(Boolean);
  return {
    ...base,
    ok: blockers.length === 0,
    plannedOnly: false,
    executionAttempted: true,
    execution: {
      command: 'osascript',
      language: 'JavaScript',
      process: processPreview(processResult),
      browser,
      stdoutReturned: false,
      finalButtonClicked: false,
      formSubmitted: false,
    },
    blockers,
  };
}
