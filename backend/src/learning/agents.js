const c = require('./core');
const models = require('./models');
const questionSkills = require('./question-skills');

const INITIAL_PRESETS = [
  {
    presetKey: 'general_tutor',
    name: '通用学习答疑助手',
    description: '检索题库与网盘资料，采用启发式分步讲解帮学生理清思路。',
    content: '你是可林留学的通用学习答疑助手。优先检索题库与网盘教学资料，采用启发式、分步引导的方式解答问题，不直接敷衍给出结论；引用资料或题目时清晰标明出处。',
    toolPermission: 'read_only',
    audience: 'all',
  },
  {
    presetKey: 'english_writing',
    name: '英语写作批改助手',
    description: '专注英语语法纠错、地道表达润色与结构及评分建议。',
    content: '你是英语写作批改助手。对学生提交的英语作文或段落，从语法准确性、词汇地道性、逻辑衔接与结构四个维度给出具体修改建议、示范改写与提升方向。',
    toolPermission: 'read_only',
    audience: 'all',
  },
  {
    presetKey: 'question_curator',
    name: '题库整理助手',
    description: '协助教师按学科规范导入新题、查重、补全知识点标签与整理题库。',
    content:
      '你是可林留学题库整理助手。协助教师按学科分类规范导入新题、检索现有题库查重、补全知识点标签并整理题库。\n' +
      '工作规范：\n' +
      '1. 按科目分类或录入新题前，先调用 read_question_skill 读取对应科目的分类规范与官方 taxonomy，再结合 list_taxonomy 和 search_questions 确认数据集、标签和是否重复。\n' +
      '2. 保持完整大题不拆子问；primary_tag 必须存在于 tags 中，不凭孤立关键词直接定类。\n' +
      '3. 导入新题使用 create_question，写入后立即进入题库生效（无草稿、审核或发布流程）。\n' +
      '4. 任何对已有题目的修改、批量变更或分类标签调整都必须使用确认卡片工具（propose_question_update、propose_question_batch_update、propose_taxonomy_change）提交，等待教师点击确认后再落库，不得擅自声称已修改。' +
      questionSkills.catalogPrompt(),
    toolPermission: 'read_write',
    audience: 'teacher_only',
  },
];

async function ensurePresetAgents() {
  try {
    const [teachers] = await c.pool.query("SELECT id FROM users WHERE role='teacher' AND status=1 ORDER BY id ASC LIMIT 1");
    const ownerId = teachers[0]?.id;
    if (!ownerId) return;
    const settings = await models.settings();
    let modelId = settings.defaultChatModelId;
    if (!modelId) {
      const enabledModels = await models.list(false);
      modelId = enabledModels[0]?.id || null;
    }
    const modelObj = modelId ? await models.resolve(modelId, true).catch(() => null) : null;
    for (const preset of INITIAL_PRESETS) {
      const exists = await c.one('SELECT id,draft_skill_id FROM kl_agents WHERE preset_key=?', [preset.presetKey]);
      if (exists) {
        if (preset.presetKey === 'question_curator' && exists.draft_skill_id) {
          const curSkill = await c.one('SELECT data FROM kl_skills WHERE id=?', [exists.draft_skill_id]);
          const curData = curSkill ? c.json(curSkill.data) : {};
          const curContent = String(curData.content || '');
          if (curContent.includes('create_question_draft') && !curContent.includes('read_question_skill')) {
            const skillId = c.id(), versionId = c.id();
            const skillData = { ...curData, content: preset.content };
            await c.transaction(async db => {
              await c.rows('INSERT INTO kl_skills(id,agent_id,data,content_hash) VALUES(?,?,?,?)', [skillId, exists.id, JSON.stringify(skillData), c.hash(JSON.stringify(skillData))], db);
              await c.rows('INSERT INTO kl_versions(id,agent_id,skill_id,model,purpose) VALUES(?,?,?,?,?)', [versionId, exists.id, skillId, JSON.stringify(modelObj || {}), 'published'], db);
              await c.rows('UPDATE kl_agents SET description=?,draft_skill_id=?,published_version=? WHERE id=?', [preset.description, skillId, versionId, exists.id], db);
            });
          }
        }
        continue;
      }
      const agentId = c.id(), skillId = c.id(), versionId = c.id();
      const skillData = { content: preset.content, references: [], toolInstructions: '' };
      await c.transaction(async db => {
        await c.rows(
          "INSERT INTO kl_agents(id,owner_id,name,description,draft_skill_id,draft_model_id,draft_parameters,tool_permission,audience,preset_key,published_version,status,enabled) VALUES(?,?,?,?,?,?,'{}',?,?,?,?,'published',1)",
          [agentId, ownerId, preset.name, preset.description, skillId, modelObj?.id || null, preset.toolPermission, preset.audience, preset.presetKey, versionId],
          db,
        );
        await c.rows('INSERT INTO kl_skills(id,agent_id,data,content_hash) VALUES(?,?,?,?)', [skillId, agentId, JSON.stringify(skillData), c.hash(JSON.stringify(skillData))], db);
        await c.rows('INSERT INTO kl_versions(id,agent_id,skill_id,model,purpose) VALUES(?,?,?,?,?)', [versionId, agentId, skillId, JSON.stringify(modelObj || {}), 'published'], db);
      });
    }
  } catch {}
}

