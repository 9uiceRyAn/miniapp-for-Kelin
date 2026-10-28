const c = require('./core');
const models = require('./models');
async function owned(user, id) {
  c.teacher(user);
  const agent = await c.one(
    'SELECT * FROM kl_agents WHERE id=? AND owner_id=?',
    [id, user.id],
  );
  if (!agent) c.fail(404, '教学助手不存在或无权管理');
  return agent;
}
async function list(user, mine = false, query = {}) {
  if (mine) c.teacher(user);
  const p = c.page(query),
    where = mine ? "a.owner_id=? AND a.status<>'system'" : "a.status='published'",
    args = mine ? [user.id] : [];
  const total = await c.one(
    'SELECT COUNT(*) total FROM kl_agents a WHERE ' + where,
    args,
  );
  const items = await c.rows(
    'SELECT a.id,a.owner_id,a.name,a.description,a.draft_skill_id,a.draft_model_id,a.published_version,a.status,u.display_name teacherName FROM kl_agents a JOIN users u ON u.id=a.owner_id WHERE ' +
      where +
      ' ORDER BY a.created_at DESC,a.id LIMIT ' +
      p.pageSize +
      ' OFFSET ' +
      p.offset,
    args,
  );
  return { items, total: Number(total.total), ...p };
}
async function create(user, input) {
  c.teacher(user);
  const id = c.id();
  await c.rows(
    'INSERT INTO kl_agents(id,owner_id,name,description,draft_parameters) VALUES(?,?,?,?,?)',
    [
      id,
      user.id,
      String(input.name || '新的教学助手').slice(0, 191),
      String(input.description || ''),
      '{}',
    ],
  );
  return { id };
}
async function detail(user, id) {
  const agent = await c.one('SELECT * FROM kl_agents WHERE id=?', [id]);
  if (
    !agent ||
    (agent.status !== 'published' && String(agent.owner_id) !== String(user.id))
  )
    c.fail(404, '教学助手不可用');
  if (String(agent.owner_id) !== String(user.id))
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      ownerId: agent.owner_id,
      versionId: agent.published_version,
      status: agent.status,
    };
  const skill = agent.draft_skill_id
    ? await c.one('SELECT * FROM kl_skills WHERE id=?', [agent.draft_skill_id])
    : null;
  return {
    ...agent,
    draft_parameters: c.json(agent.draft_parameters),
    skill: skill ? c.json(skill.data) : null,
  };
}
async function draft(user, id, input) {
  await owned(user, id);
  if (typeof input.content !== 'string' || !input.content.trim())
    c.fail(400, '教学指令不能为空');
  if (input.modelId) await models.resolve(input.modelId);
  const references = input.references || [];
  if (!Array.isArray(references)) c.fail(400, '资料清单格式无效');
  for (const ref of references) {
    const resource = await require('./media').requireResource(
      user,
      ref.resourceId,
    );
    if (resource.visibility !== 'public')
      c.fail(400, 'Skill 参考资料须为公共教学资料');
    if (
      !(await c.one(
        'SELECT id FROM kl_revisions WHERE id=? AND resource_id=?',
        [ref.revisionId, ref.resourceId],
      ))
    )
      c.fail(400, '参考资料修订不存在');
  }
  const skillId = c.id(),
    data = {
      content: input.content,
      references,
      toolInstructions: String(input.toolInstructions || ''),
      builderConversationId: input.builderConversationId || null,
    };
  await c.transaction(async (db) => {
    await c.rows(
      'INSERT INTO kl_skills(id,agent_id,data,content_hash) VALUES(?,?,?,?)',
      [skillId, id, JSON.stringify(data), c.hash(JSON.stringify(data))],
      db,
    );
    await c.rows(
      'UPDATE kl_agents SET name=?,description=?,draft_skill_id=?,draft_model_id=?,draft_parameters=? WHERE id=?',
      [
        String(input.name || '教学助手').slice(0, 191),
        String(input.description || ''),
        skillId,
        input.modelId || null,
        JSON.stringify(c.parameters(input.parameters || {})),
        id,
      ],
      db,
    );
  });
  return detail(user, id);
}
async function snapshot(user, id, purpose) {
  const agent = await owned(user, id);
  if (!agent.draft_skill_id || !agent.draft_model_id)
    c.fail(400, '请先保存教学指令并选择模型');
  const model = await models.resolve(agent.draft_model_id);
  if (!model.capabilities.tools || !model.capabilities.verified?.tools)
    c.fail(400, '教学模型须支持工具调用');
  model.parameters = { ...model.parameters, ...c.json(agent.draft_parameters) };
  const versionId = c.id();
  await c.rows(
    'INSERT INTO kl_versions(id,agent_id,skill_id,model,purpose) VALUES(?,?,?,?,?)',
    [versionId, id, agent.draft_skill_id, JSON.stringify(model), purpose],
  );
  const skill = c.json(
    (
      await c.one('SELECT data FROM kl_skills WHERE id=?', [
        agent.draft_skill_id,
      ])
    ).data,
  );
  return { versionId, skillRevisionId: agent.draft_skill_id, skill, model };
}
async function publish(user, id) {
  const version = await snapshot(user, id, 'published');
  await c.rows(
    "UPDATE kl_agents SET published_version=?,status='published' WHERE id=?",
    [version.versionId, id],
  );
  return version;
}
async function conversation(user, agentId, mode = 'student') {
  let snap;
  if (mode === 'builder') {
    const target = await owned(user, agentId);
    const draftSkill = target.draft_skill_id
      ? c.json(
          (
            await c.one('SELECT data FROM kl_skills WHERE id=?', [
              target.draft_skill_id,
            ])
          ).data,
        )
      : null;
    const builderId = (await models.settings()).builderModelId;
    if (!builderId) c.fail(503, '尚未配置创建助手模型');
    snap = {
      builderVersion: 'kelin-builder-v1',
      model: await models.resolve(builderId),
      skill: {
        content:
          '你是教学助手创建顾问。根据教师目标和提供的材料生成或修改教学 Skill。需要时检索公共题库和资料。最终草稿以 JSON 代码块返回，字段为 name、description、content（完整 SKILL.md 教学指令）、toolInstructions、references（真实 resourceId 和 revisionId）。只生成教学指令，不生成或执行脚本；不得声称已经发布。' +
          (draftSkill
            ? '\n当前待修改草稿：' +
              JSON.stringify({
                name: target.name,
                description: target.description,
                ...draftSkill,
              })
            : ''),
      },
    };
  } else if (mode === 'test') snap = await snapshot(user, agentId, 'test');
  else {
    const agent = await c.one(
      "SELECT * FROM kl_agents WHERE id=? AND status='published'",
      [agentId],
    );
    if (!agent) c.fail(404, '此教学助手暂未发布');
    const version = await c.one('SELECT * FROM kl_versions WHERE id=?', [
      agent.published_version,
    ]);
    snap = {
      versionId: version.id,
      skillRevisionId: version.skill_id,
      model: c.json(version.model),
      skill: c.json(
        (
          await c.one('SELECT data FROM kl_skills WHERE id=?', [
            version.skill_id,
          ])
        ).data,
      ),
    };
  }
  const id = c.id();
  await c.rows(
    'INSERT INTO kl_conversations(id,owner_id,agent_id,mode,snapshot) VALUES(?,?,?,?,?)',
    [id, user.id, agentId, mode, JSON.stringify(snap)],
  );
  return { id, mode, snapshot: snap };
}
async function getConversation(user, id, write = false) {
  const conv = await c.one(
    'SELECT c.*,a.owner_id teacher_id,a.name agent_name,a.status agent_status FROM kl_conversations c JOIN kl_agents a ON a.id=c.agent_id WHERE c.id=?',
    [id],
  );
  if (!conv) c.fail(404, '会话不存在');
  const owner = String(conv.owner_id) === String(user.id);
  if (
    !owner &&
    (write ||
      conv.mode !== 'student' ||
      user.role !== 'teacher' ||
      String(conv.teacher_id) !== String(user.id))
  )
    c.fail(403, '无权读取此会话');
  return { ...conv, snapshot: c.json(conv.snapshot) };
}
async function history(user, query = {}) {
  const p = c.page(query),
    args = [];
  let where = 'c.owner_id=?';
  args.push(user.id);
  if (query.teacherAgentId) {
    await owned(user, query.teacherAgentId);
    where = "c.agent_id=? AND c.mode='student'";
    args[0] = query.teacherAgentId;
  }
  if (query.userId) {
    where += ' AND c.owner_id=?';
    args.push(query.userId);
  }
  return c.rows(
    'SELECT c.id,c.owner_id,c.agent_id,c.mode,c.active_run,c.updated_at,a.name,u.display_name ownerName FROM kl_conversations c JOIN kl_agents a ON a.id=c.agent_id JOIN users u ON u.id=c.owner_id WHERE ' +
      where +
      ' ORDER BY c.updated_at DESC,c.id LIMIT ' +
      p.pageSize +
      ' OFFSET ' +
      p.offset,
    args,
  );
}
module.exports = {
  owned,
  list,
  create,
  detail,
  draft,
  snapshot,
  publish,
  conversation,
  getConversation,
  history,
};
