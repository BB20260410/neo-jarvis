// @ts-check

function text(value, max = 4000) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function listValues(collection) {
  if (!collection) return [];
  return Array.isArray(collection) ? collection : Object.values(collection);
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const STATUS_CN = {
  available: '可用',
  configured_unavailable: '已配置但不可用',
  missing: '缺失',
  not_configured: '未配置',
  unknown: '未知',
};

const CHANNEL_CN = {
  qq: '扣扣',
  qq_official: '扣扣官方回调',
  wechat_clawbot: '个人微信',
  wechat_official: '微信公众号',
  wecom: '企业微信',
  feishu: '飞书',
  discord: '外部聊天通道',
};

function cnStatus(value) {
  const raw = text(value, 80);
  return STATUS_CN[raw] || (/^[A-Za-z0-9_-]+$/.test(raw) ? '状态已记录' : raw.replace(/_/g, ' '));
}

function cnChannel(value) {
  const raw = text(value, 80);
  return CHANNEL_CN[raw] || (/^[A-Za-z0-9_-]+$/.test(raw) ? '社交通道' : raw);
}

function credentialLabel(value) {
  const raw = text(value, 80);
  const mapped = {
    wechatOfficialToken: '微信公众号凭据',
    appSecret: '应用密钥',
    appId: '应用编号',
    botToken: '机器人凭据',
    signingSecret: '签名凭据',
  };
  return mapped[raw] || (/^[A-Za-z0-9_-]+$/.test(raw) ? '凭据' : raw || '凭据');
}

function cnReason(value, fallback = '原因已记录') {
  const raw = text(value, 160);
  if (!raw) return fallback;
  const mapped = {
    configured: '已配置',
    qq_bot_app_secret_not_configured: '扣扣应用密钥未配置',
    missing_owner_visible_evidence: '缺少主人可见证据',
    owner_visible_evidence_required: '需要主人可见证据',
  };
  return mapped[raw] || (/[A-Za-z]{3,}/.test(raw) ? fallback : raw);
}

function endpointLabel(key) {
  const mapped = {
    wechatOfficial: '微信公众号',
    qqPreview: '扣扣预演',
    wechatPersonal: '个人微信',
    wecomIncoming: '企业微信',
    feishuVerification: '飞书验证',
    discordGateway: '外部聊天通道',
  };
  return mapped[key] || (/^[A-Za-z0-9_-]+$/.test(String(key || '')) ? '接口' : String(key || '接口'));
}

function statusLine(record = {}) {
  const id = credentialLabel(record.label || record.id || '凭据');
  const rawStatus = text(record.status || (record.available ? 'available' : 'missing'), 80);
  const status = cnStatus(rawStatus);
  const key = text(record.key || (Array.isArray(record.aliases) ? record.aliases[0] : ''), 120);
  const reason = cnReason(record.reason || '', '');
  return `${id}：${status}${key ? '（凭据名已记录）' : ''}${reason ? ` · ${reason}` : ''}`;
}

function endpointLines(label, endpoints = {}) {
  const rows = Object.entries(endpoints || {})
    .map(([key, value]) => `${endpointLabel(key)}：${text(value, 200)}`)
    .filter((line) => !/secret|token=/i.test(line));
  return rows.length ? [`${label}:`, ...rows.map((line) => `- ${line}`)] : [];
}

export function buildSocialIntegrationChecklist(social = {}) {
  const readiness = social.readiness || {};
  const socialSummary = readiness.credentialSummary || {};
  const qq = social.qq || {};
  const qqSummary = qq.credentialSummary || qq.credentials?.credentialSummary || {};
  const blockers = Array.isArray(qq.blockers) ? qq.blockers.map((item) => cnReason(item, '')).filter(Boolean) : [];
  return [
    '诺伊社交入站接入清单',
    `社交凭据：${count(socialSummary.available)}/${count(socialSummary.total)} 可用；${count(socialSummary.configuredUnavailable)} 已配置但不可用；${count(socialSummary.missing)} 缺失`,
    ...listValues(readiness.credentialStatuses).map((record) => `- ${statusLine(record)}`),
    `扣扣凭据：${count(qqSummary.available)}/${count(qqSummary.total)} 可用；真实回调 ${qq.readyForLiveWebhook === true ? '就绪' : '未就绪'}；预演 ${qq.readyForDryRun === true ? '就绪' : '未就绪'}`,
    ...listValues(qq.credentials?.credentialStatuses).map((record) => `- 扣扣 ${statusLine(record)}`),
    blockers.length ? `扣扣阻塞：${blockers.join('，')}` : '扣扣阻塞：无',
    `个人微信：${cnStatus(social.wechatPersonal?.loginState || '未知')}；需要主人可见证据 ${social.wechatPersonal?.ownerVisibleEvidenceRequired === true ? '是' : '否'}`,
    ...endpointLines('公开接口', social.publicEndpoints),
    ...endpointLines('主人接口', social.ownerEndpoints),
    '秘密值：未返回',
  ].join('\n');
}

export function buildQqPreviewEvent(seed = Date.now()) {
  return {
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: `noe-earth-preview-${seed}`,
      group_openid: 'noe-earth-preview-group',
      content: '诺伊地球扣扣入站预演',
      author: { id: 'noe-earth-preview-user', username: '诺伊地球' },
    },
  };
}

export function summarizeQqPreview(result = {}) {
  if (result.ok !== true) return `扣扣预演失败：${cnReason(result.reason || result.error || '未知原因')}`;
  const normalized = result.normalized || {};
  return `扣扣预演通过 · ${cnChannel(normalized.channel || result.channel || 'qq')} · 未投递 · ${text(normalized.text || '', 80)}`;
}

export function buildWeChatContractProbe() {
  return {
    channel: 'wechat_clawbot',
    text: 'Noe 地球微信契约检查',
  };
}

export function summarizeWeChatContract(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (result.allowed === true || result.ok === true) return '微信契约通过 · 仅预演 · 未发送真实消息';
  const reason = cnReason(result.reason || result.error || errors.join(', ') || '缺少主人可见证据');
  return `微信契约阻断 · ${reason} · 未发送真实消息`;
}
