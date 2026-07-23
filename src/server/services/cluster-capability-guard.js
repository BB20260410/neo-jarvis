const TERMINAL_ROOM_STATUSES = new Set(['done', 'archived', 'deleted']);
const SHARED_ROOM_CAPABILITY_KEYS = [
  'skills',
  'skillIds',
  'plugins',
  'pluginIds',
  'toolIds',
  'sharedSkills',
  'sharedSkillIds',
  'sharedPlugins',
  'sharedPluginIds',
  'sharedToolIds',
  'skillBindings',
  'pluginBindings',
];
const MEMBER_BRIDGE_KEYS = [
  'skills',
  'skillIds',
  'plugins',
  'pluginIds',
  'toolIds',
  'sharedSkills',
  'sharedSkillIds',
  'sharedPlugins',
  'sharedPluginIds',
  'sharedToolIds',
  'skillBridge',
  'pluginBridge',
  'capabilityBridge',
  'bridgeConfig',
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value === true;
}

function roomId(room = {}) {
  return String(room?.roomId || room?.id || '').trim() || 'unknown-room';
}

function roomStatus(room = {}) {
  return String(room?.status || 'idle').trim() || 'idle';
}

function isTerminalRoom(room = {}) {
  return TERMINAL_ROOM_STATUSES.has(roomStatus(room));
}

function adapterId(member = {}) {
  return String(member?.adapterId || '').trim();
}

function adapterRole(id = '') {
  const normalized = String(id || '').trim().toLowerCase();
  if (/codex|gpt|openai/.test(normalized)) return 'codex_app';
  if (/claude|anthropic/.test(normalized)) return 'claude_native';
  if (/gemini|google/.test(normalized)) return 'gemini_cli_native';
  return 'custom_native';
}

function enabledMembers(room = {}) {
  return asArray(room.members).filter((member) => member?.enabled !== false);
}

function bridgeMode(member = {}) {
  return String(member?.capabilityMode || member?.bridgeMode || member?.skillMode || '').trim().toLowerCase();
}

function isSharedBridgeMode(mode = '') {
  return /shared|room|cluster|global|codex|plugin|skill/.test(mode);
}

function nonEmptyKeys(target = {}, keys = []) {
  return keys.filter((key) => hasValue(target?.[key]));
}

function makeCheck(id, label, blockers = [], warnings = [], evidence = []) {
  return {
    id,
    label,
    status: blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed',
    blockers,
    warnings,
    evidence,
  };
}

function extractKnownAdapterIds(knownAdapterIds) {
  if (!knownAdapterIds) return new Set();
  if (knownAdapterIds instanceof Set) return new Set([...knownAdapterIds].map((item) => String(item || '').trim()).filter(Boolean));
  if (knownAdapterIds instanceof Map) return new Set([...knownAdapterIds.keys()].map((item) => String(item || '').trim()).filter(Boolean));
  if (Array.isArray(knownAdapterIds)) return new Set(knownAdapterIds.map((item) => String(item || '').trim()).filter(Boolean));
  if (typeof knownAdapterIds === 'object') return new Set(Object.keys(knownAdapterIds).map((item) => String(item || '').trim()).filter(Boolean));
  return new Set();
}

