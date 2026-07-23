export function createSessionCapacityCounter({ sessions = new Map() } = {}) {
  let activeCount = 0;

  function rebuild() {
    activeCount = 0;
    for (const session of sessions.values()) if (!session?.archived) activeCount += 1;
    return activeCount;
  }

  function onSessionCreated(session) {
    if (session && !session.archived) activeCount += 1;
  }

  function onSessionDeleted(session) {
    if (session && !session.archived) activeCount = Math.max(0, activeCount - 1);
  }

  function onSessionArchivedChange(session, archived, wasArchived = false) {
    if (!session || archived === wasArchived) return;
    activeCount += archived ? -1 : 1;
    if (activeCount < 0) activeCount = 0;
  }

  function check({ res, maxSessions, maxActiveSessions } = {}) {
    if (sessions.size >= maxSessions) {
      res.status(429).json({ error: `已达 session 总数上限（${maxSessions}）。先归档或删除一些旧 session` });
      return false;
    }
    if (activeCount >= maxActiveSessions) {
      res.status(429).json({ error: `已达活跃 session 上限（${maxActiveSessions}）。先归档一些` });
      return false;
    }
    return true;
  }

  return {
    rebuild,
    activeCount: () => activeCount,
    onSessionCreated,
    onSessionDeleted,
    onSessionArchivedChange,
    check,
  };
}
