// NoeLoop 的安全 tickHandler：把集群协同房间（cross_verify / debate / squad / arena 等）
// 的当前状态与最终共识沉淀（absorb）进 MemoryCore，形成「集群协同 ↔ 大脑长期记忆」的桥。
// 这是让 NoeLoop 从「空转调度器」升级为真正连接集群与记忆的第一步（NEXT_PLAN P1）。
//
// 安全边界（CE12 P0 红线）：纯本地只读 —— 只读 roomStore.list() + 写 noe_memory，
// 绝不执行 shell / 外发 / 删除 / 移动。单房间失败不阻断整轮 tick；roomStore 缺失则安全跳过。

function clip(value, max = 600) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

// finalConsensus 可能是字符串，也可能是 { summary, verdict, text } 之类的对象
function summarizeConsensus(room) {
  const c = room?.finalConsensus;
  if (!c) return '';
  if (typeof c === 'string') return clip(c, 600);
  return clip(c.summary || c.text || c.verdict || c.conclusion || JSON.stringify(c), 600);
}

function summarizeRoom(room) {
  const id = clip(room?.id, 80);
  if (!id) return null;
  const mode = clip(room?.mode || 'unknown', 40);
  const status = clip(room?.status || 'unknown', 40);
  const name = clip(room?.name || '', 200);
  const taskCount = Array.isArray(room?.taskList) ? room.taskList.length : 0;
  const memberCount = Array.isArray(room?.members) ? room.members.length : 0;
  const consensus = summarizeConsensus(room);
  const parts = [
    `mode=${mode}`,
    `status=${status}`,
    taskCount ? `tasks=${taskCount}` : '',
    memberCount ? `members=${memberCount}` : '',
    consensus ? `consensus: ${consensus}` : '',
  ].filter(Boolean);
  return { id, mode, status, name, hasConsensus: Boolean(consensus), body: parts.join(' · ') };
}

/**
 * 创建一个把集群房间摘要沉淀进 MemoryCore 的 tickHandler。
 * @param {object}   deps
 * @param {object}   deps.memory     MemoryCore 实例（需有 write()）
 * @param {object}   deps.roomStore  ChatRoomStore 实例（需有 list()）
 * @param {string}   [deps.projectId='noe']
 * @param {number}   [deps.maxRooms=30] 单轮最多沉淀的房间数（防超大集群拖慢 tick）
 * @returns {function} 可直接传给 NoeLoop 的 tickHandler
 */
export function createClusterMemoryTickHandler({ memory, roomStore, projectId = 'noe', maxRooms = 30 } = {}) {
  if (!memory || typeof memory.write !== 'function') {
    throw new Error('createClusterMemoryTickHandler requires memory.write');
  }
  return async function clusterMemoryTick() {
    if (!roomStore || typeof roomStore.list !== 'function') {
      return { absorbed: 0, skipped: 'no_room_store' };
    }
    let rooms;
    try {
      rooms = roomStore.list() || [];
    } catch (e) {
      return { absorbed: 0, error: e?.message || 'roomStore.list failed' };
    }
    let absorbed = 0;
    for (const room of rooms.slice(0, maxRooms)) {
      if (room?.archived) continue; // 已归档房间不再沉淀
      const s = summarizeRoom(room);
      if (!s) continue;
      try {
        memory.write({
          id: `cluster-room:${s.id}`, // 稳定 id → MemoryCore ON CONFLICT 去重更新，不会重复堆积
          projectId,
          scope: 'cluster',
          title: `[cluster] ${s.name || s.mode} (${s.status})`,
          body: s.body || `mode=${s.mode} status=${s.status}`,
          sourceType: 'noe_loop_tick',
          sourceId: s.id,
          confidence: s.hasConsensus ? 0.7 : 0.4, // 有最终共识的房间记忆更可信
          tags: ['cluster', s.mode, s.status],
        });
        absorbed += 1;
      } catch {
        // 单房间写入失败不阻断整轮 tick
      }
    }
    return { absorbed, scanned: rooms.length };
  };
}
