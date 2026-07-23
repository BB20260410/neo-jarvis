// @ts-check
// browser 域适配器：browser.open / browser.state_probe / browser.dom.execute（含 JXA/AppleScript 脚本构建）
// + account.connection_inventory（依赖 browser state probe，故归此域）。
// 拆分自 NoeFreedomAdapters.js（纯搬运，行为零改变）。
import { spawn } from 'node:child_process';
import { URL } from 'node:url';
import { buildNoeAccountConnectionInventory } from '../NoeAccountConnectionInventory.js';
import { clean, dryRunPlan, hostFromUrl, redactDiagnosticText, runProcess, safeJson, sha256Json, sha256Text } from './common.js';

export function browserOpenDryRun({ tool, args }) {
  const url = clean(args.url || args.href, 2000);
  const browserApp = clean(args.browserApp || args.app || '', 120);
  const warnings = [];
  if (!/^https?:\/\//i.test(url)) warnings.push('browser_url_must_be_http');
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-open',
    extras: {
      valid: warnings.length === 0,
      urlPreview: url,
      host: hostFromUrl(url),
      browserApp,
      wouldOpenBrowser: warnings.length === 0,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      externalSideEffectPerformed: false,
    },
    warnings,
  });
}

function appleScriptString(value = '') {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildBrowserOpenScript({ browserApp = 'Google Chrome', url = '' } = {}) {
  const app = appleScriptString(browserApp || 'Google Chrome');
  const targetUrl = appleScriptString(url);
  if (/safari/i.test(browserApp)) {
    return `
tell application ${app}
  activate
  if (count of documents) = 0 then
    make new document with properties {URL:${targetUrl}}
  else
    set URL of front document to ${targetUrl}
  end if
end tell
`;
  }
  return `
tell application ${app}
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to ${targetUrl}
end tell
`;
}

const BROWSER_STATE_PROBE_SCRIPT = `
function safeString(value) {
  try { return String(value || ""); } catch (_) { return ""; }
}
function frontmostAppName() {
  try {
    return safeString(Application("System Events").processes.whose({ frontmost: true })()[0].name());
  } catch (error) {
    return "";
  }
}
function chromeLikeState(appName, frontmost) {
  try {
    const app = Application(appName);
    if (!app.running()) return null;
    const windows = app.windows();
    const first = frontChromeLikeWindow(windows);
    const tab = first && first.activeTab ? first.activeTab() : null;
    return {
      app: appName,
      running: true,
      frontmost: frontmost === appName,
      url: safeString(tab && tab.url ? tab.url() : ""),
      title: safeString(tab && tab.title ? tab.title() : ""),
      windowCount: windows ? windows.length : 0
    };
  } catch (error) {
    return { app: appName, running: false, frontmost: frontmost === appName, error: safeString(error.message || error) };
  }
}
function frontChromeLikeWindow(windows) {
  if (!windows || !windows.length) return null;
  for (let i = 0; i < windows.length; i += 1) {
    try {
      if (windows[i].index && Number(windows[i].index()) === 1) return windows[i];
    } catch (_) {
      // fall through to first window
    }
  }
  return windows[0] || null;
}
function safariState(frontmost) {
  try {
    const app = Application("Safari");
    if (!app.running()) return null;
    const documents = app.documents();
    const first = documents && documents.length ? documents[0] : null;
    return {
      app: "Safari",
      running: true,
      frontmost: frontmost === "Safari",
      url: safeString(first && first.url ? first.url() : ""),
      title: safeString(first && first.name ? first.name() : ""),
      windowCount: app.windows ? app.windows().length : 0
    };
  } catch (error) {
    return { app: "Safari", running: false, frontmost: frontmost === "Safari", error: safeString(error.message || error) };
  }
}
const frontmost = frontmostAppName();
const chromeApps = ["Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Chromium"];
const browsers = chromeApps.map((name) => chromeLikeState(name, frontmost)).concat([safariState(frontmost)]).filter(Boolean);
const activeBrowser = browsers.find((item) => item.frontmost) || browsers.find((item) => item.running && item.url) || null;
JSON.stringify({
  ok: true,
  frontmostApp: frontmost,
  activeBrowser,
  browsers,
  cookiesReadByNoe: false,
  passwordReadByNoe: false,
  pageContentReadByNoe: false
});
`;

export function browserStateProbeDryRun({ tool, args }) {
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-state-probe',
    extras: {
      valid: true,
      wouldRunOsaScript: true,
      language: 'JavaScript',
      includeAll: args.includeAll !== false,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    },
  });
}

function parseBrowserStateProbe(stdout = '') {
  try {
    const parsed = JSON.parse(clean(stdout, 20_000));
    const activeBrowser = sanitizeBrowserState(parsed.activeBrowser);
    const browsers = Array.isArray(parsed.browsers) ? parsed.browsers.slice(0, 12).map(sanitizeBrowserState) : [];
    return {
      ok: parsed.ok !== false,
      frontmostApp: clean(parsed.frontmostApp, 200),
      activeBrowser,
      browsers,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    };
  } catch {
    return {
      ok: false,
      error: 'browser_state_probe_parse_failed',
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    };
  }
}

