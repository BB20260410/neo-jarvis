// @ts-check
// NoeBrowserActPolicy（P4-1）——浏览器/动手 act 的安全策略：① NetworkPolicy 域白名单（opt-in，owner 不设
// 则开放=最大自由；设了才按白名单拦非白名单域）② 高危操作分类闸（守红线 5：对外发布/支付/Merge PR/登录提交
// 等破坏性写操作必须停下二次确认）。
//
// 注意：高危确认不是「限制 Neo 自由」，是 owner 自己的红线 5（对外发布/支付/Merge PR/登录提交确认），对人对
// AI 同等适用——发出去/付出去/改公开历史追不回。读/普通写不拦。纯函数、确定性、可单测。

// 破坏性/红线-5 高危：对外发布 / 支付 / Merge PR / 登录密码提交 / 删除。
// 红队修复：补 buy/place order/transfer funds/send money/购买 等支付变体；merge 扩到 GitHub 实际按钮文案
//   （approve and merge / squash and merge / confirm merge / merge pull request）+ 裸「合并」。红线-5 宁可多确认。
const DESTRUCTIVE_RE = /\b(publish|deploy|release|pay|payment|purchase|buy|place\s+order|checkout|charge|subscribe|transfer\s+funds|send\s+money|wire[\s_-]*transfer|delete|destroy|remove\s+repo|force[\s_-]*push)\b|(?:approve|squash|rebase|confirm)[\s\S]{0,12}merge|\bmerge[\s_-]*(pr|pull|request|branch)|\band\s+merge\b|发布|上架|支付|付款|购买|下单|结账|订阅|删除|合并|强制推送|转账|汇款/i;
// 登录/凭据提交（提交账号密码 = 红线，可能触发风控/泄漏）。
const CREDENTIAL_SUBMIT_RE = /\b(login|sign[\s_-]*in|log[\s_-]*in|submit.*(password|credential|otp|2fa|verification)|enter.*password)\b|登录|登入|提交.*(密码|验证码|凭据)|输入.*密码/i;
// 普通写操作（点击/输入/上传/发送），非破坏性。
const WRITE_RE = /\b(click|type|fill|input|submit|post|upload|send|select|check|drag|press)\b|点击|输入|填写|提交|上传|发送|选择|勾选/i;

function hostnameOf(url = '') {
  const s = String(url || '').trim();
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    return u.hostname.toLowerCase();
  } catch { return ''; }
}

// 域白名单（后缀匹配：example.com 命中 www.example.com / a.example.com）。
export function checkDomainAllowed(url, allowlist = []) {
  const list = (Array.isArray(allowlist) ? allowlist : []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return { allowed: true, reason: 'no_policy' }; // 未设白名单=开放（owner 最大自由，opt-in 才拦）
  const host = hostnameOf(url);
  if (!host) return { allowed: false, reason: 'unparseable_url' };
  const hit = list.some((d) => host === d || host.endsWith(`.${d}`));
  return hit ? { allowed: true, reason: 'allowlisted', host } : { allowed: false, reason: 'domain_not_in_allowlist', host };
}

// 操作风险分级：read（导航/抽取/截图）/ write（点击输入）/ destructive（发布/支付/Merge PR/登录提交）。
export function classifyBrowserActionRisk(action = '', payload = {}) {
  const text = `${String(action || '')} ${JSON.stringify(payload || {})}`;
  if (DESTRUCTIVE_RE.test(text)) return { tier: 'destructive', highRisk: true, reason: 'destructive_or_publish_or_pay_or_mergepr' };
  if (CREDENTIAL_SUBMIT_RE.test(text)) return { tier: 'destructive', highRisk: true, reason: 'credential_or_login_submit' };
  if (WRITE_RE.test(text)) return { tier: 'write', highRisk: false, reason: 'ordinary_write' };
  return { tier: 'read', highRisk: false, reason: 'read_only' };
}

/**
 * 综合评估一个浏览器 act：域白名单 + 风险分级 → 是否放行 / 是否需二次确认。
 * @returns {{ok:boolean, allowed:boolean, requiresConfirm:boolean, tier:string, domain:object, risk:object, reason:string}}
 */
export function evaluateBrowserAct({ action = '', url = '', payload = {}, allowlist = [] } = {}) {
  const domain = checkDomainAllowed(url, allowlist);
  const risk = classifyBrowserActionRisk(action, payload);
  if (!domain.allowed) {
    return { ok: true, allowed: false, requiresConfirm: false, tier: risk.tier, domain, risk, reason: `network_policy_blocked:${domain.reason}` };
  }
  // 高危（红线 5）→ 放行但必须停下二次确认（不自动执行）。
  if (risk.highRisk) {
    return { ok: true, allowed: true, requiresConfirm: true, tier: risk.tier, domain, risk, reason: `requires_owner_confirm:${risk.reason}` };
  }
  return { ok: true, allowed: true, requiresConfirm: false, tier: risk.tier, domain, risk, reason: 'ok' };
}
