const { storedFilePath } = require('../utils/file-storage');
const fs = require('node:fs/promises');
const path = require('node:path');
const c = require('./core');
const media = require('./media');
const models = require('./models');
const busy = new Map();
async function insertRevision(db, resourceId, revisionId, stored, data) {
  const name = data.title;
  await c.rows(
    'INSERT INTO kl_revisions(id,resource_id,content_hash,data,search_text,status) VALUES(?,?,?,?,?,?)',
    [
      revisionId,
      resourceId,
      stored.hash,
      JSON.stringify(data),
      name,
      'queued',
    ],
    db,
  );
  await c.rows(
    'INSERT INTO kl_media(id,revision_id,kind,label,storage_path,mime,original_path,content_hash) VALUES(?,?,?,?,?,?,?,?)',
    [
      c.id(),
      revisionId,
      'original',
      name,
      stored.path,
      media.mime(name),
      name,
      stored.hash,
    ],
    db,
  );
}
function documentExtension(name, message) {
  const extension = path.extname(name).toLowerCase();
  if (!['.pdf', '.docx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp'].includes(extension))
    c.fail(400, message);
  return extension;
}
async function upload({
  user,
  bytes,
  name,
  conversationId = null,
  fileId = null,
  waitForParse = false,
}) {
  const extension = documentExtension(name, '支持文字、图片、PDF、DOCX');
  const stored = await media.blob(bytes, extension),
    resourceId = c.id(),
    revisionId = c.id();
  await c.transaction(async (db) => {
    await c.rows(
      'INSERT INTO kl_resources(id,namespace,source_id,type,visibility,owner_id,source_file_id,current_revision) VALUES(?,?,?,?,?,?,?,?)',
      [
        resourceId,
        fileId ? 'kelin-files' : 'uploads',
        String(fileId || resourceId),
        'document',
        conversationId ? 'private' : 'public',
        user.id,
        fileId,
        revisionId,
      ],
      db,
    );
    await insertRevision(db, resourceId, revisionId, stored, { title: name, extension, parseError: null });
    if (conversationId)
      await c.rows(
        'INSERT INTO kl_assets VALUES(?,?,?)',
        [c.id(), conversationId, resourceId],
        db,
      );
  });
  const processing = parse(revisionId, {
    user,
    agentId: conversationId
      ? (
          await c.one('SELECT agent_id FROM kl_conversations WHERE id=?', [
            conversationId,
          ])
        ).agent_id
      : null,
    purpose: 'parse',
  });
  if (waitForParse) {
    await processing;
    return { resourceId, revisionId, status: 'ready' };
  }
  processing.catch(() => {});
  return { resourceId, revisionId, status: 'queued' };
}
async function vision(bytes, mime, context, selectedModelId) {
  const visionId = selectedModelId || (await models.settings()).visionModelId;
  if (!visionId) c.fail(503, '尚未配置视觉识别模型');
  const model = await models.resolve(visionId);
  if (!model.capabilities.vision || !model.capabilities.verified?.vision)
    c.fail(503, '识别模型未通过视觉能力验证');
  return models.completion(
    model,
    [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请准确提取图片中的文字、公式和图表信息，保留题号、结构与数学符号。无法辨认处标记为无法辨认，不补造内容。',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mime};base64,${bytes.toString('base64')}`,
            },
          },
        ],
      },
    ],
    context,
  );
}
async function extract(bytes, extension, context) {
  if (extension === '.txt' || extension === '.md')
    return [{ label: '正文', body: bytes.toString('utf8') }];
  if (extension === '.docx') {
    const result = await require('mammoth').extractRawText({ buffer: bytes });
    return result.value
      .split(/\n\s*\n/)
      .filter((x) => x.trim())
      .map((body, i) => ({ label: `第 ${i + 1} 段`, body }));
  }
  if (extension === '.pdf') {
    const { canvas, pdfjs } = await require('./pdf-runtime').loadPdfRuntime();
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
    });
    const pdf = await loading.promise;
    const chunks = [];
    try {
      if (pdf.numPages > Number(process.env.MAX_DOCUMENT_PAGES || 100))
        c.fail(400, '文档页数超过处理上限');
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i),
          content = await page.getTextContent();
        let body = content.items
          .map((x) => x.str || '')
          .join(' ')
          .trim();
        if (body.length < 20) {
          const viewport = page.getViewport({ scale: 1.5 }),
            image = canvas.createCanvas(
              Math.ceil(viewport.width),
              Math.ceil(viewport.height),
            );
          await page.render({
            canvasContext: image.getContext('2d'),
            canvas: image,
            viewport,
          }).promise;
          body = await vision(await image.encode('png'), 'image/png', context);
        }
        chunks.push({ label: `第 ${i} 页`, body });
        page.cleanup();
      }
    } finally {
      await loading.destroy();
    }
    return chunks;
  }
  return [
    {
      label: '图片识别',
      body: await vision(bytes, media.mime('file' + extension), context),
    },
  ];
}
function parse(revisionId, context) {
  if (!busy.has(revisionId)) {
    const task = parseRevision(revisionId, context).finally(() => busy.delete(revisionId));
    busy.set(revisionId, task);
  }
  return busy.get(revisionId);
}
async function parseRevision(revisionId, context) {
  try {
    const revision = await c.one('SELECT * FROM kl_revisions WHERE id=?', [
      revisionId,
    ]);
    if (!revision || revision.status === 'ready') return;
    const original = await c.one(
      "SELECT * FROM kl_media WHERE revision_id=? AND kind='original'",
      [revisionId],
    );
    await c.rows("UPDATE kl_revisions SET status='processing' WHERE id=?", [
      revisionId,
    ]);
    const data = c.json(revision.data),
      bytes = await fs.readFile(media.absolute(original.storage_path));
    const chunks = await extract(bytes, data.extension, context);
    if (!chunks.length || chunks.every((x) => !x.body.trim()))
      c.fail(422, '未提取到可检索内容');
    await c.transaction(async (db) => {
      await c.rows(
        'DELETE FROM kl_chunks WHERE revision_id=?',
        [revisionId],
        db,
      );
      for (let i = 0; i < chunks.length; i++)
        await c.rows(
          'INSERT INTO kl_chunks VALUES(?,?,?,?)',
          [revisionId, i + 1, chunks[i].label, chunks[i].body],
          db,
        );
      await c.rows(
        "UPDATE kl_revisions SET data=?,search_text=?,status='ready' WHERE id=?",
        [
          JSON.stringify({ ...data, parseError: null }),
          data.title + ' ' + chunks.map((x) => x.body).join('\n'),
          revisionId,
        ],
        db,
      );
    });
  } catch (e) {
    const row = await c.one('SELECT data FROM kl_revisions WHERE id=?', [
      revisionId,
    ]);
    if (row)
      await c.rows(
        "UPDATE kl_revisions SET status='failed',data=? WHERE id=?",
        [
          JSON.stringify({
            ...c.json(row.data),
            parseError: e.status ? e.message : '文档解析失败，请重试',
          }),
          revisionId,
        ],
      );
    throw e;
  }
}
async function search(q = {}, user) {
  const pending = q.includeProcessing === 'true' && user?.role === 'teacher';
  const args = pending ? [user.id] : [],
    where = [
      "r.visibility='public'",
      "r.type='document'",
      '(r.source_file_id IS NULL OR EXISTS (SELECT 1 FROM files f WHERE f.id=r.source_file_id AND f.deleted_at IS NULL))',
      pending ? "(v.status='ready' OR r.owner_id=?)" : "v.status='ready'",
    ];
  if (q.q) {
    where.push('(v.search_text LIKE ?)');
    args.push(c.containsPattern(q.q));
  }
  const p = c.page(q),
    from =
      'FROM kl_resources r JOIN kl_revisions v ON v.id=r.current_revision WHERE ' +
      where.join(' AND ');
  const total = await c.one('SELECT COUNT(*) total ' + from, args);
  const found = await c.rows(
    'SELECT r.id resourceId,v.id revisionId,v.data ' +
      from +
      ' ORDER BY v.created_at DESC,r.id' + c.limitOffset(p),
    args,
  );
  const items = [];
  for (const row of found) {
    const chunks = await c.rows(
      'SELECT position,label,LEFT(body,600) body FROM kl_chunks WHERE revision_id=?' +
        (q.q ? ' AND body LIKE ?' : '') +
        ' ORDER BY position LIMIT 3',
      q.q ? [row.revisionId, c.containsPattern(q.q)] : [row.revisionId],
    );
    items.push({
      ...c.json(row.data),
      resourceId: row.resourceId,
      revisionId: row.revisionId,
      chunks,
    });
  }
  return { items, total: Number(total.total), ...p };
}
async function resume() {
  await c.rows(
    "UPDATE kl_revisions SET status='interrupted' WHERE status IN ('processing','queued')",
  );
  // Interrupted paid parsing is retried explicitly rather than silently charged twice.
}
async function replace(resource, user, bytes, name, options = {}) {
  const expectedRevision = options.expectedRevision || resource.current_revision;
  async function activate(revisionId) {
    const result = await c.rows("UPDATE kl_resources SET current_revision=? WHERE id=? AND current_revision=? AND visibility='public'",
      [revisionId, resource.id, expectedRevision]);
    if (!result.affectedRows) {
      const current = await c.one('SELECT current_revision,visibility FROM kl_resources WHERE id=?', [resource.id]);
      if (current?.current_revision !== revisionId || current.visibility !== 'public')
        c.fail(409, '资料已被其他操作更新或撤下，本次修订未替换当前资料');
    }
  }
  const extension = documentExtension(name, '不支持的资料格式');
  const stored = await media.blob(bytes, path.extname(name)),
    revisionId = c.id();
  const old = await c.one(
    'SELECT id,status FROM kl_revisions WHERE resource_id=? AND content_hash=?',
    [resource.id, stored.hash],
  );
  if (old) {
    if (old.status === 'ready')
      await activate(old.id);
    else if (options.awaitReady) c.fail(409, '相同内容正在解析或解析未成功，请先核对该修订');
    return { resourceId: resource.id, revisionId: old.id };
  }
  await c.transaction(async (db) => {
    await insertRevision(db, resource.id, revisionId, stored, { title: name, extension });
  });
  const processing = parse(revisionId, { user, purpose: 'parse' }).then(() => activate(revisionId));
  if (options.awaitReady) {
    await processing;
    return { resourceId: resource.id, revisionId, status: 'ready' };
  }
  processing.catch(() => {});
  return { resourceId: resource.id, revisionId, status: 'queued' };
}

async function indexFile(user, fileId, { driveUpload = false } = {}) {
  if (!driveUpload) c.teacher(user);
  const file = await c.one('SELECT * FROM files WHERE id=? AND deleted_at IS NULL', [fileId]);
  if (!file) c.fail(404, '文件不存在');
  if (user.role !== 'teacher' && String(file.uploader_id) !== String(user.id)) c.fail(403, '只能索引自己上传的文件');
  const existing = await c.one('SELECT id,current_revision FROM kl_resources WHERE namespace=? AND source_id=?', ['kelin-files', String(file.id)]);
  if (existing) {
    if (driveUpload) {
      await parse(existing.current_revision, { user, purpose: 'parse' });
      const revision = await c.one('SELECT status FROM kl_revisions WHERE id=?', [existing.current_revision]);
      return { resourceId: existing.id, revisionId: existing.current_revision, status: revision.status };
    }
    return { resourceId: existing.id, revisionId: existing.current_revision };
  }
  const absolute = storedFilePath(file.storage_path);
  return upload({user, bytes: await fs.readFile(absolute), name: file.original_name, fileId: file.id, waitForParse: driveUpload});
}
module.exports = { replace, upload, vision, parse, search, resume, indexFile, extract };