function redactBrowserUrl(value = '') {
  const raw = clean(value, 2000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(url.hash)) url.hash = '#[redacted]';
    return clean(url.toString(), 2000);
  } catch {
    return raw.replace(/([?&#][^=]*?(token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  }
}

function sanitizeBrowserState(value = null) {
  if (!value || typeof value !== 'object') return null;
  const state = safeJson(value);
  return {
    app: clean(state.app, 120),
    running: state.running === true,
    frontmost: state.frontmost === true,
    url: redactBrowserUrl(state.url),
    title: clean(state.title, 500),
    windowCount: Math.max(0, Number(state.windowCount) || 0),
    ...(state.error ? { error: clean(state.error, 500) } : {}),
  };
}

function normalizeBrowserDomActions(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const fallback = source.length ? source : [{ type: 'read_title' }];
  return fallback.slice(0, 20).map((action, index) => {
    const item = safeJson(action);
    return {
      index,
      type: clean(item.type || item.kind || item.action || 'read_title', 40).toLowerCase(),
      selector: clean(item.selector || item.css || '', 1000),
      role: clean(item.role || item.field || '', 80),
      probeTarget: clean(item.probeTarget || item.target || '', 80).toLowerCase(),
      hints: normalizeBrowserDomHints(item.hints || item.labels || item.match || item.matches),
      value: clean(item.value ?? item.text ?? item.content ?? '', 20_000),
    };
  });
}

function normalizeBrowserDomHints(value, maxItems = 20) {
  const source = Array.isArray(value) ? value : clean(value, 2000) ? [value] : [];
  return [...new Set(source.slice(0, maxItems).map((item) => clean(item, 200)).filter(Boolean))];
}

function browserDomExpectedHosts(args = {}) {
  const source = Array.isArray(args.expectedHosts)
    ? args.expectedHosts
    : Array.isArray(args.hosts)
      ? args.hosts
      : [args.expectedHost || args.host].filter(Boolean);
  return source.map((item) => clean(item, 240).toLowerCase()).filter(Boolean).slice(0, 20);
}

function browserDomExpectedUrlPrefixes(args = {}) {
  const source = Array.isArray(args.expectedUrlPrefixes)
    ? args.expectedUrlPrefixes
    : Array.isArray(args.expectedUrls)
      ? args.expectedUrls
      : [args.expectedUrlPrefix || args.expectedUrl].filter(Boolean);
  return source.map((item) => clean(item, 2000).toLowerCase()).filter(Boolean).slice(0, 20);
}

function browserDomActionMutates(action = {}) {
  const type = clean(action.type, 40).toLowerCase();
  return !['read_title', 'probe_by_hints'].includes(type);
}

function browserDomActionPreview(action = {}) {
  return {
    index: Number(action.index) || 0,
    type: clean(action.type, 40),
    selector: clean(action.selector, 1000),
    role: clean(action.role, 80),
    probeTarget: clean(action.probeTarget, 80),
    hintCount: Array.isArray(action.hints) ? action.hints.length : 0,
    hasValue: Boolean(action.value),
  };
}

function normalizeBrowserDomPageProbe(value = null, actions = [], expectedHosts = [], expectedUrlPrefixes = []) {
  if (!value || typeof value !== 'object') return null;
  const probe = safeJson(value);
  const requiredProbeRoles = normalizeBrowserDomHints(
    probe.requiredProbeRoles || probe.requiredRoles || actions.map((action) => action.role || action.type),
    40,
  );
  const fieldRoles = normalizeBrowserDomHints(probe.fieldRoles, 40);
  const clickableRoles = normalizeBrowserDomHints(probe.clickableRoles, 40);
  return {
    expectedHosts: browserDomExpectedHosts({ expectedHosts: probe.expectedHosts?.length ? probe.expectedHosts : expectedHosts }),
    expectedHost: clean(probe.expectedHost || expectedHosts[0] || '', 240).toLowerCase(),
    expectedUrlPrefixes: browserDomExpectedUrlPrefixes({
      expectedUrlPrefixes: probe.expectedUrlPrefixes?.length ? probe.expectedUrlPrefixes : expectedUrlPrefixes,
    }),
    requiresLoginSession: probe.requiresLoginSession === true,
    targetSurface: clean(probe.targetSurface || '', 120),
    titleRead: probe.titleRead !== false,
    requiredProbeRoles,
    fieldRoles,
    clickableRoles,
    probeOnly: probe.probeOnly !== false,
  };
}

function sanitizeBrowserDomPageReadiness(value = null) {
  if (!value || typeof value !== 'object') return null;
  const item = safeJson(value);
  const login = safeJson(item.login || {});
  return {
    ok: item.ok === true,
    hostMatched: item.hostMatched === true,
    expectedHosts: Array.isArray(item.expectedHosts) ? item.expectedHosts.map((host) => clean(host, 240)).filter(Boolean) : [],
    expectedUrlPrefixes: Array.isArray(item.expectedUrlPrefixes) ? item.expectedUrlPrefixes.map((prefix) => clean(prefix, 2000)).filter(Boolean) : [],
    targetSurface: clean(item.targetSurface, 120),
    targetSurfaceReady: item.targetSurfaceReady === true,
    requiresLoginSession: item.requiresLoginSession === true,
    loginSessionLikely: item.loginSessionLikely === true,
    login: {
      passwordFieldPresent: login.passwordFieldPresent === true,
      loginPromptPresent: login.loginPromptPresent === true,
    },
    requiredRoles: Array.isArray(item.requiredRoles) ? item.requiredRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    foundRoles: Array.isArray(item.foundRoles) ? item.foundRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    missingRoles: Array.isArray(item.missingRoles) ? item.missingRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    fieldRoles: Array.isArray(item.fieldRoles) ? item.fieldRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    clickableRoles: Array.isArray(item.clickableRoles) ? item.clickableRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    titleRead: item.titleRead === true,
    secretValuesReturned: false,
  };
}

function sanitizeBrowserDomActionResult(value = {}, index = 0) {
  const item = safeJson(value);
  return {
    index,
    type: clean(item.type, 40),
    selector: clean(item.selector, 1000),
    role: clean(item.role, 80),
    probeTarget: clean(item.probeTarget, 80),
    ok: item.ok !== false,
    found: item.found === true,
    matchedByHints: item.matchedByHints === true,
    probed: item.probed === true,
    focused: item.focused === true,
    clicked: item.clicked === true,
    valueSet: item.valueSet === true,
    contentRead: item.contentRead === true,
    // L1：保留读到的正文（read_body），否则深思拿不到内容、又退化成"只开不读"。
    ...(item.contentRead === true ? { extractedText: clean(item.extractedText, 8000), extractedLength: Number(item.extractedLength) || 0 } : {}),
    ...(item.error ? { error: clean(item.error, 300) } : {}),
  };
}

function buildBrowserDomPageScript({ actions = [], expectedHosts = [], expectedUrlPrefixes = [], pageProbe = null } = {}) {
  const safeActions = actions.map((action) => ({
    type: action.type,
    selector: action.selector,
    role: action.role,
    probeTarget: action.probeTarget,
    hints: action.hints,
    value: action.value,
  }));
  const safePageProbe = pageProbe ? {
    expectedHosts: pageProbe.expectedHosts,
    expectedUrlPrefixes: pageProbe.expectedUrlPrefixes,
    requiresLoginSession: pageProbe.requiresLoginSession,
    targetSurface: pageProbe.targetSurface,
    titleRead: pageProbe.titleRead,
    requiredProbeRoles: pageProbe.requiredProbeRoles,
    fieldRoles: pageProbe.fieldRoles,
    clickableRoles: pageProbe.clickableRoles,
  } : null;
  return `
(function () {
  function safeString(value) {
    try { return String(value || ""); } catch (_) { return ""; }
  }
  function matchesExpectedHost(host, expectedHosts) {
    if (!expectedHosts.length) return true;
    return expectedHosts.some(function (expected) {
      return host === expected || host.endsWith("." + expected);
    });
  }
  function matchesExpectedUrl(url, expectedUrlPrefixes) {
    if (!expectedUrlPrefixes.length) return true;
    const safeUrl = safeString(url).toLowerCase();
    return expectedUrlPrefixes.some(function (prefix) {
      return safeUrl.indexOf(safeString(prefix).toLowerCase()) === 0;
    });
  }
  const expectedHosts = ${JSON.stringify(expectedHosts)};
  const expectedUrlPrefixes = ${JSON.stringify(expectedUrlPrefixes)};
  const actions = ${JSON.stringify(safeActions)};
  const pageProbe = ${JSON.stringify(safePageProbe)};
  const host = safeString(location.host).toLowerCase();
  const title = safeString(document.title);
  const url = safeString(location.href);
  const hostMatched = matchesExpectedHost(host, expectedHosts);
  const urlMatched = matchesExpectedUrl(url, expectedUrlPrefixes);
  if (!hostMatched || !urlMatched) {
    return JSON.stringify({
      ok: false,
      error: hostMatched ? "browser_dom_url_mismatch" : "browser_dom_host_mismatch",
      host,
      title,
      url,
      expectedHosts,
      expectedUrlPrefixes,
      pageReadiness: pageProbe ? {
        ok: false,
        hostMatched,
        urlMatched,
        expectedHosts,
        expectedUrlPrefixes,
        targetSurface: safeString(pageProbe.targetSurface),
        targetSurfaceReady: false,
        requiresLoginSession: pageProbe.requiresLoginSession === true,
        loginSessionLikely: false,
        login: { passwordFieldPresent: false, loginPromptPresent: false },
        requiredRoles: Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles : [],
        foundRoles: [],
        missingRoles: Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles : [],
        fieldRoles: Array.isArray(pageProbe.fieldRoles) ? pageProbe.fieldRoles : [],
        clickableRoles: Array.isArray(pageProbe.clickableRoles) ? pageProbe.clickableRoles : [],
        titleRead: false,
        secretValuesReturned: false
      } : null,
      actions: [],
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false
    });
  }
  const results = [];
  function elementMetadata(el, includeVisibleText) {
    if (!el) return "";
    const values = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("class"),
      el.getAttribute("title"),
      includeVisibleText ? el.textContent : ""
    ];
    return values.filter(Boolean).join(" ").toLowerCase();
  }
  function findByHints(candidates, hints, includeVisibleText) {
    const safeHints = Array.isArray(hints) ? hints.map(function (item) { return safeString(item).toLowerCase(); }).filter(Boolean) : [];
    if (!safeHints.length) return null;
    return candidates.find(function (el) {
      const text = elementMetadata(el, includeVisibleText);
      return safeHints.some(function (hint) { return text.indexOf(hint) >= 0; });
    }) || null;
  }
  function findField(action) {
    if (action.selector) return document.querySelector(action.selector);
    const fields = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"));
    return findByHints(fields, action.hints, false);
  }
  function findClickable(action) {
    if (action.selector) return document.querySelector(action.selector);
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link'], [role='menuitem'], [tabindex], input[type='button'], input[type='submit'], [class*='btn'], [class*='button']"));
    return findByHints(controls, action.hints, true);
  }
  function findProbeTarget(action) {
    const target = safeString(action.probeTarget || "").toLowerCase();
    const role = safeString(action.role || "").toLowerCase();
    if (target === "clickable" || role === "media_upload" || role === "final_publish") return findClickable(action);
    return findField(action);
  }
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] || {};
    const type = safeString(action.type || "read_title").toLowerCase();
    const selector = safeString(action.selector || "");
    const role = safeString(action.role || "");
    const probeTarget = safeString(action.probeTarget || "");
    const result = { index, type, selector, role, probeTarget, ok: true, found: false, matchedByHints: false, focused: false, clicked: false, valueSet: false };
    try {
      if (type === "read_title") {
        result.found = true;
        results.push(result);
        continue;
      }
      if (type === "read_body" || type === "read_text" || type === "extract_text") {
        // L1：真读页面正文（innerText）——优先 main/article 主内容区，截断 8000 字，让 Neo 不再"只开不读"。
        // P5 v2 正文提取去噪(codex+M3 真实 Chrome 实测修 3 bug)：
        //   ① pickMain 优先正文容器(article 要有 p 且 >500 字,治列表页摘要卡冒充正文;补微信/知乎/V2EX 等主流站容器)
        //   ② 【不 clone】detached cloneNode 的 innerText 退化成 textContent 会泄漏 display:none 等 CSS 隐藏内容(比不去噪更脏)；
        //      改在原树临时 display:none 噪声节点 → 取 picked.innerText(在树内 CSS 感知,排除噪声+原本隐藏) → 还原 display
        //   ③ noise 去掉 .comment/.related/[aria-hidden](会掏空论坛/问答正文+误伤折叠正文) ④ 去噪空降级 picked 原始→body,最终空置 found=false 不假成功
        const pickMain = () => {
          const arts = document.querySelectorAll("article");
          let best = null, bestLen = 0;
          for (const a of arts) { const L = a.innerText ? a.innerText.length : 0; if (a.querySelector("p") && L > 500 && L > bestLen) { best = a; bestLen = L; } }
          if (best) return best;
          const sels = ["main", "[role='main']", ".article-body", ".post-content", ".article-content", ".entry-content", ".markdown-body", ".rich_media_content", "#js_content", ".RichText", ".topic_content", "[itemprop='articleBody']", ".story-body", ".article__content"];
          for (const s of sels) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.length > 200) return el; }
          const art1 = document.querySelector("article"); if (art1 && art1.innerText && art1.innerText.length > 200) return art1;
          return document.body;
        };
        let text = "";
        try {
          const picked = pickMain();
          const restore = [];
          try {
            const noise = picked.querySelectorAll("nav, header, footer, aside, script, style, noscript, form, button, iframe, .ad, .ads, .advertisement, .sidebar, .share, .social, .nav, .menu, .breadcrumb, [role='navigation'], [role='banner'], [role='contentinfo']");
            for (const n of noise) { if (n && n !== picked && n.style) { restore.push([n, n.style.display]); n.style.display = "none"; } }
          } catch (e2) { /* 收集噪声失败直接取 innerText */ }
          text = safeString(picked && picked.innerText ? picked.innerText : "");
          for (const pair of restore) { try { pair[0].style.display = pair[1]; } catch (e3) { /* 还原失败忽略 */ } }
        } catch (e4) { text = ""; }
        if (!text || !text.trim()) {
          try { const p2 = pickMain(); text = safeString(p2 && p2.innerText ? p2.innerText : (document.body && document.body.innerText ? document.body.innerText : "")); } catch (e5) { text = safeString(document.body && document.body.innerText ? document.body.innerText : ""); }
        }
        const finalText = text.slice(0, 8000);
        if (!finalText || !finalText.trim()) {
          result.found = false;
          result.contentRead = false;
          result.error = "browser_dom_empty_text";
        } else {
          result.found = true;
          result.contentRead = true;
          result.extractedText = finalText;
          result.extractedLength = text.length;
        }
        results.push(result);
        continue;
      }
      if (!selector && type !== "set_by_hints" && type !== "click_by_hints" && type !== "probe_by_hints") {
        result.ok = false;
        result.error = "browser_dom_selector_required";
        results.push(result);
        continue;
      }
      const element = type === "set_by_hints" ? findField(action) : type === "click_by_hints" ? findClickable(action) : type === "probe_by_hints" ? findProbeTarget(action) : document.querySelector(selector);
      if (!element) {
        result.ok = false;
        result.error = "browser_dom_element_not_found";
        results.push(result);
        continue;
      }
      result.found = true;
      result.matchedByHints = !selector && (type === "set_by_hints" || type === "click_by_hints" || type === "probe_by_hints");
      if (type === "focus") {
        element.focus();
        result.focused = true;
      } else if (type === "probe_by_hints") {
        result.probed = true;
      } else if (type === "set_value" || type === "set_by_hints") {
        element.focus();
        const nextValue = safeString(action.value);
        if (element.isContentEditable) {
          element.textContent = nextValue;
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        result.focused = true;
        result.valueSet = true;
      } else if (type === "click" || type === "click_by_hints") {
        element.click();
        result.clicked = true;
      } else {
        result.ok = false;
        result.error = "browser_dom_action_unsupported";
      }
    } catch (error) {
      result.ok = false;
      result.error = "browser_dom_action_failed:" + safeString(error && error.message ? error.message : error).slice(0, 200);
    }
    results.push(result);
  }
  function buildPageReadiness() {
    if (!pageProbe) return null;
    const requiredRoles = Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles.map(function (role) { return safeString(role); }).filter(Boolean) : [];
    const foundRoles = [];
    for (let i = 0; i < results.length; i += 1) {
      const item = results[i] || {};
      const role = safeString(item.role || item.type);
      if (role && item.ok !== false && item.found === true && foundRoles.indexOf(role) < 0) foundRoles.push(role);
    }
    const missingRoles = requiredRoles.filter(function (role) { return foundRoles.indexOf(role) < 0; });
    const passwordFieldPresent = document.querySelector("input[type='password']") ? true : false;
    const loginControls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link'], [role='menuitem'], [tabindex], input[type='submit'], [class*='btn'], [class*='button']"));
    const loginPromptPresent = loginControls.some(function (el) {
      const text = elementMetadata(el, true);
      return text.indexOf("login") >= 0 || text.indexOf("log in") >= 0 || text.indexOf("sign in") >= 0 || text.indexOf("登录") >= 0 || text.indexOf("登入") >= 0;
    });
    const loginSessionLikely = pageProbe.requiresLoginSession === true ? !passwordFieldPresent && !loginPromptPresent : true;
    const titleRead = results.some(function (item) { return item.type === "read_title" && item.found === true && item.ok !== false; });
    const targetSurfaceReady = hostMatched && loginSessionLikely && missingRoles.length === 0 && (pageProbe.titleRead === false || titleRead);
    return {
      ok: targetSurfaceReady,
      hostMatched,
      expectedHosts,
      expectedUrlPrefixes,
      targetSurface: safeString(pageProbe.targetSurface),
      targetSurfaceReady,
      requiresLoginSession: pageProbe.requiresLoginSession === true,
      loginSessionLikely,
      login: { passwordFieldPresent, loginPromptPresent },
      requiredRoles,
      foundRoles,
      missingRoles,
      fieldRoles: Array.isArray(pageProbe.fieldRoles) ? pageProbe.fieldRoles : [],
      clickableRoles: Array.isArray(pageProbe.clickableRoles) ? pageProbe.clickableRoles : [],
      titleRead,
      secretValuesReturned: false
    };
  }
  const pageReadiness = buildPageReadiness();
  return JSON.stringify({
    ok: results.every(function (item) { return item.ok !== false; }) && (!pageReadiness || pageReadiness.ok !== false),
    host,
    title,
    url,
    expectedHosts,
    pageReadiness,
    actions: results,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: results.some(function (item) { return item.contentRead === true && item.ok !== false; }),
    secretValuesReturned: false
  });
}());
`;
}

function buildBrowserDomJxa({
  browserApp = 'Google Chrome',
  pageScript = '',
  expectedHosts = [],
  expectedUrlPrefixes = [],
  allowTabSearch = true,
} = {}) {
  const appName = clean(browserApp || 'Google Chrome', 120) || 'Google Chrome';
  const safeExpectedHosts = Array.isArray(expectedHosts)
    ? expectedHosts.map((host) => clean(host, 240).toLowerCase()).filter(Boolean)
    : [];
  const safeExpectedUrlPrefixes = Array.isArray(expectedUrlPrefixes)
    ? expectedUrlPrefixes.map((prefix) => clean(prefix, 2000).toLowerCase()).filter(Boolean)
    : [];
  return `
function safeString(value) {
  try { return String(value || ""); } catch (_) { return ""; }
}
function hostFromUrlString(url) {
  const text = safeString(url).toLowerCase();
  const match = text.match(/^[a-z][a-z0-9+.-]*:\\/\\/([^/?#]+)/);
  return match ? match[1] : "";
}
function matchesExpectedHost(host, expectedHosts) {
  if (!expectedHosts || !expectedHosts.length) return true;
  return expectedHosts.some(function (expected) {
    return host === expected || host.endsWith("." + expected);
  });
}
function matchesExpectedUrl(url, expectedUrlPrefixes) {
  if (!expectedUrlPrefixes || !expectedUrlPrefixes.length) return true;
  const text = safeString(url).toLowerCase();
  return expectedUrlPrefixes.some(function (prefix) {
    return text.indexOf(safeString(prefix).toLowerCase()) === 0;
  });
}
function tabMatchesExpectedTarget(tab, expectedHosts, expectedUrlPrefixes) {
  if (!expectedHosts || !expectedHosts.length) return true;
  try {
    const url = tab.url();
    return matchesExpectedHost(hostFromUrlString(url), expectedHosts) && matchesExpectedUrl(url, expectedUrlPrefixes);
  } catch (_) {
    return false;
  }
}
function chromeLikeTabs(win) {
  try {
    return win && win.tabs ? win.tabs() : [];
  } catch (_) {
    return [];
  }
}
function findChromeLikeTab(windows, expectedHosts, expectedUrlPrefixes, allowTabSearch) {
  const first = frontChromeLikeWindow(windows);
  const active = first && first.activeTab ? first.activeTab() : null;
  if (!expectedHosts || !expectedHosts.length || tabMatchesExpectedTarget(active, expectedHosts, expectedUrlPrefixes)) return active;
  if (!allowTabSearch) return active;
  for (let i = 0; i < windows.length; i += 1) {
    const tabs = chromeLikeTabs(windows[i]);
    for (let j = 0; j < tabs.length; j += 1) {
      if (tabMatchesExpectedTarget(tabs[j], expectedHosts, expectedUrlPrefixes)) return tabs[j];
    }
  }
  return active;
}
function chromeLikeExecute(appName, pageScript) {
  const app = Application(appName);
  if (!app.running()) return JSON.stringify({ ok: false, browserApp: appName, error: "browser_not_running" });
  const windows = app.windows();
  const expectedHosts = ${JSON.stringify(safeExpectedHosts)};
  const expectedUrlPrefixes = ${JSON.stringify(safeExpectedUrlPrefixes)};
  const allowTabSearch = ${JSON.stringify(allowTabSearch === true)};
  const tab = findChromeLikeTab(windows, expectedHosts, expectedUrlPrefixes, allowTabSearch);
  if (!tab) return JSON.stringify({ ok: false, browserApp: appName, error: "browser_active_tab_missing" });
  const pageResult = tab.execute({ javascript: pageScript });
  return JSON.stringify({ ok: true, browserApp: appName, pageResult: safeString(pageResult) });
}
function frontChromeLikeWindow(windows) {
  if (!windows || !windows.length) return null;
  for (let i = 0; i < windows.length; i += 1) {
    try {
      if (windows[i].index && Number(windows[i].index()) === 1) return windows[i];
    } catch (_) {
      // fall through to first window
    }
  }
  return windows[0] || null;
}
function safariExecute(pageScript) {
  const app = Application("Safari");
  if (!app.running()) return JSON.stringify({ ok: false, browserApp: "Safari", error: "browser_not_running" });
  const documents = app.documents();
  const first = documents && documents.length ? documents[0] : null;
  if (!first) return JSON.stringify({ ok: false, browserApp: "Safari", error: "browser_active_document_missing" });
  const pageResult = app.doJavaScript(pageScript, { in: first });
  return JSON.stringify({ ok: true, browserApp: "Safari", pageResult: safeString(pageResult) });
}
const appName = ${JSON.stringify(appName)};
const pageScript = ${JSON.stringify(pageScript)};
appName === "Safari" ? safariExecute(pageScript) : chromeLikeExecute(appName, pageScript);
`;
}

export function browserDomDryRun({ tool, args }) {
  const actions = normalizeBrowserDomActions(args.actions);
  const expectedHosts = browserDomExpectedHosts(args);
  const expectedUrlPrefixes = browserDomExpectedUrlPrefixes(args);
  const pageProbe = normalizeBrowserDomPageProbe(args.pageProbe, actions, expectedHosts, expectedUrlPrefixes);
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-dom-execute',
    extras: {
      valid: actions.length > 0,
      language: 'JavaScript',
      browserApp: clean(args.browserApp || args.app || 'Google Chrome', 120) || 'Google Chrome',
      actionCount: actions.length,
      actions: actions.map(browserDomActionPreview),
      expectedHosts,
      expectedUrlPrefixes,
      pageProbe,
      wouldRunOsaScript: true,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    },
  });
}

function parseBrowserDomPageResult(value = '') {
  if (value && typeof value === 'object') return safeJson(value);
  try {
    return JSON.parse(clean(value, 20_000));
  } catch {
    return null;
  }
}

function parseBrowserDomExecuteStdout(stdout = '') {
  let wrapper;
  try {
    wrapper = JSON.parse(clean(stdout, 20_000));
  } catch {
    return {
      ok: false,
      error: 'browser_dom_execution_output_parse_failed',
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    };
  }
  const page = parseBrowserDomPageResult(wrapper.pageResult || wrapper.page || wrapper.result);
  if (!page) {
    return {
      ok: false,
      browserApp: clean(wrapper.browserApp, 120),
      error: clean(wrapper.error || 'browser_dom_page_result_parse_failed', 500),
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    };
  }
  const actions = Array.isArray(page.actions) ? page.actions.slice(0, 20).map(sanitizeBrowserDomActionResult) : [];
  const pageReadiness = sanitizeBrowserDomPageReadiness(page.pageReadiness);
  const redactedUrl = redactBrowserUrl(page.url);
  const title = clean(page.title, 500);
  return {
    ok: wrapper.ok !== false && page.ok !== false && (!pageReadiness || pageReadiness.ok !== false),
    browserApp: clean(wrapper.browserApp, 120),
    host: clean(page.host, 240),
    urlPresent: Boolean(redactedUrl),
    urlSha256: redactedUrl ? sha256Text(redactedUrl) : '',
    titlePresent: Boolean(title),
    titleSha256: title ? sha256Text(title) : '',
    expectedHosts: Array.isArray(page.expectedHosts) ? page.expectedHosts.map((host) => clean(host, 240)).filter(Boolean) : [],
    expectedUrlPrefixes: Array.isArray(page.expectedUrlPrefixes) ? page.expectedUrlPrefixes.map((prefix) => clean(prefix, 2000)).filter(Boolean) : [],
    pageReadiness,
    actionCount: actions.length,
    actions,
    ...(page.error ? { error: clean(page.error, 500) } : {}),
    stdoutReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: page.pageContentReadByNoe === true, // L2：透传 page script 真实申报（读了正文才 true，不再硬编码 false）
    secretValuesReturned: false,
  };
}

export async function browserDomExecute({ args, root, deps }) {
  const actions = normalizeBrowserDomActions(args.actions);
  const browserApp = clean(args.browserApp || args.app || 'Google Chrome', 120) || 'Google Chrome';
  const expectedHosts = browserDomExpectedHosts(args);
  const expectedUrlPrefixes = browserDomExpectedUrlPrefixes(args);
  const pageProbe = normalizeBrowserDomPageProbe(args.pageProbe, actions, expectedHosts, expectedUrlPrefixes);
  if (!actions.length) return { ok: false, adapter: 'browser-dom-execute', error: 'browser_dom_actions_required' };
  const pageScript = buildBrowserDomPageScript({ actions, expectedHosts, expectedUrlPrefixes, pageProbe });
  const mutating = actions.some(browserDomActionMutates);
  const script = buildBrowserDomJxa({
    browserApp,
    pageScript,
    expectedHosts,
    expectedUrlPrefixes,
    allowTabSearch: !mutating || expectedUrlPrefixes.length > 0,
  });
  const out = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], { cwd: root, spawnImpl: deps.spawn || spawn });
  const parsed = out.ok ? parseBrowserDomExecuteStdout(out.stdout) : {};
  const { stdout: _stdout, ...safeProcess } = out;
  return {
    adapter: 'browser-dom-execute',
    language: 'JavaScript',
    browserApp,
    actionCount: actions.length,
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    stdoutReturned: false,
    ...safeProcess,
    ...parsed,
  };
}

