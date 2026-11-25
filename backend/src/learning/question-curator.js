const c = require('./core');
const agents = require('./agents');
const models = require('./models');
const management = require('./question-management');
const questionSkills = require('./question-skills');

async function open(user) {
  c.teacher(user);
  await agents.ensurePresetAgents();
  let agent = await c.one("SELECT * FROM kl_agents WHERE preset_key='question_curator' AND status='published' AND enabled=1 LIMIT 1");
  if (!agent) {
    agent = await c.one("SELECT * FROM kl_agents WHERE tool_permission='read_write' AND status='published' AND enabled=1 ORDER BY pinned DESC, created_at DESC LIMIT 1");
  }
  if (agent) {
    const conv = await agents.conversation(user, agent.id, 'question_curator');
    return { id: conv.id };
  }
  const settings = await models.settings();
  const modelId = settings.defaultChatModelId || settings.builderModelId;
  if (!modelId) c.fail(503, '请先在「平台与 API 管理」配置默认模型');
  const model = await models.resolve(modelId);
  const agentId = c.hash('question-curator:' + user.id).slice(0, 36);
  const id = c.id();
  await c.transaction(async db => {
    await c.rows(
      "INSERT IGNORE INTO kl_agents(id,owner_id,name,description,draft_parameters,tool_permission,audience,status) VALUES(?,?,?,?,'{}','read_write','teacher_only','system')",
      [agentId, user.id, '题库整理助手', '协助教师查重、补标签、生成草稿与提交修改确认卡片'],
      db,
    );
    const snapshot = {
      model,
      toolPermission: 'read_write',
      skill: {
        content:
          '你是可林留学题库整理助手。可自由查询题库、查看题目详情、读取学科分类 Skill（read_question_skill）与线上标签（list_taxonomy），并使用 inspect_pdf_layout + crop_attachment_image 对上传的 PDF/图片切图后，通过 create_question（传入 attachments）直接录入带图新题。任何修改或删除已有题目的操作都必须调用确认卡片工具，等待教师点击确认后才生效。' +
          questionSkills.catalogPrompt(),
        toolInstructions: '',
      },
    };
    await c.rows('INSERT INTO kl_conversations(id,owner_id,agent_id,mode,snapshot) VALUES(?,?,?,?,?)', [id, user.id, agentId, 'question_curator', JSON.stringify(snapshot)], db);
  });
  return { id };
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
  if (card.status !== 'pending') c.fail(409, '该操作卡片已处理');
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
  if (card.status !== 'pending') c.fail(409, '该操作卡片已处理');
  const changed = await c.rows("UPDATE kl_question_actions SET status='rejected' WHERE id=? AND status='pending'", [actionId]);
  if (changed.affectedRows !== 1) c.fail(409, '该操作卡片已处理');
  return { id: actionId, status: 'rejected' };
}

module.exports = { open, cards, propose, confirm, reject };
