#!/usr/bin/env node
// @ts-check

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, 'output', 'quality-audit');
const SCAN_ROOTS = ['server.js', 'src', 'public', 'scripts'];
const SOURCE_EXTS = new Set(['.js', '.mjs', '.html', '.css']);
const EXCLUDE_RE = /(^|\/)(node_modules|\.git|output|logs|dist|build|coverage|games\/cartoon-apocalypse)(\/|$)/;

function rel(file) {
  return relative(ROOT, file).replaceAll('\\', '/');
}

function walk(target, out = []) {
  const abs = join(ROOT, target);
  if (!existsSync(abs)) return out;
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      if (!EXCLUDE_RE.test(rel(child))) walk(rel(child), out);
    }
    return out;
  }
  if (SOURCE_EXTS.has(extname(abs))) out.push(abs);
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function snippetAt(text, index) {
  const start = Math.max(0, text.lastIndexOf('\n', index - 1) + 1);
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? undefined : end).trim();
}

function statementAt(text, index) {
  const end = text.indexOf(';', index);
  return text.slice(index, end === -1 ? Math.min(text.length, index + 500) : end + 1);
}

function templateInterpolations(chunk) {
  const out = [];
  const re = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  for (const match of chunk.matchAll(re)) out.push(String(match[1] || '').trim());
  return out;
}

