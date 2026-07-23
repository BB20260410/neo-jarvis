// @ts-check
// ③ 能力自举（让 Neo 自主获取新能力）——搜索 + 评估 + 计划层（只读、安全、纯函数）。
//
// owner 愿景：Neo 能自主「察觉缺能力 → 上网搜需要的技能/插件/MCP/软件/工具 → 下载 → 安装 → 运用」。
// 本模块是【只读前半段】：上网搜候选(npm 包 / MCP server / github 仓) → 安全评估选型 → 构造获取计划。
// 真正的【下载安装】走 ActPipeline 高危 act(noe.capability.install) + standing grant + 沙箱验证
// （见 SafeActExecutors capability executor），与 self-evolution 同款多重安全门——
// 自动装第三方软件 = 供应链风险，必须 env 门控默认 OFF + owner 授权 + 装后验证 + 可回滚。
// 全注入式（webSearch 注入），不设硬超时（跑网络纪律）。

const NPM_PKG_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i; // 合法 npm 包名
const NPM_HOST_RE = /(?:\/\/)(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/?#]+)/i;
const GITHUB_RE = /github\.com\/([\w.-]+\/[\w.-]+?)(?:[/?#]|$)/i;

function cleanStr(v, max = 300) {
  return String(v ?? '').trim().slice(0, max);
}

// 从搜索结果命中提取能力候选（npm 包 / MCP server / github 仓）
function candidateFromHit(hit = {}) {
  const url = cleanStr(hit.link || hit.url, 500);
  const title = cleanStr(hit.title, 200);
  const snippet = cleanStr(hit.snippet || hit.description, 400);
  if (!url) return null;
  const npm = url.match(NPM_HOST_RE);
  if (npm) {
    const pkg = decodeURIComponent(npm[1]);
    if (NPM_PKG_RE.test(pkg)) {
      return { type: 'npm', name: pkg, source: 'npmjs.com', installSpec: pkg, url, title, snippet, key: `npm:${pkg}` };
    }
  }
  const gh = url.match(GITHUB_RE);
  if (gh && /\bmcp\b|model context protocol|server|tool|plugin/i.test(`${title} ${snippet}`)) {
    return { type: 'mcp_or_repo', name: gh[1], source: 'github.com', installSpec: gh[1], url, title, snippet, key: `gh:${gh[1]}` };
  }
  return null;
}

function buildQueries(need, kind) {
  if (kind === 'npm') return [`${need} npm package`, `npm package for ${need}`];
  if (kind === 'mcp') return [`${need} MCP server`, `model context protocol server ${need}`];
  return [`${need} npm package`, `${need} MCP server`, `open source tool for ${need}`];
}

export function createNoeCapabilityAcquisition({ webSearch = null } = {}) {
  // 察觉缺能力 → 上网搜候选（只读，安全）。
  async function searchCapability({ need = '', kind = 'any', limit = 6 } = {}) {
    const q = cleanStr(need, 200);
    if (!q) return { ok: false, error: 'need_required', candidates: [] };
    if (!webSearch || typeof webSearch.search !== 'function') {
      return { ok: false, error: 'web_search_unavailable', candidates: [] };
    }
    const seen = new Set();
    const candidates = [];
    for (const query of buildQueries(q, kind)) {
      let hits = [];
      try { hits = await webSearch.search(query, { count: limit }); } catch { hits = []; }
      for (const h of (Array.isArray(hits) ? hits : [])) {
        const c = candidateFromHit(h);
        if (c && !seen.has(c.key)) { seen.add(c.key); candidates.push(c); }
      }
    }
    return { ok: true, need: q, kind, candidates: candidates.slice(0, Math.max(1, limit * 2)) };
  }

  // 安全评估：源白名单（npmjs.com / github.com）+ 包名合法性 + 拒可疑/不支持类型。
  function assessCandidate(candidate = {}) {
    const reasons = [];
    const type = cleanStr(candidate.type, 40);
    const name = cleanStr(candidate.name, 200);
    if (!name) reasons.push('name_required');
    if (type === 'npm') {
      if (!NPM_PKG_RE.test(name)) reasons.push('invalid_npm_name');
      if (candidate.source !== 'npmjs.com') reasons.push('untrusted_source');
    } else if (type === 'mcp_or_repo') {
      if (candidate.source !== 'github.com') reasons.push('untrusted_source');
    } else {
      reasons.push(`unsupported_type:${type || 'blank'}`);
    }
    return { ok: reasons.length === 0, safe: reasons.length === 0, reasons, candidate };
  }

  // 构造获取计划（给 ActPipeline 高危 act 的 payload）——不在此执行，执行经 gate + grant + executor。
  function planAcquisition(candidate = {}) {
    const assessed = assessCandidate(candidate);
    if (!assessed.ok) return { ok: false, errors: assessed.reasons };
    return {
      ok: true,
      capability: {
        type: candidate.type,
        name: candidate.name,
        installSpec: cleanStr(candidate.installSpec || candidate.name, 200),
        source: candidate.source,
        installAction: candidate.type === 'npm' ? 'npm_install' : 'mcp_register',
      },
      requiresOwnerOrStandingGrant: true,
      sandboxVerifyRequired: true,
    };
  }

  return { searchCapability, assessCandidate, planAcquisition };
}