async function owned(user, id) {
  c.teacher(user);
  const agent = await c.one(
    "SELECT * FROM kl_agents WHERE id=? AND status<>'system' AND status<>'archived'",
    [id],
  );
  if (!agent) c.fail(404, '教学助手不存在或不可管理');
  return agent;
}
async function list(user, mine = false, query = {}) {
  await ensurePresetAgents();
  const scope = query.scope || (mine ? 'manage' : 'all');
  if (scope === 'manage' || mine) c.teacher(user);
  const p = c.page(query);
  const conditions = ["a.status<>'system'", "a.status<>'archived'"];
  const args = [];
  if (scope === 'manage') {
    if (query.onlyMine === 'true') {
      conditions.push('a.owner_id=?');
      args.push(user.id);
    }
  } else {
    conditions.push("a.status='published'", 'a.enabled=1');
    if (user.role !== 'teacher') {
      conditions.push("a.audience='all'");
    }
  }
  const where = conditions.join(' AND ');
  const total = await c.one('SELECT COUNT(*) total FROM kl_agents a WHERE ' + where, args);
  const items = await c.rows(
    'SELECT a.id,a.owner_id,a.name,a.description,a.draft_skill_id,a.draft_model_id,a.tool_permission,a.audience,a.preset_key,a.enabled,a.pinned,a.sort_order,a.published_version,a.status,u.display_name teacherName FROM kl_agents a JOIN users u ON u.id=a.owner_id WHERE ' +
      where +
      ' ORDER BY a.pinned DESC,a.sort_order ASC,a.created_at DESC,a.id' + c.limitOffset(p),
    args,
  );
  return { items, total: Number(total.total), ...p };
}
async function resolveDefaultModel() {
  const settings = await models.settings();
  if (settings.defaultChatModelId) {
    return models.resolve(settings.defaultChatModelId).catch(() => null);
  }
  const enabledModels = await models.list(false);
  return enabledModels[0] || null;
}

async function saveAgent(user, id, input) {
  await owned(user, id);
  const content = String(input.content || '').trim();
  if (!content) c.fail(400, 'Prompt 不能为空');
  const name = String(input.name || '').trim().slice(0, 191);
  if (!name) c.fail(400, '请输入助手名称');
  const toolPermission = input.toolPermission === 'read_write' ? 'read_write' : 'read_only';
  const audience = input.audience === 'teacher_only' ? 'teacher_only' : 'all';
  const enabled = input.enabled === undefined ? true : Boolean(input.enabled);
  const model = input.modelId
    ? await models.resolve(input.modelId)
    : await resolveDefaultModel();
  const skillId = c.id(), versionId = c.id();
  const data = {
    content,
    references: input.references || [],
    toolInstructions: String(input.toolInstructions || ''),
    builderConversationId: input.builderConversationId || null,
  };
  await c.transaction(async db => {
    await c.rows('INSERT INTO kl_skills(id,agent_id,data,content_hash) VALUES(?,?,?,?)', [skillId, id, JSON.stringify(data), c.hash(JSON.stringify(data))], db);
    await c.rows('INSERT INTO kl_versions(id,agent_id,skill_id,model,purpose) VALUES(?,?,?,?,?)', [versionId, id, skillId, JSON.stringify(model || {}), 'published'], db);
    await c.rows(
      "UPDATE kl_agents SET name=?,description=?,draft_skill_id=?,draft_model_id=?,tool_permission=?,audience=?,enabled=?,published_version=?,status='published' WHERE id=?",
      [name, String(input.description || '').trim(), skillId, model?.id || null, toolPermission, audience, enabled ? 1 : 0, versionId, id],
      db,
    );
  });
  return detail(user, id);
}