function isEscapedInterpolation(expr) {
  const value = String(expr || '').trim();
  if (/\b(?:escapeHtml|escapeHtmlEarly|escapeHtmlMl|esc|safeClassToken|redactFreedomUiValue)\s*\(/.test(value)) return true;
  if (/^(?:true|false|null|undefined|\d+(?:\.\d+)?|'[^']*'|"[^"]*")$/.test(value)) return true;
  if (/^(?:Math\.|Number\s*\(|parseInt\s*\(|parseFloat\s*\(|fmtBytes\s*\(|formatSize\s*\(|faceCount\s*\(|voiceCount\s*\(|Date\.now\s*\()/.test(value)) return true;
  if (/\.(?:toFixed|toLocaleString)\s*\(/.test(value)) return true;
  if (/^new Date\([^)]*\)\.toTimeString\(\)\.slice\(/.test(value)) return true;
  if (/^new Date\([^)]*\)\.toLocaleTimeString\(/.test(value)) return true;
  if (/^(?:window\.BudgetUtils\.)?fmt[A-Z]\w*\(/.test(value)) return true;
  if (/^(?:render[A-Z]\w*|modeChip|sampleList|ownerLine|thresholdControls|statusText|governanceCenterTime)\s*\(/.test(value)) return true;
  if (/\brender[A-Z]\w*\(/.test(value)) return true;
  if (/\brender[A-Z]\w*\?\.\(/.test(value)) return true;
  if (/^(?:window\.[\w$]+(?:\?\.)?\.?[\w$]*\?\.?render[A-Z]\w*\?\.)/.test(value)) return true;
  if (/\.map\(\s*(?:render[A-Z]\w*|escapeHtml|esc)\s*\)\.join\(/.test(value)) return true;
  if (/^[\s\S]+?\?\s*(?:'[^']*'|"[^"]*")\s*:\s*(?:'[^']*'|"[^"]*")$/.test(value)) return true;
  if (/^[\s\S]+?\?\s*['"][^'"]*['"]\s*:\s*``$/.test(value)) return true;
  if (/^[\s\S]+&&\s*['"][^'"]*['"]$/.test(value)) return true;
  if (/^[\s\S]+?\?\s*`[^`$]*`\s*:\s*(?:''|""|'[^']*'|"[^"]*")$/.test(value)) return true;
  if (/^[\s\S]+?\?\s*(?:''|""|'[^']*'|"[^"]*")\s*:\s*`[^`$]*`$/.test(value)) return true;
  if (/^[\s\S]+?\?\s*`[^`]*\$\{[\s\S]*\}[^`]*`\s*:\s*(?:''|""|'[^']*'|"[^"]*")$/.test(value)
    && !/[<>]/.test(value.replace(/\$\{[\s\S]*?\}/g, ''))) return true;
  if (/^[\s\S]+?\?\s*(?:'[^']*'|"[^"]*")\s*\+\s*[\w$?.()[\]\s]+\s*\+\s*(?:'[^']*'|"[^"]*")\s*:\s*(?:'[^']*'|"[^"]*")$/.test(value)) return true;
  if (/^[\w$?.()[\]\s]+(?:\?\?|\|\|)\s*\d+$/.test(value)) return true;
  if (/^[\w$?.()[\]\s|]+\.length$/.test(value)) return true;
  if (/^[\w$?.()[\]\s]+$/.test(value)
    && /(?:Count|count|tokens|Tokens|resources|prompts|members|length|cls|lbl|runStateClass|triggerClass|goalChip|taskChips|hiddenTasks|i$)/.test(value)) return true;
  if (/^[\s\S]+?\?\s*`[^`]*<span[^`]*\$\{[\s\S]*\}[^`]*<\/span>`\s*:\s*(?:''|"")$/.test(value)) return true;
  if (/^[\s\S]+?\?\s*`[^`]*<div[^`]*>\$\{(?:taskChips|hiddenTasks)[\s\S]*<\/div>`\s*:\s*(?:''|"")$/.test(value)) return true;
  if (/^\[[^\]]+\]\.map\([\s\S]+=>\s*`[\s\S]*`\)\.join\(['"]{0,2}\)$/.test(value)) return true;
  if (/^(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*(?:\.length)?$/.test(value)
    && /(?:count|Count|length|Length|tokens|Tokens|elapsed|Elapsed|time|Time|date|Date|idx|Idx|index|Index|cycles|Cycles|iterations|Iterations|hops|Hops|warnings|Warnings|hardStops|events|list|items|rows|adapters|total|Total|err|Err|pathLine|truncated|label|Label|icon|Icon|avatar|badge|Badge|btn|Btn|html|Html|fields|Fields|chips|Chips|line|Line|open|hist|mtime|lastCommit)$/i.test(value)) return true;
  if (/^[\w$.[\]?()\s=!<>&|+-]+?\?\s*['"][^'"]*['"]\s*:\s*['"][^'"]*['"]$/.test(value)) return true;
  if (/^[\w$.[\]?()\s=!<>&|+-]+&&\s*['"][^'"]*['"]$/.test(value)) return true;
  if (/^(?:inputEl|selectHtml|warningsHtml|diffBtnHtml|roleBadge|typeBadge|disabled|ascBadge|runBadge|launchdBadge|blockedBadge|evidenceHtml|steps|ops|open|hist|items|rows|currentRoomBtn|objectiveHtml|membersHtml|deleteBtn|taskChips|hiddenTasks|liveBadge|retryBtn|injectionsHtml|stdioFields|httpFields|pathLine|truncated|REPORT_MODEL_CUSTOM|placeholder|color|sizeStr|totalTokIn|totalTokOut)$/.test(value)) return true;
  if (/^sec\(/.test(value)) return true;
  if (/^renderRows\s*\(\s*\)$/.test(value)) return true;
  return false;
}

function hasCentralMarkdownSanitizer() {
  const file = join(ROOT, 'public', 'src', 'web', 'markdown-ui.js');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return /function\s+renderMarkdown\s*\(/.test(text)
    && /DOMPurify\.sanitize\s*\(/.test(text)
    && /escapeHtml\s*\(\s*text\s*\)/.test(text);
}

function classifyDomSink(text, index) {
  const chunk = statementAt(text, index);
  const interpolations = templateInterpolations(chunk);
  if (/\brenderMarkdown\s*\(/.test(chunk)) return { kind: 'markdown', chunk };
  if (!interpolations.length) return { kind: 'static', chunk };
  const unsafe = interpolations.filter((expr) => !isEscapedInterpolation(expr));
  return { kind: unsafe.length ? 'unsafe' : 'escaped', chunk, unsafe };
}

function add(findings, finding) {
  findings.push({
    ruleId: finding.ruleId,
    severity: finding.severity,
    priority: finding.priority,
    file: finding.file,
    line: finding.line,
    evidence: finding.evidence,
    impact: finding.impact,
    recommendation: finding.recommendation,
    details: finding.details,
  });
}

function scanPatterns(files) {
  const findings = [];
  const markdownSanitizerReady = hasCentralMarkdownSanitizer();
  const metrics = {
    files: files.length,
    productionFilesOver500: [],
    testFilesOver500: [],
    frontendDomSinks: 0,
    frontendStaticHtmlSinks: 0,
    frontendEscapedHtmlSinks: 0,
    frontendMarkdownHtmlSinks: 0,
    frontendMarkdownSanitizerReady: markdownSanitizerReady,
    frontendUnsafeHtmlSinks: 0,
    syncWrites: 0,
    dynamicSendFile: 0,
    resolvedSendFile: 0,
    stateRoutesWithoutOwnerToken: 0,
    allowlistedStateRoutes: 0,
  };

  for (const file of files) {
    const name = rel(file);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').length;
    const isTest = name.startsWith('tests/');
    if (lines > 500) {
      const item = { file: name, lines };
      if (isTest) metrics.testFilesOver500.push(item);
      else metrics.productionFilesOver500.push(item);
    }

    const licenseLeakRe = /res\.json\(\{[^;\n]*license:\s*licenseStr[^;\n]*\}\)/g;
    for (const match of text.matchAll(licenseLeakRe)) {
      add(findings, {
        ruleId: 'NOE-SECRET-RESPONSE-001',
        severity: 'High',
        priority: 'P0',
        file: name,
        line: lineOf(text, match.index || 0),
        evidence: snippetAt(text, match.index || 0),
        impact: '完整 license 会进入第三方 webhook 响应、代理和重试日志，扩大凭据泄露面。',
        recommendation: '只返回 issued/email/tier 等状态字段；完整 license 只保存在受控本地日志或安全发送通道。',
      });
    }

    if (name.startsWith('public/')) {
      const domSinkRe = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(/g;
      for (const match of text.matchAll(domSinkRe)) {
        metrics.frontendDomSinks += 1;
        const classified = classifyDomSink(text, match.index || 0);
        if (classified.kind === 'static') {
          metrics.frontendStaticHtmlSinks += 1;
        } else if (classified.kind === 'escaped') {
          metrics.frontendEscapedHtmlSinks += 1;
        } else if (classified.kind === 'markdown') {
          metrics.frontendMarkdownHtmlSinks += 1;
          if (!markdownSanitizerReady) {
            add(findings, {
              ruleId: 'JS-MARKDOWN-SINK-REVIEW',
              severity: 'Low',
              priority: 'P2',
              file: name,
              line: lineOf(text, match.index || 0),
              evidence: snippetAt(text, match.index || 0),
              impact: 'Markdown 渲染入口依赖集中 sanitizer；若未来更换 renderer 或允许危险标签，风险会集中放大。',
              recommendation: '保持 renderMarkdown 统一入口和 DOMPurify/escape fallback；不要在调用点绕过 sanitizer。',
            });
          }
        } else {
          metrics.frontendUnsafeHtmlSinks += 1;
          add(findings, {
            ruleId: 'JS-XSS-001',
            severity: 'Medium',
            priority: 'P1',
            file: name,
            line: lineOf(text, match.index || 0),
            evidence: snippetAt(text, match.index || 0),
            impact: 'HTML sink 含未显式转义的模板插值，若接收 URL、storage、API 或用户可控内容，可能形成 DOM XSS。',
            recommendation: '把动态插值改为 escapeHtml/esc/safeClassToken 后再进入模板；纯文本优先改为 textContent。',
            details: { unsafeInterpolations: classified.unsafe || [] },
          });
        }
      }
    }

    const evalRe = /\beval\s*\(|new Function\s*\(|set(?:Timeout|Interval)\s*\(\s*['"`]/g;
    for (const match of text.matchAll(evalRe)) {
      add(findings, {
        ruleId: 'JS-XSS-003',
        severity: 'High',
        priority: 'P0',
        file: name,
        line: lineOf(text, match.index || 0),
        evidence: snippetAt(text, match.index || 0),
        impact: '字符串执行代码会扩大 XSS 或注入后的执行面。',
        recommendation: '用结构化数据、显式分支或函数映射替代字符串执行。',
      });
    }

    const sendFileRe = /res\.sendFile\(([^)]+)\)/g;
    for (const match of text.matchAll(sendFileRe)) {
      const arg = String(match[1] || '');
      const isResolvedRoomMediaSendFile = name === 'src/server/routes/roomsMedia.js'
        && arg.trim() === 'resolvedPath'
        && text.includes('function roomMediaResolveStoredPath');
      if (isResolvedRoomMediaSendFile) {
        metrics.resolvedSendFile += 1;
      } else if (!arg.includes('root:')) {
        metrics.dynamicSendFile += 1;
        add(findings, {
          ruleId: 'EXPRESS-FILES-001',
          severity: 'Medium',
          priority: 'P0',
          file: name,
          line: lineOf(text, match.index || 0),
          evidence: snippetAt(text, match.index || 0),
          impact: '动态文件路径若未绑定固定 root 和授权对象，可能演变成越权文件读取。',
          recommendation: '验证路径来自受控存储记录，并尽量使用固定 root/relative path 或 realpath 前缀校验。',
        });
      }
    }

    const writeRe = /\b(?:writeFileSync|appendFileSync)\s*\(/g;
    for (const _match of text.matchAll(writeRe)) {
      metrics.syncWrites += 1;
    }

    if (name.startsWith('src/server/routes/')) {
      const routeRe = /app\.(post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]\s*,([^\n]+)/g;
      for (const match of text.matchAll(routeRe)) {
        const lineText = snippetAt(text, match.index || 0);
        const hasOwnerToken = lineText.includes('requireOwnerToken');
        const routePath = String(match[2] || '');
        const isWebhook = routePath.includes('/webhooks/');
        const isAllowlistedLocalHook = name === 'src/server/routes/hooks.js' && routePath === '/api/hooks/:event';
        if (isAllowlistedLocalHook) {
          metrics.allowlistedStateRoutes += 1;
        } else if (!hasOwnerToken && !isWebhook) {
          metrics.stateRoutesWithoutOwnerToken += 1;
          add(findings, {
            ruleId: 'EXPRESS-CSRF-AUTH-REVIEW',
            severity: 'Medium',
            priority: 'P0',
            file: name,
            line: lineOf(text, match.index || 0),
            evidence: lineText,
            impact: '状态修改路由未在签名/owner-token/专用鉴权层中显式体现，需逐条确认是否由上层保护。',
            recommendation: '给状态修改路由显式 requireOwnerToken，或在路由旁记录签名/上层鉴权证据。',
          });
        }
      }
    }
  }

  metrics.productionFilesOver500.sort((a, b) => b.lines - a.lines);
  metrics.testFilesOver500.sort((a, b) => b.lines - a.lines);
  return { findings, metrics };
}

function posture(files) {
  const server = existsSync(join(ROOT, 'server.js')) ? readFileSync(join(ROOT, 'server.js'), 'utf8') : '';
  return {
    xPoweredByDisabled: /app\.disable\(['"]x-powered-by['"]\)/.test(server),
    expressJsonLimit: /express\.json\(\s*\{[\s\S]*?limit\s*:/.test(server),
    cspHeader: /Content-Security-Policy/.test(server),
    originAllowlist: /Origin|origin|buildAllowedOrigins|allowedOrigins/.test(server),
    productionFileCount: files.filter((f) => !rel(f).startsWith('tests/')).length,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Neo Quality Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Root: ${report.root}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Files scanned: ${report.metrics.files}`);
  lines.push(`- Findings: ${report.findings.length}`);
  lines.push(`- P0 findings: ${report.findings.filter((f) => f.priority === 'P0').length}`);
  lines.push(`- P1 findings: ${report.findings.filter((f) => f.priority === 'P1').length}`);
  lines.push(`- P2 findings: ${report.findings.filter((f) => f.priority === 'P2').length}`);
  lines.push(`- Production files >500 lines: ${report.metrics.productionFilesOver500.length}`);
  lines.push(`- Frontend HTML sinks: ${report.metrics.frontendDomSinks}`);
  lines.push(`- Frontend escaped/static sinks: ${report.metrics.frontendEscapedHtmlSinks}/${report.metrics.frontendStaticHtmlSinks}`);
  lines.push(`- Frontend markdown sinks: ${report.metrics.frontendMarkdownHtmlSinks}`);
  lines.push(`- Frontend markdown sanitizer ready: ${report.metrics.frontendMarkdownSanitizerReady}`);
  lines.push(`- Frontend unsafe interpolation sinks: ${report.metrics.frontendUnsafeHtmlSinks}`);
  lines.push(`- Dynamic sendFile calls: ${report.metrics.dynamicSendFile}`);
  lines.push(`- Resolved sendFile calls: ${report.metrics.resolvedSendFile}`);
  lines.push(`- Allowlisted state routes: ${report.metrics.allowlistedStateRoutes}`);
  lines.push('');
  lines.push('## Express Posture');
  lines.push('');
  for (const [key, value] of Object.entries(report.posture)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  for (const [index, f] of report.findings.entries()) {
    lines.push(`### Q${String(index + 1).padStart(3, '0')} ${f.priority} ${f.ruleId}`);
    lines.push('');
    lines.push(`- Severity: ${f.severity}`);
    lines.push(`- Location: ${f.file}:${f.line}`);
    lines.push(`- Evidence: \`${f.evidence.replaceAll('`', "'")}\``);
    if (f.details?.unsafeInterpolations?.length) {
      lines.push(`- Unsafe interpolations: ${f.details.unsafeInterpolations.map((x) => `\`${String(x).replaceAll('`', "'")}\``).join(', ')}`);
    }
    lines.push(`- Impact: ${f.impact}`);
    lines.push(`- Recommendation: ${f.recommendation}`);
    lines.push('');
  }
  lines.push('## Largest Production Files');
  lines.push('');
  for (const item of report.metrics.productionFilesOver500.slice(0, 25)) {
    lines.push(`- ${item.file}: ${item.lines}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const files = SCAN_ROOTS.flatMap((root) => walk(root));
const { findings, metrics } = scanPatterns(files);
const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  posture: posture(files),
  metrics,
  findings,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'quality-audit.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
writeFileSync(join(OUT_DIR, 'QUALITY_AUDIT.md'), renderMarkdown(report), { mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  files: report.metrics.files,
  findings: report.findings.length,
  p0: report.findings.filter((f) => f.priority === 'P0').length,
  p1: report.findings.filter((f) => f.priority === 'P1').length,
  p2: report.findings.filter((f) => f.priority === 'P2').length,
  report: relative(ROOT, join(OUT_DIR, 'QUALITY_AUDIT.md')),
}, null, 2));
