// Group recent conversations by agent identity while retaining disclosure state.
function groupConversations(rows, previous, activeAgentId) {
  const expanded = new Map((previous || []).map(group => [group.id, group.expanded]));
  const groups = new Map();
  for (const row of rows) {
    const id = row.agent_id || 'unknown';
    if (!groups.has(id)) groups.set(id, {
      id,
      label: row.agent_name || row.name || '教学助手',
      expanded: expanded.has(id) ? expanded.get(id) : activeAgentId ? id === activeAgentId : groups.size === 0,
      items: [],
    });
    const mode = { student: '学习对话', test: '试聊', builder: '创建助手', library: '资料管理' }[row.mode] || '对话';
    const date = String(row.updated_at || '').replace('T', ' ').slice(5, 16);
    groups.get(id).items.push({ ...row, displayTitle: row.title || (mode + (date ? ' · ' + date : '')) });
  }
  return Array.from(groups.values());
}
module.exports = { groupConversations };