async function create(user, input) {
  c.teacher(user);
  const id = c.id();
  const toolPermission = input.toolPermission === 'read_write' ? 'read_write' : 'read_only';
  const audience = input.audience === 'teacher_only' ? 'teacher_only' : 'all';
  await c.rows(
    'INSERT INTO kl_agents(id,owner_id,name,description,draft_parameters,tool_permission,audience,enabled) VALUES(?,?,?,?,?,?,?,?)',
    [
      id,
      user.id,
      String(input.name || '新的教学助手').slice(0, 191),
      String(input.description || ''),
      '{}',
      toolPermission,
      audience,
      input.enabled === false ? 0 : 1,
    ],
  );
  if (typeof input.content === 'string' && input.content.trim()) {
    await saveAgent(user, id, input);
  }
  return { id };
}

async function updateMeta(user, id, input) {
  await owned(user, id);
  const sets = [], args = [];
  if (input.enabled !== undefined) { sets.push('enabled=?'); args.push(input.enabled ? 1 : 0); }
  if (input.pinned !== undefined) { sets.push('pinned=?'); args.push(input.pinned ? 1 : 0); }
  if (input.sortOrder !== undefined) { sets.push('sort_order=?'); args.push(Number(input.sortOrder) || 0); }
  if (!sets.length) c.fail(400, '没有需要更新的配置');
  await c.rows('UPDATE kl_agents SET ' + sets.join(',') + ' WHERE id=?', [...args, id]);
  return detail(user, id);
}

async function remove(user, id) {
  await owned(user, id);
  const conv = await c.one('SELECT id FROM kl_conversations WHERE agent_id=? LIMIT 1', [id]);
  if (conv) {
    await c.rows("UPDATE kl_agents SET status='archived',enabled=0 WHERE id=?", [id]);
  } else {
    await c.rows('DELETE FROM kl_versions WHERE agent_id=?', [id]);
    await c.rows('DELETE FROM kl_skills WHERE agent_id=?', [id]);
    await c.rows('DELETE FROM kl_agents WHERE id=?', [id]);
  }
  return { id };
}
async function detail(user, id) {
  const agent = await c.one('SELECT * FROM kl_agents WHERE id=?', [id]);
  if (
    !agent ||
    (agent.status !== 'published' && user.role !== 'teacher' && String(agent.owner_id) !== String(user.id))
  )
    c.fail(404, '教学助手不可用');
  if (user.role !== 'teacher' && String(agent.owner_id) !== String(user.id))
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
      "SELECT * FROM kl_agents WHERE id=? AND status='published' AND enabled=1",
      [agentId],
    );
    if (!agent) c.fail(404, '此教学助手暂不可用');
    if (agent.audience === 'teacher_only' && user.role !== 'teacher') {
      c.fail(403, '仅教师可使用此助手');
    }
    const version = await c.one('SELECT * FROM kl_versions WHERE id=?', [
      agent.published_version,
    ]);
    let model = c.json(version?.model || '{}');
    if (!model?.id) {
      model = (await resolveDefaultModel()) || {};
    }
    if (!model?.id) c.fail(503, '请先在平台与 API 管理中配置默认模型');
    snap = {
      versionId: version.id,
      skillRevisionId: version.skill_id,
      toolPermission: agent.tool_permission || 'read_only',
      model,
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
    const agent = await owned(user, query.teacherAgentId);
    if (String(agent.owner_id) !== String(user.id)) c.fail(403, '只能查看自己助手的学生记录');
    where = "c.agent_id=? AND c.mode='student'";
    args[0] = query.teacherAgentId;
  } else if (query.agentId) {
    where += " AND c.agent_id=? AND c.mode='student'";
    args.push(query.agentId);
  }
  if (query.userId) {
    where += ' AND c.owner_id=?';
    args.push(query.userId);
  }
  return c.rows(
    'SELECT c.id,c.owner_id,c.agent_id,c.mode,c.active_run,c.updated_at,a.name,u.display_name ownerName FROM kl_conversations c JOIN kl_agents a ON a.id=c.agent_id JOIN users u ON u.id=c.owner_id WHERE ' +
      where +
      ' ORDER BY c.updated_at DESC,c.id' + c.limitOffset(p),
    args,
  );
}
module.exports = {
  owned,
  list,
  create,
  detail,
  draft,
  saveAgent,
  updateMeta,
  remove,
  publish,
  conversation,
  getConversation,
  history,
  ensurePresetAgents,
};