export function buildClusterCapabilityGuardReport({
  rooms = [],
  knownAdapterIds = null,
  now = new Date(),
} = {}) {
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const knownAdapters = extractKnownAdapterIds(knownAdapterIds);
  const crossVerifyRooms = asArray(rooms).filter((room) => room?.mode === 'cross_verify');
  const activeRooms = crossVerifyRooms.filter((room) => !isTerminalRoom(room));
  const blockers = [];
  const warnings = [];
  const roomReports = [];
  const adapterUsage = {};
  let enabledMemberCount = 0;
  let missingAdapterMemberCount = 0;
  let duplicateAdapterRoomCount = 0;
  let sharedRoomBridgeCount = 0;
  let nativeBridgeViolationCount = 0;

  for (const room of crossVerifyRooms) {
    const id = roomId(room);
    const status = roomStatus(room);
    const terminal = isTerminalRoom(room);
    const members = enabledMembers(room);
    const roomBlockers = [];
    const roomWarnings = [];
    const roomSharedKeys = nonEmptyKeys(room, SHARED_ROOM_CAPABILITY_KEYS);
    if (!terminal && members.length === 0) {
      roomBlockers.push(`enabled_members_empty:${id}`);
    }
    if (!terminal && roomSharedKeys.length > 0) {
      sharedRoomBridgeCount += roomSharedKeys.length;
      for (const key of roomSharedKeys) roomBlockers.push(`room_shared_capability_bridge:${id}:${key}`);
    }

    const adapterCounts = {};
    members.forEach((member, index) => {
      const currentAdapterId = adapterId(member);
      const memberKey = `${currentAdapterId || 'missing'}#${index}`;
      if (!currentAdapterId) {
        missingAdapterMemberCount += 1;
        if (!terminal) roomBlockers.push(`member_adapter_id_missing:${id}:${index}`);
        return;
      }
      enabledMemberCount += 1;
      adapterUsage[currentAdapterId] = (adapterUsage[currentAdapterId] || 0) + 1;
      adapterCounts[currentAdapterId] = (adapterCounts[currentAdapterId] || 0) + 1;
      if (knownAdapters.size > 0 && !knownAdapters.has(currentAdapterId)) {
        roomWarnings.push(`unknown_adapter_id:${id}:${currentAdapterId}`);
      }
      const role = adapterRole(currentAdapterId);
      const mode = bridgeMode(member);
      const bridgeKeys = nonEmptyKeys(member, MEMBER_BRIDGE_KEYS);
      const nativeOnly = role === 'claude_native' || role === 'gemini_cli_native';
      if (!terminal && nativeOnly && (bridgeKeys.length > 0 || isSharedBridgeMode(mode))) {
        nativeBridgeViolationCount += 1;
        roomBlockers.push(`native_member_shared_bridge:${id}:${memberKey}`);
      }
    });

    for (const [currentAdapterId, count] of Object.entries(adapterCounts)) {
      if (count > 1) {
        duplicateAdapterRoomCount += 1;
        roomWarnings.push(`duplicate_enabled_adapter:${id}:${currentAdapterId}=${count}`);
      }
    }

    blockers.push(...roomBlockers);
    warnings.push(...roomWarnings);
    roomReports.push({
      roomId: id,
      name: room?.name || '',
      status,
      terminal,
      enabledMemberCount: members.length,
      adapterIds: Object.keys(adapterCounts),
      duplicateAdapters: Object.entries(adapterCounts)
        .filter(([, count]) => count > 1)
        .map(([currentAdapterId, count]) => ({ adapterId: currentAdapterId, count })),
      roomSharedCapabilityKeys: roomSharedKeys,
      blockers: roomBlockers,
      warnings: roomWarnings,
    });
  }

  const checks = [
    makeCheck(
      'enabled_members_present',
      '非终态集群协同房间至少保留一个可执行成员',
      blockers.filter((item) => item.startsWith('enabled_members_empty:')),
      [],
      [`active_rooms=${activeRooms.length}`],
    ),
    makeCheck(
      'member_adapter_ids_present',
      '启用成员必须带 adapterId',
      blockers.filter((item) => item.startsWith('member_adapter_id_missing:')),
      [],
      [`missing_adapter_members=${missingAdapterMemberCount}`],
    ),
    makeCheck(
      'room_shared_capability_bridge_absent',
      '集群协同不注入房间级共享 Skill/插件桥',
      blockers.filter((item) => item.startsWith('room_shared_capability_bridge:')),
      [],
      [`shared_room_bridge_keys=${sharedRoomBridgeCount}`],
    ),
    makeCheck(
      'native_members_keep_native_capabilities',
      'Claude/Gemini 只走各自原生能力,不挂 Codex 共享插件桥',
      blockers.filter((item) => item.startsWith('native_member_shared_bridge:')),
      [],
      [`native_bridge_violations=${nativeBridgeViolationCount}`],
    ),
    makeCheck(
      'adapter_identity_visibility',
      '适配器身份可见且重复成员风险可观测',
      [],
      warnings.filter((item) => item.startsWith('unknown_adapter_id:') || item.startsWith('duplicate_enabled_adapter:')),
      [`duplicate_adapter_rooms=${duplicateAdapterRoomCount}`],
    ),
  ];
  const status = blockers.length ? 'blocked' : warnings.length ? 'warn' : 'passed';
  return {
    guardVersion: 'cluster-capability-guard-v1',
    generatedAt,
    status,
    ok: status !== 'blocked',
    summary: {
      totalRoomCount: crossVerifyRooms.length,
      activeRoomCount: activeRooms.length,
      enabledMemberCount,
      missingAdapterMemberCount,
      duplicateAdapterRoomCount,
      sharedRoomBridgeCount,
      nativeBridgeViolationCount,
      knownAdapterCount: knownAdapters.size,
      adapterUsage,
    },
    checks,
    rooms: roomReports,
    blockers,
    warnings,
    recommendations: blockers.length
      ? [
        '移除集群协同房间级共享 Skill/插件配置,让 Codex/Claude/Gemini 分别使用自身原生能力。',
        '修复缺失 adapterId 的启用成员,或先禁用该成员再启动房间。',
      ]
      : warnings.length
        ? ['复核重复适配器或未知适配器是否为有意配置,避免多个成员争抢同一原生插件/session。']
        : [],
  };
}
