const c = require('./core');
const agents = require('./agents');
const management = require('./question-management');

async function open(user) {
  c.teacher(user);
  await agents.ensurePresetAgents();
  let agent = await c.one("SELECT * FROM kl_agents WHERE preset_key='question_curator' AND status='published' AND enabled=1 LIMIT 1");
  if (!agent) {
    agent = await c.one("SELECT * FROM kl_agents WHERE tool_permission='read_write' AND status='published' AND enabled=1 ORDER BY pinned DESC, created_at DESC LIMIT 1");
  }
  if (!agent) c.fail(503, '请先在「平台与 API 管理」配置默认模型');
  const conv = await agents.conversation(user, agent.id, 'question_curator');
  return { id: conv.id };
}

async function cards(user, conversationId) {
  c.teacher(user);
  const rows = await c.rows('SELECT * FROM kl_question_actions WHERE conversation_id=? ORDER BY created_at ASC', [conversationId]);
  return rows.map(r => ({
    ...r,
    payload: c.json(r.payload),
    result: r.result ? c.json(r.result) : null,
  }));
}

function summarize(actionType, args) {
  if (actionType === 'update_question') {
    return `修改题目 ${args.resourceId}（${args.title || '更新内容/标签/状态'}）`;
  }
  if (actionType === 'batch_update') {
    return `批量操作 ${Array.isArray(args.ids) ? args.ids.length : 0} 道题目：${args.action}`;
  }
  if (actionType === 'taxonomy_change') {
    return `分类标签变更：${args.operation || 'save'} ${args.label || args.code || ''}`;
  }
  return '题库变更提案';
}

async function propose(actionType, args, context) {
  c.teacher(context.user);
  const id = c.id();
  const summary = args.summary || summarize(actionType, args);
  await c.rows(
    "INSERT INTO kl_question_actions(id,conversation_id,action_type,status,summary,payload) VALUES(?,?,?,'pending',?,?)",
    [id, context.conversationId, actionType, summary, JSON.stringify(args || {})],
  );
  return { actionId: id, status: 'pending', summary, message: '已生成确认卡片，请等待教师在界面上点击确认。' };
}

async function confirm(user, conversationId, actionId) {
  c.teacher(user);
  await agents.getConversation(user, conversationId, true);
  const card = await c.one('SELECT * FROM kl_question_actions WHERE id=? AND conversation_id=?', [actionId, conversationId]);
  if (!card) c.fail(404, '操作卡片不存在');
  const claimed = await c.rows("UPDATE kl_question_actions SET status='applying' WHERE id=? AND status='pending'", [actionId]);
  if (claimed.affectedRows !== 1) c.fail(409, '该操作卡片已处理');
  try {
    const result = await applyCard(user, card);
    const status = result?.failed?.length ? 'partial_failure' : 'confirmed';
    await c.rows("UPDATE kl_question_actions SET status=?,result=? WHERE id=?", [status, JSON.stringify(result || {}), actionId]);
    return { id: actionId, status, result };
  } catch (error) {
    await c.rows("UPDATE kl_question_actions SET status='failed',result=? WHERE id=? AND status='applying'", [JSON.stringify({ message: error.message }), actionId]);
    throw error;
  }
}

async function applyCard(user, card) {
  const payload = c.json(card.payload);
  let result;
  if (card.action_type === 'update_question') {
    result = await management.save(user, payload.resourceId, payload);
  } else if (card.action_type === 'batch_update') {
    result = await management.batchUpdate(user, payload);
  } else if (card.action_type === 'taxonomy_change') {
    const op = payload.operation || 'save_tag';
    if (op === 'save_subject') result = await management.saveSubject(payload);
    else if (op === 'save_collection') result = await management.saveCollection(payload);
    else result = await management.saveTag(payload);
  } else {
    c.fail(400, '未知的操作类型');
  }
  return result;
}

async function reject(user, conversationId, actionId) {
  c.teacher(user);
  await agents.getConversation(user, conversationId, true);
  const card = await c.one('SELECT * FROM kl_question_actions WHERE id=? AND conversation_id=?', [actionId, conversationId]);
  if (!card) c.fail(404, '操作卡片不存在');
  const changed = await c.rows("UPDATE kl_question_actions SET status='rejected' WHERE id=? AND status='pending'", [actionId]);
  if (changed.affectedRows !== 1) c.fail(409, '该操作卡片已处理');
  return { id: actionId, status: 'rejected' };
}

module.exports = { open, cards, propose, confirm, reject };
