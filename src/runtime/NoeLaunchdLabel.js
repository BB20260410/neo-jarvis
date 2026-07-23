// @ts-check
/**
 * Noe panel launchd label resolution.
 * Historical bug: restart-panel defaulted to `com.hxx.noe.panel51835` while the
 * installed LaunchAgent Label is `com.noe.panel`, so kickstart never found the job.
 */

export const NOE_CANONICAL_LAUNCHD_LABEL = 'com.noe.panel';
export const NOE_LEGACY_LAUNCHD_LABELS = Object.freeze([
  'com.hxx.noe.panel51835',
  'com.hxx.noe.panel',
]);

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 * @param {string[]} [opts.installedLabels] Labels known present (plist / launchctl)
 * @param {string[]} [opts.preferredOrder] Discovery order when env unset
 * @returns {{ label: string, source: 'env'|'installed'|'default', candidates: string[] }}
 */
export function resolveNoeLaunchdLabel({
  env = process.env,
  installedLabels = [],
  preferredOrder = [NOE_CANONICAL_LAUNCHD_LABEL, ...NOE_LEGACY_LAUNCHD_LABELS],
} = {}) {
  const candidates = preferredOrder.map((s) => String(s || '').trim()).filter(Boolean);
  const fromEnv = String(env?.PANEL_LAUNCHD_LABEL || '').trim();
  if (fromEnv) {
    return { label: fromEnv, source: 'env', candidates };
  }
  const installed = new Set(
    (Array.isArray(installedLabels) ? installedLabels : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  );
  for (const c of candidates) {
    if (installed.has(c)) {
      return { label: c, source: 'installed', candidates };
    }
  }
  return {
    label: NOE_CANONICAL_LAUNCHD_LABEL,
    source: 'default',
    candidates,
  };
}

/**
 * Parse `Label` from a launchd plist (XML or plutil JSON-ish text).
 * @param {string} text
 * @returns {string|null}
 */
export function parseLaunchdPlistLabel(text = '') {
  const raw = String(text || '');
  // XML form: <key>Label</key>\n  <string>com.noe.panel</string>
  const xml = raw.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/i);
  if (xml?.[1]) return xml[1].trim();
  // plutil -p form: "Label" => "com.noe.panel"
  const p = raw.match(/"Label"\s*=>\s*"([^"]+)"/i);
  if (p?.[1]) return p[1].trim();
  return null;
}

/**
 * Alignment report for operator evidence (no secrets).
 * @param {{ resolved: {label:string,source:string}, installedLabel?: string|null, launchctlHasResolved?: boolean }} input
 */
export function buildLaunchdAlignmentReport(input = {}) {
  const resolved = input.resolved || resolveNoeLaunchdLabel();
  const installedLabel = input.installedLabel == null ? null : String(input.installedLabel);
  const matchInstalled = installedLabel ? installedLabel === resolved.label : null;
  const launchctlHasResolved = input.launchctlHasResolved === true;
  // When launchctlHasResolved is explicitly provided, require it true.
  // Do not treat matchInstalled as a substitute for live launchctl supervision.
  const launchctlOk = input.launchctlHasResolved == null ? true : launchctlHasResolved;
  const installedOk = matchInstalled !== false;
  const disabled = input.disabled === true;
  return {
    ok: installedOk && launchctlOk && !disabled,
    resolvedLabel: resolved.label,
    resolvedSource: resolved.source,
    installedLabel,
    matchInstalled,
    launchctlHasResolved: input.launchctlHasResolved ?? null,
    disabled: input.disabled ?? null,
    note: matchInstalled === false
      ? 'restart tooling label does not match installed plist Label'
      : disabled
        ? 'launchd service is disabled — enable before kickstart'
        : !launchctlOk
          ? 'label not present in launchctl list — bootstrap/load required'
        : 'launchd label contract aligned or env override in use',
  };
}

/**
 * Plan safe steps to put com.noe.panel under launchd supervision.
 * Never recommends bootstrap while an unmanaged panel holds the live port/DB
 * (dual-writer risk with KeepAlive).
 *
 * @param {object} input
 * @param {string} [input.label]
 * @param {string|number} [input.uid]
 * @param {string} [input.plistPath]
 * @param {boolean} [input.disabled]
 * @param {boolean} [input.loaded] service print/list shows job
 * @param {boolean} [input.launchctlHasLabel]
 * @param {boolean} [input.unmanagedLivePanel] live 51835 not under this launchd job
 * @returns {{ ok: boolean, steps: Array<object>, blockers: string[], target: string }}
 */
export function planLaunchdSupervision(input = {}) {
  const label = String(input.label || NOE_CANONICAL_LAUNCHD_LABEL).trim() || NOE_CANONICAL_LAUNCHD_LABEL;
  const uid = String(input.uid ?? '').trim() || 'UID';
  const target = `gui/${uid}/${label}`;
  const plistPath = String(input.plistPath || '').trim();
  /** @type {Array<{action:string, argv:string[], reason:string}>} */
  const steps = [];
  /** @type {string[]} */
  const blockers = [];

  if (input.disabled === true) {
    steps.push({
      action: 'enable',
      argv: ['enable', target],
      reason: 'service_disabled_in_launchctl',
    });
  }

  if (input.unmanagedLivePanel === true && (input.loaded !== true || input.launchctlHasLabel !== true)) {
    // Must release unmanaged listener before bootstrap/kickstart (KeepAlive would spawn second writer)
    steps.push({
      action: 'stop_unmanaged_panel',
      argv: [],
      reason: 'unmanaged_live_panel_holds_port_or_db',
    });
  }

  if (input.loaded !== true && input.launchctlHasLabel !== true) {
    if (!plistPath) {
      blockers.push('plist_path_required_for_bootstrap');
    } else if (input.unmanagedLivePanel === true) {
      // bootstrap only after stop_unmanaged_panel
      steps.push({
        action: 'bootstrap',
        argv: ['bootstrap', `gui/${uid}`, plistPath],
        reason: 'service_not_loaded_after_unmanaged_stop',
        requiresPrior: 'stop_unmanaged_panel',
      });
    } else {
      steps.push({
        action: 'bootstrap',
        argv: ['bootstrap', `gui/${uid}`, plistPath],
        reason: 'service_not_loaded',
      });
    }
  }

  if (input.launchctlHasLabel !== true || input.unmanagedLivePanel === true) {
    steps.push({
      action: 'kickstart',
      argv: ['kickstart', '-k', target],
      reason: 'ensure_running_under_launchd',
    });
  }

  return {
    ok: blockers.length === 0,
    label,
    target,
    steps,
    blockers,
    dualWriterSafe: !(input.unmanagedLivePanel === true && steps.some((s) => s.action === 'bootstrap' && !s.requiresPrior)),
  };
}

/**
 * Parse `launchctl print-disabled gui/UID` output for a label.
 * @param {string} text
 * @param {string} label
 */
export function isLaunchdLabelDisabledInPrint(text = '', label = NOE_CANONICAL_LAUNCHD_LABEL) {
  const re = new RegExp(`"${String(label).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"\\s*=>\\s*disabled`, 'i');
  return re.test(String(text || ''));
}
