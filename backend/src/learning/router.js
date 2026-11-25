const express = require('express'),
  multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const c = require('./core'),
  q = require('./questions'),
  media = require('./media'),
  docs = require('./documents'),
  agents = require('./agents'),
  models = require('./models'),
  runs = require('./runs');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_DOCUMENT_MB || 30) * 1024 * 1024,
    files: 1,
  },
});
const wrap = c.route;
const { decodeUploadName } = require('../utils/upload-name');
async function requireAdmin(req, res, next) {
  await c.admin(req.user);
  next();
}
function uploadName(file, preferred) {
  return typeof preferred === 'string' && preferred.trim() ? preferred : decodeUploadName(file.originalname);
}
function install(app) {
  const bank = express.Router();
  bank.get('/content/:mediaId', async (req, res, next) => {
    const item = await media.verify(req.params.mediaId, req.query.ticket);
    res.set('Cache-Control', 'private, no-store');
    res.type(item.mime);
    res.sendFile(media.absolute(item.storage_path), (error) => {
      if (error) next(error);
    });
  });
  bank.use(requireAuth);
  const management = require('./question-management');
  bank.use('/admin', requireAdmin);
  bank.get('/admin/facets', wrap(req => management.facets()));
  bank.get('/admin/items', wrap(req => management.list({ ...req.query, sessionHash: req.authTokenHash })));
  bank.get('/admin/items/:id', wrap(req => management.detail(req.params.id, req.authTokenHash)));
  bank.post('/admin/uploads', upload.single('file'), wrap(req => {
    if (!req.file) c.fail(400, '请选择媒体文件');
    return management.upload(req.user, req.file.buffer, uploadName(req.file, req.body.fileName));
  }));
  bank.post('/admin/items', wrap(req => management.save(req.user, null, req.body)));
  bank.patch('/admin/items/:id', wrap(req => management.save(req.user, req.params.id, req.body)));
  bank.delete('/admin/items/:id', wrap(req => management.visibility(req.user, req.params.id, req.body, true)));
  bank.post('/admin/items/:id/restore', wrap(req => management.visibility(req.user, req.params.id, req.body, false)));
  bank.post('/admin/imports/preview', upload.single('file'), wrap(req => {
    if (!req.file) c.fail(400, '请选择 JSON 或 ZIP 文件');
    return management.previewImport(req.user, req.file.buffer, uploadName(req.file, req.body.fileName));
  }));
  bank.post('/admin/imports/confirm', wrap(req => management.confirmImport(req.user, req.body.token)));
  bank.delete('/admin/imports/preview', wrap(req => management.cancelImport(req.user, req.body.token)));
  bank.get(
    '/facets',
    wrap((req) => q.facets(req.query)),
  );
  bank.get(
    '/taxonomy',
    wrap((req) => q.taxonomy(req.query.collection)),
  );
  bank.get(
    '/items',
    wrap(async (req) => {
      const data = await q.list(req.query);
      for (const item of data.items) {
        const refs = await media.references(item.revisionId, req.authTokenHash);
        item.thumbnail =
          refs.find((m) => m.kind === 'question' && m.available) || null;
        delete item.details;
        delete item.gallery;
        delete item.audio;
        delete item.search_text;
      }
      return data;
    }),
  );
  bank.get(
    '/items/:id/revisions/:revisionId/media/:mediaId',
    wrap(async (req) => {
      await q.detail(req.user, req.params.id, req.params.revisionId);
      const found = await c.one(
        'SELECT id FROM kl_media WHERE id=? AND revision_id=?',
        [req.params.mediaId, req.params.revisionId],
      );
      if (!found) c.fail(404, '媒体不属于此修订');
      return media.ticket(found.id, req.authTokenHash);
    }),
  );
  bank.get(
    '/items/:id/revisions/:revisionId',
    wrap((req) =>
      q.detail(
        req.user,
        req.params.id,
        req.params.revisionId,
        req.authTokenHash,
      ),
    ),
  );
  bank.get(
    '/items/:id',
    wrap((req) => q.detail(req.user, req.params.id, null, req.authTokenHash)),
  );
  app.use('/api/question-bank', bank);
  const library = express.Router();
  library.use(requireAuth);
  library.get(
    '/',
    wrap((req) => docs.search(req.query, req.user)),
  );
  library.post(
    '/upload',
    upload.single('file'),
    wrap((req) => {
      c.teacher(req.user);
      if (!req.file) c.fail(400, '请选择文件');
      return docs.upload({
        user: req.user,
        bytes: req.file.buffer,
        name: decodeUploadName(req.file.originalname),
      });
    }),
  );
  library.post(
    '/text',
    wrap((req) => {
      c.teacher(req.user);
      return docs.upload({
        user: req.user,
        bytes: Buffer.from(String(req.body.text || '')),
        name: String(req.body.title || '教学资料') + '.txt',
      });
    }),
  );
  library.post('/files/:fileId/index', wrap(req => docs.indexFile(req.user, req.params.fileId)));
  library.get(
    '/:id',
    wrap((req) =>
      q.detail(
        req.user,
        req.params.id,
        req.query.revisionId,
        req.authTokenHash,
      ),
    ),
  );
  library.post(
    '/:id/retry',
    wrap(async (req) => {
      const resource = await media.requireResource(req.user, req.params.id);
      if (String(resource.owner_id) !== String(req.user.id))
        c.fail(403, '仅上传者可以重试解析');
      const revisionId = req.body.revisionId || resource.current_revision;
      if (
        !(await c.one(
          'SELECT id FROM kl_revisions WHERE id=? AND resource_id=?',
          [revisionId, resource.id],
        ))
      )
        c.fail(404, '修订不存在');
      docs
        .parse(revisionId, { user: req.user, purpose: 'parse' })
        .then(() =>
          c.rows('UPDATE kl_resources SET current_revision=? WHERE id=?', [
            revisionId,
            resource.id,
          ]),
        )
        .catch(() => {});
      return { status: 'queued' };
    }),
  );
  library.post(
    '/:id/revisions',
    upload.single('file'),
    wrap(async (req) => {
      c.teacher(req.user);
      const resource = await media.requireResource(req.user, req.params.id);
      if (
        resource.visibility !== 'public' ||
        String(resource.owner_id) !== String(req.user.id)
      )
        c.fail(403, '仅上传者可以更新公共资料');
      if (!req.file) c.fail(400, '请选择文件');
      return docs.replace(
        resource,
        req.user,
        req.file.buffer,
        decodeUploadName(req.file.originalname),
      );
    }),
  );
  library.delete(
    '/:id',
    wrap(async (req) => {
      c.teacher(req.user);
      const resource = await media.requireResource(req.user, req.params.id);
      if (String(resource.owner_id) !== String(req.user.id))
        c.fail(403, '仅上传者可以撤下资料');
      await c.rows(
        "UPDATE kl_resources SET visibility='withdrawn' WHERE id=?",
        [resource.id],
      );
      return { id: resource.id };
    }),
  );
  app.use('/api/library', library);
  const ai = express.Router();
  ai.use(requireAuth);
  ai.get(
    '/me',
    wrap(async (req) => ({
      user: req.user,
      admin: await c.capability(req.user),
      settings: await models.settings(),
    })),
  );
  ai.get(
    '/models',
    wrap(() => models.list()),
  );
  ai.get(
    '/agents',
    wrap((req) => agents.list(req.user, req.query.mine === 'true', req.query)),
  );
  ai.post(
    '/agents',
    wrap((req) => agents.create(req.user, req.body)),
  );
  ai.get(
    '/agents/:id',
    wrap((req) => agents.detail(req.user, req.params.id)),
  );
  ai.put(
    '/agents/:id/draft',
    wrap((req) => agents.draft(req.user, req.params.id, req.body)),
  );
  ai.post(
    '/agents/:id/publish',
    wrap((req) => agents.publish(req.user, req.params.id)),
  );
  ai.post(
    '/agents/:id/unpublish',
    wrap(async (req) => {
      await agents.owned(req.user, req.params.id);
      await c.rows("UPDATE kl_agents SET status='unlisted' WHERE id=?", [
        req.params.id,
      ]);
      return { status: 'unlisted' };
    }),
  );
  ai.post(
    '/agents/:id/builder-sessions',
    wrap((req) => agents.conversation(req.user, req.params.id, 'builder')),
  );
  ai.post(
    '/agents/:id/test-conversations',
    wrap((req) => agents.conversation(req.user, req.params.id, 'test')),
  );
  ai.post('/library-manager/conversation', wrap(req => require('./library-agent').open(req.user)));
  ai.post('/conversations/:id/library-actions/:actionId/confirm', wrap(req => require('./library-agent').confirm(req.user, req.params.id, req.params.actionId)));
  ai.post(
    '/conversations',
    wrap((req) => agents.conversation(req.user, req.body.agentId, 'student')),
  );
  ai.get(
    '/conversations',
    wrap((req) => agents.history(req.user, req.query)),
  );
  ai.get(
    '/conversations/:id',
    wrap(async (req) => {
      const conversation = await agents.getConversation(
        req.user,
        req.params.id,
      );
      const before = Number(req.query.beforeSequence) || 2147483647;
      const messages = (
        await c.rows(
          'SELECT * FROM kl_messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 30',
          [req.params.id, before],
        )
      ).reverse();
      const assets = await c.rows(
        'SELECT r.id resourceId,r.current_revision revisionId,v.status,v.data FROM kl_assets a JOIN kl_resources r ON r.id=a.resource_id JOIN kl_revisions v ON v.id=r.current_revision WHERE a.conversation_id=?',
        [req.params.id],
      );
      return {
        conversation,
        libraryActions: conversation.mode === 'library' ? await require('./library-agent').cards(req.user, conversation.id) : [],
        hasOlder: messages.length > 0 && messages[0].seq > 1,
        messages: messages.map((x) => ({ ...x, data: c.json(x.data) })),
        assets: assets.map((x) => ({ ...x, data: c.json(x.data) })),
      };
    }),
  );
  ai.post(
    '/conversations/:id/messages',
    wrap(async (req) => {
      const result = await runs.send(req.user, req.params.id, req.body);
      if (result.status === 'queued')
        setImmediate(() => runs.execute(result.runId));
      return result;
    }),
  );
  ai.post(
    '/conversations/:id/assets',
    upload.single('file'),
    wrap(async (req) => {
      await agents.getConversation(req.user, req.params.id, true);
      if (!req.file) c.fail(400, '请选择附件');
      return docs.upload({
        user: req.user,
        bytes: req.file.buffer,
        name: decodeUploadName(req.file.originalname),
        conversationId: req.params.id,
      });
    }),
  );
  ai.get('/runs/:id/events', async (req, res, next) => {
    try {
      let after = Math.max(0, Number(req.query.afterSequence) || 0),
        data = await runs.events(req.user, req.params.id, after);
      if (req.query.stream !== '1') return res.json({ success: true, data });
      res.set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      const end = Date.now() + 25000;
      while (!closed && Date.now() < end) {
        for (const event of data.events) {
          res.write(JSON.stringify(event) + '\n');
          after = event.seq;
        }
        if (
          !['running', 'queued'].includes(data.run.status) &&
          data.events.length < 200
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!closed) data = await runs.events(req.user, req.params.id, after);
      }
      res.end();
    } catch (e) {
      if (res.headersSent) res.end();
      else next(e);
    }
  });
  ai.post(
    '/runs/:id/cancel',
    wrap((req) => runs.cancel(req.user, req.params.id)),
  );
  ai.get(
    '/usage',
    wrap((req) => models.usage(req.user, req.query)),
  );
  ai.get(
    '/teacher/usage',
    wrap((req) => models.usage(req.user, req.query, 'teacher')),
  );
  ai.get(
    '/teacher/agents/:id/usage',
    wrap((req) =>
      models.usage(
        req.user,
        { ...req.query, agentId: req.params.id },
        'teacher',
      ),
    ),
  );
  ai.get(
    '/teacher/agents/:id/conversations',
    wrap((req) =>
      agents.history(req.user, { ...req.query, teacherAgentId: req.params.id }),
    ),
  );
  ai.get(
    '/teacher/agents/:id/conversations/:conversationId',
    wrap(async (req) => {
      await agents.owned(req.user, req.params.id);
      const conv = await agents.getConversation(
        req.user,
        req.params.conversationId,
      );
      if (conv.agent_id !== req.params.id || conv.mode !== 'student')
        c.fail(403, '会话不属于此教学助手');
      return {
        conversation: conv,
        messages: (
          await c.rows(
            'SELECT * FROM kl_messages WHERE conversation_id=? ORDER BY seq',
            [conv.id],
          )
        ).map((x) => ({ ...x, data: c.json(x.data) })),
      };
    }),
  );
  const access = require('./connection-access');
  ai.post('/connections/unlock', wrap(access.unlock));
  ai.use('/connections', access.authorize);
  ai.use('/admin', requireAdmin);
  ai.get(
    ['/admin/models', '/connections/models'],
    wrap(() => models.list(true)),
  );
  ai.post(
    ['/admin/models', '/connections/models'],
    wrap((req) => models.create(req.body)),
  );
  ai.patch(
    ['/admin/models/:id', '/connections/models/:id'],
    wrap((req) => models.update(req.params.id, req.body)),
  );
  ai.post(
    ['/admin/models/:id/test', '/connections/models/:id/test'],
    wrap((req) =>
      models.probe(req.user, req.params.id, req.body.kind || 'text'),
    ),
  );
  ai.post(
    '/admin/prices',
    wrap((req) => models.addPrice(req.body.modelId, req.body)),
  );
  ai.get(
    '/admin/prices',
    wrap(async () => {
      const rows = await c.rows(
        'SELECT p.*,m.name modelName FROM kl_prices p LEFT JOIN kl_models m ON m.id=p.model_id ORDER BY p.effective_at DESC LIMIT 100',
      );
      return rows.map((x) => ({ ...x, rates: c.json(x.rates) }));
    }),
  );
  ai.put(
    ['/admin/settings', '/connections/settings'],
    wrap(async (req) => {
      for (const key of ['builderModelId', 'visionModelId'])
        if (req.body[key] !== undefined) {
          const model = await models.resolve(req.body[key]);
          if (key === 'builderModelId' && !model.capabilities.verified?.tools)
            c.fail(400, '请先验证创建助手模型的工具调用能力');
          if (
            key === 'visionModelId' &&
            (!model.capabilities.vision || !model.capabilities.verified?.vision)
          )
            c.fail(400, '此模型未启用视觉能力');
          await c.rows(
            'INSERT INTO kl_settings(name,data) VALUES(?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)',
            [key, JSON.stringify(req.body[key])],
          );
        }
      return models.settings();
    }),
  );
  ai.get(
    '/admin/usage',
    wrap((req) => models.usage(req.user, req.query, 'admin')),
  );
  ai.post(
    '/messages/:id/render',
    wrap((req) => require('./presentation').render(req.user, req.params.id)),
  );
  ai.get('/messages/:id/formulas/:hash', async (req, res) => {
    res
      .type('image/svg+xml')
      .send(
        await require('./presentation').formula(
          req.user,
          req.params.id,
          req.params.hash,
        ),
      );
  });
  app.use('/api/ai', ai);
}
module.exports = { install };