export async function browserStateProbeExecute({ root, deps }) {
  const out = await runProcess('osascript', ['-l', 'JavaScript', '-e', BROWSER_STATE_PROBE_SCRIPT], { cwd: root, spawnImpl: deps.spawn || spawn });
  const parsed = out.ok ? parseBrowserStateProbe(out.stdout) : {};
  const { stdout: _stdout, ...safeProcess } = out;
  return {
    adapter: 'browser-state-probe',
    language: 'JavaScript',
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    stdoutReturned: false,
    ...safeProcess,
    ...parsed,
  };
}

export async function browserOpenExecute({ args, root, deps }) {
  const url = clean(args.url || args.href, 2000);
  const browserApp = clean(args.browserApp || args.app || '', 120);
  if (!/^https?:\/\//i.test(url)) return { ok: false, adapter: 'browser-open', error: 'browser_url_must_be_http' };
  const out = browserApp
    ? /safari/i.test(browserApp)
      ? await runProcess('osascript', ['-e', buildBrowserOpenScript({ browserApp, url })], { cwd: root, spawnImpl: deps.spawn || spawn })
      : await runProcess('open', ['-a', browserApp, url], { cwd: root, spawnImpl: deps.spawn || spawn })
    : await runProcess('open', [url], { cwd: root, spawnImpl: deps.spawn || spawn });
  return {
    ...out,
    adapter: 'browser-open',
    urlPreview: url,
    host: hostFromUrl(url),
    browserApp,
    browserOpenAttempted: true,
    desktopAutomationAttempted: Boolean(browserApp),
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
  };
}

function hasBrowserStateEvidence(browserState = {}) {
  const state = safeJson(browserState);
  if (!state || !Object.keys(state).length) return false;
  const candidates = [
    state,
    state.activeBrowser,
    ...(Array.isArray(state.browsers) ? state.browsers : []),
  ].filter(Boolean);
  return candidates.some((item) => Boolean(clean(item.url || item.activeUrl || item.title || item.app || item.browser, 1000)));
}

function browserStateProbeForInventory(probe = {}) {
  const safeProbe = safeJson(probe);
  return {
    frontmostApp: clean(safeProbe.frontmostApp, 160),
    activeBrowser: safeProbe.activeBrowser || null,
    browsers: Array.isArray(safeProbe.browsers) ? safeProbe.browsers : [],
  };
}

function summarizeBrowserStateProbe(probe = {}) {
  const safeProbe = safeJson(probe);
  return {
    ok: safeProbe.ok !== false,
    adapter: clean(safeProbe.adapter || 'browser-state-probe', 120),
    frontmostApp: clean(safeProbe.frontmostApp, 160),
    activeBrowser: safeProbe.activeBrowser ? {
      app: clean(safeProbe.activeBrowser.app, 120),
      url: redactBrowserUrl(safeProbe.activeBrowser.url),
      title: clean(safeProbe.activeBrowser.title, 500),
      frontmost: safeProbe.activeBrowser.frontmost === true,
    } : null,
    browserCount: Array.isArray(safeProbe.browsers) ? safeProbe.browsers.length : 0,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    secretValuesReturned: false,
    ...(safeProbe.error ? { error: redactDiagnosticText(safeProbe.error, 500) } : {}),
    ...(safeProbe.stderr ? { stderr: redactDiagnosticText(safeProbe.stderr, 500) } : {}),
  };
}

export async function accountConnectionInventoryRun({
  args = {},
  root,
  deps = {},
  realExecute = false,
} = {}) {
  const inputArgs = safeJson(args);
  const browserStateWasProvided = hasBrowserStateEvidence(inputArgs.browserState);
  const autoProbeEnabled = inputArgs.autoProbeBrowserState !== false && inputArgs.autoProbe !== false;
  let usedArgs = inputArgs;
  let probeSummary = null;
  let autoProbeUsed = false;
  const warnings = [];

  if (realExecute === true && !browserStateWasProvided && autoProbeEnabled) {
    try {
      const probe = await browserStateProbeExecute({ root, deps });
      probeSummary = summarizeBrowserStateProbe(probe);
      if (probeSummary.ok && (probeSummary.activeBrowser || probeSummary.browserCount > 0)) {
        usedArgs = {
          ...inputArgs,
          browserState: browserStateProbeForInventory(probe),
        };
        autoProbeUsed = true;
      } else {
        warnings.push(`browser_state_auto_probe_unavailable:${redactDiagnosticText(probeSummary.error || probeSummary.stderr || 'no_browser_state', 300)}`);
      }
    } catch (error) {
      probeSummary = {
        ok: false,
        adapter: 'browser-state-probe',
        error: redactDiagnosticText(error?.message || error, 500),
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        secretValuesReturned: false,
      };
      warnings.push(`browser_state_auto_probe_failed:${redactDiagnosticText(probeSummary.error, 300)}`);
    }
  }

  const base = buildNoeAccountConnectionInventory({ args: usedArgs, realExecute });
  const { sha256: _baseSha256, ...baseWithoutSha } = base;
  const enriched = {
    ...baseWithoutSha,
    warnings: [
      ...(Array.isArray(base.warnings) ? base.warnings : []),
      ...warnings,
    ],
    browserStateAutoProbe: {
      planned: realExecute !== true && !browserStateWasProvided && autoProbeEnabled,
      attempted: realExecute === true && !browserStateWasProvided && autoProbeEnabled,
      used: autoProbeUsed,
      source: autoProbeUsed ? 'noe.freedom.browser.state_probe' : (browserStateWasProvided ? 'provided' : 'none'),
      provided: browserStateWasProvided,
      probe: probeSummary,
    },
  };
  return {
    ...enriched,
    sha256: sha256Json({ ...enriched, sha256: undefined }),
  };
}
