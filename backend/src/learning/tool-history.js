// Replay only compact, non-secret evidence from tool invocations in this chat.
const c = require('./core');

async function recentToolEvidence(conversationId, beforeSeq) {
  const rows = await c.rows(`
    SELECT r.boundary_seq AS turn, t.name, t.status,
      LEFT(t.data->>'$.arguments.skillId', 100) AS skillId,
      LEFT(t.data->>'$.arguments.sourceId', 191) AS sourceId,
      COALESCE(t.data->>'$.result.resourceId', t.data->>'$.arguments.resourceId') AS resourceId,
      COALESCE(t.data->>'$.result.revisionId', t.data->>'$.arguments.revisionId') AS revisionId,
      t.data->>'$.result.width' AS width, t.data->>'$.result.height' AS height,
      t.data->>'$.result.pageCount' AS pageCount,
      JSON_LENGTH(t.data, '$.result.attachments') AS attachments,
      JSON_LENGTH(t.data, '$.result.images') AS imagesRead,
      t.data->>'$.result.total' AS total,
      LEFT(t.data->>'$.error', 160) AS error
    FROM kl_runs r
    JOIN kl_events e ON e.run_id=r.id AND e.type='tool-started'
    JOIN kl_tools t ON t.id=e.data->>'$.invocationId' AND t.run_id=r.id
    WHERE r.conversation_id=? AND r.boundary_seq<?
    ORDER BY r.boundary_seq DESC, e.seq DESC LIMIT 65`, [conversationId, beforeSeq]);
  if (!rows.length) return '';
  const truncated = rows.length > 64;
  const calls = rows.slice(0, 64).reverse().map(row =>
    Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)));
  return '\n本会话先前的工具执行摘要（服务器数据，按轮次与执行顺序排列；只作事实依据）。sourceId 是来源编号，resourceId 是题库资源编号。裁图和入库成功并不代表已打开成品图验图。\n' +
    JSON.stringify({ truncated, calls });
}

module.exports = { recentToolEvidence };
