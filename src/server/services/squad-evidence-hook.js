// @ts-check
// 第三波手术 第29批：squad 结项证据入库 hook 自 server.js 迁出（纯 hook builder）
// 职责（选项 C 原文迁移）：squad 产出自动入证据知识库（PM 总结/Dev attempts/QA reviews），
// 让双模型协作的项目产出可持续累积+可回查（KC 跨 session 全文检索）。失败不阻断 squad 主流程。
// 注入：evidenceKnowledgeStore（src/knowledge/EvidenceKnowledgeStore.js 单例，由组合根传入）。
export function createSquadEvidenceHook({ evidenceKnowledgeStore }) {
  return (roomId, room, phase) => {
    try {
      const items = [];
      const sessionId = roomId; // squad 房 id 直接作 session 标识,便于 KC 命中后跳转
      for (const task of (room.taskList || [])) {
        const title = String(task.title || task.topic || '').slice(0, 200);
        // PM 任务描述/最终状态摘要
        if (title || task.summary) items.push({
          refKind: 'squad_task',
          refId: `${roomId}:${task.id}`,
          content: `${title}\n${task.summary || ''}\nstatus: ${task.status || ''}`.trim(),
          roomId, sessionId,
        });
        // Dev 每次实现尝试
        (task.attempts || []).forEach((a, i) => {
          if (a?.content) items.push({
            refKind: 'squad_dev_attempt',
            refId: `${roomId}:${task.id}:attempt-${i}`,
            content: `[${a.by || 'dev'}] ${a.content}`,
            roomId, sessionId,
          });
        });
        // QA 审查结果
        (task.reviews || []).forEach((r, i) => {
          const text = typeof r === 'string' ? r : JSON.stringify(r);
          if (text) items.push({
            refKind: 'squad_qa_review',
            refId: `${roomId}:${task.id}:review-${i}`,
            content: text.slice(0, 4000),
            roomId, sessionId,
          });
        });
      }
      // PM 结项总结(只有 done 阶段才会有,paused/error 时未生成)
      if (room.finalConsensus) items.push({
        refKind: 'squad_final',
        refId: `${roomId}:final`,
        content: `[${phase}] ${room.finalConsensus}`,
        roomId, sessionId,
      });
      if (items.length) evidenceKnowledgeStore.indexItems(items);
    } catch { /* 索引失败不阻断 squad 主流程 */ }
  };
}
