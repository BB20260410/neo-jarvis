// @ts-check
// NoeSkillScanner — skill 内容安全扫描（蒸馏自 OpenClaw src/skills/security/scanner.ts，按 Neo 架构重写）。
//
// 为什么存在：AutoSkillExtractor 默认 ON，从对话自动提炼 skill 写盘；skill body 会被全量注入 system prompt
//   （skillInjector）。一条被诱导/恶意内容的 skill = 持续 prompt-injection 攻击面（每次对话都重新注入）。
//   本模块在写盘/应用前扫 body：critical=拒写/隔离，warn=标记不拦（容误报）。纯本地正则、零外部依赖。
//
// 与 NoeContextScrubber（只做 secret redact）正交：那个防 secret 外泄，这个防恶意/被诱导内容进 skill。

// 注：启发式正则，挡常见明文 prompt-injection，但变体/编码/零宽字符仍可能绕过（codex 复核已知）；
//   这是 flag 默认 OFF 的纵深一层，不是完整防线。owner kickstart 后遇误报可调规则。
const INJECTION_RULES = [
  { rule: 'ignore-instructions-zh', level: 'critical', re: /(忽略|无视|忘记|不要遵守|别管)(以上|之前|前面|上述|前述|先前)(的)?(所有)?(指令|指示|规则|提示|要求|设定)/ },
  { rule: 'ignore-instructions-en', level: 'critical', re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions|prompts|rules|directives)/i },
  { rule: 'new-system-message', level: 'critical', re: /(new\s+system\s+(message|prompt)|你现在开始(只)?(听|遵守|执行)(下面|以下)|从现在起(只)?(按|听|遵守)(下面|以下|我说的))/i },
  { rule: 'override-system', level: 'critical', re: /(覆盖|无视|绕过|关掉)(系统|安全)(提示|规则|限制|约束)|override\s+(the\s+)?system\s+prompt|disregard\s+(your\s+)?(guidelines|safety)/i },
  { rule: 'reveal-prompt', level: 'warn', re: /(泄露|打印|输出|告诉我).{0,8}(系统提示词?|system\s*prompt)|(reveal|print|show)\s+(me\s+)?(your\s+)?(system\s+)?prompt/i },
];
const EXFIL_RULES = [
  { rule: 'env-to-network', level: 'critical', re: /(process\.env|\$\{?[A-Z_]*(KEY|TOKEN|SECRET)|\.env\b)[\s\S]{0,48}(curl|fetch|https?:|发送|上传|post\b)/i },
  { rule: 'send-secret', level: 'critical', re: /(把|将|发送|上传|send|exfiltrate|leak)[\s\S]{0,24}(密钥|凭据|口令|token|api[\s_-]?key|credential|password)[\s\S]{0,24}(到|给|发到|to\s|外部|external)/i },
  { rule: 'curl-pipe-sh', level: 'critical', re: /\bcurl\s+[^\n|]*\|\s*(sh|bash|zsh)\b/i },
];
const DANGER_RULES = [
  { rule: 'rm-rf-root', level: 'critical', re: /\brm\s+-[rf]{1,2}\s+(\/(\s|$)|~(\/|\s|$)|\$HOME)/i },
  { rule: 'chmod-777-system', level: 'warn', re: /chmod\s+777\s+\/(etc|usr|bin|System|Library)/i },
  { rule: 'disable-security', level: 'warn', re: /(关闭|禁用|disable|turn\s+off)[\s]{0,4}(防火墙|firewall|\bsip\b|gatekeeper|代理|proxy)/i },
];
const ALL_RULES = [...INJECTION_RULES, ...EXFIL_RULES, ...DANGER_RULES];

// 扫描 skill body：返回 { critical, warn, findings }；findings 每条 { level, rule, snippet }。
// rules 可注入便于测试/扩展。
export function scanSkillContent(text, { rules = ALL_RULES } = {}) {
  const s = String(text || '');
  const findings = [];
  for (const r of rules) {
    const m = s.match(r.re);
    if (m) findings.push({ level: r.level, rule: r.rule, snippet: String(m[0]).replace(/\s+/g, ' ').slice(0, 80) });
  }
  return {
    critical: findings.some((f) => f.level === 'critical'),
    warn: findings.some((f) => f.level === 'warn'),
    findings,
  };
}

// 便捷：是否应拒绝写入（flag 默认 OFF，开启后 critical 才拒）。供 SkillStore/DraftApply/AutoExtractor 接入。
export function shouldBlockSkill(text, { enabled = process.env.NOE_SKILL_SCAN === '1' } = {}) {
  if (!enabled) return { blocked: false, scan: null };
  const scan = scanSkillContent(text);
  return { blocked: scan.critical, scan };
}
